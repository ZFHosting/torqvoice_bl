/**
 * fork: a small mock of Shopmonkey's API v3, built from the M0 fixtures (M3 acceptance). Fetch-shaped,
 * so the real client runs against it unchanged. It pages lists and searches the way the docs say
 * (`limit`, `skip`, `meta.hasMore`, `meta.total`), ignores a GET list's `where` the way the field report
 * says (RESULTS S2), and records every call so tests can see what was fetched.
 *
 * SYNTHETIC: the fixtures are invented (fixtures/shopmonkey/synthetic/README.md).
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

type Row = Record<string, unknown>

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'shopmonkey', 'synthetic')

export function loadFixtures(): Record<string, Row[]> {
  const out: Record<string, Row[]> = {}
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    const parsed = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf-8')) as {
      table: string
      records: Row[]
    }
    out[parsed.table] = parsed.records
  }
  return out
}

export interface MockCall {
  method: string
  path: string
  skip: number | null
}

export interface MockOptions {
  /** GET lists that answer 404 (an endpoint that's gone). */
  missing?: string[]
  /** Extra generated records per table, to make lists span pages. */
  extra?: Record<string, number>
  /** M7: GET lists answer in id order even when asked for `orderby=updatedDate desc`. */
  ignoreOrderby?: boolean
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': `mock-${status}` },
  })
}

const byId = (a: Row, b: Row) => String(a.id).localeCompare(String(b.id))
/** Newest first by `updatedDate`, then by id (M7: a delta's `orderby=updatedDate desc`). */
const newestFirst = (a: Row, b: Row) =>
  String(b.updatedDate ?? '').localeCompare(String(a.updatedDate ?? '')) || byId(a, b)

export function createMockShopmonkey(options: MockOptions = {}) {
  const data = loadFixtures()
  for (const [table, count] of Object.entries(options.extra ?? {})) {
    const template = data[table]?.[0] ?? {}
    data[table] = [...(data[table] ?? [])]
    for (let i = 0; i < count; i++) {
      data[table].push({
        ...template,
        id: `syn_${table}_gen_${String(i).padStart(4, '0')}`,
        emails: [],
        phoneNumbers: [],
        updatedDate: '2025-01-01T00:00:00.000Z',
      })
    }
  }
  const calls: MockCall[] = []
  let failAt: number | null = null

  const rows = (table: string) => [...(data[table] ?? [])].sort(byId)

  function page(all: Row[], skip: number, limit: number) {
    const slice = all.slice(skip, skip + limit)
    return json(200, {
      success: true,
      data: slice,
      meta: { hasMore: skip + slice.length < all.length, total: all.length },
    })
  }

  function currentOwner(vehicleId: string): string | null {
    const owners = (data.vehicle_owner ?? [])
      .filter((o) => o.vehicleId === vehicleId)
      .sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)))
    return owners.length ? String(owners[0].customerId) : null
  }

  function matches(row: Row, where: Row | undefined): boolean {
    for (const [field, condition] of Object.entries(where ?? {})) {
      if (field === 'updatedDate') {
        const gte = (condition as Row).gte
        if (typeof gte === 'string' && String(row.updatedDate) < gte) return false
        continue
      }
      const equals = (condition as Row).equals
      if (equals !== undefined && row[field] !== equals) return false
    }
    return true
  }

  async function fetch(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : {}
    const skipParam = method === 'POST' ? body.skip : parsed.searchParams.get('skip')
    calls.push({
      method,
      path: parsed.pathname,
      skip: skipParam === null || skipParam === undefined ? null : Number(skipParam),
    })
    if (failAt !== null && calls.length >= failAt) {
      failAt = null
      throw new Error('mock: the run was killed')
    }
    if (parsed.origin !== 'https://api.shopmonkey.cloud') return json(404, { success: false })
    const parts = parsed.pathname.split('/').filter(Boolean).slice(1) // after v3
    const skip = Number(skipParam ?? 0)
    const limit = Number((method === 'POST' ? body.limit : parsed.searchParams.get('limit')) ?? 100)

    if (method === 'POST') {
      const table = parts.join('/') === 'integration/payment/search' ? 'payment' : parts[0]
      if (parts.at(-1) !== 'search') return json(405, { success: false })
      const found = rows(table).filter((row) => matches(row, body.where as Row | undefined))
      return page(found, skip, limit)
    }

    const [table, id, sub] = parts
    if (parts.length === 1) {
      if (options.missing?.includes(table)) {
        return json(404, { success: false, code: 'API-404', message: 'Not found' })
      }
      const recent =
        !options.ignoreOrderby && parsed.searchParams.get('orderby') === 'updatedDate desc'
      return page(recent ? rows(table).sort(newestFirst) : rows(table), skip, limit)
    }
    if (table === 'company' && parts.length === 2) {
      const company = rows('company').find((c) => c.id === id)
      return company ? json(200, { success: true, data: company }) : json(404, { success: false })
    }
    if (parts.length === 2) {
      const found = rows(table).find((row) => row.id === id)
      return found
        ? json(200, { success: true, data: found })
        : json(404, { success: false, message: 'Not found' })
    }
    if (table === 'customer' && sub === 'vehicle') {
      return page(
        rows('vehicle').filter((v) => currentOwner(String(v.id)) === id),
        skip,
        limit
      )
    }
    if (table === 'vehicle' && sub === 'owners') {
      return page(
        rows('vehicle_owner').filter((o) => o.vehicleId === id),
        skip,
        limit
      )
    }
    if (table === 'order' && sub === 'service') {
      return page(
        rows('order_service').filter((s) => s.orderId === id),
        skip,
        limit
      )
    }
    if (table === 'order' && sub === 'authorization') {
      return page(
        rows('authorization').filter((a) => a.orderId === id),
        skip,
        limit
      )
    }
    if (table === 'order' && sub === 'pdf') {
      if (parsed.searchParams.get('document_type') !== 'invoice')
        return json(400, { success: false })
      return new Response(`%PDF-1.4 synthetic invoice ${id}`, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'x-request-id': 'mock-pdf' },
      })
    }
    return json(404, { success: false, message: 'Not found' })
  }

  return {
    fetch,
    data,
    calls,
    /** Throw (as if the process died) on the `n`th call from now. */
    killAfter(n: number) {
      failAt = calls.length + n
    },
    /** Change a record, as an edit in Shopmonkey would. */
    change(table: string, id: string, patch: Row) {
      const list = data[table] ?? []
      const index = list.findIndex((row) => row.id === id)
      if (index < 0) throw new Error(`mock: no ${table} ${id}`)
      list[index] = { ...list[index], ...patch, updatedDate: '2026-01-01T00:00:00.000Z' }
    },
    /** M7: change a record as an edit at `updatedDate` would (a later one than `change` uses). */
    changeAt(table: string, id: string, updatedDate: string, patch: Row) {
      const list = data[table] ?? []
      const index = list.findIndex((row) => row.id === id)
      if (index < 0) throw new Error(`mock: no ${table} ${id}`)
      list[index] = { ...list[index], ...patch, updatedDate }
    },
    remove(table: string, id: string) {
      data[table] = (data[table] ?? []).filter((row) => row.id !== id)
    },
    add(table: string, row: Row) {
      data[table] = [...(data[table] ?? []), row]
    },
    reset() {
      calls.length = 0
    },
  }
}

export type MockShopmonkey = ReturnType<typeof createMockShopmonkey>
