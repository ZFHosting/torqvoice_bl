/**
 * Turns the raw responses the spike recorded (tmp/shopmonkey-raw/, gitignored) into anonymized
 * fixtures under src/__tests__/features/integrations/fixtures/shopmonkey/recorded/, one file per
 * table. Only this output is ever committed (docs/fork/FORK.md). The work is in fixture-build.ts.
 *
 *   ANONYMIZE_SALT=<secret, 16+ chars> npx tsx scripts/shopmonkey/anonymize-fixtures.ts \
 *     [--in tmp/shopmonkey-raw] [--out <dir>] [--deny deny.txt] [--allow allow.txt]
 *
 * --deny names a file of strings that must not appear in the output (one per line: the shop's name,
 * a customer surname you know is in the data, a VIN). --allow names originals that are known false
 * positives. Nothing is written if any replaced value or deny-listed string is still present.
 *
 * Keep the salt out of git and out of shell history you share: with it, a guess at a real phone
 * number could be checked against its fake.
 */
import 'dotenv/config'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildFixtures } from './fixture-build'
import type { RawResponseFile } from './raw'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function lines(file: string | undefined): string[] {
  if (!file) return []
  return readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

function main() {
  const inDir = arg('in') ?? 'tmp/shopmonkey-raw'
  const outDir = arg('out') ?? 'src/__tests__/features/integrations/fixtures/shopmonkey/recorded'
  if (!existsSync(inDir))
    throw new Error(`No raw responses in ${inDir}. Run scripts/shopmonkey/spike.ts first.`)

  const raws = readdirSync(inDir)
    .filter((n) => n.endsWith('.json') && !n.startsWith('_'))
    .map((n) => JSON.parse(readFileSync(path.join(inDir, n), 'utf-8')) as RawResponseFile)
  const result = buildFixtures(raws, {
    salt: process.env.ANONYMIZE_SALT ?? '',
    deny: lines(arg('deny')),
    allow: lines(arg('allow')),
  })

  if (result.leaks.length > 0) {
    // The values themselves go to a gitignored file for the operator to review, never to the log.
    const leakFile = path.join('tmp', 'shopmonkey-leaks.txt')
    mkdirSync('tmp', { recursive: true })
    writeFileSync(leakFile, `${result.leaks.join('\n')}\n`)
    console.error(
      `Refusing to write: ${result.leaks.length} original value(s) are still in the output; they're listed in ${leakFile} (gitignored). ` +
        'Extend the rules in scripts/shopmonkey/anonymize.ts, or list known false positives in a file passed with --allow.'
    )
    process.exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  for (const [name, content] of result.files) writeFileSync(path.join(outDir, name), content)
  console.log(
    `Wrote ${result.files.size} fixture file(s) to ${outDir}: ${Object.entries(result.counts)
      .map(([t, n]) => `${t}=${n}`)
      .join(', ')}`
  )
}

main()
