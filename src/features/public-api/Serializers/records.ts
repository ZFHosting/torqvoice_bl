/** Payments, findings and webhooks, field by field (docs/fork/API.md §4). */
import { iso, isoAlways, money } from '../Lib/serializeFormat'
import type { SerializeContext } from '../Lib/serializeFormat'
import type { FindingOut, PaymentOut, WebhookOut } from '../Schema/records'

export const PAYMENT_SELECT = {
  id: true,
  serviceRecordId: true,
  amount: true,
  date: true,
  method: true,
  note: true,
  provider: true,
  externalId: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface PaymentRow {
  id: string
  serviceRecordId: string
  amount: number
  date: Date
  method: string
  note: string | null
  provider: string | null
  externalId: string | null
  createdAt: Date
  updatedAt: Date
}

export function serializePayment(row: PaymentRow, ctx: SerializeContext): PaymentOut {
  return {
    id: row.id,
    workOrderId: row.serviceRecordId,
    amount: money(row.amount),
    currency: ctx.currency,
    date: isoAlways(row.date),
    method: row.method,
    note: row.note,
    provider: row.provider,
    externalId: row.externalId,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}

export const FINDING_SELECT = {
  id: true,
  vehicleId: true,
  serviceRecordId: true,
  resolvedServiceRecordId: true,
  description: true,
  severity: true,
  status: true,
  notes: true,
  faultCode: true,
  imageUrls: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface FindingRow {
  id: string
  vehicleId: string
  serviceRecordId: string | null
  resolvedServiceRecordId: string | null
  description: string
  severity: string
  status: string
  notes: string | null
  faultCode: string | null
  imageUrls: string[]
  createdAt: Date
  updatedAt: Date
}

export function serializeFinding(row: FindingRow): FindingOut {
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    workOrderId: row.serviceRecordId,
    resolvedWorkOrderId: row.resolvedServiceRecordId,
    description: row.description,
    severity: row.severity,
    status: row.status,
    notes: row.notes,
    faultCode: row.faultCode,
    imageCount: row.imageUrls.length,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}

/** Never the signing secret. */
export const WEBHOOK_SELECT = {
  id: true,
  name: true,
  url: true,
  description: true,
  events: true,
  isActive: true,
  failureCount: true,
  lastTriggeredAt: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface WebhookRow {
  id: string
  name: string
  url: string
  description: string | null
  /** A JSON array of event names, as the webhooks feature stores it. */
  events: string
  isActive: boolean
  failureCount: number
  lastTriggeredAt: Date | null
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function eventList(stored: string): string[] {
  try {
    const parsed = JSON.parse(stored) as unknown
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : []
  } catch {
    return []
  }
}

export function serializeWebhook(row: WebhookRow): WebhookOut {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description,
    events: eventList(row.events),
    isActive: row.isActive,
    failureCount: row.failureCount,
    lastTriggeredAt: iso(row.lastTriggeredAt),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastFailureAt: iso(row.lastFailureAt),
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}
