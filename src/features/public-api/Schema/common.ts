/**
 * Response pieces several resources share (docs/fork/API.md §3–4): custom field values, the date filters of
 * time-ranged lists, and a work order's or quote's jobs and lines (X2, X3).
 */
import { z } from 'zod'
import { LINE_KINDS } from '@/integrations/shopmonkey/schema/sourceExtra'

export const customFieldValueSchema = z
  .object({
    name: z.string().describe('The field’s machine name'),
    label: z.string(),
    value: z.string(),
  })
  .meta({ id: 'CustomFieldValue' })

/** `?from=&to=` on a time-ranged list: ISO instants, `from` inclusive, `to` exclusive. */
export const rangeFilters = {
  from: z.iso.datetime({ offset: true }).optional().describe('From this instant (inclusive)'),
  to: z.iso.datetime({ offset: true }).optional().describe('Up to this instant (exclusive)'),
}

export const jobSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    note: z.string().nullable(),
    ordinal: z.number().int(),
    authorizationStatus: z.string().nullable(),
    recommended: z.boolean(),
    hidden: z.boolean(),
    lumpSum: z.boolean(),
    fixedPrice: z.number().nullable(),
    deferredDate: z.string().nullable(),
    deferredReason: z.string().nullable(),
    totalAmount: z.number(),
    discountAmount: z.number(),
    taxAmount: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Job' })

export const lineSchema = z
  .object({
    id: z.string(),
    kind: z
      .enum(LINE_KINDS)
      .describe('labor, fee, epa and shopSupplies are labor rows; the rest parts'),
    description: z.string().describe('A labor line’s description, a part’s name'),
    partNumber: z.string().nullable(),
    quantity: z.number().describe('Parts: the quantity; labor: the hours'),
    unit: z.string().nullable(),
    unitPrice: z.number().describe('Parts: the price each; labor: the rate'),
    total: z.number().describe('After the line’s own discount'),
    discountAmount: z.number().nullable(),
    taxable: z.boolean(),
    pricingType: z.string().nullable().describe('Labor rows: hourly, service or shopFee'),
    jobId: z.string().nullable(),
    technicianId: z.string().nullable(),
    completed: z.boolean().nullable(),
    costHours: z.number().nullable(),
    costRate: z.number().nullable(),
    unitCost: z.number().nullable(),
    inventoryPartId: z.string().nullable(),
    note: z.string().nullable(),
    excluded: z.boolean().describe('A quote line the customer declined: not in the totals'),
    sourceExtra: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('What the line had in its source'),
  })
  .meta({ id: 'Line' })
