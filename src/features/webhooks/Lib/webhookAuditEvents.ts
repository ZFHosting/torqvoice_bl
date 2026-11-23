/**
 * fork: the audit events these writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the
 * same either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import type { AuditEvent } from '@/lib/audit'
import type {
  createWebhookService,
  updateWebhookService,
  deleteWebhookService,
  rotateWebhookSecretService,
} from './webhookService.server'

export function createWebhookEvent(
  result: Awaited<ReturnType<typeof createWebhookService>>
): AuditEvent {
  return {
    action: 'webhook.create',
    entity: 'webhook',
    entityId: result.id,
    details: { key: 'webhook_create', params: { name: result.name } },
  }
}

export function updateWebhookEvent(
  result: Awaited<ReturnType<typeof updateWebhookService>>
): AuditEvent {
  return {
    action: 'webhook.update',
    entity: 'webhook',
    entityId: result.id,
  }
}

export function deleteWebhookEvent(
  result: Awaited<ReturnType<typeof deleteWebhookService>>
): AuditEvent {
  return {
    action: 'webhook.delete',
    entity: 'webhook',
    entityId: result.id,
  }
}

export function rotateWebhookSecretEvent(
  result: Awaited<ReturnType<typeof rotateWebhookSecretService>>
): AuditEvent {
  return {
    action: 'webhook.rotateSecret',
    entity: 'webhook',
    entityId: result.id,
  }
}
