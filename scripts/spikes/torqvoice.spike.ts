/**
 * M0 Torqvoice spikes T1, T2 and T5 on a real PostgreSQL. Throwaway: the answers go in
 * docs/fork/spikes/RESULTS.md; the importer's own tests replace this in M5.
 * Run: see vitest.spikes.config.ts.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.E2E_DATABASE_URL ?? ''
const databaseName = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
if (!url || !/test|e2e/.test(databaseName)) {
  throw new Error('Set E2E_DATABASE_URL to a database whose name says test or e2e.')
}
process.env.DATABASE_URL = url

const stamp = randomUUID().slice(0, 8)
let db: typeof import('@/lib/db')['db']
let organizationId = ''
let userId = ''
let customerA = ''
let customerB = ''
let vehicleId = ''

beforeAll(async () => {
  ;({ db } = await import('@/lib/db'))
  const user = await db.user.create({
    data: { name: `Spike ${stamp}`, email: `spike-${stamp}@example.com` },
  })
  userId = user.id
  const org = await db.organization.create({ data: { name: `Spike ${stamp}` } })
  organizationId = org.id
  customerA = (
    await db.customer.create({
      data: { name: 'Owner Person', userId, organizationId, address: '1 Owner Rd' },
    })
  ).id
  customerB = (
    await db.customer.create({
      data: { name: 'Billed Person', userId, organizationId, address: '2 Billed Ave' },
    })
  ).id
  vehicleId = (
    await db.vehicle.create({
      data: {
        make: 'Unknown',
        model: 'Unknown',
        year: 0,
        userId,
        organizationId,
        customerId: customerA,
        fuelType: null,
      },
    })
  ).id
})

afterAll(async () => {
  if (organizationId) {
    await db.serviceRecord.deleteMany({ where: { organizationId } })
    await db.documentDesignSnapshot.deleteMany({ where: { organizationId } }).catch(() => {})
    await db.documentAssetSnapshot.deleteMany({ where: { organizationId } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: organizationId } })
  }
  if (userId) await db.user.deleteMany({ where: { id: userId } })
})

describe('T1: an empty numbering format continues plain integer numbers', () => {
  it('jobNumberPattern("") matches plain integers only', async () => {
    const { jobNumberPattern, jobNumberPrefix } = await import('@/lib/job-number')
    expect(jobNumberPattern('')).toBe('^([0-9]+)$')
    expect(jobNumberPrefix('', new Date(), 'UTC')).toBe('')
  })

  it('nextJobNumber continues after the highest imported plain number', async () => {
    const { nextJobNumber } = await import('@/lib/job-number')
    for (const n of ['1041', '1077', '1050']) {
      await db.serviceRecord.create({
        data: { title: `Imported ${n}`, organizationId, invoiceNumber: n, vehicleId },
      })
    }
    const next = await nextJobNumber({
      organizationId,
      settings: { 'workshop.invoicePrefix': '' },
      timeZone: 'America/Los_Angeles',
    })
    console.log('[T1] next number with an empty format:', next)
    expect(next.invoiceNumber).toBe('1078')
    // And with the default format nothing matches yet, so it continues from the newest job.
    const withDefault = await nextJobNumber({
      organizationId,
      settings: {},
      timeZone: 'America/Los_Angeles',
      now: new Date('2026-11-13T12:00:00Z'),
    })
    console.log('[T1] next number with the default {year}- format:', withDefault)
  })
})

describe('T2: negative payments in the paid state', () => {
  it('invoicePaymentStatus nets refunds', async () => {
    const { invoicePaymentStatus } = await import('@/lib/document-lock')
    const base = { manuallyPaid: false, totalAmount: 100, cost: 100 }
    const cases = {
      paidThenPartRefund: invoicePaymentStatus({
        ...base,
        payments: [{ amount: 100 }, { amount: -30 }],
      }),
      paidThenFullRefund: invoicePaymentStatus({
        ...base,
        payments: [{ amount: 100 }, { amount: -100 }],
      }),
      overpaidThenRefund: invoicePaymentStatus({
        ...base,
        payments: [{ amount: 130 }, { amount: -30 }],
      }),
    }
    console.log('[T2] payment status:', cases)
    expect(cases.paidThenPartRefund).toBe('partial')
    expect(cases.paidThenFullRefund).toBe('unpaid')
    expect(cases.overpaidThenRefund).toBe('paid')
  })

  it('a negative Payment.amount is accepted by the database', async () => {
    const record = await db.serviceRecord.create({
      data: { title: 'Refunded job', organizationId, vehicleId, totalAmount: 100, cost: 100 },
    })
    await db.payment.createMany({
      data: [
        {
          serviceRecordId: record.id,
          amount: 100,
          method: 'card',
          provider: 'shopmonkey',
          externalId: 'p1',
        },
        {
          serviceRecordId: record.id,
          amount: -30,
          method: 'card',
          provider: 'shopmonkey',
          externalId: 'p2',
        },
      ],
    })
    const sum = await db.payment.aggregate({
      where: { serviceRecordId: record.id },
      _sum: { amount: true },
    })
    expect(sum._sum.amount).toBe(70)
  })
})

describe('T5: issueInvoice(..., "backfill") on an invoice sent in the past', () => {
  it('dates issuedAt to sentAt, captures the snapshot, and renders a PDF', async () => {
    const { issueInvoice } = await import('@/features/invoices/Lib/issueInvoice')
    const { invoiceLockState, DOCUMENT_LOCK_DEFAULTS } = await import('@/lib/document-lock')
    const sentAt = new Date('2023-03-14T17:05:00Z')
    const record = await db.serviceRecord.create({
      data: {
        title: 'Brake job',
        organizationId,
        vehicleId,
        // The order's customer differs from the vehicle's owner (T3).
        customerId: customerB,
        invoiceNumber: '1042',
        invoiceDate: sentAt,
        sentAt,
        status: 'completed',
        subtotal: 250,
        taxRate: 10,
        taxAmount: 25,
        totalAmount: 275,
        cost: 275,
        partItems: { create: [{ name: 'Brake pads', quantity: 1, unitPrice: 100, total: 100 }] },
        laborItems: {
          create: [{ description: 'Replace pads', hours: 1.5, rate: 100, total: 150 }],
        },
      },
    })

    const issued = await issueInvoice(record.id, organizationId, 'backfill')
    const after = await db.serviceRecord.findUniqueOrThrow({
      where: { id: record.id },
      select: { issuedAt: true, issuedData: true, issuedDesignSnapshotId: true, sentAt: true },
    })
    const data = after.issuedData as { customer?: { name?: string }; vehicle?: { year?: number } }
    console.log(
      '[T5] issued:',
      issued,
      'issuedAt:',
      after.issuedAt?.toISOString(),
      'customer:',
      data?.customer?.name,
      'vehicle year:',
      data?.vehicle?.year
    )
    expect(issued).toBe(true)
    expect(after.issuedAt?.toISOString()).toBe(sentAt.toISOString())
    expect(after.issuedDesignSnapshotId).toBeTruthy()

    // A second call is a no-op: it never re-captures an issued invoice.
    expect(await issueInvoice(record.id, organizationId, 'backfill')).toBe(false)

    // The edit lock is separate from issuing: it follows the workshop's lock settings.
    const lockable = { sentAt, manuallyPaid: false, totalAmount: 275, cost: 275, payments: [] }
    const defaults = invoiceLockState(lockable, DOCUMENT_LOCK_DEFAULTS)
    const lockOnSent = invoiceLockState(lockable, {
      ...DOCUMENT_LOCK_DEFAULTS,
      invoiceLockEnabled: true,
      invoiceLockTrigger: 'sent',
    })
    console.log('[T5] lock with defaults:', defaults, 'lock on sent:', lockOnSent)

    const { assembleInvoicePrint } = await import('@/features/invoices/Lib/assembleInvoicePrint')
    const { renderInvoicePdf } = await import('@/features/invoices/Pdf/buildInvoicePdfBuffer')
    const assembly = await assembleInvoicePrint(record.id, {})
    expect(assembly).toBeTruthy()
    if (!assembly) return
    const pdf = await renderInvoicePdf(assembly, 'en')
    const dir = join(process.cwd(), 'tmp', 'spikes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 't5-backfill-invoice.pdf'), pdf)
    console.log('[T5] PDF bytes:', pdf.byteLength, 'written to tmp/spikes/t5-backfill-invoice.pdf')
    expect(pdf.byteLength).toBeGreaterThan(1000)
  })
})
