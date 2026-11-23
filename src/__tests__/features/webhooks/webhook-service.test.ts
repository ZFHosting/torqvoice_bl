/**
 * @vitest-environment node
 *
 * fork: the webhook and finding services do what their actions did (A2), plus tombstones for
 * deletes; the webhook audit events never carry the signing secret.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  webhook: { findFirst: vi.fn(), delete: vi.fn() },
  vehicleFinding: { findFirst: vi.fn(), delete: vi.fn() },
  deletedRecord: { create: vi.fn() },
}))
vi.mock('@/lib/db', () => ({ db }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/files/manager', () => ({ releaseFiles: vi.fn(async () => undefined) }))

const webhooks = await import('@/features/webhooks/Lib/webhookService.server')
const webhookEvents = await import('@/features/webhooks/Lib/webhookAuditEvents')
const findings = await import('@/features/vehicles/Lib/findingService.server')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }
const tombstone = (entityType: string, entityId: string) => ({
  data: { organizationId: 'org-a', entityType, entityId, actorUserId: 'user-1' },
})

beforeEach(() => vi.clearAllMocks())

describe('deleting a webhook', () => {
  it('removes this workshop’s webhook, then leaves a tombstone', async () => {
    db.webhook.findFirst.mockResolvedValue({ id: 'wh-1' })
    expect(await webhooks.deleteWebhookService(ctx, 'wh-1')).toEqual({ id: 'wh-1' })
    expect(db.webhook.findFirst).toHaveBeenCalledWith({
      where: { id: 'wh-1', organizationId: 'org-a' },
    })
    expect(db.deletedRecord.create).toHaveBeenCalledWith(tombstone('webhook', 'wh-1'))
  })

  it('leaves another workshop’s alone', async () => {
    db.webhook.findFirst.mockResolvedValue(null)
    await expect(webhooks.deleteWebhookService(ctx, 'theirs')).rejects.toThrow('Webhook not found')
    expect(db.webhook.delete).not.toHaveBeenCalled()
    expect(db.deletedRecord.create).not.toHaveBeenCalled()
  })

  it('audits a new webhook without its secret', () => {
    const event = webhookEvents.createWebhookEvent({
      id: 'wh-1',
      name: 'Accounting',
      url: 'https://example.com/hook',
      secret: 'whsec_sentinel',
    })
    expect(event).toMatchObject({ action: 'webhook.create', entityId: 'wh-1' })
    expect(JSON.stringify(event)).not.toContain('whsec_sentinel')
  })
})

describe('deleting a finding', () => {
  it('removes it, then leaves a tombstone', async () => {
    db.vehicleFinding.findFirst.mockResolvedValue({ id: 'f-1', vehicleId: 'v-1', imageUrls: [] })
    expect(await findings.deleteFindingService(ctx, 'f-1')).toEqual({ findingId: 'f-1' })
    expect(db.vehicleFinding.findFirst).toHaveBeenCalledWith({
      where: { id: 'f-1', vehicle: { organizationId: 'org-a' } },
    })
    expect(db.deletedRecord.create).toHaveBeenCalledWith(tombstone('finding', 'f-1'))
  })
})
