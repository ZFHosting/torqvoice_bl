/**
 * @vitest-environment node
 *
 * fork: the Shopmonkey extractor against the mock server (M3 acceptance): a full extract stages every
 * fixture record and a second writes nothing; a run killed mid-table resumes from its checkpoint; a
 * changed record is restaged and only its order's children refetched; logs carry no PII. Fixtures are
 * SYNTHETIC (fixtures/shopmonkey/synthetic/README.md); every shape is PROVISIONAL(M0:S2/S4).
 */
import { describe, expect, it } from 'vitest'
import { createShopmonkeyClient, PAGE_SIZE, PagingStalled } from '@/integrations/shopmonkey/client'
import {
  type ExtractDeps,
  type ExtractSettings,
  extractSettings,
  extractStep,
} from '@/integrations/shopmonkey/extract/engine'
import { baseType, type FileStager } from '@/integrations/shopmonkey/extract/files'
import { type ExtractState, startState } from '@/integrations/shopmonkey/extract/plan'
import { createMemoryStore } from './memoryStore'
import { createMockShopmonkey, loadFixtures, type MockOptions } from './mockServer'

const NOW = new Date('2025-06-01T00:00:00.000Z')

function harness(options: MockOptions & { settings?: Partial<ExtractSettings> } = {}) {
  const mock = createMockShopmonkey(options)
  const memory = createMemoryStore()
  const logs: unknown[][] = []
  const log = (...args: unknown[]) => {
    logs.push(args)
  }
  const client = createShopmonkeyClient({
    fetch: mock.fetch,
    log,
    sleep: async () => undefined,
    random: () => 0,
  })
  const downloads: string[] = []
  const files: FileStager = {
    async fetchUrl(table, remoteId) {
      downloads.push(`${table}:${remoteId}`)
      return {
        path: `shopmonkey-staging/conn-1/${table}/${remoteId}.bin`,
        bytes: 5,
        sha256: 'f'.repeat(64),
        contentType: 'image/jpeg',
      }
    },
    async write(table, remoteId, bytes, contentType) {
      downloads.push(`${table}:${remoteId}`)
      return {
        path: `shopmonkey-staging/conn-1/${table}/${remoteId}.pdf`,
        bytes: bytes?.byteLength ?? 0,
        sha256: 'e'.repeat(64),
        contentType: baseType(contentType),
      }
    },
  }
  const deps: ExtractDeps = {
    client,
    store: memory.store,
    files,
    settings: { ...extractSettings({ locationId: 'syn_loc_1' }), ...options.settings },
    companyId: 'syn_com_1',
    log,
    now: () => NOW,
  }
  let runs = 0
  async function run(state?: ExtractState, limit = 2000): Promise<ExtractState> {
    let current = state ?? startState(null, { runId: `run-${++runs}`, now: NOW })
    for (let i = 0; i < limit; i++) {
      const result = await extractStep(deps, current)
      current = result.state
      if (result.done) return current
    }
    throw new Error('The extract did not finish')
  }
  /** A second run that keeps what the first learned, as the job does. */
  const again = (previous: ExtractState) =>
    run(startState(previous, { runId: `run-${++runs}`, now: NOW }))
  return { mock, memory, deps, logs, downloads, run, again }
}

const callsTo = (calls: { path: string }[], fragment: string) =>
  calls.filter((c) => c.path.includes(fragment))

describe('a full extract', () => {
  it('stages every fixture record, each under its own table', async () => {
    const h = harness()
    const state = await h.run()
    expect(state.finishedAt).not.toBeNull()
    for (const [table, records] of Object.entries(loadFixtures())) {
      for (const record of records) {
        expect(h.memory.get(table, String(record.id)), `${table} ${record.id}`).toBeDefined()
      }
      expect(h.memory.count(table), table).toBe(records.length)
    }
    // Payloads are stored exactly as Shopmonkey sent them.
    const order = loadFixtures().order.find((o) => o.id === 'syn_ord_1003')
    expect(h.memory.get('order', 'syn_ord_1003')?.payload).toEqual(order)
  })

  it('stages files and invoice PDFs with where their bytes are', async () => {
    const h = harness()
    await h.run()
    expect(h.memory.get('order_file', 'syn_ofl_1')?.payload).toMatchObject({
      fileName: 'alignment-printout.pdf',
      _parent: { table: 'order', remoteId: 'syn_ord_1003' },
      _staged: { path: 'shopmonkey-staging/conn-1/order_file/syn_ofl_1.bin', bytes: 5 },
    })
    expect(h.memory.get('inspection_file', 'syn_ifl_1')?.payload).toMatchObject({
      _parent: { table: 'inspection', remoteId: 'syn_ins_1' },
    })
    // Both invoices are inside the last two years at NOW; estimates and repair orders get no PDF.
    expect(h.memory.get('invoice_pdf', 'syn_ord_1003')?.payload).toMatchObject({
      orderId: 'syn_ord_1003',
      documentType: 'invoice',
      _staged: { contentType: 'application/pdf' },
    })
    expect(h.memory.get('invoice_pdf', 'syn_ord_1004')).toBeDefined()
    expect(h.memory.get('invoice_pdf', 'syn_ord_1001')).toBeUndefined()
  })

  it('marks a record Shopmonkey reports deleted, and keeps it', async () => {
    const h = harness()
    await h.run()
    expect(h.memory.get('order', 'syn_ord_1005')?.remoteDeletedAt).toBeInstanceOf(Date)
    expect(h.memory.get('customer', 'syn_cus_3')?.remoteDeletedAt).toBeInstanceOf(Date)
    expect(h.memory.get('order', 'syn_ord_1003')?.remoteDeletedAt).toBeNull()
  })

  it('writes nothing the second time, and fetches no children', async () => {
    const h = harness()
    const first = await h.run()
    h.memory.resetWrites()
    h.mock.reset()
    h.downloads.length = 0
    await h.again(first)
    expect(h.memory.writes).toBe(0)
    expect(h.downloads).toEqual([])
    expect(callsTo(h.mock.calls, '/service')).toEqual([])
    expect(callsTo(h.mock.calls, '/owners')).toEqual([])
    expect(callsTo(h.mock.calls, '/pdf')).toEqual([])
  })
})

describe('a run killed mid-table', () => {
  it('resumes from its checkpoint and ends with the same records', async () => {
    const extra = { customer: 2 * PAGE_SIZE + 30 }
    const whole = harness({ extra })
    await whole.run()

    const h = harness({ extra })
    let state = startState(null, { runId: 'run-k', now: NOW })
    // Run until two pages of customers are checkpointed, then die on the next call.
    while (!(state.steps.customer && state.steps.customer.skip >= 2 * PAGE_SIZE)) {
      state = (await extractStep(h.deps, state)).state
    }
    h.mock.killAfter(1)
    await expect(extractStep(h.deps, state)).rejects.toThrow('killed')
    // The job runner (or the CLI) starts again from the last saved state.
    await h.run(state)

    expect(h.memory.count()).toBe(whole.memory.count())
    const pages = h.mock.calls.filter((c) => c.path === '/v3/customer/search').map((c) => c.skip)
    // Pages before the checkpoint were fetched once; only the one the run died on was asked again.
    expect(pages.filter((skip) => skip === 0)).toHaveLength(1)
    expect(pages.filter((skip) => skip === PAGE_SIZE)).toHaveLength(1)
    expect(pages.filter((skip) => skip === 2 * PAGE_SIZE)).toHaveLength(2)
  })

  it('refetches the children of a parent the run died during', async () => {
    const h = harness()
    let state = startState(null, { runId: 'run-c', now: NOW })
    while (!(state.steps.order && state.steps.order.stage === 'children')) {
      state = (await extractStep(h.deps, state)).state
    }
    h.mock.killAfter(2)
    await expect(extractStep(h.deps, state)).rejects.toThrow('killed')
    await h.run(state)
    expect(h.memory.count('order_service')).toBe(loadFixtures().order_service.length)
    expect(h.memory.count('payment')).toBe(loadFixtures().payment.length)
  })
})

describe('a changed record', () => {
  it('is restaged, and only its order’s children are fetched again', async () => {
    const h = harness()
    const first = await h.run()
    h.mock.change('order', 'syn_ord_1003', { complaint: 'Brakes squeal again' })
    h.mock.change('order_service', 'syn_svc_1003_2', { note: 'Re-checked' })
    h.mock.reset()
    h.memory.resetWrites()
    h.downloads.length = 0
    const second = await h.again(first)

    expect(second.steps.order.counts).toMatchObject({ updated: 1, created: 0 })
    expect(h.memory.get('order', 'syn_ord_1003')?.payload.complaint).toBe('Brakes squeal again')
    expect(h.memory.get('order_service', 'syn_svc_1003_2')?.payload.note).toBe('Re-checked')
    const childCalls = h.mock.calls.filter((c) => /^\/v3\/order\/[^/]+\/\w+/.test(c.path))
    expect(childCalls.length).toBeGreaterThan(0)
    expect(childCalls.every((c) => c.path.startsWith('/v3/order/syn_ord_1003/'))).toBe(true)
    // An unchanged file isn't downloaded again; the PDF of a changed invoice is.
    expect(h.downloads).toEqual(['invoice_pdf:syn_ord_1003'])
  })

  it('marks a service removed from its order as deleted', async () => {
    const h = harness()
    const first = await h.run()
    h.mock.remove('order_service', 'syn_svc_1003_4')
    h.mock.change('order', 'syn_ord_1003', { complaint: 'One job dropped' })
    const second = await h.again(first)
    expect(h.memory.get('order_service', 'syn_svc_1003_4')?.remoteDeletedAt).toBeInstanceOf(Date)
    expect(h.memory.get('order_service', 'syn_svc_1003_3')?.remoteDeletedAt).toBeNull()
    expect(second.steps.order.children.gone).toBe(1)
  })
})

describe('what is fetched', () => {
  it('fetches by id a vehicle and a customer an order names that no list returned', async () => {
    const h = harness()
    h.mock.add('vehicle', { id: 'syn_veh_9', make: 'Unknown', locationId: 'syn_loc_1' })
    h.mock.add('vehicle_owner', {
      id: 'syn_vow_9',
      vehicleId: 'syn_veh_9',
      customerId: 'syn_cus_9',
      createdDate: '2024-01-01T00:00:00.000Z',
    })
    h.mock.add('customer', { id: 'syn_cus_9', locationIds: ['syn_loc_2'] }) // another location's list
    h.mock.change('order', 'syn_ord_1002', { vehicleId: 'syn_veh_9', customerId: 'syn_cus_9' })
    await h.run()
    expect(h.memory.get('vehicle', 'syn_veh_9')).toBeDefined()
    expect(h.memory.get('customer', 'syn_cus_9')).toBeDefined()
    // The late sweep fetched the referenced vehicle's owners.
    expect(h.memory.get('vehicle_owner', 'syn_vow_9')).toBeDefined()
  })

  it('leaves out records of another location', async () => {
    const h = harness()
    h.mock.add('order', { id: 'syn_ord_2001', locationId: 'syn_loc_2', status: 'Estimate' })
    const state = await h.run()
    expect(h.memory.get('order', 'syn_ord_2001')).toBeUndefined()
    expect(state.steps.order.counts.skipped).toBe(1)
  })

  it('skips a list Shopmonkey no longer has, with a warning', async () => {
    const h = harness({ missing: ['workflow', 'tpi_scan'] })
    const state = await h.run()
    expect(state.steps.workflow).toMatchObject({ stage: 'done', skippedReason: 'not_found' })
    expect(JSON.stringify(h.logs)).toContain('Shopmonkey has no workflow list')
  })

  it('fails on a list it needs that is gone', async () => {
    const h = harness({ missing: ['order'] })
    await expect(h.run()).rejects.toMatchObject({ status: 404 })
  })

  it('fetches no files or PDFs when the settings say not to, and fetches them once they say so', async () => {
    const h = harness({ settings: { includeFiles: false, downloadInvoicePdfs: 'none' } })
    const first = await h.run()
    expect(h.downloads).toEqual([])
    expect(h.memory.count('order_file')).toBe(0)

    h.deps.settings = { ...h.deps.settings, includeFiles: true, downloadInvoicePdfs: 'all' }
    await h.again(first)
    expect(h.memory.get('order_file', 'syn_ofl_1')).toBeDefined()
    expect(h.memory.get('invoice_pdf', 'syn_ord_1004')).toBeDefined()
  })

  it('keeps PDFs to the last two years by default', async () => {
    const h = harness()
    h.deps.now = () => new Date('2026-06-01T00:00:00.000Z')
    await h.run()
    expect(h.memory.get('invoice_pdf', 'syn_ord_1003')).toBeDefined()
    expect(h.memory.get('invoice_pdf', 'syn_ord_1004')).toBeUndefined()
  })

  it('stages orders before the history date without fetching their children', async () => {
    const h = harness({ settings: { historyFrom: '2025-01-01' } })
    await h.run()
    expect(h.memory.get('order', 'syn_ord_1004')).toBeDefined()
    expect(h.memory.count('payment')).toBe(4) // 1003's, not 1004's
    expect(callsTo(h.mock.calls, 'syn_ord_1004/')).toEqual([])
  })

  it('reads only changes from a search when given a date', async () => {
    const h = harness()
    const first = await h.run()
    h.mock.change('customer', 'syn_cus_2', { note: 'Moved' })
    h.mock.reset()
    const delta = await h.run(
      startState(first, { runId: 'delta', since: '2025-12-31T00:00:00.000Z', now: NOW })
    )
    expect(delta.steps.customer).toMatchObject({ phase: 'delta', counts: { updated: 1 } })
    expect(delta.steps.customer.counts.unchanged).toBe(0)
    expect(delta.watermarks.customer).toBe('2026-01-01T00:00:00.000Z')
  })

  it('runs only the tables asked for', async () => {
    const h = harness()
    await h.run(startState(null, { runId: 'only', only: ['user', 'label'], now: NOW }))
    expect(h.memory.count()).toBe(h.memory.count('user') + h.memory.count('label'))
    expect(() => startState(null, { runId: 'x', only: ['orders'], now: NOW })).toThrow('Unknown')
  })

  it('stops with an error on a list whose pages repeat', async () => {
    const h = harness({ extra: { user: PAGE_SIZE + 10 } })
    const fetch = h.mock.fetch
    // A server that ignores `skip`: every page is the first.
    const deps: ExtractDeps = {
      ...h.deps,
      client: createShopmonkeyClient({
        fetch: (url, init) => fetch(url.replace(/skip=\d+/, 'skip=0'), init),
        log: () => undefined,
        sleep: async () => undefined,
      }),
    }
    let state = startState(null, { runId: 'stall', only: ['user'], now: NOW })
    const step = async () => {
      for (let i = 0; i < 10; i++) state = (await extractStep(deps, state)).state
    }
    await expect(step()).rejects.toThrow(PagingStalled)
  })
})

describe('logs', () => {
  it('carry no names, emails, phone numbers or file links', async () => {
    // Every fixture customer has a recognisable fake email and phone; a run with warnings in it logs.
    const h = harness({ missing: ['workflow'] })
    h.mock.change('order', 'syn_ord_1002', { vehicleId: 'syn_veh_missing' })
    await h.run()
    const logged = JSON.stringify(h.logs)
    expect(logged).toContain('syn_veh_missing') // ids are logged...
    const fixtures = loadFixtures()
    for (const customer of fixtures.customer) {
      for (const email of (customer.emails as { email: string }[]) ?? []) {
        expect(logged).not.toContain(email.email)
      }
      for (const phone of (customer.phoneNumbers as { number: string }[]) ?? []) {
        expect(logged).not.toContain(phone.number)
      }
      if (typeof customer.lastName === 'string') expect(logged).not.toContain(customer.lastName)
    }
    expect(logged).not.toContain('files.example.test')
    expect(logged).not.toMatch(/@example\.test/)
  })
})

describe('what goes wrong along the way', () => {
  it('leaves a parent pending when a file fails for now, and fetches it on the next run', async () => {
    const h = harness()
    const { TransientDownloadError } = await import('@/integrations/shopmonkey/extract/files')
    const fetchUrl = h.deps.files.fetchUrl
    let fail = true
    h.deps.files = {
      ...h.deps.files,
      fetchUrl: async (table, remoteId, url) => {
        if (fail && table === 'order_file') throw new TransientDownloadError('status 503')
        return fetchUrl(table, remoteId, url)
      },
    }
    const first = await h.run()
    expect(h.memory.get('order_file', 'syn_ofl_1')).toBeUndefined()
    expect(first.steps.order.children.retry).toBe(1)
    expect(h.memory.get('order', 'syn_ord_1003')?.childrenHash).toBeNull()
    expect(JSON.stringify(h.logs)).toContain('Could not download order_file syn_ofl_1 for now')

    fail = false
    await h.again(first)
    expect(h.memory.get('order_file', 'syn_ofl_1')?.payload._staged).toMatchObject({ bytes: 5 })
    expect(h.memory.get('order', 'syn_ord_1003')?.childrenHash).not.toBeNull()
  })

  it('skips an invoice PDF Shopmonkey refuses, and tries one that failed for now again', async () => {
    const h = harness()
    const download = h.deps.client.download
    let answer: 'refuse' | 'fail' | 'ok' = 'refuse'
    const { ShopmonkeyError } = await import('@/integrations/shopmonkey/client')
    h.deps.client = {
      ...h.deps.client,
      download: async (...args: Parameters<typeof download>) => {
        if (answer === 'refuse') throw new ShopmonkeyError(400, null, null, 'req-1')
        if (answer === 'fail') throw new ShopmonkeyError(502, null, null, 'req-2')
        return download(...args)
      },
    }
    await h.run()
    expect(h.memory.get('invoice_pdf', 'syn_ord_1003')?.payload._staged).toEqual({
      skipped: 'refused_url',
    })

    const h2 = harness()
    h2.deps.client = { ...h2.deps.client, download: h.deps.client.download }
    answer = 'fail'
    const first = await h2.run()
    expect(h2.memory.get('invoice_pdf', 'syn_ord_1003')).toBeUndefined()
    expect(first.steps.order.children.retry).toBeGreaterThan(0)
  })

  it('files a payment only under the order it belongs to, even if the search ignores its filter', async () => {
    const h = harness()
    const searchPage = h.deps.client.searchPage
    h.deps.client = {
      ...h.deps.client,
      // A search that drops its `where`: every payment, for every order.
      searchPage: (path, skip, filter) =>
        searchPage(path, skip, path.includes('payment') ? {} : filter),
    }
    await h.run()
    for (const payment of loadFixtures().payment) {
      expect(h.memory.get('payment', String(payment.id))?.payload.orderId).toBe(payment.orderId)
    }
    expect(h.memory.count('payment')).toBe(loadFixtures().payment.length)
  })

  it('does not restage a parent whose only change is a new signed link on a file', async () => {
    const h = harness()
    const first = await h.run()
    // The same order, nothing changed but a freshly signed link (as a signed URL would on every read).
    const order = h.mock.data.order.find((o) => o.id === 'syn_ord_1003') as Record<string, unknown>
    order.files = (order.files as Record<string, unknown>[]).map((f) => ({
      ...f,
      url: `${f.url}?signature=fresh`,
    }))
    h.memory.resetWrites()
    await h.again(first)
    expect(h.memory.writes).toBe(0)
  })
})
