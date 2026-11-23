/**
 * @vitest-environment node
 *
 * fork: the booking service does what the calendar actions did (A2), with the same audit events,
 * plus a tombstone when an appointment is deleted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  appointment: { findFirst: vi.fn(), delete: vi.fn() },
  deletedRecord: { create: vi.fn() },
}))
vi.mock('@/lib/db', () => ({ db }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const service = await import('@/features/calendar/Lib/bookingService.server')
const events = await import('@/features/calendar/Lib/bookingAuditEvents')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }

beforeEach(() => vi.clearAllMocks())

describe('deleting an appointment', () => {
  it('removes this workshop’s appointment, then leaves a tombstone', async () => {
    db.appointment.findFirst.mockResolvedValue({ id: 'ap-1', title: 'MOT' })
    expect(await service.deleteAppointmentService(ctx, 'ap-1')).toEqual({
      id: 'ap-1',
      title: 'MOT',
    })
    expect(db.appointment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ap-1', organizationId: 'org-a' } })
    )
    expect(db.deletedRecord.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-a',
        entityType: 'appointment',
        entityId: 'ap-1',
        actorUserId: 'user-1',
      },
    })
  })

  it('touches nothing for another workshop’s', async () => {
    db.appointment.findFirst.mockResolvedValue(null)
    await expect(service.deleteAppointmentService(ctx, 'theirs')).rejects.toThrow(
      'Appointment not found'
    )
    expect(db.appointment.delete).not.toHaveBeenCalled()
    expect(db.deletedRecord.create).not.toHaveBeenCalled()
  })
})

describe('the audit events', () => {
  const booked = { id: 'x-1', ref: 'MOT', vehicleId: 'v-1', overbooked: false }

  it('log a booking once, as an appointment or a job, as the action always did', () => {
    expect(
      events.createBookingOnceEvent({ ...booked, kind: 'appointment', repeated: false } as never)
    ).toEqual({
      action: 'appointment.create',
      entity: 'Appointment',
      entityId: 'x-1',
      details: { key: 'appointment_create', params: { title: 'MOT' } },
    })
    expect(
      events.createBookingOnceEvent({ ...booked, kind: 'workOrder', repeated: false } as never)
    ).toMatchObject({
      action: 'service.create',
      metadata: { serviceRecordId: 'x-1', vehicleId: 'v-1' },
    })
    expect(
      events.createBookingOnceEvent({ ...booked, kind: 'appointment', repeated: true } as never)
    ).toBeNull()
    expect(events.updateBookingEvent({ ...booked, kind: 'appointment' } as never).action).toBe(
      'appointment.update'
    )
  })
})
