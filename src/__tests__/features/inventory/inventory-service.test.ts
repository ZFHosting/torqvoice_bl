/**
 * @vitest-environment node
 *
 * fork: the inventory and labor preset services do what their actions did (A2), with the same
 * audit events, plus tombstones for deletes, only for this workshop's rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  inventoryPart: { deleteMany: vi.fn(), findMany: vi.fn() },
  laborPreset: { deleteMany: vi.fn() },
  deletedRecord: { create: vi.fn(), createMany: vi.fn() },
}))
vi.mock('@/lib/db', () => ({ db }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/files/collect', () => ({ inventoryPartFileUrls: vi.fn(async () => []) }))
vi.mock('@/lib/files/manager', () => ({ releaseFiles: vi.fn(async () => undefined) }))
vi.mock('@/features/inventory/Lib/onInventoryChanged', () => ({ onInventoryChanged: vi.fn() }))

const inventory = await import('@/features/inventory/Lib/inventoryService.server')
const inventoryEvents = await import('@/features/inventory/Lib/inventoryAuditEvents')
const presets = await import('@/features/labor-presets/Lib/laborPresetService.server')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }
const tombstone = (entityType: string, entityId: string) => ({
  organizationId: 'org-a',
  entityType,
  entityId,
  actorUserId: 'user-1',
})

beforeEach(() => vi.clearAllMocks())

describe('deleting inventory parts', () => {
  it('one: leaves its tombstone once the row is gone', async () => {
    db.inventoryPart.deleteMany.mockResolvedValue({ count: 1 })
    expect(await inventory.deleteInventoryPartService(ctx, 'p-1')).toEqual({
      deleted: true,
      partId: 'p-1',
    })
    expect(db.deletedRecord.create).toHaveBeenCalledWith({
      data: tombstone('inventory_part', 'p-1'),
    })
  })

  it('several: tombstones only the parts that were this workshop’s', async () => {
    db.inventoryPart.findMany.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }])
    db.inventoryPart.deleteMany.mockResolvedValue({ count: 2 })
    await inventory.deleteInventoryPartsService(ctx, ['p-1', 'p-2', 'theirs'])
    expect(db.inventoryPart.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['p-1', 'p-2', 'theirs'] }, organizationId: 'org-a' },
      select: { id: true },
    })
    expect(db.deletedRecord.createMany).toHaveBeenCalledWith({
      data: [tombstone('inventory_part', 'p-1'), tombstone('inventory_part', 'p-2')],
    })
  })

  it('names the parts asked for in the bulk audit event, as the action did', () => {
    expect(inventoryEvents.deleteInventoryPartsEvent({ deleted: 2 }, ['p-1', 'p-2'])).toEqual({
      action: 'inventory.bulkDelete',
      entity: 'InventoryPart',
      entityId: 'p-1,p-2',
      details: { key: 'inventory_bulkDelete', params: { count: 2 } },
      metadata: { partIds: ['p-1', 'p-2'], deleted: 2 },
    })
  })
})

describe('deleting a labor preset', () => {
  it('leaves a tombstone, and none for another workshop’s', async () => {
    db.laborPreset.deleteMany.mockResolvedValue({ count: 1 })
    await presets.deleteLaborPresetService(ctx, 'lp-1')
    expect(db.deletedRecord.create).toHaveBeenCalledWith({
      data: tombstone('labor_preset', 'lp-1'),
    })

    vi.clearAllMocks()
    db.laborPreset.deleteMany.mockResolvedValue({ count: 0 })
    await expect(presets.deleteLaborPresetService(ctx, 'theirs')).rejects.toThrow(
      'Preset not found'
    )
    expect(db.deletedRecord.create).not.toHaveBeenCalled()
  })
})
