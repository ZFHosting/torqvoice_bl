/**
 * @vitest-environment node
 *
 * fork (A5): the periods the API's reports group by, on the workshop's clock (AGENTS.md, "Whose clock"), tested in a
 * zone far from UTC: an instant late on Sunday in Auckland is Sunday there, Saturday in UTC.
 */
import { describe, expect, it } from 'vitest'
import { periodKey, reportQuerySchema } from '@/features/public-api/Lib/reportPeriods'

const AUCKLAND = 'Pacific/Auckland'
// 2026-05-03 10:30 UTC is Sunday 3 May 22:30 in Auckland (UTC+12).
const SUNDAY_NIGHT = new Date('2026-05-03T10:30:00.000Z')
// 2026-04-30 13:00 UTC is Friday 1 May 01:00 in Auckland.
const MAY_FIRST = new Date('2026-04-30T13:00:00.000Z')

describe('periodKey', () => {
  it('names the workshop’s day, not the server’s', () => {
    expect(periodKey(MAY_FIRST, AUCKLAND, 'day')).toBe('2026-05-01')
    expect(periodKey(MAY_FIRST, 'UTC', 'day')).toBe('2026-04-30')
  })

  it('names the workshop’s month', () => {
    expect(periodKey(MAY_FIRST, AUCKLAND, 'month')).toBe('2026-05')
    expect(periodKey(MAY_FIRST, 'UTC', 'month')).toBe('2026-04')
  })

  it('names a week by its Monday, on the workshop’s calendar', () => {
    // Sunday 3 May in Auckland belongs to the week of Monday 27 April.
    expect(periodKey(SUNDAY_NIGHT, AUCKLAND, 'week')).toBe('2026-04-27')
    // A Monday is its own week's name.
    expect(periodKey(new Date('2026-05-03T13:00:00.000Z'), AUCKLAND, 'week')).toBe('2026-05-04')
  })
})

describe('the reports’ query', () => {
  it('takes dates, a grouping and finished work only, and refuses anything else', () => {
    expect(
      reportQuerySchema.parse({
        from: '2026-01-01',
        to: '2026-01-31',
        group: 'week',
        completedOnly: 'true',
      })
    ).toEqual({ from: '2026-01-01', to: '2026-01-31', group: 'week', completedOnly: true })
    expect(reportQuerySchema.parse({})).toEqual({ group: 'month', completedOnly: false })
    expect(() => reportQuerySchema.parse({ group: 'year' })).toThrow()
    expect(() => reportQuerySchema.parse({ from: '1 Jan' })).toThrow()
    expect(() => reportQuerySchema.parse({ groupBy: 'month' })).toThrow()
  })
})
