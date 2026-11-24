/**
 * fork: what the import screen (M8) runs, on a real PostgreSQL (`npm run test:db`). The mapping saved on the screen
 * is what a load uses (a status's stage, a user matched to an existing technician); the screen's load job records a
 * dry run and a load where the screen reads them; a stopped extract stops and a resumed one carries on.
 *
 * Its own workshop, removed again. SYNTHETIC fixtures: extracts against the mock Shopmonkey.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectorContext } from '@/features/integrations/Lib/types'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
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
      where: { connectionId: shop.connectionId, entityType: 'Technician', remoteId: `user:${user.remoteId}` },
      select: { entityId: true },
    })
    expect(link.entityId).toBe(own.id)
  })

  it('refuses a load once the import is cut over, and says why', async () => {
    const { mergeState } = await import('@/integrations/shopmonkey/load/outcome')
    await mergeState(shop, { cutover: { at: new Date().toISOString(), userId: shop.userId } })
    try {
      const outcome = await runs['load.run'](await ctx(), { dryRun: true, userId: shop.userId })
      expect(outcome).toMatchObject({ summary: expect.stringMatching(/^Load refused: .*cut over/) })
      expect((await state()).loadRun).toMatchObject({ status: 'refused', message: expect.stringMatching(/cut over/) })
    } finally {
      await mergeState(shop, { cutover: null })
    }
  })
})
