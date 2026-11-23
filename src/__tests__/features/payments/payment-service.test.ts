/**
 * @vitest-environment node
 *
 * fork: the payment service does what the payment actions did (A2), with the same audit events,
 * plus a tombstone when a payment is deleted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: [] as { key: string; args: unknown }[] }))
const rows = vi.hoisted(() => ({ findFirst: {} as Record<string, unknown> }))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/document-lock.server', () => ({
  getDocumentLockSettings: vi.fn(async () => ({ lockOnSend: false, lockOnPaid: false })),
}))
vi.mock('@/lib/db', () => {
  const method = (model: string, name: string) => async (args: unknown) => {
    calls.list.push({ key: `${model}.${name}`, args })
    if (name === 'findFirst' || name === 'findUnique') return rows.findFirst[model] ?? null
    if (name === 'findMany') return []
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

const service = await import('@/features/payments/Lib/paymentService.server')
const events = await import('@/features/payments/Lib/paymentAuditEvents')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }

beforeEach(() => {
  calls.list = []
  rows.findFirst = {}
})

describe('deleting a payment', () => {
  it('removes it and leaves a tombstone', async () => {
    rows.findFirst.payment = {
      id: 'pay-1',
      serviceRecord: {
        vehicleId: 'v-1',
        id: 'sr-1',
        sentAt: null,
        manuallyPaid: false,
        totalAmount: 100,
        cost: 100,
        editUnlockedAt: null,
        payments: [{ id: 'pay-1', amount: 40 }],
      },
    }
    expect(await service.deletePaymentService(ctx, 'pay-1')).toEqual({
      deleted: true,
      paymentId: 'pay-1',
    })
    const keys = calls.list.map((c) => c.key)
    expect(keys.indexOf('deletedRecord.create')).toBeGreaterThan(keys.indexOf('payment.delete'))
    expect(calls.list.find((c) => c.key === 'deletedRecord.create')?.args).toEqual({
      data: {
        organizationId: 'org-a',
        entityType: 'payment',
        entityId: 'pay-1',
        actorUserId: 'user-1',
      },
    })
  })

  it('finds only this workshop’s payment', async () => {
    await expect(service.deletePaymentService(ctx, 'theirs')).rejects.toThrow('Payment not found')
    expect(calls.list[0]?.args).toMatchObject({
      where: { id: 'theirs', serviceRecord: { organizationId: 'org-a' } },
    })
    expect(calls.list.some((c) => c.key === 'deletedRecord.create')).toBe(false)
  })
})

describe('the audit events', () => {
  it('are the ones the actions always logged', () => {
    expect(
      events.createPaymentEvent({
        id: 'pay-1',
        amount: 40,
        serviceRecordId: 'sr-1',
        method: 'cash',
      } as never)
    ).toEqual({
      action: 'payment.create',
      entity: 'Payment',
      entityId: 'pay-1',
      details: { key: 'payment_create', params: { amount: 40, serviceRecordId: 'sr-1' } },
      metadata: { paymentId: 'pay-1', serviceRecordId: 'sr-1', amount: 40, method: 'cash' },
    })
    expect(events.deletePaymentEvent({ deleted: true, paymentId: 'pay-1' } as never).action).toBe(
      'payment.delete'
    )
  })
})
