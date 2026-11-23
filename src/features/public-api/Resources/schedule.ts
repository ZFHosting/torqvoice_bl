/** `/api/v1/appointments`, `/api/v1/time-entries` and `/api/v1/shifts`: how they read (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import type { ReadResource } from '../Lib/readResource'
import {
  type AppointmentOut,
  appointmentsSpec,
  type ShiftOut,
  shiftsSpec,
  type TimeEntryOut,
  timeEntriesSpec,
} from '../Schema/schedule'
import {
  APPOINTMENT_SELECT,
  type AppointmentRow,
  SHIFT_SELECT,
  type ShiftRow,
  serializeAppointment,
  serializeShift,
  serializeTimeEntry,
  TIME_ENTRY_SELECT,
  type TimeEntryRow,
} from '../Serializers/schedule'
import { range } from './range'

export const appointmentsResource: ReadResource<AppointmentRow, AppointmentOut> = {
  ...appointmentsSpec,
  // The calendar's own actions read appointments under services.
  permission: { action: PermissionAction.READ, subject: PermissionSubject.SERVICES },
  scope: (organizationId) => ({ organizationId }),
  where: ({ from, to }) => range('startAt', from, to),
  select: () => APPOINTMENT_SELECT,
  findMany: (args) =>
    db.appointment.findMany(args as never) as unknown as Promise<AppointmentRow[]>,
  findFirst: (args) =>
    db.appointment.findFirst(args as never) as unknown as Promise<AppointmentRow | null>,
  serialize: (row) => serializeAppointment(row),
}

export const timeEntriesResource: ReadResource<TimeEntryRow, TimeEntryOut> = {
  ...timeEntriesSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.TIME_TRACKING },
  scope: (organizationId) => ({ organizationId }),
  where: ({ from, to, technicianId, workOrderId }) => ({
    ...range('startedAt', from, to),
    ...(typeof technicianId === 'string' ? { technicianId } : {}),
    ...(typeof workOrderId === 'string' ? { serviceRecordId: workOrderId } : {}),
  }),
  select: () => TIME_ENTRY_SELECT,
  findMany: (args) => db.timeEntry.findMany(args as never) as unknown as Promise<TimeEntryRow[]>,
  findFirst: (args) =>
    db.timeEntry.findFirst(args as never) as unknown as Promise<TimeEntryRow | null>,
  serialize: (row) => serializeTimeEntry(row),
}

export const shiftsResource: ReadResource<ShiftRow, ShiftOut> = {
  ...shiftsSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.TIME_TRACKING },
  scope: (organizationId) => ({ organizationId }),
  where: ({ from, to, technicianId }) => ({
    ...range('clockIn', from, to),
    ...(typeof technicianId === 'string' ? { technicianId } : {}),
  }),
  select: () => SHIFT_SELECT,
  findMany: (args) => db.technicianShift.findMany(args as never) as unknown as Promise<ShiftRow[]>,
  findFirst: (args) =>
    db.technicianShift.findFirst(args as never) as unknown as Promise<ShiftRow | null>,
  serialize: (row) => serializeShift(row),
}
