import { publicApiOk } from '@/features/public-api/Lib/errors'
import { queryObject } from '@/features/public-api/Lib/readResource'
import { periodKey, reportQuerySchema } from '@/features/public-api/Lib/reportPeriods'
import { withPublicApi } from '@/features/public-api/Lib/withPublicApi'
import { reportWindow, revenueRecords } from '@/features/reports/Lib/revenueRecords.server'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

interface Totals {
  revenue: number
  collected: number
  count: number
  partsCost: number
  partsRevenue: number
  laborRevenue: number
}

const empty = (): Totals => ({
  revenue: 0,
  collected: 0,
  count: 0,
  partsCost: 0,
  partsRevenue: 0,
  laborRevenue: 0,
})

const withProfit = (t: Totals) => ({
  ...t,
  outstanding: t.revenue - t.collected,
  netProfit: t.partsRevenue - t.partsCost + t.laborRevenue,
})

/**
 * fork (A5) `GET /api/v1/reports/sales?from=&to=&group=day|week|month&completedOnly=` (docs/fork/API.md §4): what the
 * work orders in the window came to, by period on the workshop's clock: the same records and figures as the reports
 * screen's revenue report (`features/reports/Lib/revenueRecords.server.ts`), so a month here is that screen's month.
 * Amounts are in the workshop's currency. Needs `read:reports`.
 */
export async function GET(request: Request) {
  return withPublicApi(
    request,
    async ({ organizationId }) => {
      const query = reportQuerySchema.parse(queryObject(request))
      const { tz, start, end } = await reportWindow(organizationId, {
        startDate: query.from,
        endDate: query.to,
      })
      const records = await revenueRecords(organizationId, { start, end }, query.completedOnly)
      const periods = new Map<string, Totals>()
      const summary = empty()
      for (const r of records) {
        const key = periodKey(r.date, tz, query.group)
        const t = periods.get(key) ?? empty()
        for (const into of [t, summary]) {
          into.revenue += r.total
          into.collected += r.paid
          into.count += 1
          into.partsCost += r.partsCost
          into.partsRevenue += r.partsRevenue
          into.laborRevenue += r.laborRevenue
        }
        periods.set(key, t)
      }
      return publicApiOk({
        timeZone: tz,
        from: start.toISOString(),
        to: end.toISOString(),
        group: query.group,
        completedOnly: query.completedOnly,
        periods: [...periods.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([period, t]) => ({ period, ...withProfit(t) })),
        summary: withProfit(summary),
      })
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.REPORTS }],
    }
  )
}
