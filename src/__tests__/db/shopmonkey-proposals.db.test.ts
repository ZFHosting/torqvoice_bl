/**
 * fork: what a load proposes to the workshop's numbering and settings, and applies only when asked (M5 task 9), on
 * a real PostgreSQL (`npm run test:db`). A dry run proposes what a real run would, and writes nothing; a run with
 * `applyNumbering` makes the app's next job carry on after Shopmonkey's highest number (MAPPING §9); settings are
 * left alone until `applySettings`. SYNTHETIC fixtures: work orders 1002–1004, an 8.25 % tax that leaves shop
 * supplies untaxed, a $140 standard rate, miles, America/Chicago.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let load: typeof import('@/integrations/shopmonkey/load/run')
let workshop: Awaited<ReturnType<typeof createWorkshop>>

const run = (extra: Partial<import('@/integrations/shopmonkey/load/run').LoadOptions> = {}) =>
  load.runLoad({
    organizationId: workshop.organizationId,
    connectionId: workshop.connectionId,
    runUserId: workshop.userId,
    now: NOW,
    ...extra,
  })

const settings = async () =>
  Object.fromEntries(
    (
      await db.appSetting.findMany({
        where: { organizationId: workshop.organizationId },
        select: { key: true, value: true },
      })
    ).map((s) => [s.key, s.value])
  )

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  load = await import('@/integrations/shopmonkey/load/run')
  workshop = await createWorkshop('Proposals')
  await extractInto(createMockShopmonkey(), workshop)
})

afterAll(async () => {
  if (workshop) await workshop.remove()
})

describe('what a load proposes', () => {
  it('proposes on a dry run what a real run would, and writes nothing', async () => {
    const summary = await run({ dryRun: true })
    expect(summary.proposals.numbering).toEqual({
      highest: '1004',
      changes: [
        { key: 'workshop.invoicePrefix', current: null, proposed: '' },
        { key: 'workshop.invoiceStartNumber', current: null, proposed: '1005' },
      ],
    })
    expect(Object.fromEntries(summary.proposals.settings.map((c) => [c.key, c.proposed]))).toEqual({
      'workshop.taxEnabled': 'true',
      'workshop.defaultTaxRate': '8.25',
      'workshop.taxMode': 'single',
      'workshop.taxSelective': 'true',
      'workshop.taxAppliesToParts': 'true',
      'workshop.taxAppliesToLabor': 'true',
      'workshop.taxAppliesToShopFee': 'false',
      'workshop.defaultLaborRate': '140',
      'workshop.unitSystem': 'imperial',
      'workshop.timezone': 'America/Chicago',
    })
    expect(summary.proposals.workshopName?.proposed).toBe('Synthetic Auto Works')
    expect(summary.applied).toEqual([])
    expect(await settings()).toEqual({})
  })

  it('applies the numbering when asked, so the next job carries on after Shopmonkey’s highest number', async () => {
    const summary = await run({ applyNumbering: true })
    expect(summary.failures).toEqual([])
    expect(summary.applied).toEqual(['workshop.invoicePrefix', 'workshop.invoiceStartNumber'])
    const now = await settings()
    expect(now).toEqual({ 'workshop.invoicePrefix': '', 'workshop.invoiceStartNumber': '1005' })

    const { nextJobNumber } = await import('@/lib/job-number')
    const next = await nextJobNumber({
      organizationId: workshop.organizationId,
      settings: now,
      timeZone: 'America/Chicago',
      now: NOW,
    })
    expect(next.invoiceNumber).toBe('1005')

    const audit = await db.auditLog.findFirst({
      where: { organizationId: workshop.organizationId, action: 'shopmonkey.import' },
      orderBy: { timestamp: 'desc' },
      select: { metadata: true },
    })
    expect(audit?.metadata).toMatchObject({ applied: summary.applied })
  })

  it('applies the settings when asked, and then has nothing left to propose', async () => {
    const summary = await run({ applySettings: true })
    expect(summary.applied).toContain('workshop.defaultTaxRate')
    expect(await settings()).toMatchObject({
      'workshop.defaultTaxRate': '8.25',
      'workshop.defaultLaborRate': '140',
      'workshop.unitSystem': 'imperial',
      'workshop.timezone': 'America/Chicago',
    })
    const again = await run({ dryRun: true })
    expect(again.proposals.numbering.changes).toEqual([])
    expect(again.proposals.settings).toEqual([])
  })
})
