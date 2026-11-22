/**
 * M0 Shopmonkey spike (docs/fork/milestones/M0-setup-and-spikes.md, S1–S12). Read-only: every call
 * goes through spike-client.ts, which refuses anything but GET and allowlisted searches.
 *
 *   SHOPMONKEY_API_KEY=... npx tsx scripts/shopmonkey/spike.ts [--orders 10] [--out tmp/shopmonkey-raw]
 *
 * Writes every raw response to tmp/shopmonkey-raw/ (gitignored: real shop data) and a summary of what
 * it learned to tmp/shopmonkey-raw/_summary.json, which holds counts and shapes but no record content.
 * Then run anonymize-fixtures.ts and copy the answers into docs/fork/spikes/RESULTS.md.
 *
 * It deliberately never calls the VIN or plate decode endpoints (/v3/vehicle/vin/:vin,
 * /v3/vehicle/license_plate/...): they look a vehicle up with a data provider and may cost money.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createSpikeClient, type SpikeResponse } from './spike-client'

type Json = Record<string, unknown>

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

const apiKey = process.env.SHOPMONKEY_API_KEY ?? ''
const rawDir = arg('out', 'tmp/shopmonkey-raw')
const orderSample = Number(arg('orders', '10'))

const summary: Json = { startedAt: new Date().toISOString(), questions: {} as Json }
const answers = summary.questions as Json

function data(res: SpikeResponse): unknown {
  return (res.body as { data?: unknown } | null)?.data
}
function list(res: SpikeResponse): Json[] {
  const d = data(res)
  return Array.isArray(d) ? (d as Json[]) : []
}
function meta(res: SpikeResponse): Json {
  return ((res.body as { meta?: Json } | null)?.meta ?? {}) as Json
}
/** Keys and value types of a record: the shape, never the content. */
function shapeOf(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : []
  if (value && typeof value === 'object') {
    if (depth > 3) return 'object'
    return Object.fromEntries(
      Object.entries(value as Json).map(([k, v]) => [k, shapeOf(v, depth + 1)])
    )
  }
  return value === null ? 'null' : typeof value
}

async function main() {
  if (!apiKey) throw new Error('Set SHOPMONKEY_API_KEY (created by a Shopmonkey admin).')
  const api = createSpikeClient({ apiKey, rawDir })
  const get = (p: string, table: string | null, query?: Json, label?: string) =>
    api.request({ path: p, table, query: query as Record<string, string>, label })
  const search = (p: string, table: string | null, body: Json, label?: string) =>
    api.request({ method: 'POST', path: p, table, body, label })

  // S1: key status and identity, company and locations.
  const status = await get('/v3/auth/api_key/status', null)
  const me = await get('/v3/user/me', 'user', undefined, 'user-me')
  const companyId = String((data(me) as Json | undefined)?.companyId ?? '')
  const company = companyId ? await get(`/v3/company/${companyId}`, 'company') : null
  const companyConfig = companyId ? await get(`/v3/company/${companyId}/config`, null) : null
  const locations = await get('/v3/location', 'location')
  answers.S1 = {
    keyStatus: status.status,
    keyStatusShape: shapeOf(data(status)),
    company: company?.status ?? 'no companyId on /user/me',
    companyConfigShape: companyConfig ? shapeOf(data(companyConfig)) : null,
    locationsStatus: locations.status,
    locationCount: list(locations).length,
  }

  // S2: paging. The largest accepted limit, the where and orderby syntax.
  const limits: Json = {}
  for (const limit of [100, 250, 500, 1000]) {
    const res = await get('/v3/order', 'order', { limit, skip: 0 }, `s2-order-limit-${limit}`)
    limits[limit] = { status: res.status, returned: list(res).length, meta: meta(res) }
  }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  // The docs show Prisma-style operators (equals, in, gte, lte) in search bodies and say nothing about
  // the query-string encoding; a field report says GET lists ignore `where`. Try each form and compare
  // `meta.total` with the unfiltered list's.
  const whereForms: Record<string, Json> = {
    unfiltered: {},
    prismaGte: { where: JSON.stringify({ updatedDate: { gte: since } }) },
    prismaGt: { where: JSON.stringify({ updatedDate: { gt: since } }) },
    prismaGteNotDeleted: {
      where: JSON.stringify({ updatedDate: { gte: since }, deleted: { equals: false } }),
    },
    mongoGt: { where: JSON.stringify({ updatedDate: { $gt: since } }) },
    orderbyJson: { orderby: JSON.stringify({ updatedDate: 'desc' }) },
    orderbyIdAsc: { orderby: JSON.stringify({ id: 'asc' }) },
    orderbyText: { orderby: 'updatedDate desc' },
  }
  const whereResults: Json = {}
  for (const [name, query] of Object.entries(whereForms)) {
    const res = await get('/v3/order', 'order', { limit: 5, ...query }, `s2-order-${name}`)
    whereResults[name] = { status: res.status, returned: list(res).length, total: meta(res).total }
  }
  const customerSearch = await search(
    '/v3/customer/search',
    'customer',
    { limit: 100, skip: 0, where: { updatedDate: { gte: since } }, orderBy: { id: 'asc' } },
    's2-customer-search'
  )
  // Is a sorted list stable? Read the same two pages twice and compare the ids.
  const pageIds = async (skip: number, label: string) =>
    list(
      await get(
        '/v3/order',
        'order',
        { limit: 50, skip, orderby: JSON.stringify({ id: 'asc' }) },
        label
      )
    ).map((o) => String(o.id))
  const firstRead = [...(await pageIds(0, 's2-stable-a0')), ...(await pageIds(50, 's2-stable-a1'))]
  const secondRead = [...(await pageIds(0, 's2-stable-b0')), ...(await pageIds(50, 's2-stable-b1'))]
  answers.S2 = {
    stableWithOrderbyId: JSON.stringify(firstRead) === JSON.stringify(secondRead),
    duplicatesAcrossPages: firstRead.length - new Set(firstRead).size,
    limits,
    whereResults,
    customerSearch: { status: customerSearch.status, returned: list(customerSearch).length },
  }

  // S4 (+S5, S11): orders and their children, on a sample.
  const orders = list(await get('/v3/order', 'order', { limit: orderSample }, 's4-orders'))
  // GET /v3/order documents an `include` that nests services and their lines: one call per page
  // instead of one per order, if it works.
  const withServices = await get(
    '/v3/order',
    'order',
    {
      limit: 2,
      include: JSON.stringify({
        services: {
          include: { labors: true, parts: true, tires: true, fees: true, subcontracts: true },
        },
      }),
    },
    's4-orders-include-services'
  )
  answers.S4include = shapeOf(list(withServices)[0]?.services)
  const children: Json = {}
  for (const o of orders) {
    const id = String(o.id)
    const tries: [string, string | null][] = [
      [`/v3/order/${id}`, 'order'],
      [`/v3/order/${id}/service`, 'order_service'],
      [`/v3/order/${id}/authorization`, 'order_authorization'],
      [`/v3/order/${id}/payment`, 'payment'],
      [`/v3/order/${id}/file`, 'order_file'],
      [`/v3/order/${id}/pdf`, null],
    ]
    for (const [p, table] of tries) {
      const res = await get(p, table)
      children[p.replace(id, ':id')] = { status: res.status, shape: shapeOf(data(res)) }
    }
    const pay = await search(
      '/v3/integration/payment/search',
      'payment',
      { where: { orderId: id } },
      `s4-payments-${id}`
    )
    children['POST /v3/integration/payment/search'] = {
      status: pay.status,
      shape: shapeOf(list(pay)[0]),
    }
  }
  const firstCustomer = list(customerSearch)[0]
  if (firstCustomer) {
    const cid = String(firstCustomer.id)
    for (const [p, table] of [
      [`/v3/customer/${cid}`, 'customer'],
      [`/v3/customer/${cid}/vehicle`, 'vehicle'],
      [`/v3/customer/${cid}/order`, null],
    ] as const) {
      const res = await get(p, table)
      children[p.replace(cid, ':id')] = { status: res.status, shape: shapeOf(data(res)) }
    }
    // Contacts come embedded in every customer read; the email and phone searches look a customer up
    // by address (at most 5), so they're only recorded here to confirm their shape.
    const full = data(
      await get(`/v3/customer/${cid}`, 'customer', undefined, 's4-customer-full')
    ) as Json | undefined
    const firstEmail = (full?.emails as Json[] | undefined)?.[0]?.email
    if (typeof firstEmail === 'string') {
      const res = await search('/v3/customer/email/search', null, { emails: [firstEmail] })
      children['POST /v3/customer/email/search'] = {
        status: res.status,
        shape: shapeOf(list(res)[0]),
      }
    }
    children.customerEmbedsContacts = {
      emails: Array.isArray(full?.emails),
      phoneNumbers: Array.isArray(full?.phoneNumbers),
    }
  }
  const firstVehicleId = orders.find((o) => o.vehicleId)?.vehicleId
  if (firstVehicleId) {
    const res = await get(`/v3/vehicle/${firstVehicleId}/owners`, 'vehicle_owner')
    children['/v3/vehicle/:id/owners'] = { status: res.status, shape: shapeOf(data(res)) }
  }
  answers.S4 = children
  answers.S5 = 'Compare order, service and line *Cents in the recorded order_service files by hand.'
  answers.S11 = {
    orderNumbers: orders.map((o) => typeof o.number),
    publicIdShape: firstCustomer ? typeof firstCustomer.publicId : null,
  }

  // S6–S10: configuration and catalog tables.
  const tables: [string, string, 'get' | 'search'][] = [
    ['tax_config', '/v3/tax_config', 'get'],
    ['labor_rate', '/v3/labor_rate', 'get'],
    ['workflow_status', '/v3/workflow_status', 'get'],
    ['inspection', '/v3/inspection', 'get'],
    ['inspection_template', '/v3/inspection_template', 'get'],
    ['timesheet', '/v3/timesheet', 'get'],
    ['canned_service', '/v3/canned_service', 'get'],
    ['inventory_part', '/v3/inventory_part/search', 'search'],
    ['inventory_tire', '/v3/inventory_tire/search', 'search'],
    ['inventory_labor', '/v3/inventory_labor/search', 'search'],
    ['inventory_fee', '/v3/inventory_fee/search', 'search'],
    ['inventory_category', '/v3/inventory_category', 'get'],
    ['vendor', '/v3/vendor', 'get'],
    ['user', '/v3/user', 'get'],
    ['appointment', '/v3/appointment', 'get'],
    ['referral_source', '/v3/referral_source', 'get'],
    ['label', '/v3/label', 'get'],
    ['payment_type_config', '/v3/payment_type_config', 'get'],
    ['message', '/v3/message', 'get'],
    ['purchase_order', '/v3/purchase_order', 'get'],
  ]
  const counts: Json = { order: limits[100] && (limits[100] as Json).meta }
  for (const [table, p, how] of tables) {
    const res =
      how === 'get'
        ? await get(p, table, { limit: 25 }, `table-${table}`)
        : await search(p, table, { limit: 25, skip: 0 }, `table-${table}`)
    counts[table] = {
      status: res.status,
      total: meta(res).total ?? null,
      shape: shapeOf(list(res)[0]),
    }
  }
  const firstInspection = list(
    await get('/v3/inspection', 'inspection', { limit: 1 }, 's7-inspection')
  )[0]
  if (firstInspection)
    await get(`/v3/inspection/${firstInspection.id}`, 'inspection', undefined, 's7-inspection-full')
  answers.S6toS12 = counts

  // S3: rate limit, measured from the headers.
  const stats = api.stats()
  answers.S3 = {
    callsMade: stats.calls,
    limitPerMinute: stats.lastLimit,
    remainingAtEnd: stats.lastRemaining,
    note: 'Backfill calls ≈ list pages + orders × (1 get + services + payments + files + authorizations [+ pdf]).',
  }

  summary.finishedAt = new Date().toISOString()
  writeFileSync(path.join(rawDir, '_summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`Done: ${stats.calls} calls. Summary in ${path.join(rawDir, '_summary.json')}.`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
