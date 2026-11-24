/**
 * fork: the audit events of the fork's own records (docs/fork/API.md §5 names them), recorded in the audit log and sent
 * as webhook events (A5).
 */
import { type AuditEvent, auditDetails } from '@/lib/audit'

type Change = 'create' | 'update' | 'delete'

/**
 * Each action written out as `action: '…'`, the shape the audit label test (`i18n/audit-actions.test.ts`) finds, so
 * every one of them is checked to have a label in every locale.
 */
const ACTIONS = {
  contact: {
    create: { action: 'contact.create', details: auditDetails('contact_create') },
    update: { action: 'contact.update', details: auditDetails('contact_update') },
    delete: { action: 'contact.delete', details: auditDetails('contact_delete') },
  },
  job: {
    create: { action: 'job.create', details: auditDetails('job_create') },
    update: { action: 'job.update', details: auditDetails('job_update') },
    delete: { action: 'job.delete', details: auditDetails('job_delete') },
  },
  shift: {
    create: { action: 'shift.create', details: auditDetails('shift_create') },
    update: { action: 'shift.update', details: auditDetails('shift_update') },
    delete: { action: 'shift.delete', details: auditDetails('shift_delete') },
  },
} as const

export function contactEvent(
  change: Change,
  contact: { id: string; customerId: string }
): AuditEvent {
  return {
    ...ACTIONS.contact[change],
    entity: 'CustomerContact',
    entityId: contact.id,
    metadata: { customerId: contact.customerId },
  }
}

export function jobEvent(
  change: Change,
  job: { id: string; serviceRecordId: string | null; quoteId?: string | null }
): AuditEvent {
  return {
    ...ACTIONS.job[change],
    entity: 'WorkJob',
    entityId: job.id,
    // A5: what finds the job (it has no endpoint of its own), in its webhook event's data.
    metadata: {
      workOrderId: job.serviceRecordId,
      ...(job.quoteId ? { quoteId: job.quoteId } : {}),
    },
  }
}

export function shiftEvent(
  change: Change,
  shift: { id: string; technicianId: string }
): AuditEvent {
  return {
    ...ACTIONS.shift[change],
    entity: 'TechnicianShift',
    entityId: shift.id,
    metadata: { technicianId: shift.technicianId },
  }
}

/**
 * A clock started (the API's `POST /time-entries/start`, and since A5 the app's and the technician app's clocks,
 * `clockEvents.server.ts`): API.md §5's `time_entry.start`.
 */
export function timeEntryStartEvent(started: {
  id: string
  technicianId: string
  serviceRecordId: string
  closedEntryId: string | null
}): AuditEvent {
  return {
    action: 'time_entry.start',
    details: auditDetails('time_entry_start'),
    entity: 'timeEntry',
    entityId: started.id,
    metadata: {
      technicianId: started.technicianId,
      workOrderId: started.serviceRecordId,
      closedEntryId: started.closedEntryId,
    },
  }
}
