/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createWebhookSchema, updateWebhookSchema } from '../Schema/webhookSchema'
import { generateWebhookSecret } from '../Lib/sign'
import { checkWebhookUrl } from '../Lib/ssrf'
import { demoGuard } from '@/lib/demo'
import { requireFeature } from '@/lib/features'
import type { ServiceCtx } from '@/lib/service-context'

const SSRF_REASONS: Record<string, string> = {
  invalid_url: 'URL is not valid',
  scheme_not_http: 'Only http:// and https:// URLs are allowed',
  missing_host: 'URL is missing a host',
  metadata_host: 'Cloud metadata endpoints are not allowed',
  loopback_host: 'Loopback hostnames are not allowed',
  private_ip: 'Private IP addresses are not allowed',
  resolves_private: 'URL resolves to a private network address',
  dns_resolution_failed: 'Could not resolve URL host',
  dns_no_records: 'No DNS records found for URL host',
}

function ssrfMessage(reason: string): string {
  return SSRF_REASONS[reason] ?? `URL was rejected: ${reason}`
}

export async function createWebhookService(ctx: ServiceCtx, input: unknown) {
  const { organizationId, userId } = ctx
  await requireFeature(organizationId, 'api')
  // Otherwise the demo becomes an open outbound HTTP relay: SSRF blocks
  // private ranges, but not arbitrary public URLs.
  demoGuard()
  const data = createWebhookSchema.parse(input)
  const safety = await checkWebhookUrl(data.url)
  if (!safety.ok) throw new Error(ssrfMessage(safety.reason))
  const secret = generateWebhookSecret()

  const webhook = await db.webhook.create({
    data: {
      name: data.name,
      url: data.url,
      description: data.description ?? null,
      events: JSON.stringify(data.events),
      isActive: data.isActive ?? true,
      secret,
      organizationId,
      createdById: userId,
    },
  })

  revalidatePath('/settings/webhooks')
  // Returned ONCE on creation; the secret never appears in subsequent reads.
  return {
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    secret,
  }
}

export async function updateWebhookService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  await requireFeature(organizationId, 'api')
  demoGuard()
  const data = updateWebhookSchema.parse(input)
  const existing = await db.webhook.findFirst({
    where: { id: data.id, organizationId },
  })
  if (!existing) throw new Error('Webhook not found')

  if (data.url !== existing.url) {
    const safety = await checkWebhookUrl(data.url)
    if (!safety.ok) throw new Error(ssrfMessage(safety.reason))
  }

  const reEnabling = data.isActive === true && existing.isActive === false

  const updated = await db.webhook.update({
    where: { id: data.id },
    data: {
      name: data.name,
      url: data.url,
      description: data.description ?? null,
      events: JSON.stringify(data.events),
      isActive: data.isActive ?? existing.isActive,
      ...(reEnabling ? { failureCount: 0 } : {}),
    },
  })

  revalidatePath('/settings/webhooks')
  return { id: updated.id }
}

export async function toggleWebhookService(ctx: ServiceCtx, id: string) {
  const { organizationId } = ctx
  await requireFeature(organizationId, 'api')
  const existing = await db.webhook.findFirst({
    where: { id, organizationId },
  })
  if (!existing) throw new Error('Webhook not found')
  const reEnabling = !existing.isActive
  const updated = await db.webhook.update({
    where: { id },
    data: {
      isActive: reEnabling,
      ...(reEnabling ? { failureCount: 0 } : {}),
    },
  })
  revalidatePath('/settings/webhooks')
  return { id: updated.id, isActive: updated.isActive }
}

export async function deleteWebhookService(ctx: ServiceCtx, id: string) {
  const { organizationId, userId } = ctx
  const existing = await db.webhook.findFirst({
    where: { id, organizationId },
  })
  if (!existing) throw new Error('Webhook not found')
  await db.webhook.delete({ where: { id } })
  // fork: the tombstone an API client managing its subscriptions learns the delete from.
  await db.deletedRecord.create({
    data: { organizationId, entityType: 'webhook', entityId: id, actorUserId: userId },
  })
  revalidatePath('/settings/webhooks')
  return { id }
}

export async function rotateWebhookSecretService(ctx: ServiceCtx, id: string) {
  const { organizationId } = ctx
  await requireFeature(organizationId, 'api')
  const existing = await db.webhook.findFirst({
    where: { id, organizationId },
  })
  if (!existing) throw new Error('Webhook not found')
  const secret = generateWebhookSecret()
  await db.webhook.update({
    where: { id },
    data: { secret },
  })
  revalidatePath('/settings/webhooks')
  return { id, secret }
}
