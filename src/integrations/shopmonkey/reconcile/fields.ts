/**
 * fork: the unmapped-field section of the reconciliation (M6): keys Shopmonkey sends that no transform reads and
 * MAPPING doesn't list as archive only, with how often they carry a value, so a field that matters gets noticed.
 * The specs are the transforms' own (`transform/specs.ts`). Keys starting with `_` are the importer's.
 *
 * Read from the most recently updated records of each table, up to `SAMPLE` of them: the report says how many it
 * looked at, and a field that matters is in most of them.
 */
import 'server-only'
import { db } from '@/lib/db'
import { NESTED_SPECS, TABLE_SPECS } from '../transform/specs'
import type { UnmappedField } from './types'

export const SAMPLE = 2_000

type Row = Record<string, unknown>

const hasValue = (v: unknown) =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)

/** Counts, per key, how many records had it with a value; `known` keys and the importer's are left out. */
export function tallyUnknown(
  records: Row[],
  known: Set<string>,
  where: string,
  out: Map<string, UnmappedField>
): void {
  for (const record of records) {
    for (const [field, value] of Object.entries(record)) {
      if (field.startsWith('_') || known.has(field)) continue
      const key = `${where}\u0000${field}`
      const tally = out.get(key) ?? { where, field, seen: 0, nonEmpty: 0 }
      if (hasValue(value)) tally.nonEmpty++
      out.set(key, tally)
    }
  }
  for (const tally of out.values()) if (tally.where === where) tally.seen = records.length
}

export async function reconcileFields(organizationId: string): Promise<UnmappedField[]> {
  const out = new Map<string, UnmappedField>()
  const tables = new Set([
    ...Object.keys(TABLE_SPECS),
    ...Object.keys(NESTED_SPECS).map((k) => k.split('.')[0]),
  ])
  tables.delete('files[]')
  for (const table of [...tables, 'order_file', 'inspection_file']) {
    const rows = await db.sourceRecord.findMany({
      where: { organizationId, source: 'shopmonkey', table },
      orderBy: { updatedAt: 'desc' },
      take: SAMPLE,
      select: { payload: true },
    })
    if (!rows.length) continue
    const payloads = rows.map((r) => r.payload as Row)
    const spec =
      TABLE_SPECS[table] ?? (table.endsWith('_file') ? NESTED_SPECS['files[]'] : undefined)
    if (spec) tallyUnknown(payloads, new Set([...spec.mapped, ...spec.archive]), table, out)
    // The records nested in these (a customer's emails, a service's lines, an inspection's items).
    for (const [path, nested] of Object.entries(NESTED_SPECS)) {
      const [owner, key] = path.split('.')
      if (owner !== table || !key) continue
      const field = key.replace(/\[\]$/, '')
      const children = payloads.flatMap((p) =>
        Array.isArray(p[field])
          ? (p[field] as unknown[]).filter((c): c is Row => !!c && typeof c === 'object')
          : []
      )
      if (children.length) {
        tallyUnknown(children, new Set([...nested.mapped, ...nested.archive]), path, out)
      }
    }
  }
  return [...out.values()].sort(
    (a, b) =>
      b.nonEmpty - a.nonEmpty || a.where.localeCompare(b.where) || a.field.localeCompare(b.field)
  )
}
