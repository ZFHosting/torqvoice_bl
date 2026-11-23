/**
 * fork: undoing a Shopmonkey load, and loading again after a restore, on a real PostgreSQL (`npm run test:db`; M5
 * acceptance). Undo leaves the workshop as it was before the load, table by table. A workshop whose links are gone
 * (a restore, a reconnect) loads again without creating a second copy of anything. SYNTHETIC fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import {
  countRows,
  createWorkshop,
  extractInto,
  guardTestDatabase,
  NOW,
} from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let load: typeof import('@/integrations/shopmonkey/load/run')
let undo: typeof import('@/integrations/shopmonkey/load/undo')
let workshop: Awaited<ReturnType<typeof createWorkshop>>

const run = () =>
  load.runLoad({
    organizationId: workshop.organizationId,
    connectionId: workshop.connectionId,
    runUserId: workshop.userId,
    now: NOW,
  })

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  load = await import('@/integrations/shopmonkey/load/run')
  undo = await import('@/integrations/shopmonkey/load/undo')
  workshop = await createWorkshop('Undo')
  await extractInto(createMockShopmonkey(), workshop)
})

afterAll(async () => {
  if (workshop) await workshop.remove()
})

describe('undoing a load', () => {
  it('leaves the workshop as it was before, table by table, and a new load works again', async () => {
    const before = await countRows(workshop.organizationId)
    const summary = await run()
    expect(summary.failures).toEqual([])
    expect((await countRows(workshop.organizationId)).serviceRecord).toBeGreaterThan(0)

    await undo.undoLoad({ ...workshop, runId: summary.runId })
    expect(await countRows(workshop.organizationId)).toEqual(before)
    const batches = await db.importBatch.findMany({
      where: { organizationId: workshop.organizationId },
    })
    expect(batches.every((b) => b.status === 'undone')).toBe(true)

    const again = await run()
    expect(again.counts.customer.created).toBeGreaterThan(0)
  })
})

describe('loading after a restore', () => {
  it('re-links every row from the archive instead of creating a second copy', async () => {
    const before = await countRows(workshop.organizationId)
    // A restore (or a reconnect) leaves the rows and the archive, without the connection's links.
    await db.integrationLink.deleteMany({ where: { connectionId: workshop.connectionId } })
    const summary = await run()
    expect(summary.failures).toEqual([])
    for (const [table, c] of Object.entries(summary.counts)) expect(c.created, table).toBe(0)
    expect(await countRows(workshop.organizationId)).toEqual(before)
    expect(
      await db.integrationLink.count({ where: { connectionId: workshop.connectionId } })
    ).toBeGreaterThan(0)
  })
})
