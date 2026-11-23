'use server'

import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { revalidatePath } from 'next/cache'
import { WEBHOOK_EVENTS } from '../Schema/webhookSchema'
import { signPayload } from '../Lib/sign'
import { deliverOnce } from '../Lib/deliver'
import { demoGuard } from '@/lib/demo'
import { requireFeature } from '@/lib/features'
// fork: the write bodies and their audit events live beside the webhook service (A2)
import {
  createWebhookEvent,
  deleteWebhookEvent,
  rotateWebhookSecretEvent,
  updateWebhookEvent,
} from '../Lib/webhookAuditEvents'
import {
  createWebhookService,
  deleteWebhookService,
  rotateWebhookSecretService,
  toggleWebhookService,
  updateWebhookService,
} from '../Lib/webhookService.server'

export async function getWebhooks() {
  return withAuth(
    async ({ organizationId }) => {
      const rows = await db.webhook.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { deliveries: true } },
        },
      })
      return rows.map((w) => ({
        id: w.id,
        name: w.name,
        url: w.url,
        description: w.description,
        events: safeParseEvents(w.events),
        isActive: w.isActive,
        lastTriggeredAt: w.lastTriggeredAt,
        lastSuccessAt: w.lastSuccessAt,
        lastFailureAt: w.lastFailureAt,
        failureCount: w.failureCount,
        autoDisabled: !w.isActive && w.failureCount >= 20,
        deliveryCount: w._count.deliveries,
        createdAt: w.createdAt,
      }))
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SETTINGS }],
    }
  )
}

export async function createWebhook(input: unknown) {
  return withAuth(
    // fork: the body is createWebhookService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createWebhookService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SETTINGS },
      ],
      audit: ({ result }) => createWebhookEvent(result),
    }
  )
}

export async function updateWebhook(input: unknown) {
  return withAuth(
    // fork: the body is updateWebhookService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateWebhookService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SETTINGS },
      ],
      audit: ({ result }) => updateWebhookEvent(result),
    }
  )
}

export async function toggleWebhook(id: string) {
  return withAuth(
    // fork: the body is toggleWebhookService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      toggleWebhookService({ organizationId, userId, actor: 'user' }, id),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SETTINGS },
      ],
    }
  )
}

export async function deleteWebhook(id: string) {
  return withAuth(
    // fork: the body is deleteWebhookService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteWebhookService({ organizationId, userId, actor: 'user' }, id),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SETTINGS },
      ],
      audit: ({ result }) => deleteWebhookEvent(result),
    }
  )
}

export async function rotateWebhookSecret(id: string) {
  return withAuth(
    // fork: the body is rotateWebhookSecretService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      rotateWebhookSecretService({ organizationId, userId, actor: 'user' }, id),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SETTINGS },
      ],
      audit: ({ result }) => rotateWebhookSecretEvent(result),
    }
  )
}

export async function sendTestWebhook(id: string) {
  return withAuth(
    async ({ organizationId, userId }) => {
      await requireFeature(organizationId, 'api')
      demoGuard()
      const webhook = await db.webhook.findFirst({
        where: { id, organizationId },
      })
      if (!webhook) throw new Error('Webhook not found')

      const payload = JSON.stringify({
        id: `evt_test_${Date.now().toString(36)}`,
        event: 'ping.test',
        createdAt: new Date().toISOString(),
        organizationId,
        userId,
        data: { test: true },
      })

      const delivery = await db.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          event: 'ping.test',
          payload,
          status: 'pending',
        },
        select: { id: true },
      })

      await deliverOnce(delivery.id)
      revalidatePath('/settings/webhooks')
      return { deliveryId: delivery.id }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SETTINGS },
      ],
    }
  )
}

export async function getWebhookDeliveries(webhookId: string, limit: number = 25) {
  return withAuth(
    async ({ organizationId }) => {
      const webhook = await db.webhook.findFirst({
        where: { id: webhookId, organizationId },
        select: { id: true },
      })
      if (!webhook) throw new Error('Webhook not found')

      const deliveries = await db.webhookDelivery.findMany({
        where: { webhookId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 100),
        select: {
          id: true,
          event: true,
          status: true,
          statusCode: true,
          attempt: true,
          maxAttempts: true,
          errorMessage: true,
          durationMs: true,
          createdAt: true,
          deliveredAt: true,
          nextRetryAt: true,
        },
      })
      return deliveries
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SETTINGS }],
    }
  )
}

export async function retryWebhookDelivery(deliveryId: string) {
  return withAuth(
    async ({ organizationId }) => {
      await requireFeature(organizationId, 'api')
      demoGuard()
      const delivery = await db.webhookDelivery.findFirst({
        where: { id: deliveryId, webhook: { organizationId } },
        select: { id: true, status: true },
      })
      if (!delivery) throw new Error('Delivery not found')

      // Reset to pending so deliverOnce will pick it up
      await db.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'pending', nextRetryAt: null },
      })
      await deliverOnce(deliveryId)
      revalidatePath('/settings/webhooks')
      return { id: deliveryId }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SETTINGS },
      ],
    }
  )
}

export async function getAvailableEvents() {
  return withAuth(async () => ({ events: [...WEBHOOK_EVENTS] }), {
    requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SETTINGS }],
  })
}

export async function getDeliveryPayload(deliveryId: string) {
  return withAuth(
    async ({ organizationId }) => {
      const delivery = await db.webhookDelivery.findFirst({
        where: { id: deliveryId, webhook: { organizationId } },
        select: {
          id: true,
          event: true,
          payload: true,
          status: true,
          statusCode: true,
          responseBody: true,
          errorMessage: true,
          attempt: true,
          maxAttempts: true,
          durationMs: true,
          createdAt: true,
          deliveredAt: true,
        },
      })
      if (!delivery) throw new Error('Delivery not found')
      return delivery
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SETTINGS }],
    }
  )
}

function safeParseEvents(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// Re-export for use in unit tests / route handlers
export { signPayload }
