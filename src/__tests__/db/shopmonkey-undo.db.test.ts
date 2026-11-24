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
    // A5: what the undo removed has no tombstone each, so API clients are told to resync in full.
    expect(
      await db.deletedRecord.count({
        where: {
          organizationId: workshop.organizationId,
          entityType: 'reset',
          entityId: 'shopmonkey_undo',
        },
      })
    ).toBe(1)
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

describe('undoing a load the workshop has worked with since', () => {
  let shop: Awaited<ReturnType<typeof createWorkshop>>
  afterAll(async () => {
    if (shop) await shop.remove()
  })

  it('removes what the run made, keeps what the workshop uses, and a new load matches what was kept', async () => {
    shop = await createWorkshop('UndoUsed')
    const org = { organizationId: shop.organizationId }
    // The workshop's own records, from before the load.
    const customer = await db.customer.create({
      data: { ...org, userId: shop.userId, name: 'Walk-in' },
      select: { id: true },
    })
    const vehicle = await db.vehicle.create({
      data: {
        ...org,
        userId: shop.userId,
        customerId: customer.id,
        make: 'Make',
        model: 'Model',
        year: 2020,
      },
      select: { id: true },
    })
    const job = await db.serviceRecord.create({
      data: { ...org, title: 'Own job', vehicleId: vehicle.id, startDateTime: NOW },
      select: { id: true },
    })
    await extractInto(createMockShopmonkey(), shop)
    const loadRun = (await import('@/integrations/shopmonkey/load/run')).runLoad
    const first = await loadRun({
      organizationId: shop.organizationId,
      connectionId: shop.connectionId,
      runUserId: shop.userId,
      now: NOW,
    })
    expect(first.failures).toEqual([])
    const afterLoad = await countRows(shop.organizationId)

    // The workshop uses imported rows from the app.
    const linked = async (model: string) =>
      (
        await db.integrationLink.findFirstOrThrow({
          where: { connectionId: shop.connectionId, entityType: model },
          select: { entityId: true },
        })
      ).entityId
    const template = await linked('InspectionTemplate')
    const technician = await linked('Technician')
    const status = await linked('WorkOrderStatus')
    const part = await linked('InventoryPart')
    await db.inspection.create({ data: { ...org, vehicleId: vehicle.id, templateId: template } })
    await db.timeEntry.create({
      data: { ...org, technicianId: technician, serviceRecordId: job.id },
    })
    await db.serviceRecord.update({ where: { id: job.id }, data: { customStatusId: status } })
    await db.servicePart.create({
      data: { serviceRecordId: job.id, name: 'From stock', inventoryPartId: part, quantity: 1 },
    })
    const ownField = await db.customFieldDefinition.create({
      data: {
        ...org,
        userId: shop.userId,
        name: 'own_field',
        label: 'Own field',
        entityType: 'customer',
      },
      select: { id: true },
    })

    const result = await undo.undoLoad({ ...shop, runId: first.runId })
    // Exactly these: a row the run made that went with something removed (a time entry with its work order) is
    // neither removed here nor kept.
    expect(result.kept).toEqual({
      InspectionTemplate: 1,
      Technician: 1,
      WorkOrderStatus: 1,
      InventoryPart: 1,
    })
    expect(result.removed.CustomFieldDefinition).toBeGreaterThan(0)
    // The workshop's own records and work are all there.
    expect(await db.customer.findMany({ where: org, select: { id: true } })).toEqual([
      { id: customer.id },
    ])
    expect(await db.serviceRecord.count({ where: { id: job.id, customStatusId: status } })).toBe(1)
    expect(await db.inspection.count({ where: { ...org, templateId: template } })).toBe(1)
    expect(await db.timeEntry.count({ where: { ...org, technicianId: technician } })).toBe(1)
    expect(await db.servicePart.count({ where: { inventoryPartId: part } })).toBe(1)
    expect(await db.customFieldDefinition.count({ where: { id: ownField.id } })).toBe(1)
    for (const id of [template, technician, status, part]) {
      expect(
        await db.integrationLink.count({ where: { connectionId: shop.connectionId, entityId: id } })
      ).toBe(1)
    }

    // Loading again matches what was kept instead of making a second one.
    const again = await loadRun({
      organizationId: shop.organizationId,
      connectionId: shop.connectionId,
      runUserId: shop.userId,
      now: NOW,
    })
    expect(again.failures).toEqual([])
    const now = await countRows(shop.organizationId)
    for (const table of ['technician', 'workOrderStatus', 'inspectionTemplate', 'inventoryPart'])
      expect(now[table], table).toBe(afterLoad[table])
  })
})

describe('undo and later runs', () => {
  let shop: Awaited<ReturnType<typeof createWorkshop>>
  let mock: ReturnType<typeof createMockShopmonkey>
  const loadShop = async () => {
    await extractInto(mock, shop)
    const summary = await (await import('@/integrations/shopmonkey/load/run')).runLoad({
      organizationId: shop.organizationId,
      connectionId: shop.connectionId,
      runUserId: shop.userId,
      now: NOW,
    })
    expect(summary.failures).toEqual([])
    return summary
  }
  const undoRun = (runId: string) => undo.undoLoad({ ...shop, runId })

  beforeAll(async () => {
    shop = await createWorkshop('UndoLater')
    mock = createMockShopmonkey()
  })
  afterAll(async () => {
    if (shop) await shop.remove()
  })

  it('is refused to someone who is not a member of the workshop, before anything is removed', async () => {
    const first = await loadShop()
    const before = await countRows(shop.organizationId)
    const stranger = await db.user.create({
      data: { email: `stranger-${first.runId.slice(0, 8)}@example.com`, name: 'Stranger' },
      select: { id: true },
    })
    try {
      await expect(
        undo.undoLoad({ ...shop, userId: stranger.id, runId: first.runId })
      ).rejects.toMatchObject({ name: 'UndoRefused' })
      expect(await countRows(shop.organizationId)).toEqual(before)
    } finally {
      await db.user.delete({ where: { id: stranger.id } })
    }
  })

  it('removes a vehicle note the run wrote again, and records one audit event per undo', async () => {
    const vehicle = await db.integrationLink.findFirstOrThrow({
      where: {
        connectionId: shop.connectionId,
        entityType: 'Vehicle',
        remoteId: 'vehicle:syn_veh_1',
      },
      select: { entityId: true },
    })
    const notes = { vehicleId: vehicle.entityId }
    // Deleted in the app; written again by the next run, which a change in Shopmonkey brings.
    await db.note.deleteMany({ where: notes })
    mock.change('vehicle', 'syn_veh_1', { note: 'Second note text' })
    // A vehicle is fetched again when its customer changes (MAPPING section 1).
    mock.change('customer', 'syn_cus_1', { note: 'Touched once' })
    const second = await loadShop()
    expect(await db.note.count({ where: notes })).toBe(1)

    await undoRun(second.runId)
    expect(await db.note.count({ where: notes })).toBe(0)
    const audit = await db.auditLog.findMany({
      where: { organizationId: shop.organizationId, action: 'shopmonkey.import_undo' },
      select: { entityId: true, metadata: true, userId: true },
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      entityId: shop.connectionId,
      userId: shop.userId,
      metadata: { runId: second.runId },
    })
    // The next change in Shopmonkey writes one note, not a second.
    mock.change('vehicle', 'syn_veh_1', { note: 'Third note text' })
    mock.change('customer', 'syn_cus_1', { note: 'Touched twice' })
    await loadShop()
    expect(await db.note.findMany({ where: notes, select: { content: true } })).toEqual([
      { content: 'Third note text' },
    ])
  })

  it('clears a converted quote pointer when the work order it became is undone, and converts it again', async () => {
    const org = { organizationId: shop.organizationId }
    mock.change('order', 'syn_ord_1001', { status: 'RepairOrder', workflowStatusId: 'syn_wfs_3' })
    const converting = await loadShop()
    const quote = { ...org, quoteNumber: '1001' }
    expect((await db.quote.findFirstOrThrow({ where: quote })).convertedToId).not.toBeNull()

    await undoRun(converting.runId)
    expect(await db.serviceRecord.count({ where: { ...org, invoiceNumber: '1001' } })).toBe(0)
    // Back to accepted with no pointer: the app may convert it, and so may the next load.
    expect(
      await db.quote.findFirstOrThrow({
        where: quote,
        select: { status: true, convertedToId: true },
      })
    ).toEqual({ status: 'accepted', convertedToId: null })

    await loadShop()
    const record = await db.serviceRecord.findFirstOrThrow({
      where: { ...org, invoiceNumber: '1001' },
      select: { id: true },
    })
    expect((await db.quote.findFirstOrThrow({ where: quote })).convertedToId).toBe(record.id)
  })

  it('leaves no stale links when an older run is undone under a newer one', async () => {
    const org = { organizationId: shop.organizationId }
    // Start over: every run so far undone, newest first.
    const runs = await db.importBatch.findMany({
      where: { ...org, status: 'completed' },
      select: { mapping: true },
      orderBy: { createdAt: 'desc' },
    })
    for (const runId of new Set(
      runs.map((r) => String((r.mapping as { shopmonkeyRunId?: string }).shopmonkeyRunId))
    ))
      await undoRun(runId)
    // A first run, then a newer one whose work order sits on the first run's vehicle.
    mock.change('order', 'syn_ord_1001', { status: 'Estimate', workflowStatusId: null })
    const first = await loadShop()
    mock.change('order', 'syn_ord_1001', { status: 'RepairOrder', workflowStatusId: 'syn_wfs_3' })
    await loadShop()

    // Undoing the first takes its vehicles, and with them the newer run's work order.
    await undoRun(first.runId)
    const dangling = await db.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM "public"."integration_links" AS l
      WHERE l."connectionId" = ${shop.connectionId} AND l."entityType" = 'ServiceRecord'
        AND NOT EXISTS (SELECT 1 FROM "public"."service_records" AS r WHERE r."id" = l."entityId")`
    expect(Number(dangling[0].n)).toBe(0)
    const next = await loadShop()
    expect(next.warnings.row_recreated ?? 0).toBe(0)
  })
})
