/**
 * @vitest-environment node
 *
 * fork: the reconciliation's own rules (M6, MAPPING §12), without a database: where a staged record lands, when a
 * money difference is explained, how months add up on the workshop's clock, which invoices are spot-checked, and how
 * the report reads on a terminal. SYNTHETIC values.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

const { place } = await import('@/integrations/shopmonkey/reconcile/tables')
const {
  compareOrder,
  compareQuote,
  monthTotals,
  shopmonkeyInvoiceDate,
  spotChecks,
  smCents,
  tvCents,
} = await import('@/integrations/shopmonkey/reconcile/money')
const { tallyUnknown } = await import('@/integrations/shopmonkey/reconcile/fields')
const { formatReport, parseReconcileArgs } = await import(
  '@/integrations/shopmonkey/reconcile/format'
)

type Facts = Parameters<typeof place>[0]
const facts = (over: Partial<Facts>): Facts => ({
  table: 'order',
  remoteId: 'r1',
  localEntity: null,
  localId: null,
  rowExists: false,
  loadSkip: null,
  deleted: false,
  fileNotStaged: false,
  paymentLoaded: false,
  parentBucket: null,
  parentIsWorkOrder: false,
  ...over,
})

describe('where a staged record lands', () => {
  it('is loaded when its row is there, and missing when the row is gone', () => {
    expect(place(facts({ localEntity: 'ServiceRecord', localId: 'w1', rowExists: true }))).toEqual({
      bucket: 'loaded',
    })
    expect(place(facts({ localEntity: 'ServiceRecord', localId: 'w1', rowExists: false }))).toEqual(
      {
        bucket: 'missing',
      }
    )
  })

  it('puts what Shopmonkey deleted, what failed and what the load left out, in that order', () => {
    expect(place(facts({ deleted: true, loadSkip: 'history' })).bucket).toBe('deleted')
    expect(place(facts({ loadSkip: 'failed' })).bucket).toBe('failed')
    expect(place(facts({ loadSkip: 'history' }))).toEqual({ bucket: 'skipped', reason: 'history' })
  })

  it('accounts for archive and settings tables, and names anything else', () => {
    expect(place(facts({ table: 'vendor' })).bucket).toBe('archive')
    expect(place(facts({ table: 'tax_config' })).bucket).toBe('settings')
    expect(place(facts({ table: 'customer' })).bucket).toBe('unaccounted')
  })

  it('folds an order’s services into a loaded order, and leaves them out (or deleted) with one that isn’t', () => {
    expect(place(facts({ table: 'order_service', parentBucket: 'loaded' })).bucket).toBe('folded')
    expect(place(facts({ table: 'authorization', parentBucket: 'deleted' })).bucket).toBe('deleted')
    expect(place(facts({ table: 'order_service', parentBucket: 'skipped' }))).toEqual({
      bucket: 'skipped',
      reason: 'parent_not_loaded',
    })
    expect(place(facts({ table: 'vehicle_owner', parentBucket: 'failed' }))).toEqual({
      bucket: 'skipped',
      reason: 'parent_not_loaded',
    })
    // A parent that is itself named carries its children with it; a child with no parent found is named.
    expect(place(facts({ table: 'order_service', parentBucket: 'missing' })).bucket).toBe('folded')
    expect(place(facts({ table: 'order_service', parentBucket: null })).bucket).toBe('unaccounted')
  })

  it('takes a payment as loaded by its row, and left out when its order is no work order', () => {
    expect(place(facts({ table: 'payment', paymentLoaded: true, loadSkip: 'x' })).bucket).toBe(
      'loaded'
    )
    expect(place(facts({ table: 'payment', parentIsWorkOrder: false }))).toEqual({
      bucket: 'skipped',
      reason: 'payment_order_not_loaded',
    })
    // A deleted order's payments go with it.
    expect(place(facts({ table: 'payment', parentBucket: 'deleted' })).bucket).toBe('deleted')
    // On a work order, with no row and no reason: named.
    expect(place(facts({ table: 'payment', parentIsWorkOrder: true })).bucket).toBe('unaccounted')
  })

  it('accounts for a file by its download and its record, and folds a photo into its inspection', () => {
    expect(place(facts({ table: 'order_file', fileNotStaged: true }))).toEqual({
      bucket: 'skipped',
      reason: 'file_not_staged',
    })
    expect(place(facts({ table: 'inspection_file', parentBucket: 'skipped' }))).toEqual({
      bucket: 'skipped',
      reason: 'parent_not_loaded',
    })
    expect(place(facts({ table: 'inspection_file', parentBucket: 'loaded' })).bucket).toBe('folded')
    // An order's file on a loaded work order that isn't attached is named.
    expect(place(facts({ table: 'order_file', parentBucket: 'loaded' })).bucket).toBe('unaccounted')
  })
})

const sm = {
  orderId: 'o1',
  number: '1001',
  subtotalCents: 10_000,
  totalCents: 10_800,
  taxCents: 800,
  discountCents: 0,
  paidCents: 5_000,
  remainingCents: 5_800,
  invoicedDate: new Date('2025-03-10T15:00:00Z'),
  deleted: false,
}
const tv = {
  workOrderId: 'w1',
  vehicleId: 'v1',
  invoiceNumber: 'INV-1',
  invoiceDate: new Date('2025-03-10T15:00:00Z'),
  linesCents: 10_000,
  totalCents: 10_800,
  taxCents: 800,
  discountCents: 0,
  paidCents: 5_000,
}
const none = { asLoaded: null, skippedPayments: [] }

describe('a work order against its Shopmonkey order', () => {
  it('has no difference when they agree, or differ by a cent', () => {
    expect(compareOrder(sm, tv, none)).toEqual([])
    expect(compareOrder(sm, { ...tv, linesCents: 10_001 }, none)).toEqual([])
  })

  it('explains a lines difference only while the lines are what they were when the load warned', () => {
    // Shopmonkey's own lines came to 112.34 against a subtotal of 100.00: the load warned and kept the lines.
    const asLoaded = { ...tv, linesCents: 11_234 }
    expect(compareOrder(sm, asLoaded, none)).toEqual([
      expect.objectContaining({ field: 'lines', explainedBy: null, document: 'workOrder' }),
    ])
    const atLoad = { lines: 11_234, subtotal: 10_000 }
    expect(compareOrder(sm, asLoaded, { ...none, asLoaded: atLoad })).toEqual([
      expect.objectContaining({ field: 'lines', explainedBy: 'money_mismatch' }),
    ])
    // Shopmonkey's subtotal changed since (its total didn't): unexplained.
    expect(
      compareOrder({ ...sm, subtotalCents: 10_500 }, asLoaded, { ...none, asLoaded: atLoad })
    ).toEqual([expect.objectContaining({ field: 'lines', explainedBy: null })])
    // A line changed since: unexplained, though the order was warned.
    expect(
      compareOrder(
        sm,
        { ...tv, linesCents: 12_000 },
        { ...none, asLoaded: { lines: 11_234, subtotal: 10_000 } }
      )
    ).toEqual([expect.objectContaining({ field: 'lines', explainedBy: null })])
  })

  it('explains a paid and balance difference by payments left out by rule, to the cent only', () => {
    const tvLess = { ...tv, paidCents: 3_000 }
    const explained = compareOrder(sm, tvLess, {
      ...none,
      skippedPayments: [{ reason: 'payment_type_unsupported', cents: 2_000 }],
    })
    expect(explained.map((d) => [d.field, d.explainedBy])).toEqual([
      ['paid', 'payment_type_unsupported'],
      ['balance', 'payment_type_unsupported'],
    ])
    const notQuite = compareOrder(sm, tvLess, {
      ...none,
      skippedPayments: [{ reason: 'payment_type_unsupported', cents: 1_500 }],
    })
    expect(notQuite.every((d) => d.explainedBy === null)).toBe(true)
  })

  it('compares an estimate’s total', () => {
    expect(compareQuote(sm, { quoteId: 'q1', totalCents: 10_800 })).toEqual([])
    expect(compareQuote(sm, { quoteId: 'q1', totalCents: 9_000 })).toEqual([
      expect.objectContaining({ document: 'quote', field: 'total', workOrderId: 'q1' }),
    ])
  })

  it('reads cents from both sides, rounding half away from zero', () => {
    expect(smCents('1234')).toBe(1234)
    expect(smCents(null)).toBe(0)
    expect(tvCents(12.345)).toBe(1235)
    expect(tvCents(-12.345)).toBe(-1235)
  })

  it('takes an order as an invoice as the transform does: an Invoice with its date', () => {
    expect(shopmonkeyInvoiceDate('Invoice', '2025-03-10T15:00:00Z')).toEqual(
      new Date('2025-03-10T15:00:00Z')
    )
    expect(shopmonkeyInvoiceDate('RepairOrder', '2025-03-10T15:00:00Z')).toBeNull()
    expect(shopmonkeyInvoiceDate('Invoice', null)).toBeNull()
  })
})

describe('months on the workshop’s clock', () => {
  it('counts invoices and payments in their month, and what was still open at each month’s end', () => {
    // 31 March 23:30 in Chicago is 1 April in UTC: March, on the workshop's clock.
    const months = monthTotals(
      [
        {
          orderId: 'o1',
          date: new Date('2025-04-01T04:30:00Z'),
          totalCents: 10_000,
          taxCents: 500,
          discountCents: 100,
        },
      ],
      [
        { orderId: 'o1', cents: 4_000, date: new Date('2025-04-15T15:00:00Z') },
        { orderId: 'o1', cents: 6_000, date: new Date('2025-06-02T15:00:00Z') },
      ],
      'America/Chicago'
    )
    expect(months.map((m) => [m.month, m.invoiced, m.payments, m.openReceivables])).toEqual([
      ['2025-03', 10_000, 0, 10_000],
      ['2025-04', 0, 4_000, 6_000],
      ['2025-05', 0, 0, 6_000],
      ['2025-06', 0, 6_000, 0],
    ])
  })

  it('counts a deposit paid before the invoice from the invoice’s month', () => {
    const months = monthTotals(
      [
        {
          orderId: 'o1',
          date: new Date('2025-05-10T15:00:00Z'),
          totalCents: 5_000,
          taxCents: 0,
          discountCents: 0,
        },
      ],
      [{ orderId: 'o1', cents: 1_000, date: new Date('2025-04-10T15:00:00Z') }],
      'UTC'
    )
    expect(months.map((m) => [m.month, m.openReceivables])).toEqual([
      ['2025-04', 0],
      ['2025-05', 4_000],
    ])
  })
})

describe('spot checks', () => {
  const pairs = Array.from({ length: 40 }, (_, i) => ({
    sm: { ...sm, orderId: `o${String(i).padStart(2, '0')}` },
    tv: { ...tv, workOrderId: `w${i}`, vehicleId: i % 2 ? null : `v${i}` },
  }))

  it('picks 25 invoices, the same ones for the same seed, linking each to its page', () => {
    const first = spotChecks(pairs, 'seed')
    expect(first).toHaveLength(25)
    expect(spotChecks(pairs, 'seed')).toEqual(first)
    expect(spotChecks(pairs, 'other').map((s) => s.orderId)).not.toEqual(
      first.map((s) => s.orderId)
    )
    for (const s of first) expect(s.path).toMatch(/^\/(vehicles\/v\d+\/service|sales)\/w\d+$/)
  })

  it('leaves out work orders that are not invoices', () => {
    const open = pairs.map((p) => ({
      sm: { ...p.sm, invoicedDate: null },
      tv: { ...p.tv, invoiceDate: null },
    }))
    expect(spotChecks(open, 'seed')).toEqual([])
  })
})

describe('unmapped fields', () => {
  it('counts the keys nothing reads, how often they carry a value, and skips the importer’s own', () => {
    const out = new Map()
    tallyUnknown(
      [
        { id: '1', name: 'A', newThing: 'x', blank: '', _staged: { path: 'p' } },
        { id: '2', name: 'B', newThing: null, blank: [] },
      ],
      new Set(['id', 'name']),
      'customer',
      out
    )
    expect([...out.values()]).toEqual([
      { where: 'customer', field: 'newThing', seen: 2, nonEmpty: 1 },
      { where: 'customer', field: 'blank', seen: 2, nonEmpty: 0 },
    ])
  })
})

describe('the command line', () => {
  it('takes a connection and --json', () => {
    expect(parseReconcileArgs(['reconcile', '--connection', 'c1', '--json'])).toEqual({
      connection: 'c1',
      json: true,
    })
    expect(() => parseReconcileArgs(['reconcile'])).toThrow('--connection is required')
    expect(() => parseReconcileArgs(['reconcile', '--connection', 'c1', '--nope', 'x'])).toThrow(
      'Unknown option --nope'
    )
  })

  it('prints the gates first, and names unexplained differences by Shopmonkey id', () => {
    const ok = { passed: true, code: 'ok', values: {}, summary: 'ok' }
    const lines = formatReport({
      version: 1,
      connectionId: 'c1',
      generatedAt: '2025-06-01T00:00:00.000Z',
      timeZone: 'UTC',
      loadRunId: 'run1',
      counts: [
        {
          table: 'order',
          extractPhase: 'backfill',
          shopmonkeyTotal: 2,
          read: 2,
          otherLocation: 0,
          staged: 2,
          buckets: { loaded: 1, skipped: 1 },
          skipped: { history: 1 },
        },
      ],
      countProblems: [],
      countProblemTotal: 0,
      money: {
        workOrders: 1,
        quotes: 0,
        differences: [
          {
            orderId: 'o1',
            number: '1001',
            workOrderId: 'w1',
            document: 'workOrder',
            field: 'lines',
            shopmonkeyCents: 100,
            torqvoiceCents: 250,
            explainedBy: null,
          },
        ],
        differenceTotal: 1,
        unexplained: 1,
      },
      receivables: {
        shopmonkeyCents: 0,
        torqvoiceCents: 0,
        notImportedCents: 1_500,
        notImportedInvoices: 1,
        deletedInShopmonkey: 0,
      },
      months: { shopmonkey: [], torqvoice: [] },
      spotChecks: [],
      warnings: {},
      failures: [],
      unmapped: [],
      gates: {
        counts: ok,
        money: { passed: false, code: 'money_unexplained', values: {}, summary: '1 unexplained' },
        receivables: ok,
        failures: ok,
      },
      passed: false,
    })
    expect(lines[1]).toBe('Cutover is held back: a gate fails.')
    expect(lines).toContain('  FAIL money: 1 unexplained')
    expect(lines).toContain('    skipped: history 1')
    expect(lines).toContain('  order o1 (#1001) lines: Shopmonkey $1.00, Torqvoice $2.50')
    expect(lines).toContain(
      '  Not imported (not compared): 1 invoice(s) with $15.00 open in Shopmonkey'
    )
  })
})
