/** `/api/v1/payments`, `/api/v1/findings` and `/api/v1/webhooks`: how they read (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import type { ReadResource } from '../Lib/readResource'
import {
  type FindingOut,
  findingsSpec,
  type PaymentOut,
  paymentsSpec,
  type WebhookOut,
  webhooksSpec,
} from '../Schema/records'
import {
  FINDING_SELECT,
  type FindingRow,
  PAYMENT_SELECT,
  type PaymentRow,
  serializeFinding,
  serializePayment,
  serializeWebhook,
  WEBHOOK_SELECT,
  type WebhookRow,
} from '../Serializers/records'
import { range } from './range'

export const paymentsResource: ReadResource<PaymentRow, PaymentOut> = {
  ...paymentsSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.BILLING },
  // A payment has no workshop column: its work order says whose it is.
  scope: (organizationId) => ({ serviceRecord: { organizationId } }),
  where: ({ from, to, method }) => ({
    ...range('date', from, to),
    ...(typeof method === 'string' ? { method } : {}),
  }),
  select: () => PAYMENT_SELECT,
  findMany: (args) => db.payment.findMany(args as never) as unknown as Promise<PaymentRow[]>,
  findFirst: (args) => db.payment.findFirst(args as never) as unknown as Promise<PaymentRow | null>,
  serialize: (row, ctx) => serializePayment(row, ctx),
}

export const findingsResource: ReadResource<FindingRow, FindingOut> = {
  ...findingsSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.VEHICLES },
  // A finding has no workshop column: its vehicle says whose it is.
  scope: (organizationId) => ({ vehicle: { organizationId } }),
  where: ({ vehicleId, status }) => ({
    ...(typeof vehicleId === 'string' ? { vehicleId } : {}),
    ...(typeof status === 'string' ? { status } : {}),
  }),
  select: () => FINDING_SELECT,
  findMany: (args) => db.vehicleFinding.findMany(args as never) as unknown as Promise<FindingRow[]>,
  findFirst: (args) =>
    db.vehicleFinding.findFirst(args as never) as unknown as Promise<FindingRow | null>,
  serialize: (row) => serializeFinding(row),
}

export const webhooksResource: ReadResource<WebhookRow, WebhookOut> = {
  ...webhooksSpec,
  // Webhooks are managed in Settings.
  permission: { action: PermissionAction.READ, subject: PermissionSubject.SETTINGS },
  scope: (organizationId) => ({ organizationId }),
  select: () => WEBHOOK_SELECT,
  findMany: (args) => db.webhook.findMany(args as never) as unknown as Promise<WebhookRow[]>,
  findFirst: (args) => db.webhook.findFirst(args as never) as unknown as Promise<WebhookRow | null>,
  serialize: (row) => serializeWebhook(row),
}
