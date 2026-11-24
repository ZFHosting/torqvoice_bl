/**
 * fork: the cutover on a real PostgreSQL (`npm run test:db`; docs/fork/milestones/M7-delta-and-cutover.md,
 * Acceptance, and docs/fork/CUTOVER.md). Without the operator's word it stops at step 1; a dry run on the fixture set
 * goes through every step and changes nothing; a line total corrupted in the database stops it at step 3, the
 * reconciliation; a real one goes through every step, and the sync stops: queued jobs cancelled, the schedule and the
 * webhook doing nothing, a second cutover refused.
 *
 * Its own workshop and data folder, removed again. SYNTHETIC fixtures: extracts against the mock Shopmonkey.
 */
import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectorContext } from '@/features/integrations/Lib/types'
import type { ExtractDeps } from '@/integrations/shopmonkey/extract/engine'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
const previousDataRoot = process.env.DATA_ROOT
const SECRET = `whsec_${Buffer.from('synthetic cutover webhook secret').toString('base64')}`
let dataRoot = ''
let db: typeof import('@/lib/db')['db']
let cutover: typeof import('@/integrations/shopmonkey/sync/cutover')
let shop: Awaited<ReturnType<typeof createWorkshop>>
let mock: ReturnType<typeof createMockShopmonkey>
let deps: ExtractDeps

/** A download of a file's link: a few bytes of the type its extension says. */
function download(link: URL): Promise<IncomingMessage> {
  const type = link.pathname.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'
  const stream = Readable.from([
    Buffer.from(`bytes of ${link.pathname}`),
  ]) as unknown as IncomingMessage
  stream.statusCode = 200
  stream.headers = { 'content-type': type }
  return Promise.resolve(stream)
}

const run = (over: { dryRun: boolean; shopStopped?: boolean }) =>
  cutover.runCutover({
    organizationId: shop.organizationId,
    connectionId: shop.connectionId,
    userId: shop.userId,
    shopStopped: over.shopStopped ?? true,
    dryRun: over.dryRun,
    deps,
  })

const state = async () =>
  (
    await db.integrationConnection.findUniqueOrThrow({
      where: { id: shop.connectionId },
      select: { state: true },
    })
  ).state as Record<string, unknown>

const settings = () =>
  db.appSetting.findMany({
    where: { organizationId: shop.organizationId },
    orderBy: { key: 'asc' },
    select: { key: true, value: true },
  })

const queueSync = () =>
  db.integrationJob.create({
    data: {
      connectionId: shop.connectionId,
      organizationId: shop.organizationId,
      kind: 'sync.delta',
      idempotencyKey: `schedule:sync.delta:${randomUUID()}`,
    },
    select: { id: true },
  })

async function ctx(): Promise<ConnectorContext> {
  return {
    connection: {
      id: shop.connectionId,
      organizationId: shop.organizationId,
      connectorId: 'shopmonkey',
      settings: { locationId: 'syn_loc_1' },
      state: await state(),
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

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  dataRoot = await mkdtemp(path.join(tmpdir(), 'shopmonkey-cutover-'))
  process.env.DATA_ROOT = dataRoot
  ;({ db } = await import('@/lib/db'))
  cutover = await import('@/integrations/shopmonkey/sync/cutover')
  const { createFileStager } = await import('@/integrations/shopmonkey/extract/files')
  const { createShopmonkeyClient } = await import('@/integrations/shopmonkey/client')
  const { extractSettings } = await import('@/integrations/shopmonkey/extract/engine')
  const { prismaSourceStore } = await import('@/integrations/shopmonkey/extract/stage')
  const { runLoad } = await import('@/integrations/shopmonkey/load/run')

  shop = await createWorkshop('Cutover')
  mock = createMockShopmonkey()
  const files = createFileStager({
    connectionId: shop.connectionId,
    root: dataRoot,
    open: download,
    check: async () => ({ ok: true }),
  })
  deps = {
    client: createShopmonkeyClient({
      fetch: mock.fetch,
      log: () => undefined,
      sleep: async () => undefined,
    }),
    store: prismaSourceStore(shop),
    files,
    settings: extractSettings({ locationId: 'syn_loc_1' }),
    companyId: 'syn_com_1',
    log: () => undefined,
  }
  await extractInto(mock, shop, files)
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
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT
  else process.env.DATA_ROOT = previousDataRoot
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
})

describe('a cutover', () => {
  it("stops at step 1 without the operator's word that the shop has stopped", async () => {
    const result = await run({ dryRun: true, shopStopped: false })
    expect(result).toMatchObject({ completed: false, stoppedAt: 1 })
    expect(result.steps).toHaveLength(1)
  })

  it('goes through every step as a dry run, and changes nothing in the workshop', async () => {
    const job = await queueSync()
    const settingsBefore = await settings()
    const result = await run({ dryRun: true })
    expect(result.steps.map((s) => [s.step, s.status])).toEqual([
      [1, 'done'],
      [2, 'would'],
      [3, 'done'],
      [4, 'would'],
      [5, 'would'],
      [6, 'would'],
      [7, 'done'],
    ])
    expect(result).toMatchObject({ dryRun: true, completed: true, stoppedAt: null })
    expect(result.reconciliation?.passed).toBe(true)
    expect(result.steps[5].detail).toMatch(/^1 queued sync jobs would be cancelled/)
    expect(result.steps[6].detail).toBe(cutover.REMINDER)
    expect((await state()).cutover).toBeUndefined()
    expect(await settings()).toEqual(settingsBefore)
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'queued',
    })
    await db.integrationJob.delete({ where: { id: job.id } })
  })

  it('stops at step 3 when a money gate fails, and changes nothing after it', async () => {
    const order = await db.sourceRecord.findFirstOrThrow({
      where: { organizationId: shop.organizationId, table: 'order', remoteId: 'syn_ord_1003' },
      select: { localId: true },
    })
    const line = await db.serviceLabor.findFirstOrThrow({
      where: {
        serviceRecordId: order.localId as string,
        OR: [
          { jobId: null },
          { job: { authorizationStatus: { not: 'Declined' }, deferredDate: null } },
        ],
        total: { gt: 0 },
      },
      select: { id: true, total: true },
    })
    await db.serviceLabor.update({ where: { id: line.id }, data: { total: line.total + 12.34 } })
    try {
      const settingsBefore = await settings()
      for (const dryRun of [true, false]) {
        const result = await run({ dryRun })
        expect(result).toMatchObject({ completed: false, stoppedAt: 3 })
        expect(result.steps).toHaveLength(3)
        expect(result.steps[2].detail).toMatch(/money/)
        expect(result.reconciliation?.gates.money.passed).toBe(false)
        expect((await state()).cutover).toBeUndefined()
        expect(await settings()).toEqual(settingsBefore)
      }
    } finally {
      await db.serviceLabor.update({ where: { id: line.id }, data: { total: line.total } })
    }
  })

  it('goes through every step for real, and then the sync stops', async () => {
    const job = await queueSync()
    // A delivery not acted on yet, about a change only a refetch sees (a vehicle has no list): step 2 reads it.
    mock.change('vehicle', 'syn_veh_1', { color: 'Green' })
    const refetch = await db.integrationJob.create({
      data: {
        connectionId: shop.connectionId,
        organizationId: shop.organizationId,
        kind: 'refetch',
        payload: { table: 'vehicle', id: 'syn_veh_1' },
        idempotencyKey: 'refetch:vehicle:syn_veh_1',
      },
      select: { id: true },
    })
    const result = await run({ dryRun: false })
    expect(result.steps.map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
    ])
    expect(result.completed).toBe(true)
    expect((await state()).cutover).toMatchObject({ userId: shop.userId })
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'failed',
      error: 'Cut over',
      idempotencyKey: null,
    })
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: refetch.id } })).toMatchObject({
      status: 'done',
    })
    const vehicle = await db.integrationLink.findFirstOrThrow({
      where: {
        connectionId: shop.connectionId,
        entityType: 'Vehicle',
        remoteId: 'vehicle:syn_veh_1',
      },
      select: { entityId: true },
    })
    expect(
      await db.vehicle.findUniqueOrThrow({
        where: { id: vehicle.entityId },
        select: { color: true },
      })
    ).toEqual({ color: 'green' }) // the transform keeps colours in lower case
    // The schedule is put off for good: the scheduler never finds it due again.
    expect((await state()).scheduleRuns).toMatchObject({ 'sync.delta': 8_640_000_000_000_000 })
    expect(
      await db.auditLog.count({
        where: { organizationId: shop.organizationId, action: 'shopmonkey.cutover' },
      })
    ).toBe(1)

    // The schedule and the webhook find the cutover and do nothing.
    const { createSyncJobs } = await import('@/integrations/shopmonkey/sync/jobs')
    const jobs = createSyncJobs({ depsFor: () => deps, extractFinished: async () => undefined })
    expect(await jobs['sync.delta'](await ctx(), {})).toEqual({ summary: 'Cut over: no sync' })
    expect(await jobs.refetch(await ctx(), { table: 'order', id: 'syn_ord_1003' })).toEqual({
      summary: 'order syn_ord_1003: not refetched, cut over',
    })
    const webhook = await import('@/integrations/shopmonkey/webhook')
    const text = JSON.stringify({
      operation: 'UPDATE',
      table: 'order',
      data: { id: 'syn_ord_1003' },
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const answer = await webhook.receive(
      new Request('http://localhost:3000/webhook', {
        method: 'POST',
        body: text,
        headers: {
          'webhook-id': 'msg_after_cutover',
          'webhook-timestamp': timestamp,
          'webhook-signature': `v1,${webhook.sign(webhook.secretKey(SECRET) as Buffer, 'msg_after_cutover', timestamp, text)}`,
        },
      }),
      await ctx()
    )
    expect(await answer.response?.json()).toEqual({ ok: true, ignored: 'cut over' })
    expect(
      await db.integrationJob.count({
        where: { connectionId: shop.connectionId, status: 'queued' },
      })
    ).toBe(0)

    await expect(run({ dryRun: true })).rejects.toMatchObject({ name: 'CutoverRefused' })

    // And nothing more is loaded or read from Shopmonkey.
    const { runLoad } = await import('@/integrations/shopmonkey/load/run')
    await expect(
      runLoad({
        organizationId: shop.organizationId,
        connectionId: shop.connectionId,
        runUserId: shop.userId,
      })
    ).rejects.toMatchObject({ name: 'LoadRefused' })
    const { startShopmonkeyExtract } = await import(
      '@/features/shopmonkey-import/Lib/startExtract.server'
    )
    await expect(
      startShopmonkeyExtract({
        organizationId: shop.organizationId,
        connectionId: shop.connectionId,
      })
    ).rejects.toThrow(/cut over/)
  })
})
