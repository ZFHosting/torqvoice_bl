/**
 * Shopmonkey's REST API v3, read-only by construction (docs/fork/FORK.md, "Shopmonkey is read-only to
 * us"). Every call is a GET, or a POST to one of the read-only search paths in SEARCH_ALLOWLIST, on
 * Shopmonkey's own origin under `/v3/`; anything else throws before a request leaves the process.
 *
 * Built on the connection's `ctx.http` (credentials attached by the connector framework), but it does
 * its own retrying: the server module's `shouldRetry` answers false, so the framework neither retries
 * nor logs response bodies. This client logs failures and retries only, with method, path, status,
 * duration and Shopmonkey's request id: never a query string (a `where` can hold an email or a phone
 * number), never a body. Successful calls are counted in `stats` for a job to summarise.
 *
 * Pacing (RESULTS S3). PROVISIONAL(M0:S3): the docs show `X-RateLimit-Limit-Minute` and
 * `X-RateLimit-Remaining-Minute` on a 429; this client assumes every response carries them, and only
 * slows down when both are present. Below 10% remaining it spreads calls over the rest of the minute.
 * A 429 waits `Retry-After` (seconds, PROVISIONAL(M0:S3)); a 5xx retries with jittered backoff.
 */

export const SHOPMONKEY_BASE_URL = 'https://api.shopmonkey.cloud'

/**
 * Where this server reaches Shopmonkey: always Shopmonkey's own API, unless `SHOPMONKEY_API_BASE_URL` points it at a
 * stand-in (M8: the end-to-end suite's mock, `e2e/shopmonkey-standin.ts`). Read from the environment only, as the
 * payment vendors' stand-ins are (`lib/payment-providers/vendor-hosts.ts`): a workshop can't set it, so no tenant can
 * send its key anywhere but Shopmonkey.
 */
export function shopmonkeyBaseUrl(): string {
  const base = process.env.SHOPMONKEY_API_BASE_URL?.trim().replace(/\/+$/, '')
  return base || SHOPMONKEY_BASE_URL
}

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

/**
 * GETs never made, whatever asks: they decode a vehicle through a data provider and may be billed, and
 * their paths would carry a VIN or a plate into the logs (RESULTS S4).
 */
const NEVER_CALLED = ['/v3/vehicle/vin/', '/v3/vehicle/license_plate/']

/** The page size every list is read in. PROVISIONAL(M0:S2): no maximum is documented; clients use 100. */
export const PAGE_SIZE = 100
const SLOW_BELOW = 0.1
const REQUEST_TIMEOUT_MS = 30_000

/** How hard to try. A backfill waits out a rate limit; a connect check, with someone watching, doesn't. */
export interface RetryBudget {
  attempts: number
  /** The longest `Retry-After` honoured, in seconds; a longer one gives up rather than retry early. */
  maxRetryAfterS: number
}
export const BACKFILL_BUDGET: RetryBudget = { attempts: 5, maxRetryAfterS: 120 }
export const INTERACTIVE_BUDGET: RetryBudget = { attempts: 2, maxRetryAfterS: 5 }

export class ReadOnlyViolation extends Error {
  /** `shown` is what may appear in a log: never a path that could carry a VIN or a plate. */
  constructor(method: string, shown: string) {
    super(`Refused ${method} ${shown}: Shopmonkey is read-only to this app.`)
    this.name = 'ReadOnlyViolation'
  }
}

export class ShopmonkeyError extends Error {
  constructor(
    readonly status: number,
    /**
     * Shopmonkey's own `message`. For the key and identity endpoints it describes the key and is fine
     * to show the workshop; elsewhere it may echo request values, so don't log it wholesale.
     */
    readonly shopmonkeyMessage: string | null,
    readonly code: string | null,
    readonly requestId: string | null,
    /** On a 429 the client gave up on: how long Shopmonkey asked to wait, so a job can reschedule. */
    readonly retryAfterS: number | null = null
  ) {
    super(
      `Shopmonkey answered ${status}${code ? ` (${code})` : ''}${requestId ? ` [request ${requestId}]` : ''}`
    )
    this.name = 'ShopmonkeyError'
  }
}

/** A list whose pages stopped bringing anything new: a skip Shopmonkey ignores, not the end. */
export class PagingStalled extends Error {
  constructor(pathName: string, skip: number) {
    super(`Paging ${pathName} stalled at skip ${skip}: a full page brought no new records.`)
    this.name = 'PagingStalled'
  }
}

/** True when fetch would request exactly this path on Shopmonkey's origin (nothing encoded away). */
function staysOnShopmonkey(pathName: string): boolean {
  if (!pathName.startsWith('/v3/') || /[?#\\]|\/\.\.?(\/|$)/.test(pathName)) return false
  try {
    const base = shopmonkeyBaseUrl()
    const resolved = new URL(pathName, base)
    return resolved.origin === new URL(base).origin && resolved.pathname === pathName
  } catch {
    return false
  }
}

export function assertReadOnly(method: string, pathName: string): void {
  const m = method.toUpperCase()
  // Neither message repeats the path: it could be an encoded VIN or plate lookup.
  if (!staysOnShopmonkey(pathName)) throw new ReadOnlyViolation(m, 'a path off /v3/')
  const lower = pathName.toLowerCase()
  const never = NEVER_CALLED.find((prefix) => lower.startsWith(prefix))
  if (never) throw new ReadOnlyViolation(m, `${never}…`)
  if (m === 'GET') return
  if (m === 'POST' && SEARCH_ALLOWLIST.has(pathName)) return
  throw new ReadOnlyViolation(m, pathName)
}

/**
 * Whether a list goes on after this page. PROVISIONAL(M0:S2): `meta.hasMore` when Shopmonkey gives
 * it; otherwise a full page means there may be more. An empty page always ends it.
 */
export function pageContinues(count: number, meta: Envelope<unknown>['meta']): boolean {
  if (count === 0) return false
  if (meta?.hasMore === false) return false
  if (meta?.hasMore === true) return true
  return count >= PAGE_SIZE
}

/** One page of a list, read on its own (an extract job reads one page per run). */
export interface Page<T> {
  rows: T[]
  /** Whether to read the next page, at `skip + rows.length`. */
  more: boolean
  total: number | null
}

function retryAfterOf(response: Response): number | null {
  const raw = response.headers.get('retry-after')
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * A `where` in Shopmonkey's Prisma-style syntax (RESULTS S2). PROVISIONAL(M0:S2): the operators
 * (`equals`, `in`, `gte`) are from the timesheet and appointment search docs.
 */
export type Where = Record<string, unknown>

function mergeWhere(target: Where, source: Where): Where {
  const out: Where = { ...target }
  for (const [field, condition] of Object.entries(source)) {
    const existing = out[field]
    if (existing === undefined) {
      out[field] = condition
      continue
    }
    if (!existing || !condition || typeof existing !== 'object' || typeof condition !== 'object') {
      throw new Error(`Two conditions on ${field} can't be combined`)
    }
    for (const op of Object.keys(condition as Where)) {
      if (op in (existing as Where)) throw new Error(`${field}.${op} is given twice`)
    }
    out[field] = { ...(existing as Where), ...(condition as Where) }
  }
  return out
}

export const where = {
  equals: (field: string, value: unknown): Where => ({ [field]: { equals: value } }),
  in: (field: string, values: unknown[]): Where => ({ [field]: { in: values } }),
  updatedSince: (iso: string): Where => ({ updatedDate: { gte: iso } }),
  /** Every condition at once; two on one field merge (`gte` and `lte`), the same operator twice throws. */
  and: (...parts: Where[]): Where => parts.reduce(mergeWhere, {}),
}

/** PROVISIONAL(M0:S2): `{ success, data, meta: { hasMore, total } }` for lists, from the docs. */
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
  budget?: RetryBudget
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

export interface Query {
  [key: string]: string | number | boolean | Where | undefined
}

/** PROVISIONAL(M0:S2): `where` goes as URL-encoded JSON; the docs don't say how a GET takes it. */
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
  const budget = options.budget ?? BACKFILL_BUDGET
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const stats = { calls: 0, retries: 0, failures: 0 }

  /** How long to wait before the next call, from a response's rate-limit headers; 0 without both. */
  function paceFrom(response: Response): number {
    const limitHeader = response.headers.get('x-ratelimit-limit-minute')
    const remainingHeader = response.headers.get('x-ratelimit-remaining-minute')
    if (limitHeader === null || remainingHeader === null) return 0
    const limit = Number(limitHeader)
    const remaining = Number(remainingHeader)
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return 0
    if (remaining >= limit * SLOW_BELOW) return 0
    // Spread what is left of the minute's budget over the minute.
    return Math.ceil(60_000 / Math.max(remaining, 1))
  }
  let nextDelay = 0

  async function send(
    method: 'GET' | 'POST',
    pathName: string,
    init: { query?: Query; body?: unknown; accept?: string }
  ) {
    assertReadOnly(method, pathName)
    const url = `${shopmonkeyBaseUrl()}${pathName}${toSearch(init.query)}`
    for (let attempt = 1; ; attempt++) {
      if (nextDelay > 0) await sleep(nextDelay)
      nextDelay = 0
      const started = now()
      let response: Response
      try {
        response = await options.fetch(url, {
          method,
          headers: {
            Accept: init.accept ?? 'application/json',
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (err) {
        // A timeout or a dropped connection: counted and logged by name, never by message.
        stats.calls++
        stats.failures++
        await options.log('warn', `${method} ${pathName} failed`, {
          method,
          path: pathName,
          durationMs: now() - started,
          attempt,
          error: err instanceof Error ? err.name : 'Error',
        })
        throw err
      }
      stats.calls++
      const requestId = response.headers.get('x-request-id')
      const details = {
        method,
        path: pathName,
        status: response.status,
        durationMs: now() - started,
        requestId,
      }
      const pace = paceFrom(response)
      const lastAttempt = attempt >= budget.attempts

      if (response.status === 429 && !lastAttempt) {
        const retryAfterS = retryAfterOf(response) ?? 30
        if (retryAfterS <= budget.maxRetryAfterS) {
          stats.retries++
          await options.log('warn', `${method} ${pathName} 429, retrying`, { ...details, attempt })
          // One wait, the longer of the two: Retry-After, or the pacing the headers ask for.
          await sleep(Math.max(retryAfterS * 1000, pace))
          continue
        }
      }
      if (response.status >= 500 && !lastAttempt) {
        stats.retries++
        await options.log('warn', `${method} ${pathName} ${response.status}, retrying`, {
          ...details,
          attempt,
        })
        const backoff = 1000 * 2 ** (attempt - 1)
        await sleep(backoff + Math.floor(random() * backoff))
        continue
      }
      nextDelay = pace
      return { response, requestId, details }
    }
  }

  function parseEnvelope<T>(text: string): Envelope<T> | null {
    if (!text) return null
    try {
      return JSON.parse(text) as Envelope<T>
    } catch {
      // Not JSON (an HTML error page, a proxy's text): never let its words into an error or a log.
      return null
    }
  }

  async function failure(
    method: string,
    pathName: string,
    sent: Awaited<ReturnType<typeof send>>,
    body: Envelope<unknown> | null
  ): Promise<ShopmonkeyError> {
    const { response, requestId, details } = sent
    stats.failures++
    await options.log('warn', `${method} ${pathName} ${response.status}`, details)
    return new ShopmonkeyError(
      response.status,
      typeof body?.message === 'string' ? body.message : null,
      typeof body?.code === 'string' ? body.code : null,
      requestId,
      response.status === 429 ? (retryAfterOf(response) ?? 30) : null
    )
  }

  async function request<T>(
    method: 'GET' | 'POST',
    pathName: string,
    init: { query?: Query; body?: unknown } = {}
  ): Promise<Envelope<T>> {
    const sent = await send(method, pathName, init)
    const body = parseEnvelope<T>(await sent.response.text())
    if (!sent.response.ok || !body || body.success === false) {
      throw await failure(method, pathName, sent, body)
    }
    return body
  }

  async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel()
      return null
    }
    if (!response.body) return new Uint8Array(await response.arrayBuffer())
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.byteLength
    }
    return out
  }

  /** A binary GET on Shopmonkey's origin (the invoice PDF). `bytes` is null when over `maxBytes`. */
  async function download(
    pathName: string,
    query: Query,
    limits: { maxBytes: number; accept?: string }
  ): Promise<{ bytes: Uint8Array | null; contentType: string | null; requestId: string | null }> {
    const sent = await send('GET', pathName, { query, accept: limits.accept ?? '*/*' })
    if (!sent.response.ok) {
      throw await failure('GET', pathName, sent, parseEnvelope(await sent.response.text()))
    }
    return {
      bytes: await readCapped(sent.response, limits.maxBytes),
      contentType: sent.response.headers.get('content-type'),
      requestId: sent.requestId,
    }
  }

  async function onePage<T>(envelope: Promise<Envelope<T[]>>): Promise<Page<T>> {
    const page = await envelope
    const rows = Array.isArray(page.data) ? page.data : []
    return {
      rows,
      more: pageContinues(rows.length, page.meta),
      total: typeof page.meta?.total === 'number' ? page.meta.total : null,
    }
  }

  /**
   * Every record of a list, page by page, each once. PROVISIONAL(M0:S2): sorted by `id` and
   * de-duplicated, because plain GET lists were reported to come back in an unstable order. Ends on
   * `hasMore === false`, or on a short page when `hasMore` isn't given; throws PagingStalled when a
   * full page brings nothing new (a `skip` the server ignores), instead of paging forever.
   */
  async function* paged<T extends { id: string }>(
    pathName: string,
    fetchPage: (skip: number) => Promise<Envelope<T[]>>
  ): AsyncGenerator<T[]> {
    const seen = new Set<string>()
    for (let skip = 0; ; ) {
      const page = await fetchPage(skip)
      const data = Array.isArray(page.data) ? page.data : []
      const fresh = data.filter((row) => !seen.has(row.id))
      for (const row of fresh) seen.add(row.id)
      if (fresh.length) yield fresh
      if (!pageContinues(data.length, page.meta)) return
      if (fresh.length === 0) throw new PagingStalled(pathName, skip)
      skip += data.length
    }
  }

  const listQuery = (query: Omit<Query, 'limit' | 'skip'>, skip: number): Query => ({
    orderby: 'id asc',
    ...query,
    limit: PAGE_SIZE,
    skip,
  })
  const searchBody = (filter: { where?: Where }, skip: number) => ({
    ...filter,
    orderBy: { id: 'asc' },
    limit: PAGE_SIZE,
    skip,
  })

  return {
    stats,
    get: <T>(pathName: string, query?: Query) => request<T>('GET', pathName, { query }),
    search: <T>(pathName: string, body: unknown) => request<T>('POST', pathName, { body }),
    download,

    /** One page of a GET list at `skip`, sorted by id. */
    listPage: <T>(pathName: string, skip: number, query: Omit<Query, 'limit' | 'skip'> = {}) =>
      onePage<T>(request<T[]>('GET', pathName, { query: listQuery(query, skip) })),

    /** One page of a search at `skip`, sorted by id. PROVISIONAL(M0:S2): see searchPages. */
    searchPage: <T>(pathName: string, skip: number, filter: { where?: Where } = {}) =>
      onePage<T>(request<T[]>('POST', pathName, { body: searchBody(filter, skip) })),

    /** A GET list, every page. */
    pages: <T extends { id: string }>(
      pathName: string,
      query: Omit<Query, 'limit' | 'skip'> = {}
    ) =>
      paged<T>(pathName, (skip) =>
        request<T[]>('GET', pathName, { query: listQuery(query, skip) })
      ),

    /**
     * A search, every page (customers and inventory have no GET list, RESULTS S4).
     * PROVISIONAL(M0:S2): search bodies take `where`, `orderBy`, `limit`, `skip`.
     */
    searchPages: <T extends { id: string }>(pathName: string, filter: { where?: Where } = {}) =>
      paged<T>(pathName, (skip) =>
        request<T[]>('POST', pathName, { body: searchBody(filter, skip) })
      ),
  }
}

export type ShopmonkeyClient = ReturnType<typeof createShopmonkeyClient>
