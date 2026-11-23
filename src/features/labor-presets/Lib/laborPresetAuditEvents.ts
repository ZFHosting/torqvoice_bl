/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import type { AuditEvent } from '@/lib/audit'
import type {
  createLaborPresetService,
  updateLaborPresetService,
  deleteLaborPresetService,
} from './laborPresetService.server'

export function createLaborPresetEvent(
  result: Awaited<ReturnType<typeof createLaborPresetService>>
): AuditEvent {
  return {
    action: 'labor_preset.create',
    entity: 'LaborPreset',
    entityId: result.id,
    details: { key: 'labor_preset_create', params: { name: result.name } },
    metadata: { presetId: result.id },
  }
}

export function updateLaborPresetEvent(
  result: Awaited<ReturnType<typeof updateLaborPresetService>>
): AuditEvent {
  return {
    action: 'labor_preset.update',
    entity: 'LaborPreset',
    entityId: result.presetId,
    details: { key: 'labor_preset_update', params: { id: result.presetId } },
    metadata: { presetId: result.presetId },
  }
}

export function deleteLaborPresetEvent(
  result: Awaited<ReturnType<typeof deleteLaborPresetService>>
): AuditEvent {
  return {
    action: 'labor_preset.delete',
    entity: 'LaborPreset',
    entityId: result.presetId,
    details: { key: 'labor_preset_delete', params: { id: result.presetId } },
    metadata: { presetId: result.presetId },
  }
}
