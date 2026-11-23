/**
 * @vitest-environment node
 *
 * fork: the service record service does what the work order actions did (A2): the same writes in
 * the same order with the same audit events, plus the tombstones API sync reads.
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
vi.mock('@/lib/document-lock.server', () => ({
  assertInvoiceEditable: vi.fn(),
  assertQuoteEditable: vi.fn(),
}))
vi.mock('@/lib/files/collect', () => ({ serviceRecordFileUrls: vi.fn(async () => []) }))
vi.mock('@/lib/files/manager', () => ({ releaseFiles: vi.fn(async () => undefined) }))
vi.mock('@/features/inventory/Lib/onInventoryChanged', () => ({ onInventoryChanged: vi.fn() }))
vi.mock('@/features/inventory/Lib/reconcileStock', () => ({
  reconcileInventoryForParts: vi.fn(async () => undefined),
}))
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

const service = await import('@/features/vehicles/Lib/serviceRecordService.server')
const events = await import('@/features/vehicles/Lib/serviceRecordAuditEvents')
const actions = await import('@/features/vehicles/Actions/serviceActions')

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

describe('deleting a work order', () => {
  it('leaves a tombstone after the row, in the same transaction', async () => {
    rows.findFirst.serviceRecord = { id: 'sr-1', vehicleId: 'v-1', invoiceNumber: 'WO-1' }
    expect(await service.deleteServiceRecordService(ctx, 'sr-1')).toEqual({ recordId: 'sr-1' })
    const order = writes()
    expect(order.indexOf('deletedRecord.create')).toBeGreaterThan(
      order.indexOf('serviceRecord.delete')
    )
    expect(calls.list.find((c) => c.key === 'deletedRecord.create')?.args).toEqual({
      data: {
        organizationId: 'org-a',
        entityType: 'work_order',
        entityId: 'sr-1',
        actorUserId: 'user-1',
      },
    })
  })

  it('is refused for another workshop’s work order, writing nothing', async () => {
    await expect(service.deleteServiceRecordService(ctx, 'theirs')).rejects.toThrow(
      'Record not found'
    )
    expect(writes()).toEqual([])
  })

  it('writes the same rows from the action as from the service', async () => {
    rows.findFirst.serviceRecord = { id: 'sr-1', vehicleId: 'v-1', invoiceNumber: 'WO-1' }
    await service.deleteServiceRecordService({ ...ctx, actor: 'user' }, 'sr-1')
    const viaService = writes()
    calls.list = []
    const result = await actions.deleteServiceRecord('sr-1')
    expect(result.success, result.error).toBe(true)
    expect(writes()).toEqual(viaService)
  })
})

describe('deleting an attachment', () => {
  it('removes the row, then leaves a tombstone', async () => {
    rows.findFirst.serviceAttachment = {
      id: 'att-1',
      fileUrl: '/api/protected/files/org-a/services/a.jpg',
      serviceRecord: { vehicleId: 'v-1', id: 'sr-1' },
    }
    expect(await service.deleteServiceAttachmentService(ctx, 'att-1')).toEqual({ deleted: true })
    expect(writes()).toEqual(['serviceAttachment.delete', 'deletedRecord.create'])
  })
})

describe('the audit events', () => {
  it('are the ones the actions always logged', () => {
    expect(
      events.createServiceRecordEvent({ id: 'sr-1', invoiceNumber: '', vehicleId: 'v-1' } as never)
    ).toEqual({
      action: 'service.create',
      entity: 'ServiceRecord',
      entityId: 'sr-1',
      details: { key: 'service_create', params: { ref: 'sr-1' } },
      metadata: { serviceRecordId: 'sr-1', vehicleId: 'v-1' },
    })
    expect(
      events.updateServiceStatusEvent({
        recordId: 'sr-1',
        status: 'waiting-parts',
        customStatus: null,
      } as never)
    ).toEqual({
      action: 'service.status',
      entity: 'ServiceRecord',
      entityId: 'sr-1',
      details: { key: 'service_status', params: { status: 'waiting_parts' } },
      metadata: { serviceRecordId: 'sr-1', status: 'waiting-parts' },
    })
    expect(events.deleteServiceRecordEvent({ recordId: 'sr-1' } as never).action).toBe(
      'service.delete'
    )
  })
})
