/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { type TxClient } from '@/lib/db'
import { demoGuard } from '@/lib/demo'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { createDraftRecord } from '@/features/vehicles/Lib/createDraftRecord'
import {
  bookingConcerns,
  bookingParties,
  cleanDescription,
  syncNotifications,
  wallClock,
} from '../Lib/booking.server'
import {
  isCustomerChannel,
  type SaveBookingInput,
  saveBookingSchema,
} from '../Schema/bookingSchema'
import { db } from '@/lib/db'
import { zonedDate } from '@/lib/timezone'
import { resourceFor } from '../Lib/booking.server'
import { bookAppointmentSchema, type BookAppointmentInput } from '../Schema/appointmentSchema'
import { appointmentConcerns, appointmentTitle } from '../Lib/appointment'
import { z } from 'zod'
import type { ServiceCtx } from '@/lib/service-context'

/** What the dialog is told it booked. `repeated` when it was booked before. */
type Booked = {
  kind: 'appointment' | 'workOrder'
  id: string
  ref: string
  vehicleId: string | null
  overbooked: boolean
  repeated: boolean
}

async function bookedWith(
  organizationId: string,
  token: string,
  client: Pick<TxClient, 'serviceRecord' | 'appointment'> = db
): Promise<Booked | null> {
  const [job, appointment] = await Promise.all([
    client.serviceRecord.findFirst({
      where: { organizationId, bookingToken: token },
      select: { id: true, vehicleId: true, invoiceNumber: true },
    }),
    client.appointment.findFirst({
      where: { organizationId, bookingToken: token },
      select: { id: true, title: true, vehicleId: true },
    }),
  ])
  if (job) {
    return {
      kind: 'workOrder',
      id: job.id,
      ref: job.invoiceNumber || job.id,
      vehicleId: job.vehicleId,
      // Said the first time, if it was; nothing was taken from anyone now.
      overbooked: false,
      repeated: true,
    }
  }
  if (appointment) {
    return {
      kind: 'appointment',
      id: appointment.id,
      ref: appointment.title,
      vehicleId: appointment.vehicleId,
      overbooked: false,
      repeated: true,
    }
  }
  return null
}

/**
 * Makes sends of one booking take turns, and tells the one whose turn comes
 * second what the first booked.
 *
 * The lookup before the transaction is passed by both of two sends that
 * arrive together. The token is unique among jobs and among appointments,
 * but a send made again as the other kind (the dialog stays open after a
 * failure, and the kind can be switched) writes to the other table, where
 * nothing refuses it. So each send waits here for any other with its token
 * to finish, and then looks again.
 */
async function claimToken(
  tx: TxClient,
  organizationId: string,
  token: string
): Promise<Booked | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('booking_token'), hashtext(${`${organizationId}:${token}`}))`
  return bookedWith(organizationId, token, tx)
}

/**
 * Two sends of one booking that arrive together both find nothing booked
 * and both write. The database lets one through and refuses the other its
 * token, or, for an appointment being made a work order, finds the
 * appointment already gone. The one refused answers with what the other
 * booked; anything else that went wrong is still what went wrong.
 */
function theOneBooked(organizationId: string, token: string) {
  return async (error: unknown): Promise<Booked> => {
    const code = (error as { code?: string } | null)?.code
    if (code !== 'P2002' && code !== 'P2025') throw error
    const already = await bookedWith(organizationId, token)
    if (!already) throw error
    return already
  }
}

export async function createBookingOnceService(ctx: ServiceCtx, input: SaveBookingInput) {
  const { organizationId, userId } = ctx
  const data = saveBookingSchema.parse(input)
  if (data.id) throw new Error('This booking already exists')
  const token = data.token
  if (!token) throw new Error('This booking has no token')
  // Before anything else is looked up: an appointment that became a work
  // order the first time is gone by now, and must not read as an error.
  const already = await bookedWith(organizationId, token)
  if (already) return already
  // A message to the customer will go out from the workshop's own SMS or
  // email, which the public demo must not do.
  if (data.notifications.some((n) => isCustomerChannel(n.channel))) demoGuard()

  const timeZone = await workshopTimeZone(organizationId)
  const start = wallClock(data.startDate, data.startTime, timeZone)
  const end = wallClock(data.endDate, data.endTime, timeZone)
  const { vehicle, customer } = await bookingParties(organizationId, data)
  const description = cleanDescription(data.description)

  const from = data.fromAppointmentId
    ? await db.appointment.findFirst({
        where: { id: data.fromAppointmentId, organizationId },
        select: { id: true },
      })
    : null
  if (data.fromAppointmentId && !from) {
    // Gone because the first send finished between the two lookups and
    // took it with it: then the work order is there by now.
    const meanwhile = await bookedWith(organizationId, token)
    if (meanwhile) return meanwhile
    throw new Error('Appointment not found')
  }

  if (data.kind === 'appointment') {
    if (from) throw new Error('An appointment becomes a work order, not another appointment')
    const booking = db.$transaction(async (tx) => {
      const earlier = await claimToken(tx, organizationId, token)
      if (earlier) return earlier
      const appointment = await tx.appointment.create({
        data: {
          organizationId,
          bookingToken: token,
          title: data.title,
          description,
          startAt: start,
          endAt: end,
          vehicleId: vehicle?.id ?? null,
          // A car brings its owner.
          customerId: vehicle?.customerId ?? customer?.id ?? null,
          createdById: userId,
        },
        select: { id: true, title: true, vehicleId: true },
      })
      await syncNotifications(
        tx,
        { organizationId, userId, appointmentId: appointment.id },
        data.notifications
      )
      return appointment
    })
    const created = await booking.catch(theOneBooked(organizationId, token))
    if ('kind' in created) return created
    return {
      kind: 'appointment' as const,
      id: created.id,
      ref: created.title,
      vehicleId: created.vehicleId,
      overbooked: false,
      repeated: false,
    }
  }

  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000)
  const { resource, full } = await resourceFor(organizationId, start, minutes)
  const booking = db.$transaction(async (tx) => {
    const earlier = await claimToken(tx, organizationId, token)
    if (earlier) return earlier
    const created = await createDraftRecord(
      { organizationId, userId },
      {
        vehicleId: vehicle?.id ?? null,
        customerId: vehicle ? null : (customer?.id ?? null),
        customerExempt: vehicle
          ? (vehicle.customer?.taxExempt ?? false)
          : (customer?.taxExempt ?? false),
        title: data.title,
        startDateTime: start,
        endDateTime: end,
        technicianId: resource?.technicianId ?? undefined,
        workBayId: resource?.workBayId ?? undefined,
        // Work on a car even before the car is on file.
        shopWork: true,
        tx,
      }
    )
    const record = await tx.serviceRecord.update({
      where: { id: created.id },
      data: {
        status: 'scheduled',
        bookingToken: token,
        // What was typed as a description is the job's conditions: one
        // copy, on the work order, the print and the technician's phone.
        concerns: {
          create: bookingConcerns(data.work, description, data.title).map((text, sortOrder) => ({
            description: text,
            sortOrder,
          })),
        },
      },
      select: { id: true, vehicleId: true, invoiceNumber: true },
    })
    await syncNotifications(
      tx,
      { organizationId, userId, serviceRecordId: record.id },
      data.notifications
    )
    if (from) await tx.appointment.delete({ where: { id: from.id } })
    return record
  })
  const job = await booking.catch(theOneBooked(organizationId, token))
  if ('kind' in job) return job
  // Booked all the same when everything is taken then: the office may
  // fill an hour the booking page would refuse. The dialog says so.
  return {
    kind: 'workOrder' as const,
    id: job.id,
    ref: job.invoiceNumber || job.id,
    vehicleId: job.vehicleId,
    overbooked: full,
    repeated: false,
  }
}

export async function updateBookingService(ctx: ServiceCtx, input: SaveBookingInput) {
  const { organizationId, userId } = ctx
  const data = saveBookingSchema.parse(input)
  if (!data.id) throw new Error('Nothing to change')
  if (data.fromAppointmentId) throw new Error('An appointment becomes a work order when booked')
  if (data.notifications.some((n) => isCustomerChannel(n.channel))) demoGuard()

  const timeZone = await workshopTimeZone(organizationId)
  const start = wallClock(data.startDate, data.startTime, timeZone)
  const end = wallClock(data.endDate, data.endTime, timeZone)
  const description = cleanDescription(data.description)

  if (data.kind === 'appointment') {
    const existing = await db.appointment.findFirst({
      where: { id: data.id, organizationId },
      select: { id: true },
    })
    if (!existing) throw new Error('Appointment not found')
    const { vehicle, customer } = await bookingParties(organizationId, data)
    const saved = await db.$transaction(async (tx) => {
      const appointment = await tx.appointment.update({
        where: { id: existing.id },
        data: {
          title: data.title,
          description,
          startAt: start,
          endAt: end,
          vehicleId: vehicle?.id ?? null,
          customerId: vehicle?.customerId ?? customer?.id ?? null,
        },
        select: { id: true, title: true, vehicleId: true },
      })
      await syncNotifications(
        tx,
        { organizationId, userId, appointmentId: appointment.id },
        data.notifications
      )
      return appointment
    })
    return {
      kind: 'appointment' as const,
      id: saved.id,
      ref: saved.title,
      vehicleId: saved.vehicleId,
      overbooked: false,
    }
  }

  const job = await db.serviceRecord.findFirst({
    where: { id: data.id, organizationId },
    select: {
      id: true,
      status: true,
      invoiceNumber: true,
      vehicleId: true,
      customerId: true,
      startDateTime: true,
      endDateTime: true,
      technicianId: true,
      workBayId: true,
      concerns: {
        orderBy: { sortOrder: 'asc' },
        select: {
          description: true,
          cause: true,
          correction: true,
          confirmation: true,
          confirmedAt: true,
          _count: { select: { findings: true, attachments: true } },
        },
      },
    },
  })
  if (!job) throw new Error('Work order not found')
  if (job.status !== 'scheduled') {
    throw new Error('The job has started. Change it on the work order.')
  }

  // Who: only a car added to a booking that had none, and only the
  // customer's own.
  let who: { vehicleId: string; customerId: null } | null = null
  if ((data.vehicleId ?? null) !== job.vehicleId) {
    if (job.vehicleId || !data.vehicleId) {
      throw new Error('Change the car on the work order')
    }
    const { vehicle } = await bookingParties(organizationId, { vehicleId: data.vehicleId })
    if (!vehicle) throw new Error('Vehicle not found')
    if (job.customerId && vehicle.customerId !== job.customerId) {
      throw new Error('That car belongs to another customer')
    }
    // A job on a car finds its customer through the car.
    who = { vehicleId: vehicle.id, customerId: null }
  } else if (!job.vehicleId && (data.customerId ?? null) !== job.customerId) {
    throw new Error('Change the customer on the work order')
  }

  const recorded = job.concerns.some(
    (c) =>
      c.cause ||
      c.correction ||
      c.confirmation ||
      c.confirmedAt ||
      c._count.findings > 0 ||
      c._count.attachments > 0
  )
  // The conditions are the one copy of what the job is about. The dialog
  // offers a description an older job still carries as work lines
  // (`getBooking`), so what is saved here is all of it and the
  // description goes. A tab opened before this still sends one, and it is
  // folded in the same way. Once work is recorded the conditions are the
  // job's history: nothing is folded in and the description stays.
  const lines = bookingConcerns(data.work, recorded ? null : description, data.title)
  const workChanged = lines.join('\n') !== job.concerns.map((c) => c.description).join('\n')
  if (workChanged && recorded) {
    throw new Error('Work is recorded on these concerns. Change them on the work order.')
  }

  const moved =
    start.getTime() !== job.startDateTime?.getTime() || end.getTime() !== job.endDateTime?.getTime()
  let holds: { workBayId?: string; technicianId?: string } = {}
  let full = false
  if (moved) {
    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000)
    const found = await resourceFor(organizationId, start, minutes, {
      jobId: job.id,
      current: { workBayId: job.workBayId, technicianId: job.technicianId },
    })
    full = found.full
    if (found.resource?.workBayId) holds = { workBayId: found.resource.workBayId }
    else if (found.resource?.technicianId) holds = { technicianId: found.resource.technicianId }
  }

  const saved = await db.$transaction(async (tx) => {
    const record = await tx.serviceRecord.update({
      where: { id: job.id },
      data: {
        title: data.title,
        ...(recorded ? {} : { description: null }),
        startDateTime: start,
        endDateTime: end,
        ...(who ?? {}),
        ...holds,
      },
      select: { id: true, vehicleId: true, invoiceNumber: true },
    })
    if (workChanged) {
      await tx.serviceConcern.deleteMany({ where: { serviceRecordId: job.id } })
      await tx.serviceConcern.createMany({
        data: lines.map((text, sortOrder) => ({
          serviceRecordId: job.id,
          description: text,
          sortOrder,
        })),
      })
    }
    await syncNotifications(
      tx,
      { organizationId, userId, serviceRecordId: job.id },
      data.notifications
    )
    return record
  })
  return {
    kind: 'workOrder' as const,
    id: saved.id,
    ref: saved.invoiceNumber || saved.id,
    vehicleId: saved.vehicleId,
    overbooked: full,
  }
}

export async function deleteAppointmentService(ctx: ServiceCtx, id: string) {
  const { organizationId, userId } = ctx
  const appointmentId = z.string().min(1).parse(id)
  const appointment = await db.appointment.findFirst({
    where: { id: appointmentId, organizationId },
    select: { id: true, title: true },
  })
  if (!appointment) throw new Error('Appointment not found')
  await db.appointment.delete({ where: { id: appointment.id } })
  // fork: the tombstone an API client syncing appointments learns the delete from.
  await db.deletedRecord.create({
    data: {
      organizationId,
      entityType: 'appointment',
      entityId: appointment.id,
      actorUserId: userId,
    },
  })
  return appointment
}

export async function bookAppointmentService(ctx: ServiceCtx, input: BookAppointmentInput) {
  const { organizationId, userId } = ctx
  const data = bookAppointmentSchema.parse(input)

  // Ids from the browser can belong to another workshop.
  const vehicle = data.vehicleId
    ? await db.vehicle.findFirst({
        where: { id: data.vehicleId, organizationId },
        select: { id: true, customer: { select: { taxExempt: true } } },
      })
    : null
  if (data.vehicleId && !vehicle) throw new Error('Vehicle not found')

  // A job on a car finds its customer through the car, so a customer is
  // only looked up for a booking that has no car yet.
  const customer =
    !vehicle && data.customerId
      ? await db.customer.findFirst({
          where: { id: data.customerId, organizationId },
          select: { id: true, taxExempt: true },
        })
      : null
  if (!vehicle && !customer) throw new Error('Customer not found')

  const timeZone = await workshopTimeZone(organizationId)
  const [year, month, day] = data.date.split('-').map(Number)
  const [hour, minute] = data.time.split(':').map(Number)
  const start = zonedDate(year, month, day, hour, minute, timeZone)
  const end = new Date(start.getTime() + data.durationMinutes * 60_000)
  const concerns = appointmentConcerns(data.work)
  const { resource, full } = await resourceFor(organizationId, start, data.durationMinutes)

  const record = await db.$transaction(async (tx) => {
    const created = await createDraftRecord(
      { organizationId, userId },
      {
        vehicleId: vehicle?.id ?? null,
        customerId: vehicle ? null : (customer?.id ?? null),
        customerExempt: vehicle
          ? (vehicle.customer?.taxExempt ?? false)
          : (customer?.taxExempt ?? false),
        title: appointmentTitle(data.work),
        startDateTime: start,
        endDateTime: end,
        technicianId: resource?.technicianId ?? undefined,
        workBayId: resource?.workBayId ?? undefined,
        // Work on a car even before the car is on file.
        shopWork: true,
        tx,
      }
    )
    return tx.serviceRecord.update({
      where: { id: created.id },
      data: {
        status: 'scheduled',
        description: data.work,
        concerns: {
          create: concerns.map((description, sortOrder) => ({ description, sortOrder })),
        },
      },
      select: { id: true, vehicleId: true, invoiceNumber: true },
    })
  })
  // Booked all the same: the office may fill an hour the booking page
  // would refuse. The dialog says so, and the board shows the clash.
  return { ...record, overbooked: full }
}
