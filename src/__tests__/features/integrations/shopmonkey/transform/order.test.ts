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

describe('services that don’t count toward the totals', () => {
  const services1003 = () =>
    fixtures.order_service
      .filter((s) => s.orderId === 'syn_ord_1003')
      .map((s) => structuredClone(s) as Record<string, unknown>)
  const transform1003 = (services: Record<string, unknown>[]) =>
    transformOrder(
      fixture('order', 'syn_ord_1003'),
      { services, vehicleOwnerRemoteId: 'syn_cus_1', taxConfig, userNames, authorizations: [] },
      context(),
      NOW
    )

  it('leave out a service declined but not deferred', () => {
    const services = services1003()
    const coolant = services.find((s) => s.id === 'syn_svc_1003_4') as Record<string, unknown>
    coolant.deferredDate = null
    coolant.deferredReason = null
    const result = transform1003(services)
    const rows = asRecord(result.rows)
    expect(rows.jobs.find((j) => j.remoteId === 'syn_svc_1003_4')?.counts).toBe(false)
    expect(rows.record.subtotal).toBe(1088.09)
    expect(result.warnings.filter((w) => w.code === 'money_mismatch')).toEqual([])
  })

  it('leave out a service deferred but not declined, and make it a finding', () => {
    const services = services1003()
    const coolant = services.find((s) => s.id === 'syn_svc_1003_4') as Record<string, unknown>
    coolant.authorizationStatus = 'NotAuthorized'
    coolant.deferredReason = 'InvoicedNotAuthorized'
    const result = transform1003(services)
    const rows = asRecord(result.rows)
    const job = rows.jobs.find((j) => j.remoteId === 'syn_svc_1003_4')
    expect(job?.counts).toBe(false)
    expect(job?.deferred?.notes).toMatch(/Deferred \(InvoicedNotAuthorized\)/)
    expect(rows.record.subtotal).toBe(1088.09)
    expect(result.warnings.filter((w) => w.code === 'money_mismatch')).toEqual([])
  })

  it('would be counted (and mismatch Shopmonkey’s totals) if the rule were dropped', () => {
    const services = services1003()
    const coolant = services.find((s) => s.id === 'syn_svc_1003_4') as Record<string, unknown>
    coolant.authorizationStatus = 'Authorized'
    coolant.deferredDate = null
    const result = transform1003(services)
    expect(result.warnings.some((w) => w.code === 'money_mismatch' && w.field === 'subtotal')).toBe(
      true
    )
  })
})

describe('EPA, shop supplies and fees', () => {
  it('make EPA a shopFee line, taxed as the tax config says (order 1002)', () => {
    const rows = asRecord(run('syn_ord_1002', { owner: 'syn_cus_2' }).rows)
    const epa = rows.jobs.flatMap((j) => j.labor).find((l) => l.lineKind === 'epa')
    expect(epa).toMatchObject({
      pricingType: 'shopFee',
      hours: 1,
      taxable: taxConfig.epaTaxable === true,
    })
    expect(epa?.rate).toBe(epa?.total)
    expect(epa?.sourceExtra).toMatchObject({
      source: 'shopmonkey',
      remoteServiceId: expect.any(String),
    })
  })

  it('warn epa_also_fee only on a service that also carries EPA or shop supplies', async () => {
    const { transformService } = await import('@/integrations/shopmonkey/transform/lines')
    const fee = { id: 'f1', name: 'EPA disposal', feeType: 'FixedCents', amountCents: 300 }
    const withEpa = transformService(
      { id: 's1', calculatedEpaCents: 500, fees: [fee] },
      context(),
      false,
      false
    )
    const without = transformService({ id: 's2', fees: [fee] }, context(), false, false)
    expect(withEpa.warnings.map((w) => w.code)).toContain('epa_also_fee')
    expect(without.warnings.map((w) => w.code)).not.toContain('epa_also_fee')
  })

  it('take a percent fee’s amount from Shopmonkey, then its own line’s subtotal, then the service', async () => {
    const { feeCents } = await import('@/integrations/shopmonkey/transform/lines')
    expect(feeCents({ feeType: 'PercentLineItem', percent: 10, amountCents: 500 }, 15_000)).toBe(
      500
    )
    expect(
      feeCents({ feeType: 'PercentLineItem', percent: 10, subtotalCents: 5_000 }, 15_000)
    ).toBe(500)
    expect(feeCents({ feeType: 'PercentService', percent: 10 }, 15_000)).toBe(1_500)
    expect(feeCents({ feeType: 'FixedCents', amountCents: 450 }, 15_000)).toBe(450)
    // A percent fee stored with amountCents 0 carries no amount of its own.
    expect(feeCents({ feeType: 'PercentService', percent: 10, amountCents: 0 }, 15_000)).toBe(1_500)
  })

  it('write sourceExtra the M1 schema reads', async () => {
    const { laborSourceExtraSchema, partSourceExtraSchema } = await import(
      '@/integrations/shopmonkey/schema/sourceExtra'
    )
    const rows = asRecord(run('syn_ord_1003', { owner: 'syn_cus_1' }).rows)
    for (const line of rows.jobs.flatMap((j) => j.labor)) {
      expect(laborSourceExtraSchema.safeParse(line.sourceExtra).success, line.remoteId).toBe(true)
    }
    for (const line of rows.jobs.flatMap((j) => j.parts)) {
      expect(partSourceExtraSchema.safeParse(line.sourceExtra).success, line.remoteId).toBe(true)
      expect(line.sourceExtra).toMatchObject({ source: 'shopmonkey', remoteId: line.remoteId })
    }
  })
})

describe('order details', () => {
  const servicesOf = (orderId: string) =>
    fixtures.order_service.filter((s) => s.orderId === orderId).map((s) => structuredClone(s))

  it('take the tax rate from the tax config, Canadian components too', () => {
    const hst = {
      ...taxConfig,
      taxSystem: 'CA',
      taxPercent: null,
      gstPercent: 0,
      pstPercent: 0,
      hstPercent: 13,
    }
    const result = transformOrder(
      fixture('order', 'syn_ord_1004'),
      {
        services: servicesOf('syn_ord_1004'),
        vehicleOwnerRemoteId: 'syn_cus_4',
        taxConfig: hst,
        userNames,
        authorizations: [],
      },
      context(),
      NOW
    )
    expect(asRecord(result.rows).record.taxRate).toBe(13)
  })

  it('never make the job’s technician one of its helpers, and keep no Shopmonkey id as a user', () => {
    const order = fixture('order', 'syn_ord_1002')
    order.assignedTechnicianIds = ['syn_usr_1', 'syn_usr_2', 'syn_usr_1']
    const rows = asRecord(
      transformOrder(
        order,
        {
          services: servicesOf('syn_ord_1002'),
          vehicleOwnerRemoteId: 'syn_cus_2',
          taxConfig,
          userNames,
          authorizations: [],
        },
        context(),
        NOW
      ).rows
    )
    expect(rows.record.technicianId).toBe(local('user', 'syn_usr_1'))
    expect(rows.helperTechnicianIds).toEqual([local('user', 'syn_usr_2')])
    expect(rows.meta.serviceWriterUserId).toBeNull()
    expect(rows.meta.serviceWriterName).not.toBeNull()
  })

  it('warn about what it can’t resolve or date', () => {
    const order = fixture('order', 'syn_ord_1003')
    delete order.createdDate
    delete order.orderCreatedDate
    delete order.repairOrderDate
    order.invoicedDate = null
    const result = transformOrder(
      order,
      {
        services: servicesOf('syn_ord_1003'),
        vehicleOwnerRemoteId: 'syn_cus_1',
        taxConfig,
        userNames,
        authorizations: [],
      },
      context({ notLoaded: ['vehicle:syn_veh_1', 'customer:syn_cus_1'] }),
      NOW
    )
    expect(result.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        'order_missing_date',
        'invoice_not_issued',
        'order_vehicle_unresolved',
        'order_customer_unresolved',
      ])
    )
    expect(asRecord(result.rows).issueAsInvoice).toBe(false)
  })

  it('warn when a repair order’s status has no stage', () => {
    const result = transformOrder(
      fixture('order', 'syn_ord_1002'),
      {
        services: servicesOf('syn_ord_1002'),
        vehicleOwnerRemoteId: 'syn_cus_2',
        taxConfig,
        userNames,
        authorizations: [],
      },
      context(),
      NOW
    )
    expect(result.warnings.map((w) => w.code)).toContain('order_status_unmapped')
    expect(asRecord(result.rows).record.status).toBe('in-progress')
  })

  it('report the service and line fields it leaves out', () => {
    const result = run('syn_ord_1003', { owner: 'syn_cus_1' })
    expect(result.unmapped).toEqual(
      expect.arrayContaining(['order_service.taxPercent', 'labors.costTotalCents'])
    )
  })
})
