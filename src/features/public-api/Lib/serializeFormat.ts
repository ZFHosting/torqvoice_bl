/**
 * How the public API writes values (docs/fork/API.md §3): money in major units to 2 decimals, rounded as the
 * documents print it; instants as ISO 8601 UTC; calendar dates the workshop typed (due dates) also as
 * `YYYY-MM-DD` on the workshop's own calendar. Pure: the serializers use these and nothing else.
 */
import { roundAsPrinted } from '@/lib/money'
import { zonedDayKey } from '@/lib/timezone'

/** Everything a serializer needs besides its row. */
export interface SerializeContext {
  organizationId: string
  /** ISO 4217, from the workshop's settings: every document carries it. */
  currency: string
  /** The workshop's IANA zone, for the calendar dates it typed. */
  timeZone: string
}

/** Money as the API states it, rounded the way the documents print it, so an integration carries what the customer saw. */
export function money(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0
  const rounded = roundAsPrinted(value)
  return rounded === 0 ? 0 : rounded
}

/** Money that may be missing: null stays null. */
export function moneyOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : money(value)
}

/** An instant as ISO 8601 UTC, or null. */
export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

/** An instant that's always there. */
export function isoAlways(value: Date): string {
  return value.toISOString()
}

/** The workshop's calendar day of an instant, `YYYY-MM-DD`, or null. */
export function day(value: Date | null | undefined, timeZone: string): string | null {
  return value ? zonedDayKey(value, timeZone) : null
}
