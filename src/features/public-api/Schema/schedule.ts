/**
 * `/api/v1/appointments` (`?from=&to=`), `/api/v1/time-entries` (`?technicianId=`, `?workOrderId=`,
 * `?from=&to=`) and `/api/v1/shifts` (`?technicianId=`, `?from=&to=`; X6) (docs/fork/API.md §4).
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
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

export const scheduleEndpoints: EndpointSpec[] = [
  ...readEndpoints(appointmentsSpec),
  ...readEndpoints(timeEntriesSpec),
  ...readEndpoints(shiftsSpec),
]
