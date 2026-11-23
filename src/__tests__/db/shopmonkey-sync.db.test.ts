/**
 * fork: what changes in Shopmonkey between loads, and in the app, during the sync window (M5 review), on a real
 * PostgreSQL (`npm run test:db`). An estimate that becomes a repair order converts its quote instead of leaving a
 * second document; a timesheet that moves onto a work order stops being a shift; a changed vehicle note updates;
 * a technician mapping that didn't change writes nothing; a row deleted in the app comes back with a warning and
 * what used it points at the new row. SYNTHETIC fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let load: typeof import('@/integrations/shopmonkey/load/run')
let workshop: Awaited<ReturnType<typeof createWorkshop>>
let mock: ReturnType<typeof createMockShopmonkey>

const run = (extra: Partial<import('@/integrations/shopmonkey/load/run').LoadOptions> = {}) =>
  load.runLoad({
    organizationId: workshop.organizationId,
    connectionId: workshop.connectionId,
    runUserId: workshop.userId,
    now: NOW,
    ...extra,
  })

const sync = async (extra: Parameters<typeof run>[0] = {}) => {
  await extractInto(mock, workshop)
  const summary = await run(extra)
  expect(summary.failures).toEqual([])
  return summary
}

const linkOf = (model: string, remoteId: string) =>
  db.integrationLink.findMany({
    where: { connectionId: workshop.connectionId, entityType: model, remoteId },
    select: { entityId: true },
  })

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  load = await import('@/integrations/shopmonkey/load/run')
  workshop = await createWorkshop('Sync')
  mock = createMockShopmonkey()
  await sync()
})

afterAll(async () => {
  if (workshop) await workshop.remove()
})

describe('changes in Shopmonkey between loads', () => {
  it('converts the quote when an estimate becomes a repair order, and keeps the work order if it turns back', async () => {
    const org = { organizationId: workshop.organizationId }
    const quotesBefore = await db.quote.count({ where: org })
    mock.change('order', 'syn_ord_1001', { status: 'RepairOrder', workflowStatusId: 'syn_wfs_3' })
    await sync()
    const record = await db.serviceRecord.findFirstOrThrow({
      where: { ...org, invoiceNumber: '1001' },
      select: { id: true },
    })
    const quote = await db.quote.findFirstOrThrow({
      where: { ...org, quoteNumber: '1001' },
      select: { status: true, convertedToId: true },
    })
    expect(quote).toEqual({ status: 'converted', convertedToId: record.id })
    expect(await db.quote.count({ where: org })).toBe(quotesBefore)
    const again = await sync()
    expect(again.counts.order).toMatchObject({ created: 0, updated: 0 })

    mock.change('order', 'syn_ord_1001', { status: 'Estimate', workflowStatusId: null })
    const back = await sync()
    expect(back.warnings.order_back_to_estimate).toBe(1)
    expect(await db.quote.count({ where: org })).toBe(quotesBefore)
    expect(await db.serviceRecord.count({ where: { id: record.id } })).toBe(1)
  })

  it('turns a shift into a time entry when its timesheet lands on a work order, and back', async () => {
    const org = { organizationId: workshop.organizationId }
    const before = {
      entries: await db.timeEntry.count({ where: org }),
      shifts: await db.technicianShift.count({ where: org }),
    }
    mock.change('timesheet', 'syn_tsh_2', { orderId: 'syn_ord_1002', activity: 'Labor' })
    await sync()
    expect(await db.timeEntry.count({ where: org })).toBe(before.entries + 1)
    expect(await db.technicianShift.count({ where: org })).toBe(before.shifts - 1)
    expect(await linkOf('TechnicianShift', 'timesheet:syn_tsh_2')).toEqual([])

    mock.change('timesheet', 'syn_tsh_2', { orderId: null, activity: 'General' })
    await sync()
    expect(await db.timeEntry.count({ where: org })).toBe(before.entries)
    expect(await db.technicianShift.count({ where: org })).toBe(before.shifts)
  })

  it('updates the vehicle’s Shopmonkey note when it changes, without a second note', async () => {
    const vehicle = await linkOf('Vehicle', 'vehicle:syn_veh_1')
    const where = { vehicleId: vehicle[0].entityId }
    expect(await db.note.count({ where })).toBe(1)
    mock.change('vehicle', 'syn_veh_1', { note: 'Prefers full synthetic, 0W-20.' })
    // A vehicle is fetched again when its customer changes (MAPPING §1); M7's webhooks cover the vehicle alone.
    mock.change('customer', 'syn_cus_1', {})
    await sync()
    const notes = await db.note.findMany({ where, select: { title: true, content: true } })
    expect(notes).toEqual([{ title: 'Shopmonkey note', content: 'Prefers full synthetic, 0W-20.' }])
  })
})

describe('the operator’s technician mapping', () => {
  it('writes nothing when it didn’t change, and keeps one link when it does', async () => {
    const org = { organizationId: workshop.organizationId }
    const [first, second] = await Promise.all(
      ['Existing tech A', 'Existing tech B'].map((name) =>
        db.technician.create({ data: { ...org, name }, select: { id: true } })
      )
    )
    await sync({ technicianMap: { syn_usr_3: first.id } })
    const same = await sync({ technicianMap: { syn_usr_3: first.id } })
    expect(same.counts.user.updated).toBe(0)
    expect(await linkOf('Technician', 'user:syn_usr_3')).toEqual([{ entityId: first.id }])

    await sync({ technicianMap: { syn_usr_3: second.id } })
    expect(await linkOf('Technician', 'user:syn_usr_3')).toEqual([{ entityId: second.id }])

    // Dropping the mapping later doesn't rename the workshop's own technician to the Shopmonkey user.
    await sync()
    expect(
      await db.technician.findMany({
        where: { id: { in: [first.id, second.id] } },
        select: { name: true },
        orderBy: { name: 'asc' },
      })
    ).toEqual([{ name: 'Existing tech A' }, { name: 'Existing tech B' }])
  })
})

describe('after a restore (no links)', () => {
  it('converts the quote when an estimate becomes a repair order, instead of leaving two documents', async () => {
    const shop = await createWorkshop('SyncRestore')
    try {
      const own = createMockShopmonkey()
      await extractInto(own, shop)
      const runShop = () =>
        load.runLoad({
          organizationId: shop.organizationId,
          connectionId: shop.connectionId,
          runUserId: shop.userId,
          now: NOW,
        })
      expect((await runShop()).failures).toEqual([])
      const org = { organizationId: shop.organizationId }
      const quotes = await db.quote.count({ where: org })
      // A restore (or a reconnect) leaves the rows and the archive's mappings, not the links.
      await db.integrationLink.deleteMany({ where: { connectionId: shop.connectionId } })
      own.change('order', 'syn_ord_1001', { status: 'RepairOrder', workflowStatusId: 'syn_wfs_3' })
      await extractInto(own, shop)
      expect((await runShop()).failures).toEqual([])
      const record = await db.serviceRecord.findFirstOrThrow({
        where: { ...org, invoiceNumber: '1001' },
        select: { id: true },
      })
      expect(
        await db.quote.findFirstOrThrow({
          where: { ...org, quoteNumber: '1001' },
          select: { status: true, convertedToId: true },
        })
      ).toEqual({ status: 'converted', convertedToId: record.id })
      expect(await db.quote.count({ where: org })).toBe(quotes)
    } finally {
      await shop.remove()
    }
  })
})

describe('a row deleted in the app', () => {
  it('is created again with a warning, and what pointed at it points at the new row', async () => {
    const [old] = await linkOf('Technician', 'user:syn_usr_1')
    const linesBefore = await db.serviceLabor.count({ where: { technicianId: old.entityId } })
    expect(linesBefore).toBeGreaterThan(0)
    await db.technician.delete({ where: { id: old.entityId } })

    const summary = await sync()
    expect(summary.warnings.row_recreated).toBeGreaterThanOrEqual(1)
    const [now] = await linkOf('Technician', 'user:syn_usr_1')
    expect(now.entityId).not.toBe(old.entityId)
    expect(await db.serviceLabor.count({ where: { technicianId: now.entityId } })).toBe(linesBefore)
    // Settled: the next run changes nothing.
    const again = await sync()
    expect(again.warnings.row_recreated ?? 0).toBe(0)
    expect(again.counts.order.updated).toBe(0)
  })

  it('keeps the workshop’s own technician and the vehicle’s one note through a restore', async () => {
    const shop = await createWorkshop('SyncRestoreOwn')
    try {
      const own = createMockShopmonkey()
      const org = { organizationId: shop.organizationId }
      const runShop = async (technicianMap?: Record<string, string>) => {
        await extractInto(own, shop)
        const summary = await load.runLoad({
          organizationId: shop.organizationId,
          connectionId: shop.connectionId,
          runUserId: shop.userId,
          now: NOW,
          technicianMap,
        })
        expect(summary.failures).toEqual([])
        return summary
      }
      const tech = await db.technician.create({
        data: { ...org, name: 'Workshop Own Tech', color: '#123456' },
        select: { id: true },
      })
      await runShop({ syn_usr_1: tech.id })
      await runShop()
      // A restore (or a reconnect) leaves the rows and the archive's mappings, not the links.
      await db.integrationLink.deleteMany({ where: { connectionId: shop.connectionId } })
      own.change('vehicle', 'syn_veh_1', { note: 'Changed after the restore' })
      own.change('customer', 'syn_cus_1', { note: 'Touched after the restore' })
      const after = await runShop()
      expect(after.warnings.row_recreated ?? 0).toBe(0)
      expect(
        await db.technician.findUniqueOrThrow({
          where: { id: tech.id },
          select: { name: true, color: true },
        })
      ).toEqual({ name: 'Workshop Own Tech', color: '#123456' })
      const vehicle = await db.integrationLink.findFirstOrThrow({
        where: {
          connectionId: shop.connectionId,
          entityType: 'Vehicle',
          remoteId: 'vehicle:syn_veh_1',
        },
        select: { entityId: true },
      })
      expect(
        await db.note.findMany({
          where: { vehicleId: vehicle.entityId },
          select: { content: true },
        })
      ).toEqual([{ content: 'Changed after the restore' }])
    } finally {
      await shop.remove()
    }
  })
})
