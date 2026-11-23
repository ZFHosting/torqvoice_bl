/**
 * `/api/v1/payments` (across every work order, for accounting sync: `?from=&to=`, `?method=`), `/api/v1/findings`
 * (deferred or recommended work: `?vehicleId=`, `?status=`) and `/api/v1/webhooks` (the workshop's subscriptions;
 * their signing secrets are never returned) (docs/fork/API.md §4).
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { rangeFilters } from './common'

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
  response: findingSchema,
}

export const webhooksSpec: ReadSpec<WebhookOut> = {
  path: '/webhooks',
  tag: 'Webhooks',
  noun: { one: 'webhook', many: 'webhooks' },
  response: webhookSchema,
}

export const recordEndpoints: EndpointSpec[] = [
  ...readEndpoints(paymentsSpec),
  ...readEndpoints(findingsSpec),
  ...readEndpoints(webhooksSpec),
]
