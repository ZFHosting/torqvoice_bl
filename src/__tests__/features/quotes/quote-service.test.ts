/**
 * @vitest-environment node
 *
 * fork: the quote service does what the quote actions did (A2), with the same audit events, plus a
 * tombstone when a quote is deleted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: [] as { key: string; args: unknown }[] }))
const rows = vi.hoisted(() => ({ findFirst: {} as Record<string, unknown> }))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/document-lock.server', () => ({
  assertInvoiceEditable: vi.fn(),
  assertQuoteEditable: vi.fn(),
}))
vi.mock('@/lib/files/collect', () => ({ quoteFileUrls: vi.fn(async () => []) }))
vi.mock('@/lib/files/manager', () => ({ releaseFiles: vi.fn(async () => undefined) }))
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

const service = await import('@/features/quotes/Lib/quoteService.server')
const events = await import('@/features/quotes/Lib/quoteAuditEvents')

const ctx = { organizationId: 'org-a', userId: 'user-1', actor: 'api' as const }

beforeEach(() => {
  calls.list = []
  rows.findFirst = {}
})

describe('deleting a quote', () => {
  it('leaves a tombstone after the row, in the same transaction', async () => {
    rows.findFirst.quote = { id: 'q-1', organizationId: 'org-a' }
    expect(await service.deleteQuoteService(ctx, 'q-1')).toEqual({ quoteId: 'q-1' })
    const keys = calls.list.map((c) => c.key)
    expect(keys.indexOf('deletedRecord.create')).toBeGreaterThan(keys.indexOf('quote.deleteMany'))
    expect(calls.list.find((c) => c.key === 'deletedRecord.create')?.args).toEqual({
      data: {
        organizationId: 'org-a',
        entityType: 'quote',
        entityId: 'q-1',
        actorUserId: 'user-1',
      },
    })
  })

  it('is refused for another workshop’s quote, writing nothing', async () => {
    await expect(service.deleteQuoteService(ctx, 'theirs')).rejects.toThrow('Quote not found')
    expect(calls.list.some((c) => /delete|create/i.test(c.key.split('.')[1]))).toBe(false)
  })
})

describe('the audit events', () => {
  it('are the ones the actions always logged', () => {
    expect(events.deleteQuoteEvent({ quoteId: 'q-1' })).toEqual({
      action: 'quote.delete',
      entity: 'Quote',
      entityId: 'q-1',
      details: { key: 'quote_delete', params: { ref: 'q-1' } },
      metadata: { quoteId: 'q-1' },
    })
    expect(events.updateQuoteStatusEvent({ quoteId: 'q-1', status: 'accepted' } as never)).toEqual({
      action: 'quote.status',
      entity: 'Quote',
      entityId: 'q-1',
      details: { key: 'quote_status', params: { status: 'accepted' } },
      metadata: { quoteId: 'q-1', status: 'accepted' },
    })
  })
})
