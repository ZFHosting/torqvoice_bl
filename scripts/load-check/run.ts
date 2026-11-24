/**
 * fork (A6, docs/fork/milestones/A6-hardening.md task 4): the API's load check. 20 requests a second, open loop, on the
 * list endpoints of a workshop seeded by `seed.ts` (50,000 work orders), for two minutes; the keys rotate so no key
 * passes its 120 a minute. Prints p50, p95 and p99 per endpoint and overall, and exits 1 when the overall p95 is over
 * 500 ms or any request didn't answer 200. Run it only against a local server on the load database.
 *
 *   LOAD_BASE_URL=http://127.0.0.1:3101 LOAD_KEYS_FILE=<the seed's keys> node node_modules/tsx/dist/cli.mjs \
 *     scripts/load-check/run.ts
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3101'
const RATE = Number(process.env.LOAD_RPS ?? 20)
const SECONDS = Number(process.env.LOAD_SECONDS ?? 120)
const P95_LIMIT_MS = 500

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  throw new Error(`Refusing to load ${BASE}: the load check runs against a local server only.`)
}

const { keys } = JSON.parse(readFileSync(process.env.LOAD_KEYS_FILE as string, 'utf-8')) as { keys: string[] }

/** The list endpoints, as a syncing client and a dashboard would ask them. */
const ENDPOINTS: { name: string; path: () => string }[] = [
  { name: 'work-orders', path: () => '/work-orders?limit=50' },
  { name: 'work-orders limit=200', path: () => '/work-orders?limit=200' },
  { name: 'work-orders status', path: () => '/work-orders?status=completed&limit=50' },
  { name: 'work-orders updatedSince', path: () => '/work-orders?updatedSince=2026-01-01T00:00:00Z&limit=100' },
  { name: 'work-orders page 2', path: () => `/work-orders?limit=50${nextCursor ? `&cursor=${nextCursor}` : ''}` },
  { name: 'work-orders openOnly', path: () => '/work-orders?openOnly=true&limit=50' },
  { name: 'work-orders include', path: () => '/work-orders?include=lines,payments&limit=20' },
  { name: 'customers', path: () => '/customers?limit=50' },
  { name: 'customers q', path: () => '/customers?q=Customer%201&limit=50' },
  { name: 'vehicles', path: () => '/vehicles?limit=50' },
  { name: 'payments', path: () => '/payments?limit=50' },
  { name: 'quotes', path: () => '/quotes?limit=50' },
]

let nextCursor: string | null = null
const latencies = new Map<string, number[]>()
const statuses = new Map<number, number>()

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0

async function one(i: number) {
  const endpoint = ENDPOINTS[i % ENDPOINTS.length]
  const key = keys[i % keys.length]
  const started = performance.now()
  let status = 0
  try {
    const res = await fetch(`${BASE}/api/v1${endpoint.path()}`, {
      headers: { authorization: `Bearer ${key}`, 'x-real-ip': '127.0.0.1' },
    })
    status = res.status
    const body = (await res.json()) as { meta?: { nextCursor?: string | null } }
    if (endpoint.name === 'work-orders' && body.meta?.nextCursor) nextCursor = body.meta.nextCursor
  } catch {
    status = -1
  }
  const ms = performance.now() - started
  statuses.set(status, (statuses.get(status) ?? 0) + 1)
  const list = latencies.get(endpoint.name) ?? []
  list.push(ms)
  latencies.set(endpoint.name, list)
}

async function main() {
  const total = RATE * SECONDS
  const pending: Promise<void>[] = []
  const t0 = performance.now()
  for (let i = 0; i < total; i++) {
    const due = t0 + (i * 1000) / RATE
    const wait = due - performance.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    pending.push(one(i))
  }
  await Promise.all(pending)
  const all = [...latencies.values()].flat().sort((a, b) => a - b)
  const rows = [...latencies.entries()].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => a - b)
    return { name, n: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99) }
  })
  const report = {
    base: BASE,
    rps: RATE,
    seconds: SECONDS,
    requests: all.length,
    statuses: Object.fromEntries(statuses),
    overall: { p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99) },
    endpoints: rows,
  }
  console.log(JSON.stringify(report, (_, v) => (typeof v === 'number' ? Math.round(v) : v), 2))
  const bad = [...statuses.keys()].some((s) => s !== 200)
  if (report.overall.p95 > P95_LIMIT_MS || bad) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
