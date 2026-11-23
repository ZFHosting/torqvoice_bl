/**
 * `/api/v1/work-orders` (a ServiceRecord; docs/fork/API.md §4): `?status=`, `?customerId=`, `?vehicleId=`,
 * `?invoiceNumber=`, `?technicianId=`, `?openOnly=true`; includes `jobs`, `lines`, `concerns`, `payments`,
 * `attachments`, `timeEntries`, `meta`, `customFields`. And one work order's `jobs`, `lines`, `payments` and
 * `attachments` on their own, with an attachment's file at `.../attachments/{attachmentId}/content`.
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { customFieldValueSchema, jobSchema, lineSchema } from './common'
import { paymentSchema } from './records'
import { timeEntrySchema } from './schedule'

export const taxComponentAmountSchema = z
  .object({
    name: z.string(),
    rate: z.number().describe('Percent'),
    amount: z.number(),
    compound: z.boolean(),
    registrationNumber: z.string().nullable(),
  })
  .meta({ id: 'TaxComponentAmount' })

export const concernSchema = z
  .object({
    id: z.string(),
    description: z.string().describe('What the customer came in with'),
    cause: z.string().nullable(),
    correction: z.string().nullable(),
    confirmation: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    sortOrder: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Concern' })

export const attachmentSchema = z
  .object({
    id: z.string(),
    fileName: z.string(),
    fileType: z.string(),
    fileSize: z.number().int(),
    category: z.string(),
    description: z.string().nullable(),
    includeInInvoice: z.boolean(),
    concernId: z.string().nullable(),
    contentUrl: z.string().describe('Where the file downloads with the same key'),
    createdAt: z.string(),
  })
  .meta({ id: 'Attachment' })

export const workOrderMetaSchema = z
  .object({
    sourceStatus: z.string().nullable().describe('The status the order had in its source'),
    serviceWriterUserId: z.string().nullable(),
    serviceWriterName: z.string().nullable(),
    mileageOut: z.number().int().nullable(),
    labels: z.array(z.string()),
    authorizedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    fullyPaidAt: z.string().nullable(),
    purchaseOrderNumber: z.string().nullable(),
  })
  .meta({ id: 'WorkOrderMeta' })

export const workOrderSchema = z
  .object({
    id: z.string(),
    invoiceNumber: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    type: z.string(),
    status: z.string().describe('pending, in-progress, waiting-parts or completed'),
    customStatusId: z.string().nullable(),
    vehicleId: z.string().nullable(),
    customerId: z.string().nullable().describe('Who is billed, when not the vehicle’s owner'),
    technicianId: z.string().nullable(),
    techName: z.string().nullable(),
    inspectionId: z.string().nullable(),
    mileage: z.number().int().nullable(),
    serviceDate: z.string(),
    startDateTime: z.string().nullable(),
    endDateTime: z.string().nullable(),
    promisedAt: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    invoiceDay: z.string().nullable().describe('The invoice date on the workshop’s calendar'),
    invoiceDueDate: z.string().nullable(),
    invoiceDueDay: z.string().nullable().describe('The due date on the workshop’s calendar'),
    customerReference: z.string().nullable(),
    diagnosticNotes: z.string().nullable(),
    invoiceNotes: z.string().nullable(),
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
    manuallyPaid: z.boolean(),
    manuallyPaidAt: z.string().nullable(),
    issuedAt: z.string().nullable().describe('When the invoice was issued (locked)'),
    sentAt: z.string().nullable(),
    warrantyStatus: z.string().nullable(),
    warrantyMonths: z.number().int().nullable(),
    warrantyMileage: z.number().int().nullable(),
    warrantyExpiresAt: z.string().nullable(),
    warrantyNotes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    jobs: z.array(jobSchema).optional(),
    lines: z.array(lineSchema).optional(),
    concerns: z.array(concernSchema).optional(),
    payments: z.array(paymentSchema).optional(),
    attachments: z.array(attachmentSchema).optional(),
    timeEntries: z.array(timeEntrySchema).optional(),
    meta: workOrderMetaSchema.nullable().optional(),
    customFields: z.array(customFieldValueSchema).optional(),
  })
  .meta({ id: 'WorkOrder' })

export type WorkOrderOut = z.infer<typeof workOrderSchema>
export type ConcernOut = z.infer<typeof concernSchema>
export type AttachmentOut = z.infer<typeof attachmentSchema>
export type WorkOrderMetaOut = z.infer<typeof workOrderMetaSchema>
export type TaxComponentAmountOut = z.infer<typeof taxComponentAmountSchema>

export const WORK_ORDER_INCLUDES = [
  'jobs',
  'lines',
  'concerns',
  'payments',
  'attachments',
  'timeEntries',
  'meta',
  'customFields',
] as const

export const workOrdersSpec: ReadSpec<WorkOrderOut> = {
  path: '/work-orders',
  tag: 'Work orders',
  noun: { one: 'work order', many: 'work orders' },
  filters: z.object({
    status: z.string().trim().min(1).max(50).optional(),
    customerId: z.string().min(1).optional(),
    vehicleId: z.string().min(1).optional(),
    invoiceNumber: z.string().trim().min(1).max(100).optional(),
    technicianId: z.string().min(1).optional().describe('The technician the job is assigned to'),
    openOnly: z.enum(['true', 'false']).optional().describe('true: not completed'),
  }),
  includes: WORK_ORDER_INCLUDES,
  response: workOrderSchema,
}

const child = (name: string, summary: string, response: z.ZodType): EndpointSpec => ({
  method: 'get',
  path: `/work-orders/{id}/${name}`,
  summary,
  tag: 'Work orders',
  response,
})

export const workOrderEndpoints: EndpointSpec[] = [
  ...readEndpoints(workOrdersSpec),
  child('jobs', 'A work order’s jobs (line groups)', z.array(jobSchema)),
  child('lines', 'A work order’s labor and part lines', z.array(lineSchema)),
  child('payments', 'A work order’s payments', z.array(paymentSchema)),
  child('attachments', 'A work order’s attachments (metadata)', z.array(attachmentSchema)),
  {
    method: 'get',
    path: '/work-orders/{id}/attachments/{attachmentId}/content',
    summary: 'An attachment’s file',
    tag: 'Work orders',
    response: z.string(),
    contentType: 'application/octet-stream',
  },
]
