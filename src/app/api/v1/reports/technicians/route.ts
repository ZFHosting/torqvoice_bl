import { publicApiOk } from '@/features/public-api/Lib/errors'
import { queryObject } from '@/features/public-api/Lib/readResource'
import { periodKey, reportQuerySchema } from '@/features/public-api/Lib/reportPeriods'
import { withPublicApi } from '@/features/public-api/Lib/withPublicApi'
import { reportWindow, statusScope } from '@/features/reports/Lib/revenueRecords.server'
import { shareBilledHours } from '@/features/reports/Lib/sharedBilledHours'
import { isShopFeeLine } from '@/features/settings/Lib/shopFee'
import { listOrgEntries } from '@/features/time-tracking/Lib/timeEntries'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

interface Row {
  soldHours: number
  clockedMinutes: number
  shiftMinutes: number
  jobsCompleted: number
}

const empty = (): Row => ({ soldHours: 0, clockedMinutes: 0, shiftMinutes: 0, jobsCompleted: 0 })

/** Hours a labour line stands for. A shop fee line is one unit of a charge, not an hour. */
const laborHours = (line: { hours: number; pricingType: string }) =>
  isShopFeeLine(line) ? 0 : line.hours

/** Minutes of [from, to) inside the window. */
function clipped(from: Date, to: Date, start: Date, end: Date): number {
  const a = from < start ? start : from
  const b = to > end ? end : to
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000))
}

/**
 * fork (A5) `GET /api/v1/reports/technicians?from=&to=&group=day|week|month&completedOnly=` (docs/fork/API.md §4): per
 * technician and period on the workshop's clock, the input a pay calculation needs:
 * - hours sold: the labor lines of the work orders that started in the window, a line's own technician first, else
 *   the job's technician and helpers sharing it by the time each clocked on it (the reports screen's rule,
 *   `features/reports/Lib/sharedBilledHours.ts`); a shop fee line is no hours;
 * - minutes clocked (time entries) and shift minutes, clipped to the window, in the period they start in;
 * - jobs completed: the work orders started in the window and completed, by their technician.
 * Needs `read:reports`.
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
      const now = new Date()
      const [entries, shifts, records, technicians] = await Promise.all([
        listOrgEntries({ organizationId, from: start, to: end }),
        db.technicianShift.findMany({
          where: {
            organizationId,
            clockIn: { lt: end },
            OR: [{ clockOut: null }, { clockOut: { gte: start } }],
          },
          select: { technicianId: true, clockIn: true, clockOut: true },
        }),
        db.serviceRecord.findMany({
          where: {
            organizationId,
            startDateTime: { gte: start, lt: end },
            ...statusScope(query.completedOnly),
          },
          select: {
            id: true,
            status: true,
            startDateTime: true,
            serviceDate: true,
            technicianId: true,
            helpers: { select: { technicianId: true } },
            laborItems: { select: { hours: true, pricingType: true, technicianId: true } },
          },
        }),
        db.technician.findMany({
          where: { organizationId },
          select: { id: true, name: true, user: { select: { name: true } } },
        }),
      ])

      const rows = new Map<string, Map<string, Row>>()
      const at = (technicianId: string, period: string) => {
        let byPeriod = rows.get(technicianId)
        if (!byPeriod) {
          byPeriod = new Map()
          rows.set(technicianId, byPeriod)
        }
        let row = byPeriod.get(period)
        if (!row) {
          row = empty()
          byPeriod.set(period, row)
        }
        return row
      }

      for (const e of entries) {
        const minutes = clipped(e.startedAt, e.endedAt ?? now, start, end)
        if (minutes === 0) continue
        const from = e.startedAt < start ? start : e.startedAt
        at(e.technicianId, periodKey(from, tz, query.group)).clockedMinutes += minutes
      }
      for (const s of shifts) {
        const minutes = clipped(s.clockIn, s.clockOut ?? now, start, end)
        if (minutes === 0) continue
        const from = s.clockIn < start ? start : s.clockIn
        at(s.technicianId, periodKey(from, tz, query.group)).shiftMinutes += minutes
      }

      // What each person clocked on the jobs more than one person is on, over the job's whole life (the reports
      // screen's rule): the share is of the work.
      const sharedIds = records.filter((r) => r.helpers.length > 0).map((r) => r.id)
      const clockedOnJob = new Map<string, Map<string, number>>()
      if (sharedIds.length) {
        const worked = await db.timeEntry.findMany({
          where: { organizationId, serviceRecordId: { in: sharedIds } },
          select: {
            serviceRecordId: true,
            technicianId: true,
            startedAt: true,
            endedAt: true,
            durationMinutes: true,
          },
        })
        for (const e of worked) {
          const minutes =
            e.durationMinutes ??
            Math.max(0, Math.round(((e.endedAt ?? now).getTime() - e.startedAt.getTime()) / 60_000))
          const byPerson = clockedOnJob.get(e.serviceRecordId) ?? new Map<string, number>()
          byPerson.set(e.technicianId, (byPerson.get(e.technicianId) ?? 0) + minutes)
          clockedOnJob.set(e.serviceRecordId, byPerson)
        }
      }
      for (const r of records) {
        const period = periodKey(r.startDateTime ?? r.serviceDate, tz, query.group)
        let unassigned = 0
        for (const line of r.laborItems) {
          const hours = laborHours(line)
          if (line.technicianId) at(line.technicianId, period).soldHours += hours
          else unassigned += hours
        }
        if (r.technicianId) {
          const shares = shareBilledHours({
            hours: unassigned,
            technicianId: r.technicianId,
            helperIds: r.helpers.map((h) => h.technicianId),
            clockedMinutes: clockedOnJob.get(r.id) ?? new Map(),
          })
          for (const [technicianId, hours] of shares) at(technicianId, period).soldHours += hours
          if (r.status === 'completed') at(r.technicianId, period).jobsCompleted += 1
        }
      }

      const names = new Map(technicians.map((t) => [t.id, t.user?.name || t.name]))
      const data = [...rows.entries()]
        .map(([technicianId, byPeriod]) => {
          const periods = [...byPeriod.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([period, row]) => ({ period, ...row }))
          const total = periods.reduce(
            (t, p) => ({
              soldHours: t.soldHours + p.soldHours,
              clockedMinutes: t.clockedMinutes + p.clockedMinutes,
              shiftMinutes: t.shiftMinutes + p.shiftMinutes,
              jobsCompleted: t.jobsCompleted + p.jobsCompleted,
            }),
            empty()
          )
          return { technicianId, name: names.get(technicianId) ?? null, total, periods }
        })
        .sort((a, b) => (a.technicianId < b.technicianId ? -1 : 1))
      return publicApiOk({
        timeZone: tz,
        from: start.toISOString(),
        to: end.toISOString(),
        group: query.group,
        completedOnly: query.completedOnly,
        technicians: data,
      })
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.REPORTS }],
    }
  )
}
