/**
 * @vitest-environment node
 *
 * fork: the vehicle and note services do what the server actions did (A2), the same writes in the
 * same order with the same audit events, plus the tombstones API sync reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: [] as { key: string; args: unknown }[] }))
const rows = vi.hoisted(() => ({
  findFirst: {} as Record<string, unknown>,
  findMany: {} as Record<string, unknown[]>,
}))

vi.mock('@/lib/cached-session', () => ({
  getCachedSession: vi.fn(async () => ({ user: { id: 'user-1', email: 'a@x.test' } })),
  getCachedMembership: vi.fn(async () => ({
    organizationId: 'org-a',
    role: 'owner',
    roleId: null,
    customRole: null,
  })),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/audit', async (original) => ({
  ...(await original<typeof import('@/lib/audit')>()),
  logAudit: vi.fn(),
}))
vi.mock('@/lib/files/collect', () => ({ vehicleFileUrls: vi.fn(async () => []) }))
vi.mock('@/lib/files/manager', () => ({ releaseFiles: vi.fn(async () => undefined) }))
vi.mock('@/lib/db', () => {
  const method = (model: string, name: string) => async (args: unknown) => {
    calls.list.push({ key: `${model}.${name}`, args })
    if (name === 'findFirst' || name === 'findUnique') return rows.findFirst[model] ?? null
    if (name === 'findMany') return rows.findMany[model] ?? []
    if (name === 'count') return 0
    if (name.endsWith('Many')) return { count: 1 }
    return {}
  }
  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_, model: string) => {
        if (model === '$transaction') {
          return async (arg: unknown) =>
            typeof arg === 'function' ? arg(client) : Promise.all(arg as Promise<unknown>[])
        }
        if (model === 'then') return undefined
        return new Proxy({}, { get: (__, name: string) => method(model, name) })
      },
    }
  )
  return { db: client }
})

const service = await import('@/features/vehicles/Lib/vehicleService.server')
const notes = await import('@/features/vehicles/Lib/noteService.server')
const archive = await import('@/features/vehicles/Lib/vehicleArchiveService.server')
const events = await import('@/features/vehicles/Lib/vehicleAuditEvents')
const actions = await import('@/features/vehicles/Actions/vehicleActions')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }
const writes = () =>
  calls.list
    .map((call) => call.key)
    .filter((key) => /\.(create|createMany|update|updateMany|delete|deleteMany)$/.test(key))

beforeEach(() => {
  calls.list = []
  rows.findFirst = {}
  rows.findMany = {}
})

describe('deleting a vehicle', () => {
  it('leaves a tombstone for the vehicle and for everything that went with it', async () => {
    rows.findFirst.vehicle = { year: 2019, make: 'Volvo', model: 'V60', licensePlate: 'AB12345' }
    rows.findMany.serviceRecord = [{ id: 'sr-1' }, { id: 'sr-2' }]
    // By cascade: the work orders' payments and time entries, the vehicle's findings and inspections.
    rows.findMany.payment = [{ id: 'pay-1' }]
    rows.findMany.timeEntry = [{ id: 'te-1' }]
    rows.findMany.vehicleFinding = [{ id: 'f-1' }]
    rows.findMany.inspection = [{ id: 'in-1' }]
    const result = await service.deleteVehicleService(ctx, 'v-1')
    expect(result).toEqual({ vehicleId: 'v-1', vehicleDisplay: '2019 Volvo V60 (AB12345)' })
    const tombstones = calls.list.find((call) => call.key === 'deletedRecord.createMany')
    expect(tombstones?.args).toEqual({
      data: [
        { organizationId: 'org-a', entityType: 'vehicle', entityId: 'v-1', actorUserId: 'user-1' },
        {
          organizationId: 'org-a',
          entityType: 'work_order',
          entityId: 'sr-1',
          actorUserId: 'user-1',
        },
        {
          organizationId: 'org-a',
          entityType: 'work_order',
          entityId: 'sr-2',
          actorUserId: 'user-1',
        },
        ...[
          ['payment', 'pay-1'],
          ['time_entry', 'te-1'],
          ['finding', 'f-1'],
          ['inspection', 'in-1'],
        ].map(([entityType, entityId]) => ({
          organizationId: 'org-a',
          entityType,
          entityId,
          actorUserId: 'user-1',
        })),
      ],
    })
    // After the row is gone, in the same transaction.
    expect(writes().indexOf('deletedRecord.createMany')).toBeGreaterThan(
      writes().indexOf('vehicle.deleteMany')
    )
    // What went with it was read before the delete, while it still existed.
    const keys = calls.list.map((call) => call.key)
    for (const read of ['payment', 'timeEntry', 'vehicleFinding', 'inspection']) {
      expect(keys.indexOf(`${read}.findMany`), read).toBeGreaterThan(-1)
      expect(keys.indexOf(`${read}.findMany`), read).toBeLessThan(
        keys.indexOf('vehicle.deleteMany')
      )
    }
  })

  it('writes the same rows from the action as from the service', async () => {
    rows.findFirst.vehicle = { year: 2019, make: 'Volvo', model: 'V60', licensePlate: null }
    await service.deleteVehicleService({ ...ctx, actor: 'user' }, 'v-1')
    const viaService = writes()
    calls.list = []
    const result = await actions.deleteVehicle('v-1')
    expect(result.success, result.error).toBe(true)
    expect(writes()).toEqual(viaService)
  })
})

describe('notes', () => {
  it('deleting one leaves a tombstone', async () => {
    rows.findFirst.note = { id: 'n-1', vehicleId: 'v-1' }
    expect(await notes.deleteNoteService(ctx, 'n-1')).toEqual({ noteId: 'n-1' })
    expect(writes()).toEqual(['note.delete', 'deletedRecord.create'])
  })

  it('is refused for another workshop’s vehicle', async () => {
    await expect(
      notes.createNoteService(ctx, { vehicleId: 'theirs', title: 'x', content: 'y' })
    ).rejects.toThrow()
    expect(writes()).toEqual([])
  })
})

describe('archiving', () => {
  it('archives and unarchives only this workshop’s vehicle', async () => {
    await archive.archiveVehicleService(ctx, 'v-1', 'sold')
    await archive.unarchiveVehicleService(ctx, 'v-1')
    expect(calls.list.filter((c) => c.key === 'vehicle.updateMany').map((c) => c.args)).toEqual([
      {
        where: { id: 'v-1', organizationId: 'org-a' },
        data: { isArchived: true, archiveReason: 'sold' },
      },
      {
        where: { id: 'v-1', organizationId: 'org-a' },
        data: { isArchived: false, archiveReason: null },
      },
    ])
  })
})

describe('the audit events', () => {
  it('are the ones the actions always logged', () => {
    expect(events.vehicleDeletedEvent({ vehicleId: 'v-1', vehicleDisplay: 'Volvo V60' })).toEqual({
      action: 'vehicle.delete',
      entity: 'Vehicle',
      entityId: 'v-1',
      details: { key: 'vehicle_delete', params: { name: 'Volvo V60' } },
      metadata: { vehicleId: 'v-1', vehicleDisplay: 'Volvo V60' },
    })
    expect(
      events.vehicleUpdatedEvent({ id: 'v-1', fields: [], vehicleDisplay: 'Volvo V60' }).details
    ).toEqual({ key: 'vehicle_updateNoChanges', params: { name: 'Volvo V60' } })
    expect(events.noteCreatedEvent({ id: 'n-1', vehicleId: 'v-1' })).toMatchObject({
      action: 'note.create',
      details: { key: 'note_create', params: { vehicleId: 'v-1' } },
    })
    expect(events.vehicleArchivedEvent({ vehicleId: 'v-1' }).action).toBe('vehicle.archive')
    expect(events.vehicleUnarchivedEvent({ vehicleId: 'v-1' }).action).toBe('vehicle.unarchive')
  })
})
