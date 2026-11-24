/**
 * fork: keeping the fork's line columns (X2, X3) through an edit in the app (M5 task 12).
 *
 * The work order and quote pages save their lines by deleting them and writing the list the form sends, and the form
 * knows nothing of a line's kind, technician, cost or source fields, nor its id (its job it sends since M9, checked by
 * fork-records/Lib/lineJobs.server.ts). So the save matches each line it writes to a line it is about to delete and
 * carries those columns over, and the job when the form sent none of this document's:
 * 1. a line with the same name (parts: name and part number; labor: description and pricing) takes the first such
 *    line not yet taken, in order, so reordering, adding and removing lines, and changing quantities and prices,
 *    keep them;
 * 2. a part left over takes a left-over line with the same part number (the part was renamed).
 * Nothing else is guessed: a removed line and an added one look like a rename, and a job or a technician moved onto
 * a line they had nothing to do with is worse than one lost. A line that matches nothing (a new line, a renamed labor
 * line) gets none; what it came from stays in the archive (`SourceRecord`). A column the incoming line sets itself is
 * left as it is.
 */

import type { Prisma } from '@/generated/prisma/client'

export const PART_LINE_COLUMNS = [
  'jobId',
  'lineKind',
  'discountAmount',
  'note',
  'sourceExtra',
] as const

export const LABOR_LINE_COLUMNS = [
  'jobId',
  'lineKind',
  'technicianId',
  'completed',
  'costHours',
  'costRate',
  'discountAmount',
  'sourceExtra',
] as const

type Previous = Record<string, unknown>

/** How lines are told apart: an exact key, and for what is left, an optional looser one (null: no match). */
export interface LineMatch {
  key: (line: Previous) => string
  fallbackKey?: (line: Previous) => string | null
}

export const PART_MATCH: LineMatch = {
  key: (line) => `${String(line.name ?? '').trim()}\u0000${String(line.partNumber ?? '').trim()}`,
  fallbackKey: (line) => String(line.partNumber ?? '').trim() || null,
}

export const LABOR_MATCH: LineMatch = {
  key: (line) =>
    `${String(line.description ?? '').trim()}\u0000${String(line.pricingType ?? 'hourly')}`,
}

/** The previous line each incoming line takes its columns from, by index (or none). */
export function matchLines<P extends object, N extends object>(
  previous: P[],
  next: N[],
  match: LineMatch
): (P | undefined)[] {
  const taken = new Set<number>()
  const out: (P | undefined)[] = next.map(() => undefined)
  const pass = (keyOf: (line: Previous) => string | null) => {
    next.forEach((line, n) => {
      if (out[n]) return
      const key = keyOf(line as Previous)
      if (key === null) return
      const i = previous.findIndex((p, index) => !taken.has(index) && keyOf(p as Previous) === key)
      if (i < 0) return
      taken.add(i)
      out[n] = previous[i]
    })
  }
  pass(match.key)
  if (match.fallbackKey) pass(match.fallbackKey)
  return out
}

/** `next` with each line's fork columns filled from the line it replaces, where it doesn't set them itself. */
export function carryLineColumns<N extends object>(
  previous: Previous[],
  next: N[],
  match: LineMatch,
  columns: readonly string[]
): N[] {
  if (!previous.length || !next.length) return next
  const matched = matchLines(previous, next, match)
  return next.map((line, i) => {
    const from = matched[i]
    if (!from) return line
    const carried: Record<string, unknown> = {}
    for (const column of columns) {
      const own = (line as Record<string, unknown>)[column]
      if (own !== undefined) continue
      const value = from[column]
      if (value !== null && value !== undefined) carried[column] = value
    }
    return { ...line, ...carried }
  })
}

/** The fork's line columns, as a create takes them. */
export interface ForkLineColumns {
  jobId?: string
  lineKind?: string
  technicianId?: string
  completed?: boolean
  costHours?: number
  costRate?: number
  discountAmount?: number
  note?: string
  sourceExtra?: Prisma.InputJsonValue
}

/** The fork columns a line carries, for a create that lists its fields one by one. */
export function forkColumnsOf<C extends keyof ForkLineColumns>(
  line: object,
  columns: readonly C[]
): Pick<ForkLineColumns, C> {
  const out: Record<string, unknown> = {}
  for (const column of columns) {
    const value = (line as Record<string, unknown>)[column]
    if (value !== null && value !== undefined) out[column] = value
  }
  return out as Pick<ForkLineColumns, C>
}

/** What to read from the lines a save is about to delete. */
export const partColumnsSelect = Object.fromEntries(
  ['name', 'partNumber', ...PART_LINE_COLUMNS].map((c) => [c, true])
) as Record<'name' | 'partNumber' | (typeof PART_LINE_COLUMNS)[number], true>

export const laborColumnsSelect = Object.fromEntries(
  ['description', 'pricingType', ...LABOR_LINE_COLUMNS].map((c) => [c, true])
) as Record<'description' | 'pricingType' | (typeof LABOR_LINE_COLUMNS)[number], true>
