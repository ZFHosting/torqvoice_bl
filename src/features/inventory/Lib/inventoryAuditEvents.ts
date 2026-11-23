/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import type { AuditEvent } from '@/lib/audit'
import type {
  createInventoryPartService,
  updateInventoryPartService,
  deleteInventoryPartService,
  deleteInventoryPartsService,
} from './inventoryService.server'

export function createInventoryPartEvent(
  result: Awaited<ReturnType<typeof createInventoryPartService>>
): AuditEvent {
  return {
    action: 'inventory.create',
    entity: 'InventoryPart',
    entityId: result.id,
    details: { key: 'inventory_create', params: { name: result.name } },
    metadata: { partId: result.id },
  }
}

export function updateInventoryPartEvent(
  result: Awaited<ReturnType<typeof updateInventoryPartService>>
): AuditEvent {
  return {
    action: 'inventory.update',
    entity: 'InventoryPart',
    entityId: result.partId,
    details: { key: 'inventory_update', params: { id: result.partId } },
    metadata: { partId: result.partId },
  }
}

export function deleteInventoryPartEvent(
  result: Awaited<ReturnType<typeof deleteInventoryPartService>>
): AuditEvent {
  return {
    action: 'inventory.delete',
    entity: 'InventoryPart',
    entityId: result.partId,
    details: { key: 'inventory_delete', params: { id: result.partId } },
    metadata: { partId: result.partId },
  }
}

/** `partIds` as the caller asked for them, as the action's audit always named them. */
export function deleteInventoryPartsEvent(
  result: Awaited<ReturnType<typeof deleteInventoryPartsService>>,
  partIds: string[]
): AuditEvent {
  return {
    action: 'inventory.bulkDelete',
    entity: 'InventoryPart',
    entityId: partIds.join(','),
    details: { key: 'inventory_bulkDelete', params: { count: result.deleted } },
    metadata: { partIds, deleted: result.deleted },
  }
}
