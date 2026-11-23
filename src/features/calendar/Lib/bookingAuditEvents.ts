/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import type { AuditEvent } from '@/lib/audit'
import type {
  createBookingOnceService,
  deleteAppointmentService,
  updateBookingService,
} from './bookingService.server'
import type { bookAppointmentService } from './bookingService.server'

export function deleteAppointmentEvent(
  result: Awaited<ReturnType<typeof deleteAppointmentService>>
): AuditEvent {
  return {
    action: 'appointment.delete',
    entity: 'Appointment',
    entityId: result.id,
    details: { key: 'appointment_delete', params: { title: result.title } },
  }
}

export function bookAppointmentEvent(
  result: Awaited<ReturnType<typeof bookAppointmentService>>
): AuditEvent {
  return {
    action: 'service.create',
    entity: 'ServiceRecord',
    entityId: result.id,
    details: {
      key: 'service_bookAppointment',
      params: { ref: result.invoiceNumber || result.id },
    },
    metadata: { serviceRecordId: result.id, vehicleId: result.vehicleId },
  }
}

/** Written down when it was booked, not again each time it is found. */
export function createBookingOnceEvent(
  result: Awaited<ReturnType<typeof createBookingOnceService>>
): AuditEvent | null {
  return result.repeated
    ? null
    : result.kind === 'appointment'
      ? {
          action: 'appointment.create',
          entity: 'Appointment',
          entityId: result.id,
          details: { key: 'appointment_create', params: { title: result.ref } },
        }
      : {
          action: 'service.create',
          entity: 'ServiceRecord',
          entityId: result.id,
          details: { key: 'service_bookAppointment', params: { ref: result.ref } },
          metadata: { serviceRecordId: result.id, vehicleId: result.vehicleId },
        }
}

export function updateBookingEvent(
  result: Awaited<ReturnType<typeof updateBookingService>>
): AuditEvent {
  return result.kind === 'appointment'
    ? {
        action: 'appointment.update',
        entity: 'Appointment',
        entityId: result.id,
        details: { key: 'appointment_update', params: { title: result.ref } },
      }
    : {
        action: 'service.update',
        entity: 'ServiceRecord',
        entityId: result.id,
        details: { key: 'service_editAppointment', params: { ref: result.ref } },
        metadata: { serviceRecordId: result.id, vehicleId: result.vehicleId },
      }
}
