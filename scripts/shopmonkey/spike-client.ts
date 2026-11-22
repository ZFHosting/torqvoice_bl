/**
 * The spike's HTTP client for Shopmonkey's REST API v3. Read-only by construction
 * (docs/fork/FORK.md): it refuses every method except GET, and POST to the search paths in
 * SEARCH_ALLOWLIST, before any network call. It paces itself from the rate-limit headers, honours
 * Retry-After on 429, and records every response to tmp/shopmonkey-raw/ for the anonymizer.
 *
 * The app's own client (src/integrations/shopmonkey/client.ts, milestone M2) is built on the connector
 * http layer; this one is a standalone script so M0 has no app dependencies.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { RawResponseFile } from './raw'

export const SHOPMONKEY_BASE_URL = 'https://api.shopmonkey.cloud'

/**
 * POST endpoints that only read. PROVISIONAL(M0:S2): from the docs; extend only with paths whose
 * documentation says they search.
 */
export const SEARCH_ALLOWLIST: readonly RegExp[] = [/^\/v3\/[a-z_]+\/search$/]

export class ReadOnlyViolation extends Error {
  constructor(method: string, pathName: string) {
    super(`Refused ${method} ${pathName}: the Shopmonkey spike only reads.`)
    this.name = 'ReadOnlyViolation'
  }
}

export function assertReadOnly(method: string, pathName: string): void {
  const m = method.toUpperCase()
  if (m === 'GET') return
  if (m === 'POST' && SEARCH_ALLOWLIST.some((re) => re.test(pathName))) return
  throw new ReadOnlyViolation(m, pathName)
}

export interface SpikeRequest {
  method?: 'GET' | 'POST'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** Shopmonkey table the response's records belong to, for the anonymizer. */
  table?: string | null
  /** File name for the raw response; defaults to a slug of the path. */
  label?: string
}

export interface SpikeResponse {
  status: number
  headers: Record<string, string>
  body: unknown
  durationMs: number
}

const KEPT_HEADERS = [
  'x-request-id',
  'x-ratelimit-limit-minute',
  'x-ratelimit-remaining-minute',
  'retry-after',
  'content-type',
  'content-length',
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createSpikeClient(options: {
  apiKey: string
  rawDir: string
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? ((line: string) => console.log(line))
  let calls = 0
  let lastRemaining: number | null = null
  let lastLimit: number | null = null

  async function pace() {
    // Below 10% of the minute's budget, spread the rest of the minute out.
    if (lastRemaining !== null && lastLimit && lastRemaining < lastLimit * 0.1) {
      await sleep(Math.ceil(60_000 / Math.max(lastRemaining, 1)))
    }
  }

  async function request(req: SpikeRequest): Promise<SpikeResponse> {
    const method = req.method ?? 'GET'
    assertReadOnly(method, req.path)
    const url = new URL(req.path, SHOPMONKEY_BASE_URL)
    for (const [k, v] of Object.entries(req.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v))

    for (let attempt = 1; ; attempt++) {
      await pace()
      const started = Date.now()
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      })
      calls++
      const durationMs = Date.now() - started
      const headers: Record<string, string> = {}
      for (const name of KEPT_HEADERS) {
        const value = res.headers.get(name)
        if (value !== null) headers[name] = value
      }
      lastLimit = numberOrNull(headers['x-ratelimit-limit-minute']) ?? lastLimit
      lastRemaining = numberOrNull(headers['x-ratelimit-remaining-minute'])
      // Method, path, status, time and request id only: never query values or bodies.
      log(
        `${method} ${req.path} ${res.status} ${durationMs}ms req=${headers['x-request-id'] ?? '-'}`
      )

      if (res.status === 429 && attempt <= 5) {
        const wait = (numberOrNull(headers['retry-after']) ?? 2 ** attempt) * 1000
        log(`  429: waiting ${wait}ms (attempt ${attempt})`)
        await sleep(wait)
        continue
      }
      if (res.status >= 500 && attempt <= 3) {
        await sleep(1000 * 2 ** attempt + Math.random() * 500)
        continue
      }
      const type = headers['content-type'] ?? ''
      const body = type.includes('json')
        ? await res.json().catch(() => null)
        : await describeBinary(res)
      const response = { status: res.status, headers, body, durationMs }
      record(req, method, url, response)
      return response
    }
  }

  function record(req: SpikeRequest, method: 'GET' | 'POST', url: URL, response: SpikeResponse) {
    mkdirSync(options.rawDir, { recursive: true })
    const label = req.label ?? slug(`${method}-${req.path}`)
    const file: RawResponseFile = {
      table: req.table ?? null,
      label,
      request: {
        method,
        path: req.path,
        query: Object.fromEntries(url.searchParams),
        body: req.body,
      },
      status: response.status,
      headers: response.headers,
      durationMs: response.durationMs,
      body: response.body,
      recordedAt: new Date().toISOString(),
    }
    writeFileSync(path.join(options.rawDir, `${label}.json`), `${JSON.stringify(file, null, 2)}\n`)
  }

  return {
    request,
    stats: () => ({ calls, lastRemaining, lastLimit }),
  }
}

async function describeBinary(res: Response) {
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { binary: true, bytes: bytes.byteLength, contentType: res.headers.get('content-type') }
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function slug(value: string): string {
  return value
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 120)
}
