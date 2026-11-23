/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import { findingWebhookFields } from '@/features/fault-codes/Lib/findings'
import type { AuditEvent } from '@/lib/audit'
import type {
  createFindingService,
  updateFindingService,
  resolveFindingService,
  deleteFindingService,
} from './findingService.server'

export function createFindingEvent(
  result: Awaited<ReturnType<typeof createFindingService>>
): AuditEvent {
  return {
    action: 'finding.create',
    entity: 'VehicleFinding',
    entityId: result.id,
    details: {
      key: 'finding_create',
      params: { description: result.description, vehicleId: result.vehicleId },
    },
    metadata: {
      findingId: result.id,
      vehicleId: result.vehicleId,
      ...findingWebhookFields(result),
    },
  }
}

export function updateFindingEvent(
  result: Awaited<ReturnType<typeof updateFindingService>>
): AuditEvent {
  return {
    action: 'finding.update',
    entity: 'VehicleFinding',
    entityId: result.id,
    details: { key: 'finding_update', params: { description: result.description } },
    metadata: {
      findingId: result.id,
      vehicleId: result.vehicleId,
      ...findingWebhookFields(result),
    },
  }
}

export function resolveFindingEvent(
  result: Awaited<ReturnType<typeof resolveFindingService>>
): AuditEvent {
  return {
    action: 'finding.resolve',
    entity: 'VehicleFinding',
    entityId: result.id,
    details: { key: 'finding_resolve', params: { description: result.description } },
    metadata: {
      findingId: result.id,
      vehicleId: result.vehicleId,
      ...findingWebhookFields(result),
    },
  }
}

export function deleteFindingEvent(
  result: Awaited<ReturnType<typeof deleteFindingService>>
): AuditEvent {
  return {
    action: 'finding.delete',
    entity: 'VehicleFinding',
    entityId: result.findingId,
    details: { key: 'finding_delete', params: { id: result.findingId } },
    metadata: { findingId: result.findingId },
  }
}
