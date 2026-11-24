/**
 * `/api/v1/labor-presets` (canned services, with their labor items and parts) and `/api/v1/inventory-parts`
 * (`?q=` over name, part number and barcode, `?category=`) (docs/fork/API.md §4).
 */
import { z } from 'zod'
import { sourceSchema } from './common'
import {
  createInventoryPartSchema,
  updateInventoryPartSchema,
} from '@/features/inventory/Schema/inventorySchema'
import {
  createLaborPresetSchema,
  updateLaborPresetSchema,
} from '@/features/labor-presets/Schema/laborPresetSchema'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { patchBody, writeEndpoints } from '../Lib/writeSpec'

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
    // fork (A5): with `include=source`
    sourceRecord: sourceSchema.optional(),
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
    // fork (A5): with `include=source`
    sourceRecord: sourceSchema.optional(),
  })
  .meta({ id: 'InventoryPart' })

export type LaborPresetOut = z.infer<typeof laborPresetSchema>
export type InventoryPartOut = z.infer<typeof inventoryPartSchema>

export const laborPresetsSpec: ReadSpec<LaborPresetOut> = {
  path: '/labor-presets',
  tag: 'Labor presets',
  noun: { one: 'labor preset', many: 'labor presets' },
  // fork (A5): `include=source`
  sourceModel: 'LaborPreset',
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
  // fork (A5): `include=source`
  sourceModel: 'InventoryPart',
  response: inventoryPartSchema,
}

/** `POST /inventory-parts/{id}/adjust` (A4). */
export const adjustStockSchema = z
  .object({
    delta: z
      .number()
      .refine((d) => d !== 0, 'A change of nothing')
      .describe('Added to the count (negative takes away)'),
    note: z.string().trim().max(500).optional().describe('Kept on the stock history line'),
  })
  .strict()

export const catalogEndpoints: EndpointSpec[] = [
  ...readEndpoints(laborPresetsSpec),
  ...writeEndpoints({
    ...laborPresetsSpec,
    create: createLaborPresetSchema,
    update: patchBody(updateLaborPresetSchema),
    remove: true,
  }),
  ...readEndpoints(inventoryPartsSpec),
  ...writeEndpoints({
    ...inventoryPartsSpec,
    create: createInventoryPartSchema,
    update: patchBody(updateInventoryPartSchema),
    remove: true,
  }),
  {
    method: 'post',
    path: '/inventory-parts/{id}/adjust',
    summary:
      'Move a part’s stock count, with a line in its stock history (no webhook, as in the app)',
    tag: inventoryPartsSpec.tag,
    body: adjustStockSchema,
    response: inventoryPartSchema,
  },
]
