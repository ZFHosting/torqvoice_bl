/**
 * fork: the audit events of the fork's own records (docs/fork/API.md §5 names them). A5 adds them to the webhook
 * events; until then they're recorded in the audit log and send nothing.
 */
import type { AuditEvent } from '@/lib/audit'

type Change = 'create' | 'update' | 'delete'

/**
 * Each action written out as `action: '…'`, the shape the audit label test (`i18n/audit-actions.test.ts`) finds, so
 * every one of them is checked to have a label in every locale.
 */
const ACTIONS = {
  contact: {
    create: { action: 'contact.create' },
    update: { action: 'contact.update' },
    delete: { action: 'contact.delete' },
  },
  job: {
    create: { action: 'job.create' },
    update: { action: 'job.update' },
    delete: { action: 'job.delete' },
  },
  shift: {
    create: { action: 'shift.create' },
    update: { action: 'shift.update' },
    delete: { action: 'shift.delete' },
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
  job: { id: string; serviceRecordId: string | null }
): AuditEvent {
  return {
    ...ACTIONS.job[change],
    entity: 'WorkJob',
    entityId: job.id,
    metadata: { workOrderId: job.serviceRecordId },
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
 * A clock started through the API (`POST /time-entries/start`). The technician app's own start logs nothing; the
 * name is API.md §5's, which A5 turns into a webhook event.
 */
export function timeEntryStartEvent(started: {
  id: string
  technicianId: string
  serviceRecordId: string
  closedEntryId: string | null
}): AuditEvent {
  return {
    action: 'time_entry.start',
    entity: 'timeEntry',
    entityId: started.id,
    metadata: {
      technicianId: started.technicianId,
      workOrderId: started.serviceRecordId,
      closedEntryId: started.closedEntryId,
    },
  }
}
