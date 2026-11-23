/**
 * @vitest-environment node
 *
 * fork: the Shopmonkey client (M2): read-only before any network call, paced from the rate-limit
 * headers, Retry-After on 429, backoff on 5xx, paging to the end, and logs without query strings or
 * bodies.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createShopmonkeyClient,
  PAGE_SIZE,
  ReadOnlyViolation,
  SEARCH_ALLOWLIST,
  ShopmonkeyError,
  where,
} from '@/integrations/shopmonkey/client'

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', ...headers },
  })
}

function setup(responses: Response[]) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => responses.shift() ?? reply(500, { success: false })
  )
  const log = vi.fn()
  const sleep = vi.fn(async () => undefined)
  const client = createShopmonkeyClient({ fetch, log, sleep, random: () => 0, now: () => 0 })
  return { client, fetch, log, sleep }
}

describe('read-only', () => {
  it('refuses anything but GET and the search paths, before any request', async () => {
    const { client, fetch } = setup([])
    await expect(client.search('/v3/customer', { name: 'x' })).rejects.toThrow(ReadOnlyViolation)
    await expect(client.search('/v3/order/123/delete', {})).rejects.toThrow(ReadOnlyViolation)
    await expect(client.get('/v2/customer')).rejects.toThrow(ReadOnlyViolation)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('allows a GET and a listed search', async () => {
    const { client, fetch } = setup([
      reply(200, { success: true, data: { id: 'c-1' } }),
      reply(200, { success: true, data: [] }),
    ])
    await client.get('/v3/customer/c-1')
    await client.search('/v3/customer/search', { where: where.updatedSince('2026-01-01') })
    expect(fetch.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(['GET', 'POST'])
    expect(SEARCH_ALLOWLIST.has('/v3/customer/search')).toBe(true)
  })

  it('never follows a redirect off Shopmonkey', async () => {
    const { client, fetch } = setup([reply(200, { success: true, data: [] })])
    await client.get('/v3/order')
    expect((fetch.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
    expect(fetch.mock.calls[0][0]).toMatch(/^https:\/\/api\.shopmonkey\.cloud\/v3\/order/)
  })
})

describe('pacing', () => {
  it('waits Retry-After on a 429, then retries', async () => {
    const { client, sleep, fetch } = setup([
      reply(429, { success: false, message: 'Too many' }, { 'retry-after': '7' }),
      reply(200, { success: true, data: { id: 'o-1' } }),
    ])
    expect((await client.get('/v3/order/o-1')).data).toEqual({ id: 'o-1' })
    expect(sleep).toHaveBeenCalledWith(7000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('slows down below 10% of the minute’s budget, and not above it', async () => {
    const { client, sleep } = setup([
      reply(
        200,
        { success: true, data: {} },
        {
          'x-ratelimit-limit-minute': '120',
          'x-ratelimit-remaining-minute': '60',
        }
      ),
      reply(
        200,
        { success: true, data: {} },
        {
          'x-ratelimit-limit-minute': '120',
          'x-ratelimit-remaining-minute': '6',
        }
      ),
      reply(200, { success: true, data: {} }),
    ])
    await client.get('/v3/order/a')
    await client.get('/v3/order/b')
    expect(sleep).not.toHaveBeenCalled()
    await client.get('/v3/order/c')
    expect(sleep).toHaveBeenCalledWith(10_000)
  })

  it('backs off on a 5xx and gives Shopmonkey’s message when it keeps failing', async () => {
    const { client, sleep } = setup([
      reply(503, { success: false }),
      reply(401, { success: false, code: 'API-401', message: 'Invalid API key' }),
    ])
    const error = await client.get('/v3/auth/api_key/status').catch((e) => e)
    expect(error).toBeInstanceOf(ShopmonkeyError)
    expect(error).toMatchObject({ status: 401, shopmonkeyMessage: 'Invalid API key' })
    expect(sleep).toHaveBeenCalledWith(1000)
  })
})

describe('paging', () => {
  it('reads every page to the end, each record once', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `c-${from + i}` }))
    const { client, fetch } = setup([
      reply(200, { success: true, data: page(0, PAGE_SIZE), meta: { hasMore: true } }),
      // The next page repeats one row from the first: it is not yielded twice.
      reply(200, {
        success: true,
        data: [{ id: 'c-99' }, ...page(PAGE_SIZE, 10)],
        meta: { hasMore: false },
      }),
    ])
    const seen: string[] = []
    for await (const rows of client.pages<{ id: string }>('/v3/customer')) {
      seen.push(...rows.map((r) => r.id))
    }
    expect(seen).toHaveLength(PAGE_SIZE + 10)
    expect(new Set(seen).size).toBe(seen.length)
    expect(fetch.mock.calls[1][0]).toContain(`skip=${PAGE_SIZE}`)
    expect(fetch.mock.calls[0][0]).toContain('orderby=id+asc')
  })
})

describe('logs', () => {
  it('name the method, path, status, time and request id, never a query or a body', async () => {
    const { client, log } = setup([
      reply(200, { success: true, data: [{ id: 'c-1', email: 'ada@example.com' }] }),
    ])
    await client.get('/v3/customer', { where: where.equals('email', 'ada@example.com') })
    const logged = JSON.stringify(log.mock.calls)
    expect(log).toHaveBeenCalledWith('info', 'GET /v3/customer 200', {
      method: 'GET',
      path: '/v3/customer',
      status: 200,
      durationMs: 0,
      requestId: 'req-1',
    })
    expect(logged).not.toContain('ada@example.com')
    expect(logged).not.toContain('where')
  })
})
