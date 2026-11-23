/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import type { AuditEvent } from '@/lib/audit'
import type {
  createTechnicianService,
  updateTechnicianService,
  deleteTechnicianService,
} from './technicianService.server'

export function createTechnicianEvent(
  result: Awaited<ReturnType<typeof createTechnicianService>>
): AuditEvent {
  return {
    action: 'technician.create',
    entity: 'Technician',
    entityId: result.id,
    details: { key: 'technician_create', params: { name: result.name } },
    metadata: { technicianId: result.id, technicianName: result.name },
  }
}

export function updateTechnicianEvent(
  result: Awaited<ReturnType<typeof updateTechnicianService>>
): AuditEvent {
  return {
    action: 'technician.update',
    entity: 'Technician',
    entityId: result.technicianId,
    details: { key: 'technician_update', params: { id: result.technicianId } },
    metadata: { technicianId: result.technicianId },
  }
}

export function deleteTechnicianEvent(
  result: Awaited<ReturnType<typeof deleteTechnicianService>>
): AuditEvent {
  return {
    action: 'technician.delete',
    entity: 'Technician',
    entityId: result.technicianId,
    details: { key: 'technician_delete', params: { id: result.technicianId } },
    metadata: { technicianId: result.technicianId },
  }
}
