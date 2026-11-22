/**
 * The core of anonymize-fixtures.ts: raw spike responses in, anonymized fixture files out. Pure, so it
 * is unit tested (src/__tests__/scripts/shopmonkey/fixture-build.test.ts).
 *
 * The same record usually arrives several times: in a list page, in a search, and from its own "Find"
 * endpoint, which is the only one carrying some fields (an order's `files[]`). The responses for one
 * record are merged, never overwritten: list responses first, single-record responses last, and a
 * later value replaces an earlier one only when it isn't null, with objects merged key by key.
 */
import { createAnonymizer, findLeaks } from './anonymize'
import type { RawResponseFile } from './raw'

type Json = Record<string, unknown>

export interface FixtureBuildOptions {
  salt: string
  /** Strings that must not appear in the output: the shop's name, known surnames, VINs. */
  deny?: string[]
  /** Originals known to be false positives. */
  allow?: string[]
}

export interface FixtureBuildResult {
  /** File name → content. Empty when `leaks` isn't. */
  files: Map<string, string>
  /** Replaced or deny-listed values still present; non-empty means nothing may be written. */
  leaks: string[]
  /** Records per table. */
  counts: Record<string, number>
}

function isPlainObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** `b` over `a`: non-null values win, objects merge, an empty list never replaces a full one. */
export function mergeRecords(a: Json, b: Json): Json {
  const out: Json = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key]
    if (value === null || value === undefined) continue
    if (isPlainObject(prev) && isPlainObject(value)) out[key] = mergeRecords(prev, value)
    else if (Array.isArray(value) && value.length === 0 && Array.isArray(prev) && prev.length > 0)
      continue
    else out[key] = value
  }
  return out
}

function recordsOf(body: unknown): { records: Json[]; single: boolean } {
  if (!isPlainObject(body)) return { records: [], single: false }
  const data = body.data
  if (Array.isArray(data)) return { records: data.filter(isPlainObject), single: false }
  if (isPlainObject(data)) return { records: [data], single: true }
  return { records: [], single: false }
}

export function buildFixtures(
  raws: RawResponseFile[],
  options: FixtureBuildOptions
): FixtureBuildResult {
  const anon = createAnonymizer(options.salt)
  const usable = raws
    .filter((raw) => raw.table && raw.status === 200)
    .map((raw) => ({ raw, ...recordsOf(raw.body) }))
    // Lists before single-record responses, then by label, so the richest response lands last.
    .sort((x, y) => Number(x.single) - Number(y.single) || x.raw.label.localeCompare(y.raw.label))

  const tables = new Map<
    string,
    { endpoint: string; total: number | null; records: Map<string, Json> }
  >()
  for (const { raw, records } of usable) {
    const table = raw.table as string
    const entry = tables.get(table) ?? {
      endpoint: raw.request.path,
      total: null,
      records: new Map(),
    }
    const total = (raw.body as { meta?: { total?: unknown } } | null)?.meta?.total
    if (typeof total === 'number') entry.total = Math.max(entry.total ?? 0, total)
    for (const record of records) {
      const id = typeof record.id === 'string' ? record.id : `${raw.label}#${entry.records.size}`
      const prev = entry.records.get(id)
      entry.records.set(id, prev ? mergeRecords(prev, record) : record)
    }
    tables.set(table, entry)
  }

  const files = new Map<string, string>()
  const counts: Record<string, number> = {}
  for (const [table, entry] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
    const fixture = {
      table,
      source: 'recorded',
      anonymized: true,
      endpoint: entry.endpoint,
      total: entry.total,
      records: [...entry.records.values()].map((record) => anon.record(table, record)),
    }
    files.set(`${table}.json`, `${JSON.stringify(fixture, null, 2)}\n`)
    counts[table] = entry.records.size
  }

  const leaks = findLeaks(
    [...files.values()].join('\n'),
    anon.originals(),
    options.deny ?? [],
    options.allow ?? []
  )
  return { files: leaks.length > 0 ? new Map() : files, leaks, counts }
}
