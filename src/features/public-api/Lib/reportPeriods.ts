/**
 * fork (A5): the periods the API's reports group by, on the workshop's clock (AGENTS.md, "Whose clock"): a day
 * (`2026-04-29`), a week named by its Monday (`2026-04-27`), a month (`2026-04`).
 */
import { z } from 'zod'
import { zonedDayKey, zonedParts } from '@/lib/timezone'
import { workshopMonthKey } from '@/lib/workshop-datetime'

export const REPORT_GROUPS = ['day', 'week', 'month'] as const
export type ReportGroup = (typeof REPORT_GROUPS)[number]

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD')

/** A report's query: the window as workshop dates (both days included), how to group, finished work only. */
export const reportQuerySchema = z.object({
  from: dayKey.optional(),
  to: dayKey.optional(),
  group: z.enum(REPORT_GROUPS).default('month'),
  completedOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
})

export function periodKey(date: Date, timeZone: string, group: ReportGroup): string {
  if (group === 'month') return workshopMonthKey(date, timeZone)
  if (group === 'day') return zonedDayKey(date, timeZone)
  // The Monday of its week, on the workshop's calendar.
  const p = zonedParts(date, timeZone)
  const back = (p.weekday + 6) % 7
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - back))
  return monday.toISOString().slice(0, 10)
}
