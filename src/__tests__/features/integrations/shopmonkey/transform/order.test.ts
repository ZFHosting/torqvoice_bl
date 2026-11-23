/**
 * @vitest-environment node
 *
 * fork: orders (M4, MAPPING §6) against the synthetic fixtures: the complex invoice transforms with no
 * money_mismatch; declined and deferred services stay under their job but out of the totals; fees,
 * EPA and shop supplies become shopFee lines; estimates become quotes with the right status; a
 * difference from Shopmonkey's totals is a warning with both numbers, never a correction.
 */
import { describe, expect, it } from 'vitest'
import { type OrderRows, transformOrder } from '@/integrations/shopmonkey/transform/order'
import { context, fixture, fixtures, local } from './context'

const NOW = new Date('2025-06-01T00:00:00.000Z')
const taxConfig = fixtures.tax_config[0]
const userNames = {
  syn_usr_1: 'Avery Example',
  syn_usr_2: 'Blake Example',
  syn_usr_3: 'Casey Example',
}

function run(
  orderId: string,
  opts: { owner?: string | null; stageMap?: Record<string, never> } = {}
) {
  const order = fixture('order', orderId)
  const services = fixtures.order_service
    .filter((s) => s.orderId === orderId)
    .map((s) => structuredClone(s))
  const authorizations = fixtures.authorization.filter((a) => a.orderId === orderId)
  const ctx = context({
    settings: {
      statusStageMap: Object.fromEntries(
        fixtures.workflow_status.map((s, i) => [String(s.id), i === 0 ? 'pending' : 'in-progress'])
      ),
      technicianMap: {},
    },
  })
  return transformOrder(
    order,
    { services, vehicleOwnerRemoteId: opts.owner ?? null, taxConfig, userNames, authorizations },
    ctx,
    NOW
  )
}

const asRecord = (rows: OrderRows | null) => {
  if (rows?.kind !== 'serviceRecord') throw new Error('expected a work order')
  return rows
}

describe('the complex invoice (order 1003)', () => {
  const result = run('syn_ord_1003', { owner: 'syn_cus_1' })
  const rows = asRecord(result.rows)

  it('transforms with no money_mismatch', () => {
    expect(result.warnings.filter((w) => w.code === 'money_mismatch')).toEqual([])
  })

  it('keeps Shopmonkey’s totals as they are', () => {
    const order = fixture('order', 'syn_ord_1003')
    expect(rows.record.totalAmount).toBe((order.totalCostCents as number) / 100)
    expect(rows.record.taxAmount).toBe((order.taxCents as number) / 100)
    expect(rows.record.cost).toBe(rows.record.totalAmount)
  })

  it('is a completed invoice, issued on its invoice date, billed to the vehicle’s owner', () => {
    expect(rows.record).toMatchObject({
      status: 'completed',
      invoiceNumber: '1003',
      invoiceDate: new Date('2025-03-14T17:05:00.000Z'),
      sentAt: new Date('2025-03-14T17:05:00.000Z'),
      vehicleId: local('vehicle', 'syn_veh_1'),
      customerId: null,
    })
    expect(rows.issueAsInvoice).toBe(true)
  })

  it('keeps every service as a job, declined and deferred ones out of the totals', () => {
    expect(rows.jobs.map((j) => j.job.name)).toHaveLength(4)
    const declined = rows.jobs.find((j) => j.job.authorizationStatus === 'Declined')
    expect(declined?.counts).toBe(false)
    expect((declined?.labor.length ?? 0) + (declined?.parts.length ?? 0)).toBeGreaterThan(0)
    const counted = rows.jobs.filter((j) => j.counts)
    const lineSum = counted.reduce(
      (a, j) => a + Object.values(j.cents).reduce((b, c) => b + c, 0),
      0
    )
    expect(rows.record.subtotal).toBe(lineSum / 100)
  })

  it('turns a deferred service into a finding on this order', () => {
    const deferred = rows.jobs.filter((j) => j.deferred)
    expect(deferred.length).toBeGreaterThan(0)
    expect(deferred[0].deferred?.notes).toMatch(/Deferred/)
  })

  it('makes fees, EPA and shop supplies shopFee lines, untaxed fees, taxed per the tax config', () => {
    const lines = rows.jobs.flatMap((j) => j.labor)
    const fee = lines.find((l) => l.lineKind === 'fee')
    const supplies = lines.find((l) => l.lineKind === 'shopSupplies')
    expect(fee).toMatchObject({ pricingType: 'shopFee', hours: 1, taxable: false })
    expect(fee?.rate).toBe(fee?.total)
    expect(supplies).toMatchObject({
      pricingType: 'shopFee',
      taxable: taxConfig.shopSuppliesTaxable === true,
    })
  })

  it('carries tires and sublets as parts with their kind and category', () => {
    const parts = rows.jobs.flatMap((j) => j.parts)
    expect(parts.find((p) => p.lineKind === 'tire')).toMatchObject({ category: 'Tires' })
    expect(parts.find((p) => p.lineKind === 'subcontract')).toMatchObject({
      category: 'Sublet',
      quantity: 1,
    })
  })

  it('matches the snapshot', () => {
    expect(result).toMatchSnapshot()
  })
})

describe('an invoice billed to the vehicle’s previous owner (order 1004)', () => {
  it('sets the order’s own customer, and takes an order-level percent discount', () => {
    const result = run('syn_ord_1004', { owner: 'syn_cus_4' })
    const rows = asRecord(result.rows)
    expect(rows.record.customerId).toBe(local('customer', 'syn_cus_1'))
    expect(result.warnings.filter((w) => w.code === 'money_mismatch')).toEqual([])
    expect(rows.record.discountAmount).toBeGreaterThan(0)
    expect(result).toMatchSnapshot()
  })
})

describe('a repair order (order 1002)', () => {
  it('takes its workflow status’s stage, its technicians and its service writer', () => {
    const result = run('syn_ord_1002', { owner: 'syn_cus_2' })
    const rows = asRecord(result.rows)
    expect(['pending', 'in-progress']).toContain(rows.record.status)
    expect(rows.record.customStatusId).toMatch(/^local:workflow_status:/)
    expect(rows.meta.serviceWriterName).not.toBeNull()
    expect(rows.issueAsInvoice).toBe(false)
    expect(result).toMatchSnapshot()
  })
})

describe('an estimate (order 1001)', () => {
  it('becomes a quote', () => {
    const result = run('syn_ord_1001')
    expect(result.rows?.kind).toBe('quote')
    expect(result).toMatchSnapshot()
  })
})

describe('a deleted order (order 1005)', () => {
  it('is not imported', () => {
    expect(run('syn_ord_1005').rows).toBeNull()
  })
})

describe('totals that don’t add up', () => {
  it('are warned with both numbers and left as Shopmonkey had them', () => {
    const order = fixture('order', 'syn_ord_1003')
    const services = fixtures.order_service
      .filter((s) => s.orderId === 'syn_ord_1003')
      .map((s) => structuredClone(s))
    order.totalCostCents = (order.totalCostCents as number) + 1
    const result = transformOrder(
      order,
      { services, vehicleOwnerRemoteId: 'syn_cus_1', taxConfig, userNames, authorizations: [] },
      context(),
      NOW
    )
    const mismatch = result.warnings.find(
      (w) => w.code === 'money_mismatch' && w.field === 'totalCostCents'
    )
    expect(mismatch?.message).toContain(String(order.totalCostCents))
    expect(asRecord(result.rows).record.totalAmount).toBe((order.totalCostCents as number) / 100)
  })
})
