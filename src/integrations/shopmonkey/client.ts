/**
 * Shopmonkey's REST API v3, read-only by construction (docs/fork/FORK.md, "Shopmonkey is read-only to
 * us"). Every call is a GET, or a POST to one of the read-only search paths in SEARCH_ALLOWLIST;
 * anything else throws before a request leaves the process.
 *
 * Built on the connection's `ctx.http` (credentials attached by the connector framework), but it does
 * its own retrying: the server module's `shouldRetry` answers false, so the framework neither retries
 * nor logs response bodies, and this client logs only method, path, status, duration and Shopmonkey's
 * request id. Never a query string (a `where` can hold an email or a phone number) and never a body.
 *
 * Pacing (RESULTS S3): every response carries `X-RateLimit-Limit-Minute` and
 * `X-RateLimit-Remaining-Minute` over a rolling minute; below 10% remaining the client spreads its
 * calls over the rest of the minute. A 429 waits `Retry-After`; a 5xx retries with jittered backoff.
 */

export const SHOPMONKEY_BASE_URL = 'https://api.shopmonkey.cloud'

/**
 * POST endpoints that only read: every `.../search` route in Shopmonkey's API reference
 * (docs/fork/spikes/RESULTS.md S4). Exact paths, not a pattern, so nothing new is allowed by accident.
 * PROVISIONAL(M0:S2): from the docs; confirm with a key that each one only reads.
 */
export const SEARCH_ALLOWLIST: ReadonlySet<string> = new Set([
  '/v3/appointment/search',
  '/v3/customer/search',
  '/v3/customer/email/search',
  '/v3/customer/phone_number/search',
  '/v3/integration/payment/search',
  '/v3/inventory_fee/search',
  '/v3/inventory_labor/search',
  '/v3/inventory_part/search',
  '/v3/inventory_tire/search',
  '/v3/inventory_transfer/search',
  '/v3/part_return/search',
  '/v3/purchase_order/search',
  '/v3/statement/search',
  '/v3/timesheet/search',
])

/** The page size every list is read in. PROVISIONAL(M0:S2): no maximum is documented; clients use 100. */
export const PAGE_SIZE = 100
const MAX_ATTEMPTS = 5
const MAX_RETRY_AFTER_S = 120
const SLOW_BELOW = 0.1

export class ReadOnlyViolation extends Error {
  constructor(method: string, pathName: string) {
    super(`Refused ${method} ${pathName}: Shopmonkey is read-only to this app.`)
    this.name = 'ReadOnlyViolation'
  }
}

export class ShopmonkeyError extends Error {
  constructor(
    readonly status: number,
    /** Shopmonkey's own words (`message`), safe to show the workshop: they describe its key. */
    readonly shopmonkeyMessage: string | null,
    readonly code: string | null,
    readonly requestId: string | null
  ) {
    super(
      `Shopmonkey answered ${status}${code ? ` (${code})` : ''}${shopmonkeyMessage ? `: ${shopmonkeyMessage}` : ''}`
    )
    this.name = 'ShopmonkeyError'
  }
}

export function assertReadOnly(method: string, pathName: string): void {
  const m = method.toUpperCase()
  if (m === 'GET') return
  if (m === 'POST' && SEARCH_ALLOWLIST.has(pathName)) return
  throw new ReadOnlyViolation(m, pathName)
}

/** A `where` in Shopmonkey's Prisma-style syntax (RESULTS S2): `{ updatedDate: { gte: ISO } }`. */
export type Where = Record<string, unknown>

export const where = {
  equals: (field: string, value: unknown): Where => ({ [field]: { equals: value } }),
  in: (field: string, values: unknown[]): Where => ({ [field]: { in: values } }),
  updatedSince: (iso: string): Where => ({ updatedDate: { gte: iso } }),
  and: (...parts: Where[]): Where => Object.assign({}, ...parts),
}

export interface Envelope<T> {
  success: boolean
  data: T
  meta?: { hasMore?: boolean; total?: number }
  code?: string
  message?: string
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type Log = (
  level: 'info' | 'warn' | 'error',
  message: string,
  details?: Record<string, unknown>
) => Promise<void> | void

export interface ShopmonkeyClientOptions {
  /** `ctx.http.fetch` in the app; anything fetch-shaped in tests. */
  fetch: Fetch
  log: Log
  baseUrl?: string
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

export interface Query {
  [key: string]: string | number | boolean | Where | undefined
}

function toSearch(query: Query | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function createShopmonkeyClient(options: ShopmonkeyClientOptions) {
  const base = (options.baseUrl ?? SHOPMONKEY_BASE_URL).replace(/\/$/, '')
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now

  /** How long to wait before the next call, from the last response's rate-limit headers. */
  function paceFrom(response: Response): number {
    const limit = Number(response.headers.get('x-ratelimit-limit-minute'))
    const remaining = Number(response.headers.get('x-ratelimit-remaining-minute'))
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return 0
    if (remaining >= limit * SLOW_BELOW) return 0
    // Spread what is left of the minute's budget over the minute.
    return Math.ceil(60_000 / Math.max(remaining, 1))
  }
  let nextDelay = 0

  async function request<T>(
    method: 'GET' | 'POST',
    pathName: string,
    init: { query?: Query; body?: unknown } = {}
  ): Promise<Envelope<T>> {
    if (!pathName.startsWith('/v3/')) throw new ReadOnlyViolation(method, pathName)
    assertReadOnly(method, pathName)
    const url = `${base}${pathName}${toSearch(init.query)}`
    for (let attempt = 1; ; attempt++) {
      if (nextDelay > 0) await sleep(nextDelay)
      const started = now()
      const response = await options.fetch(url, {
        method,
        headers: { Accept: 'application/json' },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'manual',
      })
      const requestId = response.headers.get('x-request-id')
      await options.log(response.ok ? 'info' : 'warn', `${method} ${pathName} ${response.status}`, {
        method,
        path: pathName,
        status: response.status,
        durationMs: now() - started,
        requestId,
      })
      nextDelay = paceFrom(response)

      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const seconds = Number(response.headers.get('retry-after'))
        await sleep(
          (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : 30) *
            1000
        )
        continue
      }
      if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
        const backoff = 1000 * 2 ** (attempt - 1)
        await sleep(backoff + Math.floor(random() * backoff))
        continue
      }
      const text = await response.text()
      const body = text
        ? (JSON.parse(text) as Envelope<T>)
        : ({ success: response.ok } as Envelope<T>)
      if (!response.ok || body.success === false) {
        throw new ShopmonkeyError(
          response.status,
          body.message ?? null,
          body.code ?? null,
          requestId
        )
      }
      return body
    }
  }

  return {
    get: <T>(pathName: string, query?: Query) => request<T>('GET', pathName, { query }),
    search: <T>(pathName: string, body: unknown) => request<T>('POST', pathName, { body }),

    /**
     * Every record of a list, page by page (`limit`/`skip`), each once. PROVISIONAL(M0:S2): sorted by
     * `id` and de-duplicated, because plain GET lists were reported to come back in an unstable order;
     * finishes on `hasMore === false` or a short page.
     */
    async *pages<T extends { id: string }>(
      pathName: string,
      query: Omit<Query, 'limit' | 'skip'> = {}
    ): AsyncGenerator<T[]> {
      const seen = new Set<string>()
      for (let skip = 0; ; skip += PAGE_SIZE) {
        const page = await request<T[]>('GET', pathName, {
          query: { orderby: 'id asc', ...query, limit: PAGE_SIZE, skip },
        })
        const rows = (page.data ?? []).filter((row) => !seen.has(row.id))
        for (const row of rows) seen.add(row.id)
        if (rows.length) yield rows
        if (page.meta?.hasMore === false || (page.data ?? []).length < PAGE_SIZE) return
      }
    },
  }
}

export type ShopmonkeyClient = ReturnType<typeof createShopmonkeyClient>
