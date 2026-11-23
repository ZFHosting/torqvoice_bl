/**
 * Appointment, time entry and shift writes (docs/fork/API.md §4), through the services the calendar, the timesheet
 * and the technician app run (A2), with their own audit events.
 *
 * - An appointment is booked through the booking dialog's service, on the workshop's clock; a change is the
 *   appointment as stored with the fields sent laid over it, so what isn't sent stays (reminders included).
 * - A time entry is the timesheet's; `POST /time-entries/start` is the technician app's clock (one running clock a
 *   technician: starting another stops it), and `/stop` the timesheet's.
 * - A shift is the fork's own record (X6).
 */
import 'server-only'
import { randomBytes } from 'node:crypto'
import {
  createBookingOnceEvent,
  deleteAppointmentEvent,
  updateBookingEvent,
} from '@/features/calendar/Lib/bookingAuditEvents'
import {
  createBookingOnceService,
  deleteAppointmentService,
  updateBookingService,
} from '@/features/calendar/Lib/bookingService.server'
import { shiftEvent, timeEntryStartEvent } from '@/features/fork-records/Lib/forkRecordAuditEvents'
import {
  createShiftService,
  deleteShiftService,
  updateShiftService,
} from '@/features/fork-records/Lib/forkRecordServices.server'
import { getOpenEntry, startEntry } from '@/features/time-tracking/Lib/timeEntries'
import {
  createTimeEntryEvent,
  deleteTimeEntryEvent,
  stopTimeEntryEvent,
  updateTimeEntryEvent,
} from '@/features/time-tracking/Lib/timeEntryAuditEvents'
import {
  createTimeEntryService,
  deleteTimeEntryService,
  stopTimeEntryService,
  updateTimeEntryService,
} from '@/features/time-tracking/Lib/timeEntryService.server'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { zonedDateInput, zonedTimeInput } from '@/lib/timezone'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { writeRoute } from '../Lib/writeRoute'
import { appointmentsResource, shiftsResource, timeEntriesResource } from '../Resources/schedule'
import {
  createAppointmentSchema,
  createTimeEntrySchema,
  startTimeEntrySchema,
  updateAppointmentSchema,
  updateTimeEntrySchema,
} from '../Schema/schedule'
import { answerWith, deleted, withId } from './common'

/* ---------- appointments ---------- */

const services = PermissionSubject.SERVICES

const currentAppointment = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.appointment.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

/** The once-only token the dialog makes up when it opens; Idempotency-Key does that job for the API. */
const bookingToken = () => randomBytes(24).toString('base64url')

export const createAppointmentPOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject: services },
  run: (svc, body) => {
    const sent = createAppointmentSchema.parse(body)
    return createBookingOnceService(svc, {
      ...(body as typeof sent),
      kind: 'appointment',
      token: bookingToken(),
      notifications: (body as typeof sent).notifications ?? [],
    })
  },
  audit: (result) => createBookingOnceEvent(result),
  respond: async (result, ctx) =>
    answerWith(appointmentsResource, ctx.organizationId, result.id, 201),
})

/** Sent, or (for a key sent as null) nothing, or the appointment's own. */
function pick<T>(sent: Record<string, unknown>, key: string, own: T): T | undefined {
  if (!Object.hasOwn(sent, key) || sent[key] === undefined) return own
  return (sent[key] ?? undefined) as T | undefined
}

export const updateAppointmentPATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject: services },
  current: currentAppointment,
  run: async (svc, body, { id }: { id: string }) => {
    updateAppointmentSchema.parse(body)
    const sent = body as Record<string, unknown>
    const own = await db.appointment.findFirst({
      where: { id, organizationId: svc.organizationId },
      select: {
        title: true,
        description: true,
        customerId: true,
        vehicleId: true,
        startAt: true,
        endAt: true,
        notifications: {
          select: { channel: true, amount: true, unit: true, atTime: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!own) throw new Error('Appointment not found')
    const zone = await workshopTimeZone(svc.organizationId)
    return updateBookingService(svc, {
      kind: 'appointment',
      id,
      title: pick(sent, 'title', own.title) ?? own.title,
      description: pick(sent, 'description', own.description ?? undefined),
      customerId: pick(sent, 'customerId', own.customerId ?? undefined),
      vehicleId: pick(sent, 'vehicleId', own.vehicleId ?? undefined),
      startDate: pick(sent, 'startDate', zonedDateInput(own.startAt, zone)) as string,
      startTime: pick(sent, 'startTime', zonedTimeInput(own.startAt, zone)) as string,
      endDate: pick(sent, 'endDate', zonedDateInput(own.endAt, zone)) as string,
      endTime: pick(sent, 'endTime', zonedTimeInput(own.endAt, zone)) as string,
      notifications:
        (sent.notifications as never) ??
        own.notifications.map((n) => ({
          channel: n.channel as never,
          amount: n.amount,
          unit: n.unit as never,
          atTime: n.atTime,
        })),
    })
  },
  audit: (result) => updateBookingEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(appointmentsResource, ctx.organizationId, id),
})

export const deleteAppointmentDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.DELETE, subject: services },
  current: currentAppointment,
  run: (svc, _body, { id }) => deleteAppointmentService(svc, id),
  audit: (result) => deleteAppointmentEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})

/* ---------- time entries ---------- */

/**
 * The app's own permissions: time tracking has only View and Edit, and Edit is what the timesheet asks for to add,
 * correct, stop or remove an entry (shifts, the fork's, follow it). Clocking in is `update:services`, as the
 * technician app asks (`src/lib/permissions.ts`).
 */
const timeTracking = PermissionSubject.TIME_TRACKING

const currentTimeEntry = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.timeEntry.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createTimeEntryPOST = writeRoute('POST', {
  permission: { action: PermissionAction.UPDATE, subject: timeTracking },
  run: (svc, body) => {
    const sent = createTimeEntrySchema.parse(body)
    // The API's name for the job is the work order's.
    return createTimeEntryService(svc, {
      technicianId: sent.technicianId,
      serviceRecordId: sent.workOrderId,
      startedAt: sent.startedAt,
      endedAt: sent.endedAt,
      note: sent.note,
    })
  },
  audit: (result) => createTimeEntryEvent(result),
  respond: async (result, ctx) =>
    answerWith(timeEntriesResource, ctx.organizationId, result.id, 201),
})

export const updateTimeEntryPATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject: timeTracking },
  current: currentTimeEntry,
  run: (svc, body, { id }) => {
    updateTimeEntrySchema.parse(body)
    return updateTimeEntryService(svc, withId(body, id) as never)
  },
  audit: (result) => updateTimeEntryEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(timeEntriesResource, ctx.organizationId, id),
})

export const deleteTimeEntryDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.UPDATE, subject: timeTracking },
  current: currentTimeEntry,
  run: (svc, _body, { id }) => deleteTimeEntryService(svc, id),
  audit: (result) => deleteTimeEntryEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})

/**
 * The technician app's clock: one running clock a technician, a running one on another job stops, and the job
 * moves to in progress if it hadn't started. Starting the clock already running on that job changes nothing.
 */
export const startTimeEntryPOST = writeRoute('POST', {
  permission: { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
  run: async (svc, body) => {
    const { technicianId, workOrderId } = startTimeEntrySchema.parse(body)
    const technician = await db.technician.count({
      where: { id: technicianId, organizationId: svc.organizationId },
    })
    if (!technician) throw new Error('Technician not found')
    const open = await getOpenEntry(svc.organizationId, [technicianId])
    const started = await startEntry({
      organizationId: svc.organizationId,
      technicianId,
      technicianIds: [technicianId],
      serviceRecordId: workOrderId,
      source: 'api',
    })
    return {
      id: started.entry.id,
      technicianId,
      serviceRecordId: workOrderId,
      closedEntryId: started.closed?.id ?? null,
      running: open?.serviceRecordId === workOrderId,
    }
  },
  audit: (result) => (result.running ? null : timeEntryStartEvent(result)),
  respond: async (result, ctx) =>
    answerWith(timeEntriesResource, ctx.organizationId, result.id, result.running ? 200 : 201),
})

export const stopTimeEntryPOST = writeRoute('POST', {
  permission: { action: PermissionAction.UPDATE, subject: timeTracking },
  current: currentTimeEntry,
  run: (svc, _body, { id }: { id: string }) => stopTimeEntryService(svc, id),
  audit: (result) => stopTimeEntryEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(timeEntriesResource, ctx.organizationId, id),
})

/* ---------- shifts (X6) ---------- */

const currentShift = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.technicianShift.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createShiftPOST = writeRoute('POST', {
  permission: { action: PermissionAction.UPDATE, subject: timeTracking },
  run: (svc, body) => createShiftService(svc, body),
  audit: (result) => shiftEvent('create', result),
  respond: async (result, ctx) => answerWith(shiftsResource, ctx.organizationId, result.id, 201),
})

export const updateShiftPATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject: timeTracking },
  current: currentShift,
  run: (svc, body, { id }) => updateShiftService(svc, id, body),
  audit: (result) => shiftEvent('update', result),
  respond: async (_result, ctx, { id }) => answerWith(shiftsResource, ctx.organizationId, id),
})

export const deleteShiftDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.UPDATE, subject: timeTracking },
  current: currentShift,
  run: (svc, _body, { id }) => deleteShiftService(svc, id),
  audit: (result) => shiftEvent('delete', result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})
