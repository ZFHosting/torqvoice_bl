/**
 * Turns the raw responses the spike recorded (tmp/shopmonkey-raw/, gitignored) into anonymized
 * fixtures under src/__tests__/features/integrations/fixtures/shopmonkey/recorded/, one file per
 * table. Only this output is ever committed (docs/fork/FORK.md).
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createAnonymizer, findLeaks } from './anonymize'
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

function recordsOf(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return []
  const data = (body as { data?: unknown }).data
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') return [data]
  return []
}

function main() {
  const salt = process.env.ANONYMIZE_SALT ?? ''
  const inDir = arg('in') ?? 'tmp/shopmonkey-raw'
  const outDir = arg('out') ?? 'src/__tests__/features/integrations/fixtures/shopmonkey/recorded'
  if (!existsSync(inDir))
    throw new Error(`No raw responses in ${inDir}. Run scripts/shopmonkey/spike.ts first.`)

  const anon = createAnonymizer(salt)
  const tables = new Map<
    string,
    { endpoint: string; total: number | null; records: Map<string, unknown> }
  >()

  for (const name of readdirSync(inDir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const raw = JSON.parse(readFileSync(path.join(inDir, name), 'utf-8')) as RawResponseFile
    if (!raw.table || raw.status !== 200) continue
    const entry = tables.get(raw.table) ?? {
      endpoint: raw.request.path,
      total: null,
      records: new Map(),
    }
    const meta = (raw.body as { meta?: { total?: number } } | null)?.meta
    if (typeof meta?.total === 'number') entry.total = Math.max(entry.total ?? 0, meta.total)
    for (const record of recordsOf(raw.body)) {
      const id = String((record as { id?: unknown }).id ?? `${name}#${entry.records.size}`)
      entry.records.set(id, anon.record(raw.table, record))
    }
    tables.set(raw.table, entry)
  }

  const files = new Map<string, string>()
  for (const [table, entry] of tables) {
    const fixture = {
      table,
      source: 'recorded',
      anonymized: true,
      endpoint: entry.endpoint,
      total: entry.total,
      records: [...entry.records.values()],
    }
    files.set(`${table}.json`, `${JSON.stringify(fixture, null, 2)}\n`)
  }

  const leaks = findLeaks(
    [...files.values()].join('\n'),
    anon.originals(),
    lines(arg('deny')),
    lines(arg('allow'))
  )
  if (leaks.length > 0) {
    // Print how many and how long, never the values themselves.
    console.error(
      `Refusing to write: ${leaks.length} original value(s) are still in the output (lengths ${leaks.map((l) => l.length).join(', ')}). ` +
        'Extend the rules in scripts/shopmonkey/anonymize.ts, or list known false positives with --allow.'
    )
    process.exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  for (const [name, content] of files) writeFileSync(path.join(outDir, name), content)
  console.log(
    `Wrote ${files.size} fixture file(s) to ${outDir}: ${[...tables].map(([t, e]) => `${t}=${e.records.size}`).join(', ')}`
  )
}

main()
