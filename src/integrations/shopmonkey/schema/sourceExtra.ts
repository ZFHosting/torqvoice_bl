/**
 * The shape of `sourceExtra` on ServiceLabor / QuoteLabor and ServicePart / QuotePart (fork columns,
 * docs/fork/MAPPING.md X3): what a Shopmonkey line had that the Torqvoice row has no column for.
 *
 * Read leniently, like the upstream JSON columns (issuedInvoice.ts): every key is optional, unknown keys
 * pass through, and a value that doesn't parse reads as an empty object rather than breaking a page.
 * Writers (the M4 transforms) produce exactly these keys.
 */
import { z } from 'zod'

const cents = z.number().int()

/** Common to every line kind. */
const lineSourceBase = z
  .object({
    /** Where the line came from. */
    source: z.literal('shopmonkey').optional(),
    /** The Shopmonkey id of the line (labor, part, tire, fee or subcontract). */
    remoteId: z.string().optional(),
    /** The Shopmonkey service the line was on. */
    remoteServiceId: z.string().optional(),
    ordinal: z.number().optional(),
    discountPercent: z.number().optional(),
    discountValueType: z.string().optional(),
    categoryId: z.string().nullable().optional(),
    labels: z.unknown().optional(),
  })
  .passthrough()

export const laborSourceExtraSchema = lineSourceBase
  .extend({
    multiplier: z.number().optional(),
    multiplierType: z.string().optional(),
    rateId: z.string().nullable().optional(),
    costTotalCents: cents.nullable().optional(),
    skillRequired: z.string().nullable().optional(),
    inventoryLaborId: z.string().nullable().optional(),
    // Fee lines (lineKind "fee").
    feeType: z.string().optional(),
    percent: z.number().optional(),
    subtotalCents: cents.nullable().optional(),
    inventoryFeeId: z.string().nullable().optional(),
  })
  .passthrough()

export const partSourceExtraSchema = lineSourceBase
  .extend({
    sku: z.string().nullable().optional(),
    binLocation: z.string().nullable().optional(),
    vendorId: z.string().nullable().optional(),
    reserved: z.boolean().optional(),
    inventoryStatus: z.string().nullable().optional(),
    purchaseStatus: z.string().nullable().optional(),
    // Tires (lineKind "tire").
    size: z.string().nullable().optional(),
    sizeFormat: z.string().nullable().optional(),
    tireIdentificationNumbers: z.array(z.string()).optional(),
    tireModelId: z.string().nullable().optional(),
    federalExciseTaxCents: cents.optional(),
    wasteTireFee: cents.optional(),
    // Subcontracts (lineKind "subcontract").
    costCents: cents.optional(),
  })
  .passthrough()

export type LaborSourceExtra = z.infer<typeof laborSourceExtraSchema>
export type PartSourceExtra = z.infer<typeof partSourceExtraSchema>

function lenient<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : ({} as T)
}

export const readLaborSourceExtra = (raw: unknown): LaborSourceExtra =>
  lenient(laborSourceExtraSchema, raw)
export const readPartSourceExtra = (raw: unknown): PartSourceExtra =>
  lenient(partSourceExtraSchema, raw)

/** The kinds a line may have been in its source (`lineKind`). */
export const LINE_KINDS = [
  'labor',
  'fee',
  'epa',
  'shopSupplies',
  'part',
  'tire',
  'subcontract',
] as const
export type LineKind = (typeof LINE_KINDS)[number]
