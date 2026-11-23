/**
 * @vitest-environment node
 *
 * fork: the Shopmonkey connector's connect checks (M2 acceptance): a valid key passes and names the
 * company, a bad key shows Shopmonkey's own message, locations come from the location list or, when
 * that's missing, from the key's user. Shapes are from Shopmonkey's docs (PROVISIONAL(M0:S1)).
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorContext } from '@/features/integrations/Lib/types'
import { connector } from '@/integrations/shopmonkey/server'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
  })
}

function ctxWith(routes: Record<string, Response>) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname
    return routes[path] ?? json(404, { success: false, message: 'Not found' })
  })
  const ctx = {
    credentials: { apiKey: 'sm-test-key' },
    http: { fetch, json: vi.fn() },
    log: vi.fn(async () => undefined),
  } as unknown as ConnectorContext
  return { ctx, fetch }
}

describe('the Shopmonkey connector', () => {
  it('passes a valid key, sending it as a bearer token', async () => {
    const { ctx, fetch } = ctxWith({
      '/v3/auth/api_key/status': json(200, { success: true, data: {} }),
    })
    expect(await connector.test(ctx)).toEqual({ ok: true })
    const init = fetch.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sm-test-key')
    expect(init.method).toBe('GET')
  })

  it('shows Shopmonkey’s own message for a bad key', async () => {
    const { ctx } = ctxWith({
      '/v3/auth/api_key/status': json(401, {
        success: false,
        code: 'API-401',
        message: 'The API key is invalid or expired',
      }),
    })
    expect(await connector.test(ctx)).toEqual({
      ok: false,
      message: 'The API key is invalid or expired',
    })
  })

  it('names the company the key belongs to', async () => {
    const { ctx } = ctxWith({
      '/v3/user/me': json(200, {
        success: true,
        data: { companyId: 'co-1', company: { name: 'Example Auto' }, locations: [] },
      }),
    })
    expect(await connector.identify?.(ctx)).toEqual({ id: 'co-1', name: 'Example Auto' })
  })

  it('takes the company from company.id when there is no companyId', async () => {
    const { ctx } = ctxWith({
      '/v3/user/me': json(200, { success: true, data: { company: { id: 'co-2' } } }),
    })
    expect(await connector.identify?.(ctx)).toEqual({ id: 'co-2', name: 'co-2' })
  })

  it('refuses to name a connection when Shopmonkey doesn’t say which company the key is for', async () => {
    const { ctx } = ctxWith({ '/v3/user/me': json(200, { success: true, data: {} }) })
    await expect(connector.identify?.(ctx)).rejects.toThrow('which company')
  })

  it('gives up at once on a long rate limit while someone waits on the connect check', async () => {
    const { ctx, fetch } = ctxWith({
      '/v3/auth/api_key/status': new Response(
        JSON.stringify({ success: false, message: 'Too many requests' }),
        { status: 429, headers: { 'retry-after': '60' } }
      ),
    })
    expect(await connector.test(ctx)).toEqual({ ok: false, message: 'Too many requests' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('lists locations from the location list, a page of up to 100', async () => {
    const { ctx, fetch } = ctxWith({
      '/v3/location': json(200, { success: true, data: [{ id: 'loc-1', name: 'Main street' }] }),
    })
    expect(await connector.remoteOptions?.locations(ctx)).toEqual([
      { value: 'loc-1', label: 'Main street' },
    ])
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('limit')).toBe('100')
  })

  it('lists locations, falling back to the key’s own user when the list endpoint is gone', async () => {
    const { ctx } = ctxWith({
      '/v3/location': json(404, { success: false, message: 'Not found' }),
      '/v3/user/me': json(200, {
        success: true,
        data: {
          companyId: 'co-1',
          locations: [{ id: 'loc-1', name: 'Main street' }, { id: 'loc-2' }],
        },
      }),
    })
    expect(await connector.remoteOptions?.locations(ctx)).toEqual([
      { value: 'loc-1', label: 'Main street' },
      { value: 'loc-2', label: 'loc-2' },
    ])
  })

  it('leaves retrying and logging to its own client', () => {
    expect(connector.shouldRetry?.(429, '{}')).toBe(false)
    expect(connector.shouldRetry?.(503, '{}')).toBe(false)
  })
})
