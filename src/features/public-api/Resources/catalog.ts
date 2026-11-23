/** `/api/v1/labor-presets` and `/api/v1/inventory-parts`: how they read (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import type { ReadResource } from '../Lib/readResource'
import {
  type InventoryPartOut,
  inventoryPartsSpec,
  type LaborPresetOut,
  laborPresetsSpec,
} from '../Schema/catalog'
import {
  INVENTORY_SELECT,
  type InventoryRow,
  PRESET_SELECT,
  type PresetRow,
  serializeInventoryPart,
  serializePreset,
} from '../Serializers/catalog'

export const laborPresetsResource: ReadResource<PresetRow, LaborPresetOut> = {
  ...laborPresetsSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.LABOR_PRESETS },
  scope: (organizationId) => ({ organizationId }),
  select: () => PRESET_SELECT,
  findMany: (args) => db.laborPreset.findMany(args as never) as unknown as Promise<PresetRow[]>,
  findFirst: (args) =>
    db.laborPreset.findFirst(args as never) as unknown as Promise<PresetRow | null>,
  serialize: (row, ctx) => serializePreset(row, ctx),
}

export const inventoryPartsResource: ReadResource<InventoryRow, InventoryPartOut> = {
  ...inventoryPartsSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.INVENTORY },
  scope: (organizationId) => ({ organizationId }),
  where: ({ q, category }) => ({
    ...(typeof category === 'string' ? { category } : {}),
    ...(typeof q === 'string'
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { partNumber: { contains: q, mode: 'insensitive' } },
            { barcode: { equals: q } },
          ],
        }
      : {}),
  }),
  select: () => INVENTORY_SELECT,
  findMany: (args) =>
    db.inventoryPart.findMany(args as never) as unknown as Promise<InventoryRow[]>,
  findFirst: (args) =>
    db.inventoryPart.findFirst(args as never) as unknown as Promise<InventoryRow | null>,
  serialize: (row, ctx) => serializeInventoryPart(row, ctx),
}
