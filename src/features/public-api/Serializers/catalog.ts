/** Labor presets and inventory parts, field by field (docs/fork/API.md §4). */
import { isoAlways, money } from '../Lib/serializeFormat'
import type { SerializeContext } from '../Lib/serializeFormat'
import type { InventoryPartOut, LaborPresetOut } from '../Schema/catalog'

export const PRESET_SELECT = {
  id: true,
  name: true,
  description: true,
  isArchived: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      description: true,
      hours: true,
      rate: true,
      pricingType: true,
      sortOrder: true,
    },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  },
  parts: {
    select: {
      id: true,
      name: true,
      partNumber: true,
      quantity: true,
      unit: true,
      category: true,
      unitPrice: true,
      inventoryPartId: true,
      sortOrder: true,
    },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  },
} as const

export interface PresetRow {
  id: string
  name: string
  description: string | null
  isArchived: boolean
  createdAt: Date
  updatedAt: Date
  items: {
    id: string
    description: string
    hours: number
    rate: number
    pricingType: string
    sortOrder: number
  }[]
  parts: {
    id: string
    name: string
    partNumber: string | null
    quantity: number
    unit: string | null
    category: string | null
    unitPrice: number
    inventoryPartId: string | null
    sortOrder: number
  }[]
}

export function serializePreset(row: PresetRow, ctx: SerializeContext): LaborPresetOut {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isArchived: row.isArchived,
    currency: ctx.currency,
    items: row.items.map((item) => ({
      id: item.id,
      description: item.description,
      hours: item.hours,
      rate: money(item.rate),
      pricingType: item.pricingType,
      sortOrder: item.sortOrder,
    })),
    parts: row.parts.map((part) => ({
      id: part.id,
      name: part.name,
      partNumber: part.partNumber,
      quantity: part.quantity,
      unit: part.unit,
      category: part.category,
      unitPrice: money(part.unitPrice),
      inventoryPartId: part.inventoryPartId,
      sortOrder: part.sortOrder,
    })),
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}

export const INVENTORY_SELECT = {
  id: true,
  partNumber: true,
  barcode: true,
  name: true,
  description: true,
  category: true,
  quantity: true,
  minQuantity: true,
  trackStock: true,
  unit: true,
  unitCost: true,
  sellPrice: true,
  supplier: true,
  location: true,
  tags: true,
  isArchived: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface InventoryRow {
  id: string
  partNumber: string | null
  barcode: string | null
  name: string
  description: string | null
  category: string | null
  quantity: number
  minQuantity: number
  trackStock: boolean
  unit: string | null
  unitCost: number
  sellPrice: number
  supplier: string | null
  location: string | null
  tags: string[]
  isArchived: boolean
  createdAt: Date
  updatedAt: Date
}

export function serializeInventoryPart(row: InventoryRow, ctx: SerializeContext): InventoryPartOut {
  return {
    id: row.id,
    partNumber: row.partNumber,
    barcode: row.barcode,
    name: row.name,
    description: row.description,
    category: row.category,
    quantity: row.quantity,
    minQuantity: row.minQuantity,
    trackStock: row.trackStock,
    unit: row.unit,
    unitCost: money(row.unitCost),
    sellPrice: money(row.sellPrice),
    currency: ctx.currency,
    supplier: row.supplier,
    location: row.location,
    tags: [...row.tags],
    isArchived: row.isArchived,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}
