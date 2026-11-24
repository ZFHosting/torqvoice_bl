/**
 * `/api/v1/payments` (across every work order, for accounting sync: `?from=&to=`, `?method=`), `/api/v1/findings`
 * (deferred or recommended work: `?vehicleId=`, `?status=`) and `/api/v1/webhooks` (the workshop's subscriptions;
 * their signing secrets are never returned, except once to the request that made one) (docs/fork/API.md §4).
 */
import { z } from 'zod'
import { createWebhookSchema, updateWebhookSchema } from '@/features/webhooks/Schema/webhookSchema'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { patchBody, writeEndpoints } from '../Lib/writeSpec'
import { rangeFilters, sourceSchema } from './common'

export const paymentSchema = z
  .object({
    id: z.string(),
    workOrderId: z.string(),
    amount: z.number().describe('Negative for a refund'),
    currency: z.string(),
    date: z.string(),
    method: z.string(),
    note: z.string().nullable(),
    provider: z.string().nullable().describe('Where it came from: stripe, vipps, shopmonkey…'),
    externalId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Payment' })

export const findingSchema = z
  .object({
    id: z.string(),
    vehicleId: z.string(),
    workOrderId: z.string().nullable().describe('The job it was found on'),
    resolvedWorkOrderId: z.string().nullable().describe('The job that did the work'),
    description: z.string(),
    severity: z.string(),
    status: z.string(),
    notes: z.string().nullable(),
    faultCode: z.string().nullable(),
    imageCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    // fork (A5): with `include=source`
    sourceRecord: sourceSchema.optional(),
  })
  .meta({ id: 'Finding' })

export const webhookSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    description: z.string().nullable(),
    events: z.array(z.string()),
    isActive: z.boolean(),
    failureCount: z.number().int(),
    lastTriggeredAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    lastFailureAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Webhook' })

export type PaymentOut = z.infer<typeof paymentSchema>
export type FindingOut = z.infer<typeof findingSchema>
export type WebhookOut = z.infer<typeof webhookSchema>

export const paymentsSpec: ReadSpec<PaymentOut> = {
  path: '/payments',
  tag: 'Payments',
  noun: { one: 'payment', many: 'payments' },
  filters: z.object({ ...rangeFilters, method: z.string().trim().min(1).max(50).optional() }),
  response: paymentSchema,
}

export const findingsSpec: ReadSpec<FindingOut> = {
  path: '/findings',
  tag: 'Findings',
  noun: { one: 'finding', many: 'findings' },
  filters: z.object({
    vehicleId: z.string().min(1).optional(),
    status: z.string().trim().min(1).max(50).optional(),
  }),
  // fork (A5): `include=source`
  sourceModel: 'VehicleFinding',
  response: findingSchema,
}

export const webhooksSpec: ReadSpec<WebhookOut> = {
  path: '/webhooks',
  tag: 'Webhooks',
  noun: { one: 'webhook', many: 'webhooks' },
  response: webhookSchema,
}

/* ---------- writes (A4) ---------- */

const severity = z.enum(['needs_work', 'monitor', 'urgent'])

/** A finding as the app records one; `workOrderId` is the job it was found on. */
export const createFindingSchema = z
  .object({
    vehicleId: z.string().min(1),
    description: z.string().min(1),
    severity: severity.optional().describe('needs_work unless sent'),
    notes: z.string().optional(),
    workOrderId: z.string().min(1).optional(),
    concernId: z.string().min(1).nullable().optional().describe('The customer concern it answers'),
  })
  .strict()

export const updateFindingSchema = z
  .object({
    vehicleId: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    severity: severity.optional(),
    notes: z.string().optional().describe('Empty clears it'),
    workOrderId: z.string().min(1).optional(),
    concernId: z.string().min(1).nullable().optional(),
  })
  .strict()

export const resolveFindingSchema = z
  .object({ workOrderId: z.string().min(1).optional().describe('The job that did the work') })
  .strict()

/** A new webhook, with its signing secret: shown this once, never in a read. */
export const webhookCreatedSchema = webhookSchema
  .extend({
    secret: z
      .string()
      .nullable()
      .describe(
        'Signs every delivery; shown only here (null when the answer is an Idempotency-Key replay)'
      ),
  })
  .meta({ id: 'WebhookCreated' })

export const recordEndpoints: EndpointSpec[] = [
  ...readEndpoints(paymentsSpec),
  ...readEndpoints(findingsSpec),
  ...writeEndpoints({
    ...findingsSpec,
    create: createFindingSchema,
    update: updateFindingSchema,
    remove: true,
  }),
  {
    method: 'post',
    path: '/findings/{id}/resolve',
    summary: 'Mark a finding resolved, by the work order that did the work',
    tag: findingsSpec.tag,
    body: resolveFindingSchema,
    response: findingSchema,
  },
  ...readEndpoints(webhooksSpec),
  {
    method: 'post',
    path: '/webhooks',
    summary: 'Create a webhook (its secret is in this answer only)',
    tag: webhooksSpec.tag,
    body: createWebhookSchema,
    response: webhookCreatedSchema,
    status: 201,
  },
  ...writeEndpoints({
    ...webhooksSpec,
    update: patchBody(updateWebhookSchema),
    remove: true,
  }),
]
