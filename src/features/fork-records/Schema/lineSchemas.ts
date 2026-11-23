/**
 * fork: what the public API takes to add or change one line on a work order (docs/fork/API.md §4,
 * `/work-orders/{id}/lines`), with the fork's columns the app's form doesn't have.
 */
import { z } from 'zod'

export const LABOR_KINDS = ['labor', 'fee', 'epa', 'shopSupplies'] as const
export const PART_KINDS = ['part', 'tire', 'subcontract'] as const

const money = z.number().min(0).max(100_000_000)
const forkColumns = {
  jobId: z.string().min(1).nullable().optional(),
  discountAmount: money.nullable().optional(),
}

const laborFields = {
  kind: z.enum(LABOR_KINDS),
  description: z.string().trim().min(1).max(500),
  hours: z.number().min(0).max(10_000),
  rate: money,
  pricingType: z.enum(['hourly', 'service', 'shopFee']).optional(),
  taxable: z.boolean().optional(),
  technicianId: z.string().min(1).nullable().optional(),
  completed: z.boolean().nullable().optional(),
  costHours: z.number().min(0).max(10_000).nullable().optional(),
  costRate: money.nullable().optional(),
  ...forkColumns,
}

const partFields = {
  kind: z.enum(PART_KINDS),
  description: z.string().trim().min(1).max(500).describe('The part’s name'),
  partNumber: z.string().trim().max(100).nullable().optional(),
  quantity: z.number().positive().max(100_000),
  unit: z.string().trim().max(20).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  unitPrice: money,
  unitCost: money.optional(),
  inventoryPartId: z.string().min(1).nullable().optional(),
  taxable: z.boolean().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  ...forkColumns,
}

export const laborLineSchema = z.object(laborFields).strict()
export const partLineSchema = z.object(partFields).strict()
export type LaborInput = z.infer<typeof laborLineSchema>
export type PartInput = z.infer<typeof partLineSchema>

export const createLineSchema = z.discriminatedUnion('kind', [laborLineSchema, partLineSchema])

export const isLabor = (line: LaborInput | PartInput): line is LaborInput =>
  (LABOR_KINDS as readonly string[]).includes(line.kind)

/** A change: any of the line's fields but its kind and its inventory link. */
export const updateLineSchema = z
  .object({
    description: laborFields.description.optional(),
    hours: laborFields.hours.optional(),
    rate: laborFields.rate.optional(),
    pricingType: laborFields.pricingType,
    taxable: z.boolean().optional(),
    technicianId: laborFields.technicianId,
    completed: laborFields.completed,
    costHours: laborFields.costHours,
    costRate: laborFields.costRate,
    partNumber: partFields.partNumber,
    quantity: partFields.quantity.optional(),
    unit: partFields.unit,
    category: partFields.category,
    unitPrice: partFields.unitPrice.optional(),
    unitCost: partFields.unitCost,
    note: partFields.note,
    ...forkColumns,
  })
  .strict()
