/**
 * `/api/v1/labor-presets` (canned services, with their labor items and parts) and `/api/v1/inventory-parts`
 * (`?q=` over name, part number and barcode, `?category=`) (docs/fork/API.md §4).
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'

export const laborPresetItemSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    hours: z.number(),
    rate: z.number(),
    pricingType: z.string().describe('hourly, service or shopFee'),
    sortOrder: z.number().int(),
  })
  .meta({ id: 'LaborPresetItem' })

export const laborPresetPartSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    partNumber: z.string().nullable(),
    quantity: z.number(),
    unit: z.string().nullable(),
    category: z.string().nullable(),
    unitPrice: z.number(),
    inventoryPartId: z.string().nullable(),
    sortOrder: z.number().int(),
  })
  .meta({ id: 'LaborPresetPart' })

export const laborPresetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isArchived: z.boolean(),
    currency: z.string(),
    items: z.array(laborPresetItemSchema),
    parts: z.array(laborPresetPartSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'LaborPreset' })

export const inventoryPartSchema = z
  .object({
    id: z.string(),
    partNumber: z.string().nullable(),
    barcode: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    quantity: z.number(),
    minQuantity: z.number(),
    trackStock: z.boolean(),
    unit: z.string().nullable(),
    unitCost: z.number(),
    sellPrice: z.number(),
    currency: z.string(),
    supplier: z.string().nullable(),
    location: z.string().nullable(),
    tags: z.array(z.string()),
    isArchived: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'InventoryPart' })

export type LaborPresetOut = z.infer<typeof laborPresetSchema>
export type InventoryPartOut = z.infer<typeof inventoryPartSchema>

export const laborPresetsSpec: ReadSpec<LaborPresetOut> = {
  path: '/labor-presets',
  tag: 'Labor presets',
  noun: { one: 'labor preset', many: 'labor presets' },
  response: laborPresetSchema,
}

export const inventoryPartsSpec: ReadSpec<InventoryPartOut> = {
  path: '/inventory-parts',
  tag: 'Inventory',
  noun: { one: 'inventory part', many: 'inventory parts' },
  filters: z.object({
    q: z.string().trim().min(1).max(100).optional().describe('Name, part number or barcode'),
    category: z.string().trim().min(1).max(100).optional(),
  }),
  response: inventoryPartSchema,
}

export const catalogEndpoints: EndpointSpec[] = [
  ...readEndpoints(laborPresetsSpec),
  ...readEndpoints(inventoryPartsSpec),
]
