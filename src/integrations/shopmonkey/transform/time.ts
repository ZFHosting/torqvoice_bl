/**
 * Time (MAPPING §3): a timesheet entry on an order that loaded as a work order becomes a `TimeEntry`;
 * every other one (activity `General`, no order, or an order that isn't a work order) becomes a
 * `TechnicianShift` (X6). Minutes always come from the clock times: the source `duration` has no stated
 * unit (PROVISIONAL(M0:S8)) and stays in the archive. Appointments become `Appointment`s.
 */
import { date, type FieldSpec, str, unmappedFields, warn } from './fields'
import type { Row, TransformContext, TransformResult, Warning } from './types'

export const TIMESHEET_FIELDS: FieldSpec = {
  mapped: ['id', 'technicianId', 'activity', 'orderId', 'clockIn', 'clockOut', 'note'],
  archive: [
    'companyId',
    'createdDate',
    'duration',
    'flatRate',
    'inProgress',
    'laborId',
    'locationId',
    'metadata',
    'number',
    'rateCents',
    'serviceId',
    'type',
    'updatedDate',
  ],
}

export type TimeRows =
  | {
      kind: 'timeEntry'
      row: {
        startedAt: Date
        endedAt: Date | null
        durationMinutes: number | null
        note: string | null
        source: 'shopmonkey'
        technicianId: string
        serviceRecordId: string
        organizationId: string
      }
    }
  | {
      kind: 'shift'
      row: {
        clockIn: Date
        clockOut: Date | null
        durationMinutes: number | null
        note: string | null
        source: 'shopmonkey'
        sourceRemoteId: string
        technicianId: string
        organizationId: string
      }
    }

export function minutesBetween(start: Date, end: Date | null): number | null {
  if (!end) return null
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000)
  return minutes >= 0 ? minutes : null
}

export function transformTimesheet(
  entry: Row,
  ctx: TransformContext
): TransformResult<TimeRows | null> {
  const remoteId = String(entry.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(entry, TIMESHEET_FIELDS)
  const clockIn = date(entry.clockIn)
  const userId = str(entry.technicianId)
  const technicianId = userId ? ctx.resolve('user', userId) : null
  if (!clockIn || !technicianId) {
    warnings.push(
      warn(
        'timesheet',
        remoteId,
        clockIn ? 'timesheet_technician_unresolved' : 'timesheet_missing_clock_in',
        clockIn ? 'Its technician was not imported' : 'No clock-in time',
        clockIn ? 'technicianId' : 'clockIn'
      )
    )
    return { rows: null, warnings, unmapped }
  }
  const clockOut = date(entry.clockOut)
  const durationMinutes = minutesBetween(clockIn, clockOut)
  const note = str(entry.note)
  const orderId = str(entry.orderId)
  const serviceRecordId =
    entry.activity !== 'General' && orderId ? ctx.resolve('order', orderId) : null
  if (orderId && entry.activity !== 'General' && !serviceRecordId) {
    warnings.push(
      warn(
        'timesheet',
        remoteId,
        'timesheet_order_not_loaded',
        'Kept as a shift: its order is not a loaded work order',
        'orderId'
      )
    )
  }
  if (serviceRecordId) {
    return {
      rows: {
        kind: 'timeEntry',
        row: {
          startedAt: clockIn,
          endedAt: clockOut,
          durationMinutes,
          note,
          source: 'shopmonkey',
          technicianId,
          serviceRecordId,
          organizationId: ctx.organizationId,
        },
      },
      warnings,
      unmapped,
    }
  }
  return {
    rows: {
      kind: 'shift',
      row: {
        clockIn,
        clockOut,
        durationMinutes,
        note,
        source: 'shopmonkey',
        sourceRemoteId: remoteId,
        technicianId,
        organizationId: ctx.organizationId,
      },
    },
    warnings,
    unmapped,
  }
}

export const APPOINTMENT_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'name',
    'note',
    'startDate',
    'endDate',
    'customerId',
    'vehicleId',
    'orderId',
    'createdDate',
  ],
  archive: [
    'allDay',
    'color',
    'companyId',
    'confirmationStatus',
    'locationId',
    'metadata',
    'origin',
    'publicId',
    'recurring',
    'sendConfirmation',
    'sendReminder',
    'updatedDate',
    'useEmail',
    'useSMS',
  ],
}

export interface AppointmentRows {
  appointment: {
    title: string
    description: string | null
    startAt: Date
    endAt: Date
    customerId: string | null
    vehicleId: string | null
    organizationId: string
    createdAt: Date | undefined
  }
  /** The order it was booked for: M5 sets that work order's `startDateTime` (MAPPING §3). */
  orderRemoteId: string | null
}

const HOUR = 60 * 60_000

export function transformAppointment(
  appointment: Row,
  ctx: TransformContext
): TransformResult<AppointmentRows | null> {
  const remoteId = String(appointment.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(appointment, APPOINTMENT_FIELDS)
  const startAt = date(appointment.startDate)
  if (!startAt) {
    warnings.push(
      warn('appointment', remoteId, 'appointment_missing_start', 'No start time', 'startDate')
    )
    return { rows: null, warnings, unmapped }
  }
  let endAt = date(appointment.endDate)
  if (!endAt || endAt < startAt) {
    endAt = new Date(startAt.getTime() + HOUR)
    warnings.push(
      warn(
        'appointment',
        remoteId,
        'appointment_end_assumed',
        'No usable end time: an hour assumed',
        'endDate'
      )
    )
  }
  const customerRemote = str(appointment.customerId)
  const vehicleRemote = str(appointment.vehicleId)
  return {
    rows: {
      appointment: {
        title: str(appointment.name) ?? 'Appointment',
        description: str(appointment.note),
        startAt,
        endAt,
        customerId: customerRemote ? ctx.resolve('customer', customerRemote) : null,
        vehicleId: vehicleRemote ? ctx.resolve('vehicle', vehicleRemote) : null,
        organizationId: ctx.organizationId,
        createdAt: date(appointment.createdDate) ?? undefined,
      },
      orderRemoteId: str(appointment.orderId),
    },
    warnings,
    unmapped,
  }
}
