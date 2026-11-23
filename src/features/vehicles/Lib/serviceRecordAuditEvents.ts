/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import type { AuditEvent } from '@/lib/audit'
import type {
  createServiceRecordService,
  updateServiceRecordService,
  updateServiceStatusService,
  updateInternalNotesService,
  updateServiceRecordTitleService,
  deleteServiceRecordService,
} from './serviceRecordService.server'

export function createServiceRecordEvent(
  result: Awaited<ReturnType<typeof createServiceRecordService>>
): AuditEvent {
  return {
    action: 'service.create',
    entity: 'ServiceRecord',
    entityId: result.id,
    details: { key: 'service_create', params: { ref: result.invoiceNumber || result.id } },
    metadata: { serviceRecordId: result.id, vehicleId: result.vehicleId },
  }
}

export function updateServiceRecordEvent(
  result: Awaited<ReturnType<typeof updateServiceRecordService>>
): AuditEvent {
  return {
    action: 'service.update',
    entity: 'ServiceRecord',
    entityId: result.id,
    details: { key: 'service_update', params: { ref: result.invoiceNumber || result.id } },
    metadata: { serviceRecordId: result.id },
  }
}

export function updateServiceStatusEvent(
  result: Awaited<ReturnType<typeof updateServiceStatusService>>
): AuditEvent {
  return {
    action: 'service.status',
    entity: 'ServiceRecord',
    entityId: result.recordId,
    // ICU select selectors cannot contain a hyphen, and the stored
    // statuses do: in-progress, waiting-parts.
    details: {
      key: 'service_status',
      params: { status: result.status.replaceAll('-', '_') },
    },
    metadata: {
      serviceRecordId: result.recordId,
      status: result.status,
      ...(result.customStatus ? { customStatus: result.customStatus } : {}),
    },
  }
}

export function updateInternalNotesEvent(
  result: Awaited<ReturnType<typeof updateInternalNotesService>>
): AuditEvent {
  return {
    action: 'service.update',
    entity: 'ServiceRecord',
    entityId: result.id,
    details: { key: 'service_update', params: { ref: result.invoiceNumber || result.id } },
    metadata: { serviceRecordId: result.id, field: 'diagnosticNotes' },
  }
}

export function updateServiceRecordTitleEvent(
  result: Awaited<ReturnType<typeof updateServiceRecordTitleService>>
): AuditEvent {
  return {
    action: 'service.update',
    entity: 'ServiceRecord',
    entityId: result.id,
    details: { key: 'service_update', params: { ref: result.invoiceNumber || result.id } },
    metadata: { serviceRecordId: result.id, field: 'title' },
  }
}

export function deleteServiceRecordEvent(
  result: Awaited<ReturnType<typeof deleteServiceRecordService>>
): AuditEvent {
  return {
    action: 'service.delete',
    entity: 'ServiceRecord',
    entityId: result.recordId,
    details: { key: 'service_delete', params: { ref: result.recordId } },
    metadata: { serviceRecordId: result.recordId },
  }
}
