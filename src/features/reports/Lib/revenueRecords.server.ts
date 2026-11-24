/**
 * fork (A5): the revenue report's records and their figures, shared by the reports screen (`getRevenueReport`) and
 * the public API (`/api/v1/reports/sales`), so the two agree to the cent. Moved unchanged from the action.
 */
import { db } from '@/lib/db'
import { isShopFeeLine } from '@/features/settings/Lib/shopFee'
import { earnedLineTotal } from '@/lib/tax'
import { zonedDate, zonedParts } from '@/lib/timezone'
import { workshopDayRange } from '@/lib/workshop-datetime'
import { workshopTimeZone } from '@/lib/workshop-timezone'

/** The date range a report covers, and whether it counts finished work only. */
export interface ReportRange {
  startDate?: string
  endDate?: string
  /** Only work orders marked completed; open ones are left out. */
  completedOnly?: boolean
}

/**
 * Which work orders a report counts: every job in the window, or with the
 * switch on, only those marked completed. The stored status is one of the
 * four system values, whatever the workshop calls its own stages, so
 * `completed` is the same job for every workshop.
 */
export function statusScope(completedOnly?: boolean) {
  return completedOnly ? { status: 'completed' } : {}
}

/**
 * The report window on the workshop's calendar. The picker sends bare
 * YYYY-MM-DD keys, so "to 31 Dec" must cover the whole of that day in the
 * workshop, and the default start is 1 January of the workshop's current
 * year, not the server's. `end` is exclusive: query with `lt`.
 */
export async function reportWindow(organizationId: string, params: ReportRange) {
  const tz = await workshopTimeZone(organizationId)
  const now = new Date()
  const { gte, lt } = workshopDayRange(params.startDate, params.endDate, tz, {
    start: zonedDate(zonedParts(now, tz).year, 1, 1, 0, 0, tz),
    end: now,
  })
  return { tz, start: gte, end: lt }
}

export interface RevenueRecord {
  /** When the job counts: its start, else its service date. */
  date: Date
  type: string
  /** The gross customer-facing total (what was charged). */
  total: number
  paid: number
  partsCost: number
  /** NET (pre-tax), with their share of the job's discount, so they add up with `partsCost` for profit. */
  partsRevenue: number
  /** Every labor line, shop fee lines included (the reports screen's figure). */
  laborRevenue: number
  /** The shop fee lines among them, net. */
  feeRevenue: number
  /** The tax charged, as the work order stores it. */
  tax: number
  /** The discount off the work order. */
  discount: number
}

/** The work orders in the window and what each came to. */
export async function revenueRecords(
  organizationId: string,
  window: { start: Date; end: Date },
  completedOnly?: boolean
): Promise<RevenueRecord[]> {
  const records = await db.serviceRecord.findMany({
    where: {
      organizationId,
      startDateTime: { gte: window.start, lt: window.end },
      ...statusScope(completedOnly),
    },
    select: {
      serviceDate: true,
      startDateTime: true,
      totalAmount: true,
      cost: true,
      type: true,
      taxRate: true,
      taxInclusive: true,
      subtotal: true,
      discountAmount: true,
      taxAmount: true,
      manuallyPaid: true,
      payments: { select: { amount: true } },
      partItems: { select: { unitCost: true, quantity: true, total: true, taxable: true } },
      laborItems: { select: { total: true, taxable: true, pricingType: true } },
    },
    orderBy: [{ startDateTime: { sort: 'asc', nulls: 'last' } }, { serviceDate: 'asc' }],
  })
  return records.map((r) => {
    const total = r.totalAmount > 0 ? r.totalAmount : r.cost
    return {
      date: r.startDateTime ?? r.serviceDate,
      type: r.type,
      total,
      paid: r.manuallyPaid ? total : r.payments.reduce((s, p) => s + p.amount, 0),
      partsCost: r.partItems.reduce((s, p) => s + p.unitCost * p.quantity, 0),
      partsRevenue: r.partItems.reduce((s, p) => s + earnedLineTotal(p.total, r, p.taxable), 0),
      laborRevenue: r.laborItems.reduce((s, l) => s + earnedLineTotal(l.total, r, l.taxable), 0),
      feeRevenue: r.laborItems
        .filter(isShopFeeLine)
        .reduce((s, l) => s + earnedLineTotal(l.total, r, l.taxable), 0),
      tax: r.taxAmount,
      discount: r.discountAmount,
    }
  })
}
