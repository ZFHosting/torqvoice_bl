/**
 * Inventory part and labor preset writes (docs/fork/API.md §4), through the services the inventory and labor preset
 * pages run (A2), with their own audit events. `POST /inventory-parts/{id}/adjust` is the stock scan's adjustment:
 * it moves the count by `delta` and writes the line in the part's stock history (reason `manual_adjustment`). Like the
 * scan, it records no audit event and so sends no webhook.
 */
import 'server-only'
import {
  createInventoryPartEvent,
  deleteInventoryPartEvent,
  updateInventoryPartEvent,
} from '@/features/inventory/Lib/inventoryAuditEvents'
import {
  adjustInventoryStockService,
  createInventoryPartService,
  deleteInventoryPartService,
  updateInventoryPartService,
} from '@/features/inventory/Lib/inventoryService.server'
import {
  createLaborPresetEvent,
  deleteLaborPresetEvent,
  updateLaborPresetEvent,
} from '@/features/labor-presets/Lib/laborPresetAuditEvents'
import {
  createLaborPresetService,
  deleteLaborPresetService,
  updateLaborPresetService,
} from '@/features/labor-presets/Lib/laborPresetService.server'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { writeRoute } from '../Lib/writeRoute'
import { inventoryPartsResource, laborPresetsResource } from '../Resources/catalog'
import { adjustStockSchema } from '../Schema/catalog'
import { answerWith, deleted, withId } from './common'

/* ---------- inventory parts ---------- */

const inventory = PermissionSubject.INVENTORY

const currentPart = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.inventoryPart.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createInventoryPartPOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject: inventory },
  run: (svc, body) => createInventoryPartService(svc, body),
  audit: (result) => createInventoryPartEvent(result),
  respond: async (result, ctx) =>
    answerWith(inventoryPartsResource, ctx.organizationId, result.id, 201),
})

export const updateInventoryPartPATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject: inventory },
  current: currentPart,
  run: (svc, body, { id }) => updateInventoryPartService(svc, withId(body, id)),
  audit: (result) => updateInventoryPartEvent(result),
  respond: async (_result, ctx, { id }) =>
    answerWith(inventoryPartsResource, ctx.organizationId, id),
})

export const deleteInventoryPartDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.DELETE, subject: inventory },
  current: currentPart,
  run: (svc, _body, { id }) => deleteInventoryPartService(svc, id),
  audit: (result) => deleteInventoryPartEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})

export const adjustInventoryStockPOST = writeRoute('POST', {
  permission: { action: PermissionAction.UPDATE, subject: inventory },
  current: currentPart,
  run: (svc, body, { id }: { id: string }) => {
    const { delta, note } = adjustStockSchema.parse(body)
    return adjustInventoryStockService(svc, { id, adjustment: delta, note })
  },
  respond: async (_result, ctx, { id }) =>
    answerWith(inventoryPartsResource, ctx.organizationId, id),
})

/* ---------- labor presets ---------- */

const presets = PermissionSubject.LABOR_PRESETS

const currentPreset = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.laborPreset.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createLaborPresetPOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject: presets },
  run: (svc, body) => createLaborPresetService(svc, body),
  audit: (result) => createLaborPresetEvent(result),
  respond: async (result, ctx) =>
    answerWith(laborPresetsResource, ctx.organizationId, result.id, 201),
})

export const updateLaborPresetPATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject: presets },
  current: currentPreset,
  run: (svc, body, { id }) => updateLaborPresetService(svc, withId(body, id)),
  audit: (result) => updateLaborPresetEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(laborPresetsResource, ctx.organizationId, id),
})

export const deleteLaborPresetDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.DELETE, subject: presets },
  current: currentPreset,
  run: (svc, _body, { id }) => deleteLaborPresetService(svc, id),
  audit: (result) => deleteLaborPresetEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})
