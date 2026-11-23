/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import { type AuditEvent, auditDetails } from '@/lib/audit'
import type {
  createTimeEntryService,
  updateTimeEntryService,
  stopTimeEntryService,
  deleteTimeEntryService,
} from './timeEntryService.server'

export function createTimeEntryEvent(
  result: Awaited<ReturnType<typeof createTimeEntryService>>
): AuditEvent {
  return {
    action: 'timeEntry.create',
    entity: 'timeEntry',
    entityId: result.id,
    details: auditDetails('timeEntry_create', {
      technician: result.technicianName,
      job: result.job.title,
      minutes: result.durationMinutes ?? 0,
    }),
  }
}

export function updateTimeEntryEvent(
  result: Awaited<ReturnType<typeof updateTimeEntryService>>
): AuditEvent {
  return {
    action: 'timeEntry.update',
    entity: 'timeEntry',
    entityId: result.id,
    details: auditDetails('timeEntry_update', {
      technician: result.technicianName,
      job: result.job.title,
      minutes: result.durationMinutes ?? 0,
    }),
  }
}

export function stopTimeEntryEvent(
  result: Awaited<ReturnType<typeof stopTimeEntryService>>
): AuditEvent {
  return {
    action: 'timeEntry.update',
    entity: 'timeEntry',
    entityId: result.id,
    details: auditDetails('timeEntry_stop', {
      technician: result.technicianName,
      job: result.job.title,
      minutes: result.durationMinutes ?? 0,
    }),
  }
}

export function deleteTimeEntryEvent(
  result: Awaited<ReturnType<typeof deleteTimeEntryService>>
): AuditEvent {
  return {
    action: 'timeEntry.delete',
    entity: 'timeEntry',
    entityId: result.id,
    details: auditDetails('timeEntry_delete', { id: result.id }),
  }
}
