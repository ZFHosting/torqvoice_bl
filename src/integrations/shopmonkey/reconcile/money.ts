/**
 * fork: the money sections of the reconciliation (M6): each imported work order (and estimate) against its
 * Shopmonkey order, the workshop's receivables on both sides, and both sides by month on the workshop's clock.
 *
 * Torqvoice's side is read from what is stored, the lines included, not from the totals the load copied over: a
 * line changed or broken since shows. Lines count as the load counts them (`countsTowardTotals`, MAPPING §6.3): not
 * under a Declined or deferred job. A difference is explained only by a rule MAPPING §12 names, cited by its code.
 *
 * Payload fields are read with one `jsonb_to_record` per row: a payload of a few kilobytes is stored compressed, and
 * each `->>` would unpack it again.
 */
import 'server-only'
import { db } from '@/lib/db'
import { roundMoney } from '@/lib/money'
import { zonedParts } from '@/lib/timezone'
import { orderSubtotalCents } from '../money'
import type { MoneyDifference, MonthTotals, SpotCheck } from './types'

/** Cents from a Shopmonkey amount (a number of cents, or text of one); 0 when there is none. */
export function smCents(value: unknown): number {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? Math.round(n) : 0
}

/** Cents from a Torqvoice amount (major units), rounded to the cent as the app rounds money (`roundMoney`). */
export function tvCents(value: unknown): number {
  return Math.round(roundMoney(value) * 100)
}

export interface ShopmonkeyOrder {
  orderId: string
  number: string | null
  subtotalCents: number
  totalCents: number
  taxCents: number
  discountCents: number
  paidCents: number
  remainingCents: number
  /** Its invoice date, when Shopmonkey made it an invoice (the transform's rule, below). */
  invoicedDate: Date | null
  /** Deleted in Shopmonkey since it was loaded. */
  deleted: boolean
}

export interface TorqvoiceOrder {
  workOrderId: string
  vehicleId: string | null
  invoiceNumber: string | null
  invoiceDate: Date | null
  linesCents: number
  totalCents: number
  taxCents: number
  discountCents: number
  /** What the app counts as paid: its payments, or the whole total when marked paid by hand. */
  paidCents: number
}

export interface PaymentFact {
  orderId: string
  cents: number
  date: Date
}

/**
 * The differences of one work order over a cent, each with the rule that explains it, if one does (MAPPING §12):
 * - `money_mismatch`: the load warned that Shopmonkey's own lines and subtotal disagree, and both are still what they
 *   were then (`asLoaded`, to the cent). A line changed on either side since is unexplained.
 * - `payment_type_unsupported`, `payment_missing_date`: payments Shopmonkey counts as paid and the load left out
 *   (MAPPING §6.5, §6.6), when they come to the paid difference to the cent; the balance follows.
 */
export function compareOrder(
  sm: ShopmonkeyOrder,
  tv: TorqvoiceOrder,
  known: {
    asLoaded: { lines: number; subtotal: number } | null
    skippedPayments: { reason: string; cents: number }[]
  }
): MoneyDifference[] {
  const out: MoneyDifference[] = []
  const add = (
    field: MoneyDifference['field'],
    shopmonkeyCents: number,
    torqvoiceCents: number,
    explainedBy: string | null
  ) => {
    if (Math.abs(shopmonkeyCents - torqvoiceCents) <= 1) return
    out.push({
      orderId: sm.orderId,
      number: sm.number,
      workOrderId: tv.workOrderId,
      document: 'workOrder',
      field,
      shopmonkeyCents,
      torqvoiceCents,
      explainedBy,
    })
  }
  const linesAsLoaded =
    known.asLoaded !== null &&
    Math.abs(tv.linesCents - known.asLoaded.lines) <= 1 &&
    Math.abs(sm.subtotalCents - known.asLoaded.subtotal) <= 1
  add('lines', sm.subtotalCents, tv.linesCents, linesAsLoaded ? 'money_mismatch' : null)
  add('total', sm.totalCents, tv.totalCents, null)
  // PROVISIONAL(M0:S5): Shopmonkey's paidCostCents nets refunds and leaves failed charges out, so it equals the sum
  // of the imported payments; remainingCostCents is the total less that.
  const paidGap = sm.paidCents - tv.paidCents
  const byRule = known.skippedPayments.filter((p) =>
    ['payment_type_unsupported', 'payment_missing_date'].includes(p.reason)
  )
  const ruleSum = byRule.reduce((a, p) => a + p.cents, 0)
  const paidRule =
    byRule.length && Math.abs(paidGap - ruleSum) <= 1
      ? [...new Set(byRule.map((p) => p.reason))].join(',')
      : null
  add('paid', sm.paidCents, tv.paidCents, paidRule)
  const balanceGap = sm.remainingCents - (tv.totalCents - tv.paidCents)
  add(
    'balance',
    sm.remainingCents,
    tv.totalCents - tv.paidCents,
    paidRule && Math.abs(balanceGap + ruleSum) <= 1 ? paidRule : null
  )
  return out
}

/** An estimate: its total only (nothing is owed on a quote). */
export function compareQuote(
  sm: ShopmonkeyOrder,
  quote: { quoteId: string; totalCents: number }
): MoneyDifference[] {
  if (Math.abs(sm.totalCents - quote.totalCents) <= 1) return []
  return [
    {
      orderId: sm.orderId,
      number: sm.number,
      workOrderId: quote.quoteId,
      document: 'quote',
      field: 'total',
      shopmonkeyCents: sm.totalCents,
      torqvoiceCents: quote.totalCents,
      explainedBy: null,
    },
  ]
}

/** YYYY-MM on the workshop's clock. */
export function monthOf(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}`
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/**
 * Totals by month for one side: what was invoiced (with its tax and discounts) in the month of the invoice, what was
 * paid in the month of the payment, and at each month's end what the invoices issued by then still had open.
 */
export function monthTotals(
  invoices: {
    orderId: string
    date: Date
    totalCents: number
    taxCents: number
    discountCents: number
  }[],
  payments: PaymentFact[],
  timeZone: string
): MonthTotals[] {
  const months = new Map<string, MonthTotals>()
  const at = (month: string) => {
    let row = months.get(month)
    if (!row) {
      row = { month, invoiced: 0, tax: 0, discounts: 0, payments: 0, openReceivables: 0 }
      months.set(month, row)
    }
    return row
  }
  const invoiceMonth = new Map<string, string>()
  // What becomes receivable, and what stops being, by month: an invoice in its month, a payment on an invoice in
  // the later of its own month and its invoice's.
  const opens = new Map<string, number>()
  for (const inv of invoices) {
    const month = monthOf(inv.date, timeZone)
    invoiceMonth.set(inv.orderId, month)
    const row = at(month)
    row.invoiced += inv.totalCents
    row.tax += inv.taxCents
    row.discounts += inv.discountCents
    opens.set(month, (opens.get(month) ?? 0) + inv.totalCents)
  }
  for (const p of payments) {
    const month = monthOf(p.date, timeZone)
    at(month).payments += p.cents
    const invoiced = invoiceMonth.get(p.orderId)
    if (!invoiced) continue
    const counts = invoiced > month ? invoiced : month
    opens.set(counts, (opens.get(counts) ?? 0) - p.cents)
  }
  if (!months.size) return []
  const sorted = [...months.keys()].sort()
  let open = 0
  const out: MonthTotals[] = []
  for (let m = sorted[0]; m <= sorted[sorted.length - 1]; m = nextMonth(m)) {
    open += opens.get(m) ?? 0
    out.push({ ...at(m), openReceivables: open })
  }
  return out
}

/** A small seeded generator, so the same report picks the same spot checks. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 25 invoices picked at random (seeded), for a person to open on both sides. */
export function spotChecks(
  pairs: { sm: ShopmonkeyOrder; tv: TorqvoiceOrder }[],
  seed: string,
  count = 25
): SpotCheck[] {
  const invoices = pairs
    // Invoices: every work order has a number, but only an invoice has a date.
    .filter((p) => p.sm.invoicedDate || p.tv.invoiceDate)
    .sort((a, b) => (a.sm.orderId < b.sm.orderId ? -1 : 1))
  const random = seeded(seed)
  for (let i = invoices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[invoices[i], invoices[j]] = [invoices[j], invoices[i]]
  }
  return invoices.slice(0, count).map(({ sm, tv }) => ({
    orderId: sm.orderId,
    number: sm.number,
    workOrderId: tv.workOrderId,
    invoiceNumber: tv.invoiceNumber,
    path: tv.vehicleId
      ? `/vehicles/${tv.vehicleId}/service/${tv.workOrderId}`
      : `/sales/${tv.workOrderId}`,
    shopmonkeyTotalCents: sm.totalCents,
    torqvoiceTotalCents: tv.totalCents,
  }))
}

/* ---------- reading both sides ---------- */

const date = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The transform's rule (transform/order.ts): an Invoice with an `invoicedDate` is an invoice; a RepairOrder that
 * carries one stays an open work order (MAPPING §6.6). PROVISIONAL(M0:S4).
 */
export function shopmonkeyInvoiceDate(status: unknown, invoicedDate: unknown): Date | null {
  return status === 'Invoice' ? date(invoicedDate) : null
}

/** The Shopmonkey orders behind the loaded work orders and quotes. */
export async function readShopmonkeyOrders(
  organizationId: string,
  loaded: Set<string>
): Promise<ShopmonkeyOrder[]> {
  const rows = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT sr."remoteId", sr."remoteDeletedAt" IS NOT NULL AS deleted, r.*
    FROM "public"."source_records" sr
    CROSS JOIN LATERAL jsonb_to_record(sr.payload) AS r(
      "number" text, "status" text, "invoicedDate" text,
      "laborCents" text, "partsCents" text, "tiresCents" text, "subcontractsCents" text, "feesCents" text,
      "epaCents" text, "shopSuppliesCents" text, "discountCents" text, "taxCents" text,
      "totalCostCents" text, "paidCostCents" text, "remainingCostCents" text
    )
    WHERE sr."organizationId" = ${organizationId} AND sr.source = 'shopmonkey' AND sr."table" = 'order'
      AND sr."localEntity" IN ('ServiceRecord', 'Quote')
  `
  return rows
    .filter((r) => loaded.has(String(r.remoteId)))
    .map((r) => ({
      orderId: String(r.remoteId),
      number: r.number ? String(r.number) : null,
      // MAPPING §6.1: the categories of the services that count, as the load reads them.
      subtotalCents: orderSubtotalCents(r),
      totalCents: smCents(r.totalCostCents),
      taxCents: smCents(r.taxCents),
      discountCents: smCents(r.discountCents),
      paidCents: smCents(r.paidCostCents),
      remainingCents: smCents(r.remainingCostCents),
      invoicedDate: shopmonkeyInvoiceDate(r.status, r.invoicedDate),
      deleted: r.deleted === true,
    }))
}

/** Open on Shopmonkey invoices that weren't imported as work orders (and weren't deleted). */
export async function readNotImported(
  organizationId: string
): Promise<{ invoices: number; openCents: number }> {
  const rows = await db.$queryRaw<
    { status: string | null; invoicedDate: string | null; remaining: string | null }[]
  >`
    SELECT r."status", r."invoicedDate", r."remainingCostCents" AS remaining
    FROM "public"."source_records" sr
    CROSS JOIN LATERAL jsonb_to_record(sr.payload) AS r("status" text, "invoicedDate" text, "remainingCostCents" text)
    WHERE sr."organizationId" = ${organizationId} AND sr.source = 'shopmonkey' AND sr."table" = 'order'
      AND sr."remoteDeletedAt" IS NULL AND COALESCE(sr."localEntity", '') <> 'ServiceRecord'
  `
  let invoices = 0
  let openCents = 0
  for (const r of rows) {
    if (!shopmonkeyInvoiceDate(r.status, r.invoicedDate)) continue
    invoices++
    openCents += smCents(r.remaining)
  }
  return { invoices, openCents }
}

/** The loaded work orders as stored: their totals, their counted lines, what has been paid on them. */
export async function readTorqvoiceOrders(
  organizationId: string,
  workOrders: Map<string, string>
): Promise<{ orders: Map<string, TorqvoiceOrder>; payments: PaymentFact[] }> {
  const records = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT id, "vehicleId", "invoiceNumber", "invoiceDate", "totalAmount", "taxAmount", "discountAmount",
      "manuallyPaid"
    FROM "public"."service_records" WHERE "organizationId" = ${organizationId}
  `
  // Lines that count: not under a Declined or deferred job. The SQL form of `countsTowardTotals`
  // (transform/lines.ts, MAPPING §6.3) on the job's stored `authorizationStatus` and `deferredDate`.
  // PROVISIONAL(M0:S5).
  const lines = await db.$queryRaw<{ serviceRecordId: string; total: number }[]>`
    SELECT l."serviceRecordId", SUM(l.total)::float8 AS total
    FROM (
      SELECT "serviceRecordId", total, "jobId" FROM "public"."service_parts"
      UNION ALL
      SELECT "serviceRecordId", total, "jobId" FROM "public"."service_labor"
    ) l
    JOIN "public"."service_records" sr ON sr.id = l."serviceRecordId"
    LEFT JOIN "public"."work_jobs" j ON j.id = l."jobId"
    WHERE sr."organizationId" = ${organizationId}
      AND (j.id IS NULL OR (COALESCE(j."authorizationStatus", '') <> 'Declined' AND j."deferredDate" IS NULL))
    GROUP BY l."serviceRecordId"
  `
  const paid = await db.$queryRaw<{ serviceRecordId: string; amount: number; date: Date }[]>`
    SELECT p."serviceRecordId", p.amount, p.date
    FROM "public"."payments" p
    JOIN "public"."service_records" sr ON sr.id = p."serviceRecordId"
    WHERE sr."organizationId" = ${organizationId}
  `
  const byRecord = new Map<string, string>()
  for (const [orderId, workOrderId] of workOrders) byRecord.set(workOrderId, orderId)
  const lineSums = new Map(lines.map((l) => [l.serviceRecordId, tvCents(l.total)]))
  const paidSums = new Map<string, number>()
  const payments: PaymentFact[] = []
  for (const p of paid) {
    const orderId = byRecord.get(p.serviceRecordId)
    if (!orderId) continue
    const cents = tvCents(p.amount)
    paidSums.set(p.serviceRecordId, (paidSums.get(p.serviceRecordId) ?? 0) + cents)
    payments.push({ orderId, cents, date: new Date(p.date) })
  }
  const orders = new Map<string, TorqvoiceOrder>()
  for (const r of records) {
    const id = String(r.id)
    const orderId = byRecord.get(id)
    if (!orderId) continue
    const totalCents = tvCents(r.totalAmount)
    orders.set(orderId, {
      workOrderId: id,
      vehicleId: r.vehicleId ? String(r.vehicleId) : null,
      invoiceNumber: r.invoiceNumber ? String(r.invoiceNumber) : null,
      invoiceDate: r.invoiceDate ? new Date(r.invoiceDate as Date) : null,
      linesCents: lineSums.get(id) ?? 0,
      totalCents,
      taxCents: tvCents(r.taxAmount),
      discountCents: tvCents(r.discountAmount),
      // The app's own reading (billing): marked paid by hand, the whole total is paid.
      paidCents: r.manuallyPaid === true ? totalCents : (paidSums.get(id) ?? 0),
    })
  }
  return { orders, payments }
}

/** The loaded quotes' totals. */
export async function readTorqvoiceQuotes(
  organizationId: string,
  quotes: Map<string, string>
): Promise<Map<string, { quoteId: string; totalCents: number }>> {
  const ids = [...quotes.values()]
  const totals = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 10_000) {
    const rows = await db.quote.findMany({
      where: { organizationId, id: { in: ids.slice(i, i + 10_000) } },
      select: { id: true, totalAmount: true },
    })
    for (const r of rows) totals.set(r.id, tvCents(r.totalAmount))
  }
  const out = new Map<string, { quoteId: string; totalCents: number }>()
  for (const [orderId, quoteId] of quotes) {
    const total = totals.get(quoteId)
    if (total !== undefined) out.set(orderId, { quoteId, totalCents: total })
  }
  return out
}

/**
 * Shopmonkey's payments on the work orders as Shopmonkey counts them (succeeded charges and refunds, refunds
 * negative, MAPPING §6.5), and, by order, the ones the load left out by rule that aren't imported since.
 */
export async function readShopmonkeyPayments(
  organizationId: string,
  workOrders: Map<string, string>,
  imported: Set<string>
): Promise<{
  payments: PaymentFact[]
  skipped: Map<string, { reason: string; cents: number }[]>
}> {
  const rows = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT sr."remoteId", sr."loadSkip", r."orderId", r."status", r."transactionType", r."amountCents",
      COALESCE(r."recordedDate", r."createdDate") AS "paidOn"
    FROM "public"."source_records" sr
    CROSS JOIN LATERAL jsonb_to_record(sr.payload) AS r(
      "orderId" text, "status" text, "transactionType" text, "amountCents" text,
      "recordedDate" text, "createdDate" text
    )
    WHERE sr."organizationId" = ${organizationId} AND sr.source = 'shopmonkey' AND sr."table" = 'payment'
      AND sr."remoteDeletedAt" IS NULL
  `
  const payments: PaymentFact[] = []
  const skipped = new Map<string, { reason: string; cents: number }[]>()
  for (const r of rows) {
    const orderId = r.orderId ? String(r.orderId) : null
    if (!orderId || !workOrders.has(orderId) || r.status !== 'Succeeded') continue
    const raw = smCents(r.amountCents)
    // PROVISIONAL(M0:S5): a refund's amount is taken as negative whatever sign it carries.
    const cents = r.transactionType === 'Refund' ? -Math.abs(raw) : raw
    const paidOn = date(r.paidOn)
    // Left out by rule, and not imported since (a reason stays until the payment loads).
    if (r.loadSkip && !imported.has(String(r.remoteId))) {
      const list = skipped.get(orderId) ?? []
      list.push({ reason: String(r.loadSkip), cents })
      skipped.set(orderId, list)
    }
    if ((r.transactionType === 'Charge' || r.transactionType === 'Refund') && paidOn) {
      payments.push({ orderId, cents, date: paidOn })
    }
  }
  return { payments, skipped }
}
