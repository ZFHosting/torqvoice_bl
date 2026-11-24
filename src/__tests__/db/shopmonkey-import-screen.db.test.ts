/**
 * fork: what the import screen (M8) runs, on a real PostgreSQL (`npm run test:db`). The mapping saved on the screen
 * is what a load uses (a status's stage, a user matched to an existing technician); the screen's load job records a
 * dry run and a load where the screen reads them; a running load beats, so the queue's ten-minute stuck recovery
 * leaves its job running and the screen keeps seeing it; a copy of a run that started (a crashed worker's, or one
 * already finished) never runs it again; a load before an extract has finished, or after cutover, is refused. A job
 * billed to a vehicle's previous owner is listed in the current owner's portal (blocker B10's default, spike T3).
 * (Stopping an extract is tested in `extract-jobs.test.ts`.)
 *
 * Its own workshop, removed again. SYNTHETIC fixtures: extracts against the mock Shopmonkey.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConnectorContext } from '@/features/integrations/Lib/types'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()

// The customer portal's session: whoever the test signs in as.
const portal = vi.hoisted(() => ({ customerId: '', organizationId: '' }))
vi.mock('@/features/portal/Lib/portalAuth', () => ({
  withPortalAuth: async (fn: (session: typeof portal) => Promise<unknown>) => ({
    success: true,
    data: await fn(portal),
  }),
}))
let db: typeof import('@/lib/db')['db']
let shop: Awaited<ReturnType<typeof createWorkshop>>
let mock: ReturnType<typeof createMockShopmonkey>
let runs: ReturnType<typeof import('@/integrations/shopmonkey/sync/runs')['createRunJobs']>

const state = async () =>
  (
    await db.integrationConnection.findUniqueOrThrow({
      where: { id: shop.connectionId },
      select: { state: true },
    })
  ).state as Record<string, never>

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
    credentials: { apiKey: 'sm-test-key' },
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
  ;({ db } = await import('@/lib/db'))
  const { createRunJobs } = await import('@/integrations/shopmonkey/sync/runs')
  const { createShopmonkeyClient } = await import('@/integrations/shopmonkey/client')
  const { extractSettings } = await import('@/integrations/shopmonkey/extract/engine')
  const { prismaSourceStore } = await import('@/integrations/shopmonkey/extract/stage')
  shop = await createWorkshop('Screen')
  mock = createMockShopmonkey()
  runs = createRunJobs({
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
  })
  await extractInto(mock, shop)
}, 180_000)

afterAll(async () => {
  if (shop) await shop.remove()
})

describe('the import screen', () => {
  it('records a dry run where the screen reads it, and writes nothing', async () => {
    const before = await db.customer.count({ where: { organizationId: shop.organizationId } })
    const outcome = await runs['load.run'](await ctx(), { dryRun: true, userId: shop.userId })
    expect(outcome).toMatchObject({ summary: expect.stringMatching(/^Dry run .* done$/) })
    const s = await state()
    expect(s.loadRun).toMatchObject({ status: 'done', dryRun: true })
    expect(s.lastDryRun).toMatchObject({ failureCount: 0 })
    expect(await db.customer.count({ where: { organizationId: shop.organizationId } })).toBe(before)
  })

  it('loads with the mapping saved on the screen: a status’s stage, a user matched to a technician', async () => {
    const { mergeState } = await import('@/integrations/shopmonkey/load/outcome')
    const own = await db.technician.create({
      data: { organizationId: shop.organizationId, name: 'Existing technician' },
      select: { id: true },
    })
    const user = await db.sourceRecord.findFirstOrThrow({
      where: { organizationId: shop.organizationId, table: 'user' },
      orderBy: { remoteId: 'asc' },
      select: { remoteId: true },
    })
    await mergeState(shop, {
      mapping: {
        // By position this one would be "in progress"; the operator says it's pending.
        statusStageMap: { syn_wfs_3: 'pending' },
        technicianMap: { [user.remoteId]: own.id },
      },
    })
    const outcome = await runs['load.run'](await ctx(), { dryRun: false, userId: shop.userId })
    expect(outcome).toMatchObject({ summary: expect.stringMatching(/^Load .* done$/) })
    expect((await state()).loadRun).toMatchObject({ status: 'done', dryRun: false })

    const status = await db.workOrderStatus.findFirstOrThrow({
      where: { organizationId: shop.organizationId, name: 'Waiting on parts' },
      select: { stage: true },
    })
    expect(status.stage).toBe('pending')
    const link = await db.integrationLink.findFirstOrThrow({
      where: {
        connectionId: shop.connectionId,
        entityType: 'Technician',
        remoteId: `user:${user.remoteId}`,
      },
      select: { entityId: true },
    })
    expect(link.entityId).toBe(own.id)
  })

  it('lists a job billed to a vehicle’s previous owner in the current owner’s portal (B10’s default)', async () => {
    const linked = async (entityType: string, remoteId: string) =>
      (
        await db.integrationLink.findFirstOrThrow({
          where: { connectionId: shop.connectionId, entityType, remoteId },
          select: { entityId: true },
        })
      ).entityId
    const vehicleId = await linked('Vehicle', 'vehicle:syn_veh_3')
    const jobId = await linked('ServiceRecord', 'order:syn_ord_1004')
    const vehicle = await db.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
      select: { customerId: true },
    })
    const job = await db.serviceRecord.findUniqueOrThrow({
      where: { id: jobId },
      select: { customerId: true },
    })
    // Billed to the previous owner (MAPPING §6.1), on the current owner's vehicle.
    expect(job.customerId).not.toBeNull()
    expect(job.customerId).not.toBe(vehicle.customerId)
    portal.organizationId = shop.organizationId
    portal.customerId = vehicle.customerId as string
    const { getPortalVehicleDetail } = await import('@/features/portal/Actions/portalActions')
    const detail = await getPortalVehicleDetail(vehicleId)
    expect(detail.success).toBe(true)
    const listed = (detail as { data: { serviceRecords: { id: string }[] } }).data.serviceRecords
    expect(listed.map((r) => r.id)).toContain(jobId)
  })

  it('leaves a running load alone when the queue starts a second copy of its job', async () => {
    const { mergeState } = await import('@/integrations/shopmonkey/load/outcome')
    const running = {
      status: 'running',
      dryRun: false,
      at: new Date().toISOString(),
      token: 'run-token-1',
    }
    await mergeState(shop, { loadRun: running })
    const before = await db.customer.count({ where: { organizationId: shop.organizationId } })
    const outcome = await runs['load.run'](await ctx(), {
      dryRun: false,
      userId: shop.userId,
      token: 'run-token-1',
    })
    expect(outcome).toEqual({ summary: 'This load already ran or is running' })
    expect((await state()).loadRun).toEqual(running)
    expect(await db.customer.count({ where: { organizationId: shop.organizationId } })).toBe(before)
  })

  it('keeps a long load’s job running past the queue’s stuck recovery, so the screen still sees it', async () => {
    const { mergeState } = await import('@/integrations/shopmonkey/load/outcome')
    const { keepAlive } = await import('@/integrations/shopmonkey/sync/runs')
    const { recoverStuckJobs } = await import('@/features/integrations/Lib/jobs')
    const { liveJobs } = await import('@/features/shopmonkey-import/Lib/liveJobs.server')
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000)
    const job = await db.integrationJob.create({
      data: {
        organizationId: shop.organizationId,
        connectionId: shop.connectionId,
        kind: 'load.run',
        status: 'running',
        lockedAt: elevenMinutesAgo,
        startedAt: elevenMinutesAgo,
        payload: { dryRun: false, userId: shop.userId, token: 'run-token-2' },
      },
      select: { id: true },
    })
    try {
      await mergeState(shop, {
        loadRun: {
          status: 'running',
          dryRun: false,
          at: elevenMinutesAgo.toISOString(),
          token: 'run-token-2',
        },
      })
      const stop = keepAlive(shop, 'load.run', 'loadRun', 50)
      await new Promise((resolve) => setTimeout(resolve, 400))
      stop()
      await recoverStuckJobs()
      const row = await db.integrationJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { status: true },
      })
      expect(row.status).toBe('running')
      expect((await liveJobs(shop.organizationId, shop.connectionId)).load).toBe(true)
      const beat = (await state()).loadRun as unknown as { beatAt?: string; status: string }
      expect(beat.status).toBe('running')
      expect(Date.now() - Date.parse(beat.beatAt ?? '')).toBeLessThan(60_000)
    } finally {
      await db.integrationJob.delete({ where: { id: job.id } })
    }
  })

  it('marks a run failed when the worker running it stopped, and never runs a finished one again', async () => {
    const { mergeState } = await import('@/integrations/shopmonkey/load/outcome')
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    const before = await db.customer.count({ where: { organizationId: shop.organizationId } })
    await mergeState(shop, {
      loadRun: { status: 'running', dryRun: false, at: stale, beatAt: stale, token: 'run-token-3' },
    })
    const crashed = await runs['load.run'](await ctx(), {
      dryRun: false,
      userId: shop.userId,
      token: 'run-token-3',
    })
    expect(crashed?.summary).toMatch(/stopped: marked failed/)
    expect((await state()).loadRun).toMatchObject({ status: 'failed', token: 'run-token-3' })
    // A copy of a run that finished (here: failed) leaves it as it is.
    const again = await runs['load.run'](await ctx(), {
      dryRun: false,
      userId: shop.userId,
      token: 'run-token-3',
    })
    expect(again).toEqual({ summary: 'This load already ran or is running' })
    expect((await state()).loadRun).toMatchObject({ status: 'failed' })
    // The same for a cutover.
    await mergeState(shop, {
      cutoverRun: { status: 'done', dryRun: true, at: stale, token: 'cut-token-1' },
    })
    expect(
      await runs['cutover.run'](await ctx(), {
        dryRun: true,
        userId: shop.userId,
        token: 'cut-token-1',
      })
    ).toEqual({ summary: 'This cutover already ran or is running' })
    expect(await db.customer.count({ where: { organizationId: shop.organizationId } })).toBe(before)
  })

  it('puts a dry run back in the queue, with its token, while another load holds the lock', async () => {
    const { withLoadLock } = await import('@/integrations/shopmonkey/load/lock')
    let outcome: Awaited<ReturnType<(typeof runs)['load.run']>> | undefined
    await withLoadLock(shop.connectionId, async () => {
      outcome = await runs['load.run'](await ctx(), {
        dryRun: true,
        userId: shop.userId,
        token: 'run-token-5',
      })
    })
    try {
      expect(outcome?.summary).toMatch(/queued again/)
      expect((await state()).loadRun).toMatchObject({ status: 'queued', token: 'run-token-5' })
      const again = await db.integrationJob.findFirstOrThrow({
        where: { connectionId: shop.connectionId, kind: 'load.run', status: 'queued' },
        select: { payload: true, maxAttempts: true, runAfter: true },
      })
      expect(again.payload).toMatchObject({ dryRun: true, token: 'run-token-5' })
      expect(again.maxAttempts).toBe(1)
      expect(again.runAfter.getTime()).toBeGreaterThan(Date.now())
    } finally {
      await db.integrationJob.deleteMany({
        where: { connectionId: shop.connectionId, kind: 'load.run' },
      })
    }
  })

  it('refuses a load from the screen until an extract has finished', async () => {
    const { mergeState } = await import('@/integrations/shopmonkey/load/outcome')
    const finished = (await state()).extract
    try {
      await mergeState(shop, {
        extract: { ...(finished as object), finishedAt: null, sync: false },
      })
      const outcome = await runs['load.run'](await ctx(), {
        dryRun: true,
        userId: shop.userId,
        token: 'run-token-4',
      })
      expect(outcome?.summary).toMatch(/^Load refused: The extract has not finished/)
      expect((await state()).loadRun).toMatchObject({ status: 'refused', token: 'run-token-4' })
    } finally {
      await mergeState(shop, { extract: finished })
    }
  })

  it('refuses a load once the import is cut over, and says why', async () => {
    const { mergeState } = await import('@/integrations/shopmonkey/load/outcome')
    await mergeState(shop, { cutover: { at: new Date().toISOString(), userId: shop.userId } })
    try {
      const outcome = await runs['load.run'](await ctx(), { dryRun: true, userId: shop.userId })
      expect(outcome).toMatchObject({ summary: expect.stringMatching(/^Load refused: .*cut over/) })
      expect((await state()).loadRun).toMatchObject({
        status: 'refused',
        message: expect.stringMatching(/cut over/),
      })
    } finally {
      await mergeState(shop, { cutover: null })
    }
  })
})
