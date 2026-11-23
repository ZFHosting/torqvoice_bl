/**
 * @vitest-environment node
 *
 * fork: Idempotency-Key's failure paths that a real database won't stage on demand: storing the
 * response fails after the write committed. The happy paths and concurrency run on Postgres
 * (src/__tests__/db/public-api-idempotency.db.test.ts).
 */
import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  apiIdempotencyKey: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async () => ({ id: 'claim-1' })),
    updateMany: vi.fn(async () => {
      throw new Error('connection lost')
    }),
    findFirst: vi.fn(),
  },
}))
vi.mock('@/lib/db', () => ({ db }))

const { withIdempotency } = await import('@/features/public-api/Lib/idempotency')

describe('Idempotency-Key, when storing the response fails', () => {
  it('still answers with the committed write, not a 500 that invites a retry', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const request = new Request('http://localhost/api/v1/customers?x=1', {
      method: 'POST',
      headers: { 'idempotency-key': 'k-1' },
      body: '{}',
    })
    const response = await withIdempotency(
      request,
      { organizationId: 'org-a', apiKeyId: 'key-1' },
      '{}',
      async () => Response.json({ data: { id: 'cust-1' } }, { status: 201 })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { id: 'cust-1' } })
    expect(db.apiIdempotencyKey.updateMany).toHaveBeenCalled()
    // Logged by claim id only.
    expect(JSON.stringify(spy.mock.calls[0]?.slice(0, 2))).toContain('claim-1')
    spy.mockRestore()
  })
})
