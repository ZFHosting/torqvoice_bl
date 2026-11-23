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
    expect(result.kept).toMatchObject({
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
