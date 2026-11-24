/**
 * @vitest-environment node
 *
 * fork (A5): the webhook dispatcher with the fork's hook. A fork event goes out under the API's name, and its record
 * is read only once a webhook subscribes to it; an event nobody takes reads nothing and makes no delivery; upstream's
 * own events go out as they always have.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('@/features/webhooks/Lib/dispatcher')

const mocks = vi.hoisted(() => ({
  webhooks: vi.fn(),
  create: vi.fn(),
  forkData: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    webhook: { findMany: mocks.webhooks },
    webhookDelivery: { create: mocks.create },
  },
}))
vi.mock('@/lib/features', () => ({ getFeatures: async () => ({ api: true }) }))
vi.mock('@/features/webhooks/Lib/deliver', () => ({ deliverOnce: vi.fn(async () => undefined) }))
vi.mock('@/features/public-api/Lib/eventHook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/public-api/Lib/eventHook')>()),
  forkData: mocks.forkData,
}))

import { dispatchWebhookEvent } from '@/features/webhooks/Lib/dispatcher'

beforeEach(() => {
  mocks.webhooks.mockReset()
  mocks.create.mockReset()
  mocks.create.mockResolvedValue({ id: 'del-1' })
  mocks.forkData.mockReset()
  mocks.forkData.mockResolvedValue({ id: 'con-1', customerId: 'cus-1' })
})

const contactUpdate = {
  event: 'contact.update',
  organizationId: 'org-1',
  entity: 'CustomerContact',
  entityId: 'con-1',
  data: { customerId: 'cus-1' },
}
const payloadOf = (call: number) => JSON.parse(mocks.create.mock.calls[call][0].data.payload)

describe('the dispatcher with the fork’s hook', () => {
  it('reads nothing and delivers nothing for a fork event nobody takes', async () => {
    mocks.webhooks.mockResolvedValue([{ id: 'wh-1', events: JSON.stringify(['customer.create']) }])
    await dispatchWebhookEvent(contactUpdate)
    expect(mocks.forkData).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('reads the record once for a subscriber, and sends it under the API’s name and kind', async () => {
    mocks.webhooks.mockResolvedValue([
      { id: 'wh-1', events: JSON.stringify(['contact.update']) },
      { id: 'wh-2', events: JSON.stringify(['*']) },
    ])
    await dispatchWebhookEvent(contactUpdate)
    expect(mocks.forkData).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(payloadOf(0)).toMatchObject({
      event: 'contact.update',
      entity: 'contact',
      entityId: 'con-1',
      data: { id: 'con-1', customerId: 'cus-1' },
    })
  })

  it('renames an app action to the API’s event before it matches subscribers', async () => {
    mocks.webhooks.mockResolvedValue([{ id: 'wh-1', events: JSON.stringify(['time_entry.stop']) }])
    mocks.forkData.mockResolvedValue({ id: 'te-1' })
    await dispatchWebhookEvent({
      event: 'timeEntry.update',
      organizationId: 'org-1',
      entity: 'timeEntry',
      entityId: 'te-1',
      data: { details: { key: 'timeEntry_stop' } },
    })
    expect(payloadOf(0)).toMatchObject({ event: 'time_entry.stop', entity: 'time_entry' })
  })

  it('leaves upstream’s own events as they were', async () => {
    mocks.webhooks.mockResolvedValue([{ id: 'wh-1', events: JSON.stringify(['*']) }])
    await dispatchWebhookEvent({
      event: 'customer.create',
      organizationId: 'org-1',
      entity: 'Customer',
      entityId: 'cus-1',
      data: { name: 'Acme' },
    })
    expect(mocks.forkData).not.toHaveBeenCalled()
    expect(payloadOf(0)).toMatchObject({
      event: 'customer.create',
      entity: 'Customer',
      data: { name: 'Acme' },
    })
  })
})
