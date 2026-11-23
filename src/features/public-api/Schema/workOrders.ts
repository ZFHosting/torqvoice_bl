/**
 * `/api/v1/work-orders` (a ServiceRecord; docs/fork/API.md §4): `?status=`, `?customerId=`, `?vehicleId=`,
 * `?invoiceNumber=`, `?technicianId=`, `?openOnly=true`; includes `jobs`, `lines`, `concerns`, `payments`,
 * `attachments`, `timeEntries`, `meta`, `customFields`. And one work order's `jobs`, `lines`, `payments` and
 * `attachments` on their own, with an attachment's file at `.../attachments/{attachmentId}/content`.
 */
import { z } from 'zod'
import { createJobSchema, updateJobSchema } from '@/features/fork-records/Schema/forkRecordSchemas'
import { createLineSchema, updateLineSchema } from '@/features/fork-records/Schema/lineSchemas'
import { createPaymentSchema } from '@/features/payments/Schema/paymentSchema'
import { createServiceSchema, updateServiceSchema } from '@/features/vehicles/Schema/serviceSchema'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { deletedSchema, documentBodySchema, patchBody, writeEndpoints } from '../Lib/writeSpec'
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
    status: z.string().describe('pending, scheduled, in-progress, waiting-parts or completed'),
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
    customerId: z
      .string()
      .min(1)
      .optional()
      .describe('The customer’s: billed to them, or on a vehicle they own'),
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

const write = (
  method: EndpointSpec['method'],
  path: string,
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
  status?: number
): EndpointSpec => ({ method, path, summary, tag: 'Work orders', response, body, status })

/** `POST /work-orders/{id}/status` (A4): a stage, or the workshop's own status. */
export const workOrderStatusBodySchema = z
  .object({ status: z.string().min(1), customStatusId: z.string().min(1).nullable().optional() })
  .strict()

export const workOrderEndpoints: EndpointSpec[] = [
  ...readEndpoints(workOrdersSpec),
  ...writeEndpoints({
    ...workOrdersSpec,
    create: documentBodySchema(createServiceSchema),
    update: patchBody(documentBodySchema(updateServiceSchema)),
    remove: true,
  }),
  write(
    'post',
    '/work-orders/{id}/status',
    'Move a work order to a status (the work board’s own rules)',
    workOrderSchema,
    workOrderStatusBodySchema
  ),
  write('post', '/work-orders/{id}/lines', 'Add a line', lineSchema, createLineSchema, 201),
  write('patch', '/work-orders/{id}/lines/{lineId}', 'Change a line', lineSchema, updateLineSchema),
  write('delete', '/work-orders/{id}/lines/{lineId}', 'Remove a line', deletedSchema),
  write(
    'post',
    '/work-orders/{id}/jobs',
    'Add a job (line group)',
    jobSchema,
    createJobSchema,
    201
  ),
  write('patch', '/work-orders/{id}/jobs/{jobId}', 'Change a job', jobSchema, updateJobSchema),
  write('delete', '/work-orders/{id}/jobs/{jobId}', 'Remove a job (its lines stay)', deletedSchema),
  write(
    'post',
    '/work-orders/{id}/payments',
    'Record a payment (issues the invoice, as the app does)',
    paymentSchema,
    createPaymentSchema.omit({ serviceRecordId: true }),
    201
  ),
  write('delete', '/work-orders/{id}/payments/{paymentId}', 'Remove a payment', deletedSchema),
  child('jobs', 'A work order’s jobs (line groups)', z.array(jobSchema)),
  child('lines', 'A work order’s labor and part lines', z.array(lineSchema)),
  child('payments', 'A work order’s payments', z.array(paymentSchema)),
  child('attachments', 'A work order’s attachments (metadata)', z.array(attachmentSchema)),
  {
    method: 'post',
    path: '/work-orders/{id}/attachments',
    summary:
      'Attach a file: a photo (JPEG, PNG, WebP, HEIC, 60 MB), a PDF, text or CSV (25 MB) or a video (MP4, MOV, WebM, 250 MB)',
    tag: 'Work orders',
    body: z.object({
      file: z.string().meta({ format: 'binary' }).describe('The file, with its own Content-Type'),
      category: z
        .enum(['image', 'diagnostic', 'document', 'dropoff'])
        .optional()
        .describe(
          'image for a photo, document for a PDF or text, unless sent; a video is always video'
        ),
      description: z.string().max(500).optional(),
      includeInInvoice: z
        .enum(['true', 'false'])
        .optional()
        .describe('true unless sent, false for dropoff'),
    }),
    bodyContentType: 'multipart/form-data',
    response: attachmentSchema,
    status: 201,
  },
  write(
    'delete',
    '/work-orders/{id}/attachments/{attachmentId}',
    'Remove an attachment (and its file, unless something else uses it)',
    deletedSchema
  ),
  {
    method: 'get',
    path: '/work-orders/{id}/attachments/{attachmentId}/content',
    summary: 'An attachment’s file',
    tag: 'Work orders',
    response: z.string(),
    contentType: 'application/octet-stream',
  },
]
