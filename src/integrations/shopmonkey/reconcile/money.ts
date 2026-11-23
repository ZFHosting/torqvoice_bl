/**
 * fork: the money sections of the reconciliation (M6): each imported work order against its Shopmonkey order, the
 * workshop's receivables on both sides, and both sides by month on the workshop's clock.
 *
 * Torqvoice's side is read from what is stored, the lines included, not from the totals the load copied over: a
 * line changed or broken since shows. Lines count as the load counts them (`countsTowardTotals`, MAPPING §6.3): not
 * under a Declined or deferred job. A difference is explained only by a rule MAPPING §6.6 names, cited by its code.
 */
import 'server-only'
import { db } from '@/lib/db'
import { zonedParts } from '@/lib/timezone'
import type { MoneyDifference, MonthTotals, SpotCheck } from './types'

/** Cents from a Shopmonkey amount (a number of cents, or text of one); 0 when there is none. */
export function smCents(value: unknown): number {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? Math.round(n) : 0
}

/** Cents from a Torqvoice amount (major units). */
export function tvCents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
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
  invoicedDate: Date | null
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
  paidCents: number
}

export interface PaymentFact {
  orderId: string
  cents: number
  date: Date
}

/**
 * The differences of one order over a cent, each with the rule that explains it, if one does:
 * - `money_mismatch`: Shopmonkey's own lines and subtotal (or subtotal, discount, tax and total) disagree, as the
 *   load warned (MAPPING §6.6): its lines can't match both.
 * - `payment_type_unsupported`, `payment_missing_date`: payments Shopmonkey counts as paid and the load leaves out
 *   (MAPPING §6.5, §6.6), when they come to the difference to the cent.
 */
export function compareOrder(
  sm: ShopmonkeyOrder,
  tv: TorqvoiceOrder,
  known: { moneyMismatch: boolean; skippedPayments: { reason: string; cents: number }[] }
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
      field,
      shopmonkeyCents,
      torqvoiceCents,
      explainedBy,
    })
  }
  add('lines', sm.subtotalCents, tv.linesCents, known.moneyMismatch ? 'money_mismatch' : null)
  add('total', sm.totalCents, tv.totalCents, null)
  // Payments left out by rule explain a paid difference that comes to exactly what they add up to.
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

/** The Shopmonkey orders behind the loaded work orders. */
export async function readShopmonkeyOrders(
  organizationId: string,
  workOrders: Map<string, string>
): Promise<ShopmonkeyOrder[]> {
  const rows = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT "remoteId", payload->>'number' AS number, payload->>'invoicedDate' AS "invoicedDate",
      payload->>'laborCents' AS labor, payload->>'partsCents' AS parts, payload->>'tiresCents' AS tires,
      payload->>'subcontractsCents' AS subcontracts, payload->>'feesCents' AS fees,
      payload->>'epaCents' AS epa, payload->>'shopSuppliesCents' AS "shopSupplies",
      payload->>'discountCents' AS discount, payload->>'taxCents' AS tax,
      payload->>'totalCostCents' AS total, payload->>'paidCostCents' AS paid,
      payload->>'remainingCostCents' AS remaining
    FROM "public"."source_records"
    WHERE "organizationId" = ${organizationId} AND source = 'shopmonkey' AND "table" = 'order'
      AND "localEntity" = 'ServiceRecord'
  `
  return rows
    .filter((r) => workOrders.has(String(r.remoteId)))
    .map((r) => ({
      orderId: String(r.remoteId),
      number: r.number ? String(r.number) : null,
      // MAPPING §6.1: the subtotal is the categories of the services that count.
      subtotalCents:
        smCents(r.labor) +
        smCents(r.parts) +
        smCents(r.tires) +
        smCents(r.subcontracts) +
        smCents(r.fees) +
        smCents(r.epa) +
        smCents(r.shopSupplies),
      totalCents: smCents(r.total),
      taxCents: smCents(r.tax),
      discountCents: smCents(r.discount),
      paidCents: smCents(r.paid),
      remainingCents: smCents(r.remaining),
      invoicedDate: date(r.invoicedDate),
    }))
}

/** The loaded work orders as stored: their totals, their counted lines, what has been paid on them. */
export async function readTorqvoiceOrders(
  organizationId: string,
  workOrders: Map<string, string>
): Promise<{ orders: Map<string, TorqvoiceOrder>; payments: PaymentFact[] }> {
  const records = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT id, "vehicleId", "invoiceNumber", "invoiceDate", "totalAmount", "taxAmount", "discountAmount"
    FROM "public"."service_records" WHERE "organizationId" = ${organizationId}
  `
  // Lines that count (MAPPING §6.3, `countsTowardTotals`): not under a Declined or deferred job.
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
    orders.set(orderId, {
      workOrderId: id,
      vehicleId: r.vehicleId ? String(r.vehicleId) : null,
      invoiceNumber: r.invoiceNumber ? String(r.invoiceNumber) : null,
      invoiceDate: r.invoiceDate ? new Date(r.invoiceDate as Date) : null,
      linesCents: lineSums.get(id) ?? 0,
      totalCents: tvCents(r.totalAmount),
      taxCents: tvCents(r.taxAmount),
      discountCents: tvCents(r.discountAmount),
      paidCents: paidSums.get(id) ?? 0,
    })
  }
  return { orders, payments }
}

/**
 * Shopmonkey's payments on these orders as Shopmonkey counts them (succeeded charges and refunds, refunds
 * negative, MAPPING §6.5), and the ones the load left out by rule, by order.
 */
export async function readShopmonkeyPayments(
  organizationId: string,
  workOrders: Map<string, string>
): Promise<{
  payments: PaymentFact[]
  skipped: Map<string, { reason: string; cents: number }[]>
}> {
  const rows = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT payload->>'orderId' AS "orderId", payload->>'status' AS status,
      payload->>'transactionType' AS "type", payload->>'amountCents' AS amount,
      COALESCE(payload->>'recordedDate', payload->>'createdDate') AS "paidOn", "loadSkip"
    FROM "public"."source_records"
    WHERE "organizationId" = ${organizationId} AND source = 'shopmonkey' AND "table" = 'payment'
      AND "remoteDeletedAt" IS NULL
  `
  const payments: PaymentFact[] = []
  const skipped = new Map<string, { reason: string; cents: number }[]>()
  for (const r of rows) {
    const orderId = r.orderId ? String(r.orderId) : null
    if (!orderId || !workOrders.has(orderId) || r.status !== 'Succeeded') continue
    const raw = smCents(r.amount)
    const cents = r.type === 'Refund' ? -Math.abs(raw) : raw
    const paidOn = date(r.paidOn)
    if (r.loadSkip) {
      skipped.set(orderId, [...(skipped.get(orderId) ?? []), { reason: String(r.loadSkip), cents }])
    }
    if ((r.type === 'Charge' || r.type === 'Refund') && paidOn)
      payments.push({ orderId, cents, date: paidOn })
  }
  return { payments, skipped }
}
