/** Appointments, time entries and shifts, field by field (docs/fork/API.md §4). */
import { iso, isoAlways } from '../Lib/serializeFormat'
import type { AppointmentOut, ShiftOut, TimeEntryOut } from '../Schema/schedule'

export const APPOINTMENT_SELECT = {
  id: true,
  title: true,
  description: true,
  startAt: true,
  endAt: true,
  customerId: true,
  vehicleId: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface AppointmentRow {
  id: string
  title: string
  description: string | null
  startAt: Date
  endAt: Date
  customerId: string | null
  vehicleId: string | null
  createdAt: Date
  updatedAt: Date
}

export function serializeAppointment(row: AppointmentRow): AppointmentOut {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startAt: isoAlways(row.startAt),
    endAt: isoAlways(row.endAt),
    customerId: row.customerId,
    vehicleId: row.vehicleId,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}

export const TIME_ENTRY_SELECT = {
  id: true,
  technicianId: true,
  serviceRecordId: true,
  startedAt: true,
  endedAt: true,
  durationMinutes: true,
  note: true,
  source: true,
  editedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface TimeEntryRow {
  id: string
  technicianId: string
  serviceRecordId: string
  startedAt: Date
  endedAt: Date | null
  durationMinutes: number | null
  note: string | null
  source: string
  editedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export function serializeTimeEntry(row: TimeEntryRow): TimeEntryOut {
  return {
    id: row.id,
    technicianId: row.technicianId,
    workOrderId: row.serviceRecordId,
    startedAt: isoAlways(row.startedAt),
    endedAt: iso(row.endedAt),
    durationMinutes: row.durationMinutes,
    note: row.note,
    source: row.source,
    editedAt: iso(row.editedAt),
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}

export const SHIFT_SELECT = {
  id: true,
  technicianId: true,
  clockIn: true,
  clockOut: true,
  durationMinutes: true,
  note: true,
  source: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface ShiftRow {
  id: string
  technicianId: string
  clockIn: Date
  clockOut: Date | null
  durationMinutes: number | null
  note: string | null
  source: string
  createdAt: Date
  updatedAt: Date
}

export function serializeShift(row: ShiftRow): ShiftOut {
  return {
    id: row.id,
    technicianId: row.technicianId,
    clockIn: isoAlways(row.clockIn),
    clockOut: iso(row.clockOut),
    durationMinutes: row.durationMinutes,
    note: row.note,
    source: row.source,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}
