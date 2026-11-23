/**
 * @vitest-environment node
 *
 * fork: the customer service does exactly what the server actions did (A2): the same writes, in the
 * same order, with the same audit event, whether the action or the public API calls it. Plus the one
 * addition: a delete leaves a tombstone for API sync.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: [] as { key: string; args: unknown }[] }))
const audit = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/lib/db', () => {
  const method = (model: string, name: string) => async (args: unknown) => {
    calls.list.push({ key: `${model}.${name}`, args })
    if (name === 'findMany' || name === 'findFirst' || name === 'findUnique') {
      if (model === 'customer' && name === 'findMany') {
        const where = (args as { where?: { id?: { in?: string[] } } }).where
        return where?.id?.in
          ? where.id.in.filter((id) => id !== 'theirs').map((id) => ({ id }))
          : []
      }
      if (model === 'organizationMember') {
        return { role: 'owner', customRole: null, organizationId: 'org-a' }
      }
      return name === 'findMany' ? [] : null
    }
    if (name === 'count') return 0
    if (name.endsWith('Many')) return { count: 1 }
    if (name === 'create') {
      const data = (args as { data: Record<string, unknown> }).data
      return { id: 'cust-1', ...data }
    }
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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAudit: audit }))
vi.mock('@/lib/features', async (original) => ({
  ...(await original<typeof import('@/lib/features')>()),
  getFeatures: async () => ({ maxCustomers: 1000 }),
}))
vi.mock('@/lib/customer-limit', () => ({ countCustomersTowardLimit: async () => 0 }))
vi.mock('@/lib/whatsapp', () => ({ claimWhatsappMessagesForCustomer: async () => undefined }))
vi.mock('@/features/messaging/Lib/emailClaim.server', () => ({
  claimEmailMessagesForCustomer: async () => undefined,
}))
// Signed in as an owner of org-a, the way upstream's action tests get past withAuth.
vi.mock('@/lib/cached-session', () => ({
  getCachedSession: vi.fn(async () => ({ user: { id: 'user-1', email: 'a@x.test' } })),
  getCachedMembership: vi.fn(async () => ({
    organizationId: 'org-a',
    role: 'owner',
    roleId: null,
    customRole: null,
  })),
}))
vi.mock('@/lib/demo', () => ({
  demoGuard: vi.fn(),
  demoGuardSettingKey: vi.fn(),
  isDemoMode: vi.fn(() => false),
}))

const actions = await import('@/features/customers/Actions/customerActions')
const service = await import('@/features/customers/Lib/customerService.server')
const events = await import('@/features/customers/Lib/customerAuditEvents')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }
const writes = () =>
  calls.list
    .map((call) => call.key)
    .filter((key) => /\.(create|createMany|update|updateMany|delete|deleteMany)$/.test(key))

beforeEach(() => {
  calls.list = []
  audit.mockClear()
})

describe('the customer service', () => {
  it('creates the customer the action creates, numbered the same way', async () => {
    const created = await service.createCustomerService(ctx, { name: 'Ada' } as never)
    expect(created).toMatchObject({ id: 'cust-1', name: 'Ada', customerNumber: '1001' })
    const create = calls.list.find((call) => call.key === 'customer.create')
    expect(create?.args).toMatchObject({
      data: { name: 'Ada', customerNumber: '1001', organizationId: 'org-a', userId: 'user-1' },
    })
  })

  it('updates only this workshop’s customer and clears emptied fields', async () => {
    expect(await service.updateCustomerService(ctx, { id: 'c-1', phone: '' } as never)).toEqual({
      id: 'c-1',
    })
    const update = calls.list.find((call) => call.key === 'customer.updateMany')
    expect(update?.args).toMatchObject({
      where: { id: 'c-1', organizationId: 'org-a' },
      data: { phone: null },
    })
  })

  it('deletes, then leaves one tombstone per customer deleted', async () => {
    await service.deleteCustomerService(ctx, 'c-1')
    expect(writes()).toEqual([
      'customer.deleteMany',
      'customFieldValue.deleteMany',
      'deletedRecord.create',
    ])
    expect(calls.list.at(-1)?.args).toEqual({
      data: {
        organizationId: 'org-a',
        entityType: 'customer',
        entityId: 'c-1',
        actorUserId: 'user-1',
      },
    })

    calls.list = []
    await service.deleteCustomersService(ctx, ['c-1', 'c-2', 'theirs'])
    const tombstones = calls.list.find((call) => call.key === 'deletedRecord.createMany')
    expect(tombstones?.args).toEqual({
      data: ['c-1', 'c-2'].map((entityId) => ({
        organizationId: 'org-a',
        entityType: 'customer',
        entityId,
        actorUserId: 'user-1',
      })),
    })
  })
})

describe('the audit events', () => {
  it('are the ones the actions always logged', () => {
    expect(events.customerCreatedEvent({ id: 'c-1', name: 'Ada' })).toEqual({
      action: 'customer.create',
      entity: 'Customer',
      entityId: 'c-1',
      details: { key: 'customer_create', params: { name: 'Ada' } },
      metadata: { customerId: 'c-1' },
    })
    expect(events.customerUpdatedEvent({ id: 'c-1' })).toMatchObject({ action: 'customer.update' })
    expect(events.customerDeletedEvent({ customerId: 'c-1' })).toMatchObject({
      action: 'customer.delete',
      entityId: 'c-1',
    })
  })
})

describe('the actions', () => {
  it('write what the service writes', async () => {
    await service.deleteCustomerService({ ...ctx, actor: 'user' }, 'c-1')
    const viaService = writes()
    calls.list = []
    const result = await actions.deleteCustomer('c-1')
    expect(result.success, result.error).toBe(true)
    expect(writes()).toEqual(viaService)
  })
})
