import { z } from 'zod'
import { publicApiOk } from '@/features/public-api/Lib/errors'
import { queryObject } from '@/features/public-api/Lib/readResource'
import { withPublicApi } from '@/features/public-api/Lib/withPublicApi'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { zonedDayKey } from '@/lib/timezone'
import { workshopTimeZone } from '@/lib/workshop-timezone'

export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 60 * 60 * 1000

/** Days past due: not yet due, then 1-30, 31-60, 61-90 and over 90. */
const BUCKETS = ['current', '1-30', '31-60', '61-90', 'over90'] as const
type Bucket = (typeof BUCKETS)[number]

function bucketOf(daysPastDue: number): Bucket {
  if (daysPastDue <= 0) return 'current'
  if (daysPastDue <= 30) return '1-30'
  if (daysPastDue <= 60) return '31-60'
  if (daysPastDue <= 90) return '61-90'
  return 'over90'
}

/**
 * fork (A5) `GET /api/v1/reports/receivables` (docs/fork/API.md §4): every invoice with money still owed, aged by days
 * past its due date, with the due dates on the workshop's clock. An invoice is a work order with a due date, not
 * cancelled; what it owes is its total less its payments (all of it when marked paid by hand), the rule the reports
 * screen's past-due report uses, so the overdue part here is that report's total. Amounts in the workshop's currency.
 * Needs `read:reports`.
 */
export async function GET(request: Request) {
  return withPublicApi(
    request,
    async ({ organizationId }) => {
      // It takes no parameters; one sent is a 400, as on every list (a misspelt filter would answer everything).
      z.object({}).strict().parse(queryObject(request))
      const now = new Date()
      const tz = await workshopTimeZone(organizationId)
      const records = await db.serviceRecord.findMany({
        where: { organizationId, invoiceDueDate: { not: null }, status: { not: 'cancelled' } },
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDueDate: true,
          totalAmount: true,
          cost: true,
          manuallyPaid: true,
          customerId: true,
          vehicle: { select: { customerId: true } },
          payments: { select: { amount: true } },
        },
        orderBy: [{ invoiceDueDate: 'asc' }, { id: 'asc' }],
      })
      const totals = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>
      const invoices: {
        workOrderId: string
        invoiceNumber: string | null
        customerId: string | null
        dueDate: string
        daysPastDue: number
        bucket: Bucket
        total: number
        paid: number
        due: number
      }[] = []
      for (const r of records) {
        const total = r.totalAmount > 0 ? r.totalAmount : r.cost
        const paid = r.manuallyPaid ? total : r.payments.reduce((s, p) => s + p.amount, 0)
        const due = total - paid
        if (due <= 0) continue
        const dueDate = r.invoiceDueDate as Date
        // Whole days, as the past-due report counts them.
        const daysPastDue =
          dueDate < now ? Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS) : 0
        const bucket = dueDate < now && daysPastDue === 0 ? '1-30' : bucketOf(daysPastDue)
        totals[bucket] += due
        invoices.push({
          workOrderId: r.id,
          invoiceNumber: r.invoiceNumber,
          customerId: r.customerId ?? r.vehicle?.customerId ?? null,
          dueDate: zonedDayKey(dueDate, tz),
          daysPastDue,
          bucket,
          total,
          paid,
          due,
        })
      }
      const overdue = invoices.filter((i) => i.bucket !== 'current')
      return publicApiOk({
        timeZone: tz,
        asOf: now.toISOString(),
        totals: {
          ...totals,
          open: invoices.reduce((s, i) => s + i.due, 0),
          overdue: overdue.reduce((s, i) => s + i.due, 0),
          invoices: invoices.length,
          overdueInvoices: overdue.length,
        },
        invoices,
      })
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.REPORTS }],
    }
  )
}
