/**
 * fork: the sync window on a real PostgreSQL (`npm run test:db`; docs/fork/milestones/M7-delta-and-cutover.md,
 * Acceptance). A delivery replayed queues nothing new, even after its job was claimed; an order changed in Shopmonkey
 * and delivered by webhook is updated within one job run; the ten-minute delta catches a change no webhook told of; an
 * edit made in Torqvoice is overwritten by Shopmonkey's next change, with a warning; a Shopmonkey delete removes an
 * untouched work order (with its tombstone) and keeps an edited appointment, listed; two loads never run at once.
 *
 * Its own workshop, removed again. SYNTHETIC fixtures: extracts against the mock Shopmonkey.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectorContext } from '@/features/integrations/Lib/types'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
const SECRET = `whsec_${Buffer.from('synthetic webhook secret for the tests').toString('base64')}`
let db: typeof import('@/lib/db')['db']
let webhook: typeof import('@/integrations/shopmonkey/webhook')
let jobs: ReturnType<typeof import('@/integrations/shopmonkey/sync/jobs')['createSyncJobs']>
let shop: Awaited<ReturnType<typeof createWorkshop>>
let mock: ReturnType<typeof createMockShopmonkey>

async function ctx(): Promise<ConnectorContext> {
  const connection = await db.integrationConnection.findUniqueOrThrow({
    where: { id: shop.connectionId },
    select: { state: true },
  })
  return {
    connection: {
      id: shop.connectionId,
      organizationId: shop.organizationId,
      connectorId: 'shopmonkey',
      settings: { locationId: 'syn_loc_1' },
      state: (connection.state as Record<string, unknown>) ?? {},
      externalAccountId: 'syn_com_1',
    },
    credentials: { apiKey: 'sm-test-key', webhookSecret: SECRET },
    http: { fetch: mock.fetch } as unknown as ConnectorContext['http'],
    links: {} as ConnectorContext['links'],
    log: async () => undefined,
    saveState: async () => undefined,
    timezone: 'UTC',
    appUrl: 'http://localhost:3000',
  }
}

/** A signed delivery, as Shopmonkey sends it (Standard Webhooks), made fresh each call: a body reads once. */
function delivery(body: Record<string, unknown>, id = `msg_${randomUUID()}`) {
  const text = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = webhook.secretKey(SECRET) as Buffer
  return () =>
    new Request(`http://localhost:3000/api/integrations/shopmonkey/${shop.connectionId}/webhook`, {
      method: 'POST',
      body: text,
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${webhook.sign(key, id, timestamp, text)}`,
      },
    })
}

const queued = (kind: string) =>
  db.integrationJob.findMany({
    where: { connectionId: shop.connectionId, kind, status: 'queued' },
    orderBy: { createdAt: 'asc' },
  })

/** Each queued job of a kind, run as the queue runs it: claimed (its key released), handled, done. */
async function runQueued(kind: 'refetch' | 'sync.delta' | 'sync.load') {
  const out: unknown[] = []
  for (const job of await queued(kind)) {
    await db.integrationJob.update({
      where: { id: job.id },
      data: { status: 'running', idempotencyKey: null },
    })
    out.push(await jobs[kind](await ctx(), (job.payload as Record<string, unknown>) ?? {}))
    await db.integrationJob.update({ where: { id: job.id }, data: { status: 'done' } })
  }
  return out
}

/** The ten-minute delta, run until it's done (it hands back to the queue after its budget). */
async function runDelta() {
  for (let i = 0; i < 20; i++) {
    const outcome = (await jobs['sync.delta'](await ctx(), {})) as {
      summary?: string
      rescheduleInSeconds?: number
    }
    if (!outcome.rescheduleInSeconds) return outcome
  }
  throw new Error('The delta did not finish')
}

const localOf = async (model: string, table: string, remoteId: string) =>
  (
    await db.integrationLink.findFirstOrThrow({
      where: {
        connectionId: shop.connectionId,
        entityType: model,
        remoteId: `${table}:${remoteId}`,
      },
      select: { entityId: true },
    })
  ).entityId

const state = async () =>
  (
    await db.integrationConnection.findUniqueOrThrow({
      where: { id: shop.connectionId },
      select: { state: true },
    })
  ).state as Record<string, never>

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  webhook = await import('@/integrations/shopmonkey/webhook')
  const { createSyncJobs } = await import('@/integrations/shopmonkey/sync/jobs')
  const { createShopmonkeyClient } = await import('@/integrations/shopmonkey/client')
  const { extractSettings } = await import('@/integrations/shopmonkey/extract/engine')
  const { prismaSourceStore } = await import('@/integrations/shopmonkey/extract/stage')
  const { runLoad } = await import('@/integrations/shopmonkey/load/run')

  shop = await createWorkshop('Delta')
  mock = createMockShopmonkey()
  jobs = createSyncJobs({
    depsFor: () => ({
      client: createShopmonkeyClient({
        fetch: mock.fetch,
        log: () => undefined,
        sleep: async () => undefined,
      }),
      store: prismaSourceStore(shop),
      files: {
        fetchUrl: async () => ({ skipped: 'not_found' as const }),
        write: async () => ({ skipped: 'too_large' as const }),
      },
      settings: extractSettings({ locationId: 'syn_loc_1' }),
      companyId: 'syn_com_1',
      log: () => undefined,
    }),
    extractFinished: async () => undefined,
  })
  // The backfill and the operator's first load: the sync only ever loads after that one.
  await extractInto(mock, shop)
  const first = await runLoad({
    organizationId: shop.organizationId,
    connectionId: shop.connectionId,
    runUserId: shop.userId,
    now: NOW,
  })
  expect(first.failures).toEqual([])
}, 180_000)

afterAll(async () => {
  if (shop) await shop.remove()
})

describe('a webhook delivery', () => {
  it('queues one refetch, and a replay of it queues nothing new, even after its job was claimed', async () => {
    const body = { operation: 'UPDATE', table: 'order', data: { id: 'syn_ord_1004' } }
    const send = delivery(body)
    const answer = await webhook.receive(send(), await ctx())
    expect(answer.jobs).toEqual([])
    expect(answer.response?.status).toBe(200)
    expect((await queued('refetch')).map((j) => j.payload)).toEqual([
      { table: 'order', id: 'syn_ord_1004' },
    ])

    const replay = await webhook.receive(send(), await ctx())
    expect(await replay.response?.json()).toEqual({ ok: true, duplicate: true })
    expect(await queued('refetch')).toHaveLength(1)

    // The queue releases a job's key when it claims it: the delivery's own record still knows it.
    const [job] = await queued('refetch')
    await db.integrationJob.update({
      where: { id: job.id },
      data: { status: 'running', idempotencyKey: null },
    })
    await webhook.receive(send(), await ctx())
    expect(await queued('refetch')).toHaveLength(0)
    await db.integrationJob.update({ where: { id: job.id }, data: { status: 'done' } })

    // Another delivery about the same order, while one waits for it, joins the waiting one.
    await webhook.receive(delivery(body)(), await ctx())
    await webhook.receive(delivery(body)(), await ctx())
    expect(await queued('refetch')).toHaveLength(1)
    await db.integrationJob.deleteMany({ where: { connectionId: shop.connectionId } })
  })

  it('is refused when its signature is wrong, and queues nothing', async () => {
    const send = delivery({ operation: 'UPDATE', table: 'order', data: { id: 'syn_ord_1004' } })
    const tampered = send()
    const forged = new Request(tampered.url, {
      method: 'POST',
      headers: tampered.headers,
      body: JSON.stringify({ operation: 'UPDATE', table: 'order', data: { id: 'syn_ord_1003' } }),
    })
    await expect(webhook.receive(forged, await ctx())).rejects.toThrow(/Signature refused/)
    expect(await queued('refetch')).toHaveLength(0)
  })

  it('updates an order changed in Shopmonkey within one job run', async () => {
    mock.change('order', 'syn_ord_1002', { name: 'Changed in Shopmonkey during the sync' })
    await webhook.receive(
      delivery({ operation: 'UPDATE', table: 'order', data: { id: 'syn_ord_1002' } })(),
      await ctx()
    )
    const [outcome] = await runQueued('refetch')
    expect(outcome).toMatchObject({
      summary: expect.stringMatching(/syn_ord_1002: staged; loaded/),
    })
    const record = await db.serviceRecord.findFirstOrThrow({
      where: {
        id: await localOf('ServiceRecord', 'order', 'syn_ord_1002'),
        organizationId: shop.organizationId,
      },
      select: { title: true },
    })
    expect(record.title).toBe('Changed in Shopmonkey during the sync')
    expect((await state()).lastSync).toMatchObject({ deleted: 0, keptDeleteCount: 0 })
  })

  it('loads once for a burst: the last refetch waiting loads what the others staged', async () => {
    mock.change('customer', 'syn_cus_1', { note: 'Burst' })
    mock.change('customer', 'syn_cus_2', { note: 'Burst' })
    for (const id of ['syn_cus_1', 'syn_cus_2']) {
      await webhook.receive(
        delivery({ operation: 'UPDATE', table: 'customer', data: { id } })(),
        await ctx()
      )
    }
    const outcomes = (await runQueued('refetch')) as { summary: string }[]
    expect(outcomes[0].summary).toMatch(/load left to the next refetch/)
    expect(outcomes[1].summary).toMatch(/loaded/)
    for (const id of ['syn_cus_1', 'syn_cus_2']) {
      const customer = await db.customer.findFirstOrThrow({
        where: {
          id: await localOf('Customer', 'customer', id),
          organizationId: shop.organizationId,
        },
        select: { notes: true },
      })
      expect(customer.notes).toBe('Burst')
    }
  })
})

describe('the ten-minute delta', () => {
  it('catches a change no webhook told of', async () => {
    mock.changeAt('order', 'syn_ord_1002', '2026-02-01T09:00:00.000Z', { name: 'Polled' })
    const outcome = await runDelta()
    expect(outcome.summary).toMatch(/^[1-9]\d* records changed in Shopmonkey; loaded/)
    const record = await db.serviceRecord.findFirstOrThrow({
      where: {
        id: await localOf('ServiceRecord', 'order', 'syn_ord_1002'),
        organizationId: shop.organizationId,
      },
      select: { title: true },
    })
    expect(record.title).toBe('Polled')
    // Its watermark moved on: the next delta starts from the change it saw.
    expect((await state()).extract).toMatchObject({
      sync: true,
      watermarks: { order: '2026-02-01T09:00:00.000Z' },
    })
  })

  it('loads nothing when nothing changed', async () => {
    expect((await runDelta()).summary).toBe('0 records changed in Shopmonkey; nothing changed')
  })
})

describe('an edit made in Torqvoice during the sync window', () => {
  it("is overwritten by Shopmonkey's next change to the record, with a warning", async () => {
    const id = await localOf('Customer', 'customer', 'syn_cus_4')
    // A while after the last load: the edit is the workshop's, not the load's.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await db.customer.update({ where: { id }, data: { notes: 'Edited in Torqvoice' } })
    mock.change('customer', 'syn_cus_4', { note: 'Changed in Shopmonkey' })
    await webhook.receive(
      delivery({ operation: 'UPDATE', table: 'customer', data: { id: 'syn_cus_4' } })(),
      await ctx()
    )
    await runQueued('refetch')
    const lastLoad = (await state()).lastLoad as {
      warnings: Record<string, { examples: unknown[] }>
    }
    expect(lastLoad.warnings.local_edit_overwritten.examples).toEqual([
      expect.objectContaining({ table: 'customer', remoteId: 'syn_cus_4' }),
    ])
  })

  it('stays an edit when it is made while a load runs (the load syncs only what it wrote)', async () => {
    const { runLoad } = await import('@/integrations/shopmonkey/load/run')
    const id = await localOf('Customer', 'customer', 'syn_cus_2')
    const loading = runLoad({
      organizationId: shop.organizationId,
      connectionId: shop.connectionId,
      runUserId: shop.userId,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await db.customer.update({ where: { id }, data: { notes: 'Edited while a load ran' } })
    await loading
    const row = await db.customer.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })
    const link = await db.integrationLink.findFirstOrThrow({
      where: { connectionId: shop.connectionId, entityType: 'Customer', entityId: id },
      select: { lastSyncedAt: true },
    })
    expect(row.updatedAt.getTime()).toBeGreaterThan(link.lastSyncedAt.getTime())
    // So Shopmonkey's next change to it warns.
    mock.changeAt('customer', 'syn_cus_2', '2026-02-15T00:00:00.000Z', { note: 'Shopmonkey again' })
    await webhook.receive(
      delivery({ operation: 'UPDATE', table: 'customer', data: { id: 'syn_cus_2' } })(),
      await ctx()
    )
    await runQueued('refetch')
    const lastLoad = (await state()).lastLoad as {
      warnings: Record<string, { examples: unknown[] }>
    }
    expect(lastLoad.warnings.local_edit_overwritten.examples).toEqual([
      expect.objectContaining({ table: 'customer', remoteId: 'syn_cus_2' }),
    ])
  })

  it("isn't warned of when the record changes in Shopmonkey again, nobody having edited it since", async () => {
    mock.changeAt('customer', 'syn_cus_4', '2026-03-01T00:00:00.000Z', { note: 'Again' })
    await webhook.receive(
      delivery({ operation: 'UPDATE', table: 'customer', data: { id: 'syn_cus_4' } })(),
      await ctx()
    )
    await runQueued('refetch')
    const lastLoad = (await state()).lastLoad as { warnings: Record<string, unknown> }
    expect(lastLoad.warnings.local_edit_overwritten).toBeUndefined()
  })
})

describe('a record deleted in Shopmonkey', () => {
  it('keeps an appointment edited in Torqvoice since its last sync, and lists it', async () => {
    const id = await localOf('Appointment', 'appointment', 'syn_apt_1')
    await new Promise((resolve) => setTimeout(resolve, 50))
    await db.appointment.update({ where: { id }, data: { title: 'Moved by the workshop' } })
    mock.remove('appointment', 'syn_apt_1')
    await webhook.receive(
      delivery({ operation: 'DELETE', table: 'appointment', data: { id: 'syn_apt_1' } })(),
      await ctx()
    )
    const [outcome] = (await runQueued('refetch')) as { summary: string }[]
    expect(outcome.summary).toMatch(/syn_apt_1: gone; loaded .*0 deleted, 1 deletes kept/)
    expect(await db.appointment.count({ where: { id } })).toBe(1)
    expect((await state()).lastSync).toMatchObject({
      keptDeletes: [
        { table: 'appointment', remoteId: 'syn_apt_1', model: 'Appointment', reason: 'edited' },
      ],
    })
  })

  it('keeps a work order the workshop added a status report to, even after Shopmonkey changed it since', async () => {
    const id = await localOf('ServiceRecord', 'order', 'syn_ord_1003')
    await db.statusReport.create({
      data: {
        organizationId: shop.organizationId,
        serviceRecordId: id,
        publicToken: `syn-${randomUUID()}`,
        title: 'Brake video',
      },
    })
    // Shopmonkey changes the order, and the load syncs it again: the report is still the workshop's.
    mock.changeAt('order', 'syn_ord_1003', '2026-02-20T00:00:00.000Z', { name: 'Brakes, revised' })
    await webhook.receive(
      delivery({ operation: 'UPDATE', table: 'order', data: { id: 'syn_ord_1003' } })(),
      await ctx()
    )
    await runQueued('refetch')
    mock.remove('order', 'syn_ord_1003')
    await webhook.receive(
      delivery({ operation: 'DELETE', table: 'order', data: { id: 'syn_ord_1003' } })(),
      await ctx()
    )
    await runQueued('refetch')
    expect(await db.serviceRecord.count({ where: { id } })).toBe(1)
    expect(await db.statusReport.count({ where: { serviceRecordId: id } })).toBe(1)
    expect((await state()).lastSync).toMatchObject({
      keptDeletes: expect.arrayContaining([
        { table: 'order', remoteId: 'syn_ord_1003', model: 'ServiceRecord', reason: 'edited' },
      ]),
    })
  })

  it('keeps a work order the workshop took a payment on, even after Shopmonkey changed it since', async () => {
    const id = await localOf('ServiceRecord', 'order', 'syn_ord_1004')
    await db.payment.create({ data: { serviceRecordId: id, amount: 10, method: 'cash' } })
    mock.changeAt('order', 'syn_ord_1004', '2026-02-21T00:00:00.000Z', {
      name: 'Check engine, revised',
    })
    await webhook.receive(
      delivery({ operation: 'UPDATE', table: 'order', data: { id: 'syn_ord_1004' } })(),
      await ctx()
    )
    await runQueued('refetch')
    mock.remove('order', 'syn_ord_1004')
    await webhook.receive(
      delivery({ operation: 'DELETE', table: 'order', data: { id: 'syn_ord_1004' } })(),
      await ctx()
    )
    await runQueued('refetch')
    expect(await db.serviceRecord.count({ where: { id } })).toBe(1)
    expect((await state()).lastSync).toMatchObject({
      keptDeletes: expect.arrayContaining([
        { table: 'order', remoteId: 'syn_ord_1004', model: 'ServiceRecord', reason: 'edited' },
      ]),
    })
  })

  it('deletes a work order untouched since its last sync, with its tombstone', async () => {
    const id = await localOf('ServiceRecord', 'order', 'syn_ord_1002')
    // Its parts came from Shopmonkey's counts and never left the shelf here: the delete puts nothing back.
    const stock = () =>
      db.inventoryPart.findMany({
        where: { organizationId: shop.organizationId },
        orderBy: { id: 'asc' },
        select: { id: true, quantity: true },
      })
    const stockBefore = await stock()
    const linked = await db.servicePart.count({
      where: { serviceRecordId: id, inventoryPartId: { not: null } },
    })
    expect(linked).toBeGreaterThan(0)
    mock.remove('order', 'syn_ord_1002')
    await webhook.receive(
      delivery({ operation: 'DELETE', table: 'order', data: { id: 'syn_ord_1002' } })(),
      await ctx()
    )
    const [outcome] = (await runQueued('refetch')) as { summary: string }[]
    expect(outcome.summary).toMatch(/syn_ord_1002: gone; loaded .*1 deleted/)
    expect(await db.serviceRecord.count({ where: { id } })).toBe(0)
    expect(
      await db.deletedRecord.count({
        where: { organizationId: shop.organizationId, entityType: 'work_order', entityId: id },
      })
    ).toBe(1)
    // The archive keeps it, marked deleted and no longer mapped to a row.
    const archived = await db.sourceRecord.findFirstOrThrow({
      where: { organizationId: shop.organizationId, table: 'order', remoteId: 'syn_ord_1002' },
      select: { remoteDeletedAt: true, localId: true },
    })
    expect(archived.remoteDeletedAt).not.toBeNull()
    expect(archived.localId).toBeNull()
    expect((await state()).lastSync).toMatchObject({ deleted: 1 })
    expect(await stock()).toEqual(stockBefore)
    expect(
      await db.stockMovement.count({
        where: { organizationId: shop.organizationId, reason: 'service_record_deleted' },
      })
    ).toBe(0)
    // One audit event for the deletes, naming them.
    expect(
      await db.auditLog.count({
        where: { organizationId: shop.organizationId, action: 'shopmonkey.sync_delete' },
      })
    ).toBe(1)
  })
})

describe('two loads at once', () => {
  it('never happen: the second is refused while the first holds the lock', async () => {
    const { withLoadLock } = await import('@/integrations/shopmonkey/load/lock')
    const { runLoad } = await import('@/integrations/shopmonkey/load/run')
    const load = () =>
      runLoad({
        organizationId: shop.organizationId,
        connectionId: shop.connectionId,
        runUserId: shop.userId,
      })
    await withLoadLock(shop.connectionId, async () => {
      await expect(load()).rejects.toMatchObject({ name: 'LoadBusy' })
      // A dry run writes nothing and isn't held up.
      await expect(
        runLoad({
          organizationId: shop.organizationId,
          connectionId: shop.connectionId,
          runUserId: shop.userId,
          dryRun: true,
        })
      ).resolves.toMatchObject({ dryRun: true })
    })
    await expect(load()).resolves.toMatchObject({ dryRun: false })
  })

  it("puts the sync's load off while another runs, and queues it again", async () => {
    const { withLoadLock } = await import('@/integrations/shopmonkey/load/lock')
    await withLoadLock(shop.connectionId, async () => {
      mock.changeAt('customer', 'syn_cus_1', '2026-04-01T00:00:00.000Z', { firstName: 'Later' })
      await webhook.receive(
        delivery({ operation: 'UPDATE', table: 'customer', data: { id: 'syn_cus_1' } })(),
        await ctx()
      )
      const [outcome] = (await runQueued('refetch')) as { summary: string }[]
      expect(outcome.summary).toMatch(/another load is running: queued again/)
    })
    expect(
      await db.integrationJob.count({
        where: { connectionId: shop.connectionId, kind: 'sync.load', status: 'queued' },
      })
    ).toBe(1)
    await db.integrationJob.updateMany({
      where: { connectionId: shop.connectionId, kind: 'sync.load' },
      data: { runAfter: new Date() },
    })
    const [later] = (await runQueued('sync.load')) as { summary: string }[]
    expect(later.summary).toMatch(/^loaded/)
    const customer = await db.customer.findFirstOrThrow({
      where: {
        id: await localOf('Customer', 'customer', 'syn_cus_1'),
        organizationId: shop.organizationId,
      },
      select: { name: true },
    })
    expect(customer.name).toMatch(/^Later /)
  })
})
