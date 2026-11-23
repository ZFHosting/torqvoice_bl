/**
 * fork: the Shopmonkey extractor on a real PostgreSQL (`npm run test:db`; M3 acceptance). The unit
 * tests run the same flows on an in-memory store; this proves the Prisma store means the same thing:
 * a full extract against the mock Shopmonkey stages every fixture record and a second writes nothing,
 * the children sweep's SQL finds exactly the parents that changed, a child gone from its parent is
 * marked deleted through a JSON path, and one workshop never sees another's archive.
 *
 * Its own two workshops, removed again; it empties nothing. SYNTHETIC fixtures.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey, loadFixtures } from '../features/integrations/shopmonkey/mockServer'

const url = process.env.E2E_DATABASE_URL ?? ''
const databaseName = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
if (url && !/test|e2e/.test(databaseName)) {
  throw new Error(
    `Refusing to use database "${databaseName}": its name must say test or e2e, like the rest of this suite.`
  )
}
process.env.DATABASE_URL = url

const stamp = randomUUID().slice(0, 8)
const NOW = new Date('2025-06-01T00:00:00.000Z')

let db: typeof import('@/lib/db')['db']
let stage: typeof import('@/integrations/shopmonkey/extract/stage')
let engine: typeof import('@/integrations/shopmonkey/extract/engine')
let plan: typeof import('@/integrations/shopmonkey/extract/plan')
let client: typeof import('@/integrations/shopmonkey/client')
let orgA = ''
let orgB = ''
const users: string[] = []

function depsFor(organizationId: string, mock: ReturnType<typeof createMockShopmonkey>) {
  return {
    client: client.createShopmonkeyClient({
      fetch: mock.fetch,
      log: () => undefined,
      sleep: async () => undefined,
    }),
    store: stage.prismaSourceStore({ organizationId, connectionId: `conn-${stamp}` }),
    files: {
      fetchUrl: async (table: string, remoteId: string) => ({
        path: `shopmonkey-staging/conn/${table}/${remoteId}`,
        bytes: 1,
        sha256: 'a'.repeat(64),
        contentType: 'image/jpeg',
      }),
      write: async (table: string, remoteId: string) => ({
        path: `shopmonkey-staging/conn/${table}/${remoteId}.pdf`,
        bytes: 1,
        sha256: 'b'.repeat(64),
        contentType: 'application/pdf',
      }),
    },
    settings: engine.extractSettings({ locationId: 'syn_loc_1' }),
    companyId: 'syn_com_1',
    log: () => undefined,
    now: () => NOW,
  }
}

async function runAll(
  deps: ReturnType<typeof depsFor>,
  previous: import('@/integrations/shopmonkey/extract/plan').ExtractState | null
) {
  let state = plan.startState(previous, { runId: randomUUID(), now: NOW })
  for (let i = 0; i < 2_000; i++) {
    const result = await engine.extractStep(deps, state)
    state = result.state
    if (result.done) return state
  }
  throw new Error('The extract did not finish')
}

const snapshot = async (organizationId: string) =>
  (
    await db.sourceRecord.findMany({
      where: { organizationId },
      select: { id: true, updatedAt: true },
      orderBy: { id: 'asc' },
    })
  ).map((r) => `${r.id}@${r.updatedAt.toISOString()}`)

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  stage = await import('@/integrations/shopmonkey/extract/stage')
  engine = await import('@/integrations/shopmonkey/extract/engine')
  plan = await import('@/integrations/shopmonkey/extract/plan')
  client = await import('@/integrations/shopmonkey/client')
  orgA = (await db.organization.create({ data: { name: `Extract A ${stamp}` } })).id
  orgB = (await db.organization.create({ data: { name: `Extract B ${stamp}` } })).id
})

afterAll(async () => {
  if (!db) return
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB].filter(Boolean) } } })
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
})

describe('a full extract into PostgreSQL', () => {
  it('stages every fixture record, and the second run writes nothing', async () => {
    const mock = createMockShopmonkey()
    const deps = depsFor(orgA, mock)
    const first = await runAll(deps, null)
    for (const [table, records] of Object.entries(loadFixtures())) {
      const count = await db.sourceRecord.count({ where: { organizationId: orgA, table } })
      expect(count, table).toBe(records.length)
    }
    const order = await db.sourceRecord.findFirst({
      where: { organizationId: orgA, table: 'order', remoteId: 'syn_ord_1003' },
    })
    expect(order?.payload).toEqual(loadFixtures().order.find((o) => o.id === 'syn_ord_1003'))
    expect(order?.childrenHash).toBe(order?.payloadHash)
    expect(order?.connectionId).toBe(`conn-${stamp}`)
    expect(order?.remoteUpdatedAt).toBeInstanceOf(Date)

    const before = await snapshot(orgA)
    await runAll(deps, first)
    expect(await snapshot(orgA)).toEqual(before)
  })

  it('finds exactly the changed parent in the children sweep, and marks a removed service deleted', async () => {
    const mock = createMockShopmonkey()
    const deps = depsFor(orgA, mock)
    const store = deps.store
    expect(await store.pendingChildren('order', null, 50)).toEqual([])

    mock.change('order', 'syn_ord_1003', { complaint: 'Changed in Shopmonkey' })
    const page = await deps.client.listPage<Record<string, unknown>>('/v3/order', 0)
    await store.stage(
      'order',
      page.rows.map((payload) => ({ payload }))
    )
    const pending = await store.pendingChildren('order', null, 50)
    expect(pending.map((p) => p.remoteId)).toEqual(['syn_ord_1003'])
    expect(pending[0].payload).toMatchObject({ complaint: 'Changed in Shopmonkey' })
    // After the cursor, nothing.
    expect(await store.pendingChildren('order', pending[0].id, 50)).toEqual([])

    const gone = await store.markGone(
      'order_service',
      ['orderId'],
      'syn_ord_1003',
      ['syn_svc_1003_1', 'syn_svc_1003_2', 'syn_svc_1003_3'],
      NOW
    )
    expect(gone).toBe(1)
    const removed = await db.sourceRecord.findFirst({
      where: { organizationId: orgA, table: 'order_service', remoteId: 'syn_svc_1003_4' },
    })
    expect(removed?.remoteDeletedAt).toEqual(NOW)
    expect(
      await store.markGone(
        'order_file',
        ['_parent', 'remoteId'],
        'syn_ord_1003',
        ['syn_ofl_1'],
        NOW
      )
    ).toBe(0)

    // Children marked fetched only for the payload they were fetched for.
    await store.markChildrenFetched('order', 'syn_ord_1003', 'not-the-hash')
    expect(await store.pendingChildren('order', null, 50)).toHaveLength(1)
    await store.markChildrenFetched('order', 'syn_ord_1003', pending[0].payloadHash)
    expect(await store.pendingChildren('order', null, 50)).toEqual([])

    await store.resetChildren('order')
    expect(await store.pendingChildren('order', null, 50)).toHaveLength(5)
  })

  it('keeps each workshop’s archive to itself', async () => {
    const storeB = stage.prismaSourceStore({
      organizationId: orgB,
      connectionId: `conn-b-${stamp}`,
    })
    const order = loadFixtures().order[0]
    expect(await storeB.stage('order', [{ payload: order }])).toEqual([
      { remoteId: order.id, hash: stage.payloadHash(order), result: 'created' },
    ])
    expect((await storeB.pendingChildren('order', null, 50)).map((p) => p.remoteId)).toEqual([
      order.id,
    ])
    expect(await storeB.hashes('customer', ['syn_cus_1'])).toEqual(new Map())
    await storeB.resetChildren('order')
    const storeA = stage.prismaSourceStore({ organizationId: orgA, connectionId: `conn-${stamp}` })
    expect((await storeA.hashes('order', [String(order.id)])).size).toBe(1)
    expect(await db.sourceRecord.count({ where: { organizationId: orgB } })).toBe(1)
  })
})

describe('saving a run’s checkpoint', () => {
  it('goes through only while the run is the connection’s, and only in its workshop', async () => {
    const { saveExtractState } = await import(
      '@/features/shopmonkey-import/Lib/extractState.server'
    )
    const user = await db.user.create({
      data: { email: `extract-owner-${stamp}@example.com`, name: 'Owner' },
    })
    users.push(user.id)
    const connection = await db.integrationConnection.create({
      data: {
        organizationId: orgA,
        connectorId: 'shopmonkey',
        createdById: user.id,
        state: { other: 1, extract: { runId: 'run-1' } },
      },
    })
    const scope = { connectionId: connection.id, organizationId: orgA }
    const run1 = { ...plan.startState(null, { runId: 'run-1', now: NOW }), step: 3 }
    const stateOf = async () =>
      (await db.integrationConnection.findUnique({ where: { id: connection.id } }))
        ?.state as Record<string, never>

    expect(await saveExtractState(scope, run1)).toBe(true)
    expect(await stateOf()).toMatchObject({ other: 1, extract: { runId: 'run-1', step: 3 } })

    // A new start replaces the run while the old one is between units.
    await db.integrationConnection.update({
      where: { id: connection.id },
      data: { state: { other: 1, extract: { runId: 'run-2' } } },
    })
    expect(await saveExtractState(scope, { ...run1, step: 4 })).toBe(false)
    expect(await stateOf()).toEqual({ other: 1, extract: { runId: 'run-2' } })

    // Another workshop's id never matches.
    expect(
      await saveExtractState(
        { connectionId: connection.id, organizationId: orgB },
        { ...run1, runId: 'run-2' }
      )
    ).toBe(false)
  })
})
