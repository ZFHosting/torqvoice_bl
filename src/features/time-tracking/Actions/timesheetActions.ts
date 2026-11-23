'use server'

import { z } from 'zod'
import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { addZonedDays, startOfZonedDay, zonedDayKey } from '@/lib/timezone'
import { workshopDayRange } from '@/lib/workshop-datetime'
import { OPEN_SERVICE_STATUSES } from '@/lib/service-record'
import { SETTING_KEYS } from '@/features/settings/Schema/settingsSchema'
import { listOrgEntries } from '../Lib/timeEntries'
import { toSheetEntries } from '../Lib/serialize'
import { canEditTimeEntries } from '../Lib/canEdit'
import type { SheetEntry, SheetTechnician } from '../Lib/timesheet'
import { typeKeySearch } from '@/features/vehicles/Lib/typeKeySetting'
// fork: the write bodies, their input schemas and audit events live beside the time entry service (A2)
import {
  createTimeEntryEvent,
  deleteTimeEntryEvent,
  stopTimeEntryEvent,
  updateTimeEntryEvent,
} from '../Lib/timeEntryAuditEvents'
import {
  type createSchema,
  createTimeEntryService,
  deleteTimeEntryService,
  stopTimeEntryService,
  type updateSchema,
  updateTimeEntryService,
} from '../Lib/timeEntryService.server'

/**
 * The manager's side of the clock: who worked when, and fixing what the
 * clock got wrong.
 *
 * Reading needs READ on time tracking; changing anything needs UPDATE. Both
 * are their own subject rather than riding on reports, because a foreman
 * who may correct a forgotten clock-out is not necessarily someone who may
 * read the revenue report.
 */

export interface TimesheetData {
  timeZone: string
  /** Whole workshop days, as ISO instants: `from` inclusive, `to` exclusive. */
  from: string
  to: string
  fromKey: string
  toKey: string
  technicians: SheetTechnician[]
  entries: SheetEntry[]
  canEdit: boolean
}

const rangeSchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  technicianId: z.string().optional().nullable(),
})

export async function getTimesheet(input: z.input<typeof rangeSchema>) {
  return withAuth(
    async (ctx): Promise<TimesheetData> => {
      const args = rangeSchema.parse(input)
      const [timeZone, weekStartRow] = await Promise.all([
        workshopTimeZone(ctx.organizationId),
        db.appSetting.findFirst({
          where: { organizationId: ctx.organizationId, key: SETTING_KEYS.WORKBOARD_WEEK_START_DAY },
          select: { value: true },
        }),
      ])
      const weekStartDay = Number.parseInt(weekStartRow?.value ?? '1', 10) || 0
      const now = new Date()
      // Default: the whole of this week, from the workshop's own first day of
      // the week, in the workshop's days. The same arithmetic as the page's
      // "This week" preset, so the two agree on what the week is.
      const todayStart = startOfZonedDay(now, timeZone)
      const dow = new Date(todayStart.getTime() + 12 * 3_600_000).getUTCDay()
      const sinceWeekStart = (dow - weekStartDay + 7) % 7
      const weekStart = addZonedDays(todayStart, -sinceWeekStart, timeZone)
      const range = workshopDayRange(args.from, args.to, timeZone, {
        start: weekStart,
        end: addZonedDays(weekStart, 6, timeZone),
      })
      // A window longer than a quarter is a report, not a sheet, and would
      // pull every row the workshop has. Clamp rather than refuse.
      const maxTo = addZonedDays(range.gte, 92, timeZone)
      const to = range.lt > maxTo ? maxTo : range.lt

      const [technicians, rows] = await Promise.all([
        db.technician.findMany({
          where: { organizationId: ctx.organizationId, isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            color: true,
            userId: true,
            user: { select: { name: true } },
          },
        }),
        listOrgEntries({
          organizationId: ctx.organizationId,
          from: range.gte,
          to,
          technicianId: args.technicianId ?? null,
        }),
      ])

      const canEdit = await canEditTimeEntries(ctx)

      return {
        timeZone,
        from: range.gte.toISOString(),
        to: to.toISOString(),
        fromKey: zonedDayKey(range.gte, timeZone),
        toKey: zonedDayKey(new Date(to.getTime() - 1), timeZone),
        // The account's name wins over the row's copy, as on the work board.
        technicians: technicians.map((t) => ({
          id: t.id,
          name: t.user?.name || t.name,
          color: t.color,
          linked: t.userId !== null,
        })),
        entries: await toSheetEntries(rows),
        canEdit,
      }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.TIME_TRACKING },
      ],
    }
  )
}

/** Jobs a manual entry can be booked against: open ones first, then recent. */
export async function searchTimesheetJobs(query: string) {
  return withAuth(
    async (ctx) => {
      const q = query.trim()
      const rows = await db.serviceRecord.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(q
            ? {
                OR: [
                  { title: { contains: q, mode: 'insensitive' } },
                  { vehicle: { licensePlate: { contains: q, mode: 'insensitive' } } },
                  ...(await typeKeySearch(ctx.organizationId, q)).map((vehicle) => ({ vehicle })),
                  { vehicle: { make: { contains: q, mode: 'insensitive' } } },
                  { vehicle: { model: { contains: q, mode: 'insensitive' } } },
                ],
              }
            : { status: { in: [...OPEN_SERVICE_STATUSES] } }),
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 20,
        select: {
          id: true,
          title: true,
          status: true,
          vehicle: { select: { make: true, model: true, licensePlate: true } },
        },
      })
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        vehicleLabel: r.vehicle
          ? [r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ')
          : null,
        licensePlate: r.vehicle?.licensePlate ?? null,
      }))
    },
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.TIME_TRACKING },
      ],
    }
  )
}

export async function createTimeEntry(input: z.input<typeof createSchema>) {
  return withAuth(
    // fork: the body is createTimeEntryService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createTimeEntryService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.TIME_TRACKING },
      ],
      audit: ({ result }) => createTimeEntryEvent(result),
    }
  )
}

export async function updateTimeEntry(input: z.input<typeof updateSchema>) {
  return withAuth(
    // fork: the body is updateTimeEntryService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateTimeEntryService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.TIME_TRACKING },
      ],
      audit: ({ result }) => updateTimeEntryEvent(result),
    }
  )
}

/** A manager stopping a clock somebody left running: an update with "now" as the end. */
export async function stopTimeEntry(id: string) {
  return withAuth(
    // fork: the body is stopTimeEntryService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      stopTimeEntryService({ organizationId, userId, actor: 'user' }, id),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.TIME_TRACKING },
      ],
      audit: ({ result }) => stopTimeEntryEvent(result),
    }
  )
}

export async function deleteTimeEntry(id: string) {
  return withAuth(
    // fork: the body is deleteTimeEntryService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteTimeEntryService({ organizationId, userId, actor: 'user' }, id),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.TIME_TRACKING },
      ],
      audit: ({ result }) => deleteTimeEntryEvent(result),
    }
  )
}
