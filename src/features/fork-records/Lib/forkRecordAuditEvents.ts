/**
 * fork: the audit events of the fork's own records (docs/fork/API.md §5 names them). A5 adds them to the webhook
 * events; until then they're recorded in the audit log and send nothing.
 */
import type { AuditEvent } from '@/lib/audit'

export function contactEvent(
  action: 'create' | 'update' | 'delete',
  contact: { id: string; customerId: string }
): AuditEvent {
  return {
    action: `contact.${action}`,
    entity: 'CustomerContact',
    entityId: contact.id,
    metadata: { customerId: contact.customerId },
  }
}

export function jobEvent(
  action: 'create' | 'update' | 'delete',
  job: { id: string; serviceRecordId: string }
): AuditEvent {
  return {
    action: `job.${action}`,
    entity: 'WorkJob',
    entityId: job.id,
    metadata: { workOrderId: job.serviceRecordId },
  }
}

export function shiftEvent(
  action: 'create' | 'update' | 'delete',
  shift: { id: string; technicianId: string }
): AuditEvent {
  return {
    action: `shift.${action}`,
    entity: 'TechnicianShift',
    entityId: shift.id,
    metadata: { technicianId: shift.technicianId },
  }
}

/** The action names, for the audit log's labels and the test that every emitted action has one. */
export const FORK_RECORD_ACTIONS = [
  'contact.create',
  'contact.update',
  'contact.delete',
  'job.create',
  'job.update',
  'job.delete',
  'shift.create',
  'shift.update',
  'shift.delete',
] as const
