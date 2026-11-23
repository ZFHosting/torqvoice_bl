/**
 * `/api/v1/appointments` (`?from=&to=`), `/api/v1/time-entries` (`?technicianId=`, `?workOrderId=`,
 * `?from=&to=`) and `/api/v1/shifts` (`?technicianId=`, `?from=&to=`; X6) (docs/fork/API.md §4).
 */
import { z } from 'zod'
import {
  bookingNotificationSchema,
  MAX_NOTIFICATIONS,
} from '@/features/calendar/Schema/bookingSchema'
import {
  createShiftSchema,
  updateShiftSchema,
} from '@/features/fork-records/Schema/forkRecordSchemas'
import { isDateKey, isTime } from '@/features/workshop-calendar/Lib/calendar'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { writeEndpoints } from '../Lib/writeSpec'
import { rangeFilters } from './common'

export const appointmentSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    startAt: z.string(),
    endAt: z.string(),
    customerId: z.string().nullable(),
    vehicleId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Appointment' })

export const timeEntrySchema = z
  .object({
    id: z.string(),
    technicianId: z.string(),
    workOrderId: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable().describe('Null while the clock runs'),
    durationMinutes: z.number().int().nullable(),
    note: z.string().nullable(),
    source: z.string().describe('Where it was clocked: app, tech app, import'),
    editedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'TimeEntry' })

export const shiftSchema = z
  .object({
    id: z.string(),
    technicianId: z.string(),
    clockIn: z.string(),
    clockOut: z.string().nullable(),
    durationMinutes: z.number().int().nullable(),
    note: z.string().nullable(),
    source: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Shift' })

export type AppointmentOut = z.infer<typeof appointmentSchema>
export type TimeEntryOut = z.infer<typeof timeEntrySchema>
export type ShiftOut = z.infer<typeof shiftSchema>

export const appointmentsSpec: ReadSpec<AppointmentOut> = {
  path: '/appointments',
  tag: 'Appointments',
  noun: { one: 'appointment', many: 'appointments' },
  filters: z.object({ ...rangeFilters }).describe('By start'),
  response: appointmentSchema,
}

export const timeEntriesSpec: ReadSpec<TimeEntryOut> = {
  path: '/time-entries',
  tag: 'Time',
  noun: { one: 'time entry', many: 'time entries' },
  filters: z.object({
    technicianId: z.string().min(1).optional(),
    workOrderId: z.string().min(1).optional(),
    ...rangeFilters,
  }),
  response: timeEntrySchema,
}

export const shiftsSpec: ReadSpec<ShiftOut> = {
  path: '/shifts',
  tag: 'Time',
  noun: { one: 'shift', many: 'shifts' },
  filters: z.object({ technicianId: z.string().min(1).optional(), ...rangeFilters }),
  response: shiftSchema,
}

/* ---------- writes (A4) ---------- */

const wallDate = z
  .string()
  .refine(isDateKey, 'Pick a valid date')
  .describe('YYYY-MM-DD on the workshop’s clock')
const wallTime = z
  .string()
  .refine(isTime, 'Pick a valid time')
  .describe('HH:MM on the workshop’s clock')
const notifications = z
  .array(bookingNotificationSchema)
  .max(MAX_NOTIFICATIONS)
  .describe(
    'Reminders before the start: in_app or email to the workshop, customer_sms or customer_email to the customer'
  )

/** An appointment as the app's booking dialog makes one, on the workshop's clock. */
export const createAppointmentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).optional().describe('HTML, cleaned before it is kept'),
    customerId: z.string().min(1).optional(),
    vehicleId: z.string().min(1).optional().describe('With a vehicle, its owner is the customer'),
    startDate: wallDate,
    startTime: wallTime,
    endDate: wallDate,
    endTime: wallTime,
    notifications: notifications.optional().describe('None when left out'),
  })
  .strict()

/** Only the fields sent change; null clears the description, customer or vehicle. */
export const updateAppointmentSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20_000).nullable().optional(),
    customerId: z.string().min(1).nullable().optional(),
    vehicleId: z.string().min(1).nullable().optional(),
    startDate: wallDate.optional(),
    startTime: wallTime.optional(),
    endDate: wallDate.optional(),
    endTime: wallTime.optional(),
    notifications: notifications.optional().describe('Replaces the reminders; left out, they stay'),
  })
  .strict()

const wallClock = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/)
  .describe('YYYY-MM-DDTHH:MM on the workshop’s clock (to the minute)')

/** A stretch clocked after the fact, as the timesheet adds one. */
export const createTimeEntrySchema = z
  .object({
    technicianId: z.string().min(1),
    workOrderId: z.string().min(1),
    startedAt: wallClock,
    endedAt: wallClock,
    note: z.string().max(500).nullable().optional(),
  })
  .strict()

export const updateTimeEntrySchema = z
  .object({
    startedAt: wallClock.optional(),
    endedAt: wallClock.nullable().optional().describe('Null keeps a running clock running'),
    note: z.string().max(500).nullable().optional(),
  })
  .strict()

export const startTimeEntrySchema = z
  .object({ technicianId: z.string().min(1), workOrderId: z.string().min(1) })
  .strict()

export const scheduleEndpoints: EndpointSpec[] = [
  ...readEndpoints(appointmentsSpec),
  ...writeEndpoints({
    ...appointmentsSpec,
    create: createAppointmentSchema,
    update: updateAppointmentSchema,
    remove: true,
  }),
  ...readEndpoints(timeEntriesSpec),
  ...writeEndpoints({
    ...timeEntriesSpec,
    create: createTimeEntrySchema,
    update: updateTimeEntrySchema,
    remove: true,
  }),
  {
    method: 'post',
    path: '/time-entries/start',
    summary:
      'Start a technician’s clock on a work order (one clock a technician: a running one stops)',
    tag: timeEntriesSpec.tag,
    body: startTimeEntrySchema,
    response: timeEntrySchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/time-entries/{id}/stop',
    summary: 'Stop a running clock',
    tag: timeEntriesSpec.tag,
    response: timeEntrySchema,
  },
  ...readEndpoints(shiftsSpec),
  ...writeEndpoints({
    ...shiftsSpec,
    create: createShiftSchema,
    update: updateShiftSchema,
    remove: true,
  }),
]
