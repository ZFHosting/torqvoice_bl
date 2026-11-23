/**
 * @vitest-environment node
 *
 * fork: the Shopmonkey client (M2): read-only before any network call, paced from the rate-limit
 * headers, Retry-After on 429, bounded backoff on 5xx, paging to the end without looping, errors that
 * never quote a response body, and logs of failures and retries only, without query strings or bodies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

import { createConnectorHttp } from '@/features/integrations/Lib/http'
import {
  assertReadOnly,
  createShopmonkeyClient,
  INTERACTIVE_BUDGET,
  pageContinues,
  PAGE_SIZE,
  PagingStalled,
  ReadOnlyViolation,
  type RetryBudget,
  SEARCH_ALLOWLIST,
  ShopmonkeyError,
  where,
} from '@/integrations/shopmonkey/client'
import { connector } from '@/integrations/shopmonkey/server'
import { SEARCH_ALLOWLIST as SPIKE_ALLOWLIST } from '../../../../../scripts/shopmonkey/spike-client'

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', ...headers },
  })
}

function setup(responses: Response[], budget?: RetryBudget) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => responses.shift() ?? reply(500, { success: false })
  )
  const log = vi.fn(
    (_level: string, _message: string, _details?: Record<string, unknown>) => undefined
  )
  const sleep = vi.fn(async (_ms: number) => undefined)
  const client = createShopmonkeyClient({
    fetch,
    log,
    sleep,
    budget,
    random: () => 0,
    now: () => 0,
  })
  return { client, fetch, log, sleep }
}

const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `c-${from + i}` }))

async function collect<T extends { id: string }>(pages: AsyncIterable<T[]>) {
  const seen: string[] = []
  for await (const page of pages) seen.push(...page.map((r) => r.id))
  return seen
}

describe('read-only', () => {
  it('refuses anything but GET and the search paths, before any request', async () => {
    const { client, fetch } = setup([])
    await expect(client.search('/v3/customer', { name: 'x' })).rejects.toThrow(ReadOnlyViolation)
    await expect(client.search('/v3/order/123/delete', {})).rejects.toThrow(ReadOnlyViolation)
    await expect(client.get('/v2/customer')).rejects.toThrow(ReadOnlyViolation)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses every writing method, even on a search path', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(() => assertReadOnly(method, '/v3/customer/search')).toThrow(ReadOnlyViolation)
      expect(() => assertReadOnly(method, '/v3/customer/c-1')).toThrow(ReadOnlyViolation)
    }
    expect(() => assertReadOnly('post', '/v3/customer')).toThrow(ReadOnlyViolation)
  })

  it('reads a method the same whatever its case', () => {
    expect(() => assertReadOnly('get', '/v3/order')).not.toThrow()
    expect(() => assertReadOnly('post', '/v3/customer/search')).not.toThrow()
  })

  it('refuses a path that could reach somewhere else', () => {
    for (const path of [
      '/v3/customer/search?x=1',
      '/v3/customer/search#x',
      '/v3/../v2/customer',
      '/v3/./customer/search',
      '/v3/customer/..',
      'https://elsewhere.example/v3/order',
      'v3/order',
    ]) {
      expect(() => assertReadOnly('GET', path), path).toThrow(ReadOnlyViolation)
    }
  })

  it('never decodes a VIN or a plate through Shopmonkey, whatever asks', async () => {
    const { client, fetch } = setup([])
    await expect(client.get('/v3/vehicle/vin/1HGCM82633A004352')).rejects.toThrow(ReadOnlyViolation)
    await expect(client.get('/v3/vehicle/license_plate/AB12345')).rejects.toThrow(ReadOnlyViolation)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('allows exactly the search paths the M0 spike allowed', () => {
    expect([...SEARCH_ALLOWLIST].sort()).toEqual([...SPIKE_ALLOWLIST].sort())
  })

  it('allows a GET and a listed search, sending the search as JSON', async () => {
    const { client, fetch } = setup([
      reply(200, { success: true, data: { id: 'c-1' } }),
      reply(200, { success: true, data: [] }),
    ])
    await client.get('/v3/customer/c-1')
    await client.search('/v3/customer/search', { where: where.updatedSince('2026-01-01') })
    expect(fetch.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(['GET', 'POST'])
    const post = fetch.mock.calls[1][1] as RequestInit
    expect((post.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(post.body as string)).toEqual({
      where: { updatedDate: { gte: '2026-01-01' } },
    })
  })

  it('only talks to Shopmonkey, never follows a redirect, and times out', async () => {
    const { client, fetch } = setup([reply(200, { success: true, data: [] })])
    await client.get('/v3/order')
    const init = fetch.mock.calls[0][1] as RequestInit
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
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
    expect(sleep.mock.calls).toEqual([[7000]])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('waits once on a 429, the longer of Retry-After and the pacing the headers ask for', async () => {
    const { client, sleep } = setup([
      reply(
        429,
        { success: false },
        {
          'retry-after': '2',
          'x-ratelimit-limit-minute': '120',
          'x-ratelimit-remaining-minute': '1',
        }
      ),
      reply(200, { success: true, data: {} }),
      reply(200, { success: true, data: {} }),
    ])
    await client.get('/v3/order/a')
    await client.get('/v3/order/b')
    expect(sleep.mock.calls).toEqual([[60_000]])
  })

  it('retries at once on a Retry-After of 0, and waits 30 s when there is none', async () => {
    const { client, sleep } = setup([
      reply(429, { success: false }, { 'retry-after': '0' }),
      reply(429, { success: false }),
      reply(200, { success: true, data: {} }),
    ])
    await client.get('/v3/order/a')
    expect(sleep.mock.calls).toEqual([[0], [30_000]])
  })

  it('gives up rather than wait out a Retry-After longer than it may', async () => {
    const { client, sleep, fetch } = setup([
      reply(429, { success: false, message: 'Daily limit' }, { 'retry-after': '3600' }),
    ])
    await expect(client.get('/v3/order/a')).rejects.toMatchObject({ status: 429 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('tries a rate-limited call a bounded number of times', async () => {
    const limited = () => reply(429, { success: false }, { 'retry-after': '1' })
    const backfill = setup(Array.from({ length: 10 }, limited))
    await expect(backfill.client.get('/v3/order/a')).rejects.toMatchObject({ status: 429 })
    expect(backfill.fetch).toHaveBeenCalledTimes(5)

    const interactive = setup(Array.from({ length: 10 }, limited), INTERACTIVE_BUDGET)
    await expect(interactive.client.get('/v3/order/a')).rejects.toMatchObject({ status: 429 })
    expect(interactive.fetch).toHaveBeenCalledTimes(2)
  })

  it('slows down below 10% of the minute’s budget, and not above it', async () => {
    const { client, sleep } = setup([
      reply(
        200,
        { success: true, data: {} },
        { 'x-ratelimit-limit-minute': '120', 'x-ratelimit-remaining-minute': '60' }
      ),
      reply(
        200,
        { success: true, data: {} },
        { 'x-ratelimit-limit-minute': '120', 'x-ratelimit-remaining-minute': '6' }
      ),
      reply(200, { success: true, data: {} }),
    ])
    await client.get('/v3/order/a')
    await client.get('/v3/order/b')
    expect(sleep).not.toHaveBeenCalled()
    await client.get('/v3/order/c')
    expect(sleep).toHaveBeenCalledWith(10_000)
  })

  it('does not slow down when a response leaves out either rate-limit header', async () => {
    const { client, sleep } = setup([
      reply(200, { success: true, data: {} }, { 'x-ratelimit-limit-minute': '120' }),
      reply(200, { success: true, data: {} }, { 'x-ratelimit-remaining-minute': '0' }),
      reply(200, { success: true, data: {} }),
    ])
    await client.get('/v3/order/a')
    await client.get('/v3/order/b')
    await client.get('/v3/order/c')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('backs off on a 5xx and gives Shopmonkey’s message when it keeps failing', async () => {
    const { client, sleep } = setup([
      reply(503, { success: false }),
      reply(401, { success: false, code: 'API-401', message: 'Invalid API key' }),
    ])
    const error = await client.get('/v3/auth/api_key/status').catch((e) => e)
    expect(error).toBeInstanceOf(ShopmonkeyError)
    expect(error).toMatchObject({
      status: 401,
      code: 'API-401',
      shopmonkeyMessage: 'Invalid API key',
    })
    expect(error.message).not.toContain('Invalid API key')
    expect(sleep.mock.calls).toEqual([[1000]])
  })

  it('gives up after five 5xx answers, backing off longer each time', async () => {
    const { client, sleep, fetch } = setup(
      Array.from({ length: 6 }, () => reply(503, { success: false }))
    )
    await expect(client.get('/v3/order/a')).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(sleep.mock.calls).toEqual([[1000], [2000], [4000], [8000]])
  })
})

describe('errors', () => {
  it('never quotes a body that isn’t JSON, in the error or the log', async () => {
    const page = '<html><body>Bad gateway for ada@example.com</body></html>'
    const fetch = vi.fn(async () => new Response(page, { status: 502 }))
    const log = vi.fn()
    const client = createShopmonkeyClient({
      fetch,
      log,
      budget: { attempts: 1, maxRetryAfterS: 0 },
    })
    const error = await client.get('/v3/order/a').catch((e) => e)
    expect(error).toBeInstanceOf(ShopmonkeyError)
    expect(error).toMatchObject({ status: 502, shopmonkeyMessage: null, code: null })
    expect(JSON.stringify([error.message, log.mock.calls])).not.toMatch(/html|ada@example\.com/)
  })

  it('treats a 200 that isn’t JSON, or says it failed, as a failure', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('OK', { status: 200 }))
      .mockResolvedValueOnce(reply(200, { success: false, message: 'No access' }))
    const client = createShopmonkeyClient({ fetch, log: vi.fn() })
    await expect(client.get('/v3/order/a')).rejects.toMatchObject({
      status: 200,
      shopmonkeyMessage: null,
    })
    await expect(client.get('/v3/order/a')).rejects.toMatchObject({
      shopmonkeyMessage: 'No access',
    })
  })
})

describe('paging', () => {
  it('reads every page to the end, each record once', async () => {
    const { client, fetch } = setup([
      reply(200, { success: true, data: rows(0, PAGE_SIZE), meta: { hasMore: true } }),
      // The next page repeats one row from the first: it is not yielded twice.
      reply(200, {
        success: true,
        data: [{ id: 'c-99' }, ...rows(PAGE_SIZE, 10)],
        meta: { hasMore: false },
      }),
    ])
    const seen = await collect(client.pages<{ id: string }>('/v3/customer'))
    expect(seen).toHaveLength(PAGE_SIZE + 10)
    expect(new Set(seen).size).toBe(seen.length)
    expect(fetch.mock.calls[1][0]).toContain(`skip=${PAGE_SIZE}`)
    expect(fetch.mock.calls[0][0]).toContain('orderby=id+asc')
  })

  it('keeps going past a short page while Shopmonkey says there is more, skipping what it got', async () => {
    const { client, fetch } = setup([
      reply(200, { success: true, data: rows(0, 40), meta: { hasMore: true } }),
      reply(200, { success: true, data: rows(40, 10), meta: { hasMore: false } }),
    ])
    expect(await collect(client.pages<{ id: string }>('/v3/order'))).toHaveLength(50)
    expect(fetch.mock.calls[1][0]).toContain('skip=40')
  })

  it('ends on a short page when Shopmonkey doesn’t say, and on an empty one', async () => {
    const short = setup([reply(200, { success: true, data: rows(0, 30) })])
    expect(await collect(short.client.pages<{ id: string }>('/v3/order'))).toHaveLength(30)
    expect(short.fetch).toHaveBeenCalledTimes(1)

    const exact = setup([
      reply(200, { success: true, data: rows(0, PAGE_SIZE) }),
      reply(200, { success: true, data: [] }),
    ])
    expect(await collect(exact.client.pages<{ id: string }>('/v3/order'))).toHaveLength(PAGE_SIZE)
    expect(exact.fetch).toHaveBeenCalledTimes(2)
  })

  it('stops with an error when a full page brings nothing new, instead of paging forever', async () => {
    const same = () =>
      reply(200, { success: true, data: rows(0, PAGE_SIZE), meta: { hasMore: true } })
    const { client, fetch } = setup([same(), same(), same()])
    const seen: string[] = []
    const run = async () => {
      for await (const page of client.pages<{ id: string }>('/v3/order'))
        seen.push(...page.map((r) => r.id))
    }
    await expect(run()).rejects.toThrow(PagingStalled)
    expect(seen).toHaveLength(PAGE_SIZE)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('pages a search through its body, sorted by id', async () => {
    const { client, fetch } = setup([
      reply(200, { success: true, data: rows(0, PAGE_SIZE), meta: { hasMore: true } }),
      reply(200, { success: true, data: rows(PAGE_SIZE, 5), meta: { hasMore: false } }),
    ])
    const filter = { where: where.updatedSince('2026-01-01T00:00:00Z') }
    const seen = await collect(client.searchPages<{ id: string }>('/v3/customer/search', filter))
    expect(seen).toHaveLength(PAGE_SIZE + 5)
    const bodies = fetch.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string))
    expect(bodies).toEqual([
      { ...filter, orderBy: { id: 'asc' }, limit: PAGE_SIZE, skip: 0 },
      { ...filter, orderBy: { id: 'asc' }, limit: PAGE_SIZE, skip: PAGE_SIZE },
    ])
    expect(fetch.mock.calls.every((c) => (c[1] as RequestInit).method === 'POST')).toBe(true)
  })

  it('refuses to page a search that isn’t on the allowlist', async () => {
    const { client, fetch } = setup([])
    await expect(collect(client.searchPages('/v3/order/search'))).rejects.toThrow(ReadOnlyViolation)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('where', () => {
  it('combines conditions, merging two on one field', () => {
    expect(
      where.and(
        where.updatedSince('2026-01-01'),
        { updatedDate: { lte: '2026-02-01' } },
        where.equals('locationId', 'loc-1')
      )
    ).toEqual({
      updatedDate: { gte: '2026-01-01', lte: '2026-02-01' },
      locationId: { equals: 'loc-1' },
    })
  })

  it('refuses the same operator on one field twice', () => {
    expect(() =>
      where.and(where.updatedSince('2026-01-01'), where.updatedSince('2026-02-01'))
    ).toThrow('updatedDate.gte is given twice')
  })
})

describe('logs', () => {
  it('stay quiet on success and count the call', async () => {
    const { client, log } = setup([reply(200, { success: true, data: [] })])
    await client.get('/v3/customer')
    expect(log).not.toHaveBeenCalled()
    expect(client.stats).toEqual({ calls: 1, retries: 0, failures: 0 })
  })

  it('name the method, path, status, time and request id of a failure, never a query or a body', async () => {
    const { client, log } = setup([
      reply(400, { success: false, message: 'No customer with email ada@example.com' }),
    ])
    await client
      .get('/v3/customer', { where: where.equals('email', 'ada@example.com') })
      .catch(() => undefined)
    expect(log).toHaveBeenCalledWith('warn', 'GET /v3/customer 400', {
      method: 'GET',
      path: '/v3/customer',
      status: 400,
      durationMs: 0,
      requestId: 'req-1',
    })
    const logged = JSON.stringify(log.mock.calls)
    expect(logged).not.toContain('ada@example.com')
    expect(logged).not.toContain('where')
    expect(client.stats).toEqual({ calls: 1, retries: 0, failures: 1 })
  })

  it('note each retry with its attempt', async () => {
    const { client, log } = setup([
      reply(503, { success: false }),
      reply(200, { success: true, data: {} }),
    ])
    await client.get('/v3/order/a')
    expect(log).toHaveBeenCalledWith(
      'warn',
      'GET /v3/order/a 503, retrying',
      expect.objectContaining({ status: 503, attempt: 1, requestId: 'req-1' })
    )
    expect(client.stats).toEqual({ calls: 2, retries: 1, failures: 0 })
  })
})

describe('on the connector framework’s http', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries once, itself, and never logs the body of a failed answer', async () => {
    const body = JSON.stringify({ success: false, message: 'Upstream down near ada@example.com' })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(body, { status: 503 }))
      .mockResolvedValueOnce(reply(200, { success: true, data: { id: 'o-1' } }))
    const log = vi.fn(
      async (_level: string, _message: string, _details?: Record<string, unknown>) => undefined
    )
    const http = createConnectorHttp({
      connectionId: 'conn-1',
      credentials: { apiKey: 'sm-test-key' },
      auth: {},
      log,
      shouldRetry: connector.shouldRetry?.bind(connector),
    })
    const client = createShopmonkeyClient({ fetch: http.fetch, log, sleep: async () => undefined })
    expect((await client.get('/v3/order/o-1')).data).toEqual({ id: 'o-1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(log.mock.calls)).not.toContain('ada@example.com')
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('paths that would leave Shopmonkey after encoding', () => {
  it('are refused, whatever fetch would make of them', async () => {
    const { client, fetch } = setup([])
    for (const path of [
      '/v3/x/%2e%2e/vehicle/vin/1HGCM82633A004352',
      '/v3/vehicle\\vin/1HGCM82633A004352',
      '/v3/%2e%2e/v2/customer',
      '/v3/order/a b',
    ]) {
      await expect(client.get(path), path).rejects.toThrow(ReadOnlyViolation)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuse a VIN or plate lookup in any case, without repeating the VIN', () => {
    for (const path of [
      '/v3/Vehicle/VIN/1HGCM82633A004352',
      '/v3/vehicle/license_plate/US/AB12345',
    ]) {
      const error = (() => {
        try {
          assertReadOnly('GET', path)
        } catch (e) {
          return e as Error
        }
      })()
      expect(error).toBeInstanceOf(ReadOnlyViolation)
      expect(error?.message).not.toMatch(/1HGCM82633A004352|AB12345/)
    }
    expect(() => assertReadOnly('GET', '/v3/x/%2e%2e/vehicle/vin/1HGCM82633A004352')).toThrow(
      /^(?!.*1HGCM).*$/
    )
  })
})

describe('a request that never answers', () => {
  it('is counted and logged by the error’s name, then thrown', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const fetch = vi.fn(async () => {
      throw timeout
    })
    const log = vi.fn()
    const client = createShopmonkeyClient({ fetch, log, now: () => 0 })
    await expect(client.get('/v3/order/a')).rejects.toBe(timeout)
    expect(log).toHaveBeenCalledWith('warn', 'GET /v3/order/a failed', {
      method: 'GET',
      path: '/v3/order/a',
      durationMs: 0,
      attempt: 1,
      error: 'TimeoutError',
    })
    expect(client.stats).toEqual({ calls: 1, retries: 0, failures: 1 })
  })
})

describe('giving up on a rate limit', () => {
  it('says how long Shopmonkey asked to wait, so a job can come back then', async () => {
    const { client } = setup([reply(429, { success: false }, { 'retry-after': '3600' })])
    await expect(client.get('/v3/order/a')).rejects.toMatchObject({
      status: 429,
      retryAfterS: 3600,
    })
  })

  it('carries no wait on any other failure', async () => {
    const { client } = setup([reply(404, { success: false })])
    await expect(client.get('/v3/order/a')).rejects.toMatchObject({
      status: 404,
      retryAfterS: null,
    })
  })
})

describe('one page at a time', () => {
  it('reads a GET list page at a skip, saying whether there is more', async () => {
    const { client, fetch } = setup([
      reply(200, {
        success: true,
        data: rows(100, PAGE_SIZE),
        meta: { hasMore: true, total: 250 },
      }),
    ])
    const page = await client.listPage<{ id: string }>('/v3/order', 100, {
      where: where.equals('locationId', 'loc-1'),
    })
    expect(page).toMatchObject({ more: true, total: 250 })
    expect(page.rows).toHaveLength(PAGE_SIZE)
    const url = new URL(fetch.mock.calls[0][0])
    expect(Object.fromEntries(url.searchParams)).toEqual({
      orderby: 'id asc',
      where: JSON.stringify({ locationId: { equals: 'loc-1' } }),
      limit: String(PAGE_SIZE),
      skip: '100',
    })
  })

  it('reads a search page through its body, and ends on a short page', async () => {
    const { client, fetch } = setup([reply(200, { success: true, data: rows(0, 3) })])
    const page = await client.searchPage<{ id: string }>('/v3/customer/search', 200)
    expect(page).toEqual({ rows: rows(0, 3), more: false, total: null })
    expect(JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      orderBy: { id: 'asc' },
      limit: PAGE_SIZE,
      skip: 200,
    })
  })

  it('goes on after a page only while Shopmonkey says so, or the page was full', () => {
    expect(pageContinues(0, { hasMore: true })).toBe(false)
    expect(pageContinues(5, { hasMore: true })).toBe(true)
    expect(pageContinues(PAGE_SIZE, { hasMore: false })).toBe(false)
    expect(pageContinues(PAGE_SIZE, undefined)).toBe(true)
    expect(pageContinues(PAGE_SIZE - 1, {})).toBe(false)
  })
})

describe('downloads', () => {
  const pdf = (bytes: number, headers: Record<string, string> = {}) =>
    new Response(new Uint8Array(bytes).fill(37), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'x-request-id': 'req-9', ...headers },
    })

  it('fetch the bytes and their type from Shopmonkey, with the query', async () => {
    const { client, fetch } = setup([pdf(10)])
    const file = await client.download(
      '/v3/order/o-1/pdf',
      { document_type: 'invoice' },
      { maxBytes: 100 }
    )
    expect(file.contentType).toBe('application/pdf')
    expect(file.bytes?.byteLength).toBe(10)
    expect(file.requestId).toBe('req-9')
    expect(fetch.mock.calls[0][0]).toBe(
      'https://api.shopmonkey.cloud/v3/order/o-1/pdf?document_type=invoice'
    )
    expect((fetch.mock.calls[0][1] as RequestInit).method).toBe('GET')
  })

  it('stop at the size cap, whether or not the length is declared', async () => {
    const declared = setup([pdf(10, { 'content-length': '500' })])
    expect(
      (await declared.client.download('/v3/order/o-1/pdf', {}, { maxBytes: 100 })).bytes
    ).toBeNull()
    const streamed = setup([pdf(500)])
    expect(
      (await streamed.client.download('/v3/order/o-1/pdf', {}, { maxBytes: 100 })).bytes
    ).toBeNull()
  })

  it('fail like any other call when Shopmonkey refuses', async () => {
    const { client } = setup([
      reply(403, { success: false, code: 'API-472811', message: 'No access' }),
    ])
    await expect(client.download('/v3/order/o-1/pdf', {}, { maxBytes: 100 })).rejects.toMatchObject(
      {
        status: 403,
        code: 'API-472811',
      }
    )
  })
})
