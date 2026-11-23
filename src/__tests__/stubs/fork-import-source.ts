import fs from 'node:fs'
import path from 'node:path'

/**
 * fork: the backup import's source as upstream's restore-completeness tests read it
 * (features/backup/part-restore-fields, features/backup/restore-map-fields).
 *
 * The fork restores its own tables and columns in src/lib/backup/fork-restore.ts, which import.ts
 * calls through one-line `// fork:` hooks. Read alone, import.ts hides those columns behind a spread
 * and those tables in another file, so this folds them back in. The tests then check them exactly as
 * strictly as upstream's own:
 * - every spread of a fork-restore.ts helper that returns an object (`...forkPartColumns(p, ids)`,
 *   `...stamps(row)`) is replaced by that object's properties, on one line so a test that reads a
 *   fixed window after a call still sees all of them;
 * - fork-restore.ts and fork-archive.ts (the import archive's own backup file) are appended, so their
 *   create calls count as restore sites.
 */
export function readImportSourceWithFork(root = process.cwd()): string {
  const read = (file: string) =>
    fs.readFileSync(path.join(root, file), 'utf-8').replace(/\r\n/g, '\n')
  const importSource = read('src/lib/backup/import.ts')
  const forkSource = read('src/lib/backup/fork-restore.ts')
  const archiveSource = read('src/lib/backup/fork-archive.ts')

  const helpers = new Map<string, string>()
  const objectHelpers = [
    // export function name(...) { return { ... } }
    /^(?:export )?function (\w+)\([^)]*\)[^{]*\{\n\s*return \{\n([\s\S]*?)\n\s*\}\n\}/gm,
    // const name = (...) => ({ ... })
    /^const (\w+) = \([^)]*\) => \(\{\n([\s\S]*?)\n\}\)/gm,
  ]
  for (const pattern of objectHelpers) {
    for (const [, name, body] of forkSource.matchAll(pattern)) {
      helpers.set(name, body.replace(/\s+/g, ' ').trim())
    }
  }

  const inline = (source: string) =>
    source.replace(
      /\.\.\.(\w+)\(([^()]*)\)/g,
      (spread, name: string) => helpers.get(name) ?? spread
    )

  return `${inline(importSource)}\n${inline(forkSource)}\n${inline(archiveSource)}`
}
