/**
 * `/api/v1/quotes` (docs/fork/API.md §4): `?status=`, `?customerId=`, `?vehicleId=`; includes `jobs`, `lines`
 * (with `excluded` for what the customer declined) and `customFields`.
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { customFieldValueSchema, jobSchema, lineSchema } from './common'
import { taxComponentAmountSchema } from './workOrders'

export const quoteSchema = z
  .object({
    id: z.string(),
    quoteNumber: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    validUntil: z.string().nullable(),
    customerId: z.string().nullable(),
    vehicleId: z.string().nullable(),
    inspectionId: z.string().nullable(),
    convertedToId: z.string().nullable().describe('The work order it became'),
    customerReference: z.string().nullable(),
    notes: z.string().nullable(),
    currency: z.string(),
    subtotal: z.number(),
    discountType: z.string().nullable(),
    discountValue: z.number(),
    discountAmount: z.number(),
    taxRate: z.number(),
    taxAmount: z.number(),
    taxInclusive: z.boolean(),
    taxComponents: z.array(taxComponentAmountSchema).nullable(),
    totalAmount: z.number(),
    warrantyStatus: z.string().nullable(),
    warrantyMonths: z.number().int().nullable(),
    warrantyMileage: z.number().int().nullable(),
    warrantyNotes: z.string().nullable(),
    sentAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    jobs: z.array(jobSchema).optional(),
    lines: z.array(lineSchema).optional(),
    customFields: z.array(customFieldValueSchema).optional(),
  })
  .meta({ id: 'Quote' })

export type QuoteOut = z.infer<typeof quoteSchema>

export const quotesSpec: ReadSpec<QuoteOut> = {
  path: '/quotes',
  tag: 'Quotes',
  noun: { one: 'quote', many: 'quotes' },
  filters: z.object({
    status: z.string().trim().min(1).max(50).optional(),
    customerId: z.string().min(1).optional(),
    vehicleId: z.string().min(1).optional(),
  }),
  includes: ['jobs', 'lines', 'customFields'],
  response: quoteSchema,
}

export const quoteEndpoints: EndpointSpec[] = readEndpoints(quotesSpec)
