/**
 * @vitest-environment node
 *
 * The M0 spike client must never write to Shopmonkey (docs/fork/FORK.md). These tests drive it with a
 * fake fetch: anything but GET or an allowlisted search is refused before fetch is called, a 429 is
 * retried after Retry-After, and every response is recorded for the anonymizer without the key.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  assertReadOnly,
  createSpikeClient,
  ReadOnlyViolation,
} from '../../../../scripts/shopmonkey/spike-client'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', ...headers },
  })
}

function client(fetchImpl: typeof fetch) {
  const rawDir = mkdtempSync(path.join(tmpdir(), 'sm-raw-'))
  const lines: string[] = []
  return {
    rawDir,
    lines,
    api: createSpikeClient({
      apiKey: 'sk_test_secret_value',
      rawDir,
      fetchImpl,
      log: (l) => lines.push(l),
    }),
  }
}

describe('assertReadOnly', () => {
  it('allows GET and allowlisted search POSTs only', () => {
    expect(() => assertReadOnly('GET', '/v3/order')).not.toThrow()
    expect(() => assertReadOnly('POST', '/v3/order/search')).not.toThrow()
    expect(() => assertReadOnly('POST', '/v3/customer/email/search')).not.toThrow()
    expect(() => assertReadOnly('POST', '/v3/integration/payment/search')).not.toThrow()
    for (const [method, p] of [
      ['POST', '/v3/order'],
      ['PUT', '/v3/order/abc'],
      ['PATCH', '/v3/customer/abc'],
      ['DELETE', '/v3/vehicle/abc'],
      ['POST', '/v3/order/abc/service'],
      ['POST', '/v3/order/search/../abc'],
      ['POST', '/v3/order/64b0c1d2e3f4a5b6c7d8e9f0/search'],
      ['POST', '/v3/customer/email'],
    ]) {
      expect(() => assertReadOnly(method, p), `${method} ${p}`).toThrow(ReadOnlyViolation)
    }
  })
})

describe('createSpikeClient', () => {
  it('refuses a write before any network call', async () => {
    const fetchImpl = vi.fn()
    const { api } = client(fetchImpl as unknown as typeof fetch)
    await expect(
      api.request({ method: 'POST', path: '/v3/customer', body: { firstName: 'x' } })
    ).rejects.toThrow(ReadOnlyViolation)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('waits for Retry-After on 429, then records the successful response', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'slow down' }, { 'retry-after': '2' }))
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          { success: true, data: [{ id: 'c1' }], meta: { hasMore: false } },
          {
            'x-ratelimit-limit-minute': '300',
            'x-ratelimit-remaining-minute': '299',
          }
        )
      )
    const { api, rawDir, lines } = client(fetchImpl as unknown as typeof fetch)
    const pending = api.request({ path: '/v3/customer', query: { limit: 5 }, table: 'customer' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const res = await pending
    vi.useRealTimers()

    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(api.stats()).toMatchObject({ calls: 2, lastLimit: 300, lastRemaining: 299 })

    const files = readdirSync(rawDir)
    expect(files).toEqual(['get-v3-customer.json'])
    const raw = JSON.parse(readFileSync(path.join(rawDir, files[0]), 'utf-8'))
    expect(raw.table).toBe('customer')
    expect(raw.request.query).toEqual({ limit: '5' })
    expect(raw.headers['x-request-id']).toBe('req-1')
    expect(JSON.stringify(raw)).not.toContain('sk_test_secret_value')
    // Logs carry method, path, status and request id; never the key or query values.
    expect(lines.join('\n')).toContain('GET /v3/customer 200')
    expect(lines.join('\n')).not.toContain('sk_test_secret_value')
  })

  it('sends the key as a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: {} }))
    const { api } = client(fetchImpl as unknown as typeof fetch)
    await api.request({ path: '/v3/auth/api_key/status' })
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk_test_secret_value'
    )
    expect(init.method).toBe('GET')
  })
})
