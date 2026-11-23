/**
 * fork: the guard against connections that hear `service.update`, checked again just before a load issues its
 * invoices (M5 review), on a real PostgreSQL (`npm run test:db`). A connection turned on while the run was writing
 * means nothing is issued and the run says so; the next run, with it off again, issues them. The mid-run
 * connection is stood in for by the check the runner calls before issuing; the check at the start is the real one.
 * SYNTHETIC fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const listening = vi.hoisted(() => ({ names: [] as string[] }))
vi.mock('@/integrations/shopmonkey/load/finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/shopmonkey/load/finish')>()),
  // What run.ts asks just before issuing; `assertNoInvoiceListeners` at the start uses the real lookup.
  connectionsHearingInvoices: async () => listening.names,
}))

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let workshop: Awaited<ReturnType<typeof createWorkshop>>

const run = async () => {
  const { runLoad } = await import('@/integrations/shopmonkey/load/run')
  const summary = await runLoad({
    organizationId: workshop.organizationId,
    connectionId: workshop.connectionId,
    runUserId: workshop.userId,
    now: NOW,
  })
  expect(summary.failures).toEqual([])
  return summary
}

const issued = async () =>
  db.serviceRecord.count({
    where: { organizationId: workshop.organizationId, issuedAt: { not: null } },
  })

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  workshop = await createWorkshop('IssueGuard')
  await extractInto(createMockShopmonkey(), workshop)
})

afterAll(async () => {
  if (workshop) await workshop.remove()
})

describe('a connection turned on while a load runs', () => {
  it('stops the run issuing anything, and the next run issues them', async () => {
    listening.names = ['Xero']
    const first = await run()
    expect(first.warnings.issue_postponed).toBe(1)
    expect(first.issued).toBe(0)
    expect(await issued()).toBe(0)

    listening.names = []
    const second = await run()
    expect(second.warnings.issue_postponed ?? 0).toBe(0)
    // Invoices 1003 and 1004.
    expect(second.issued).toBe(2)
    expect(await issued()).toBe(2)
  })
})
