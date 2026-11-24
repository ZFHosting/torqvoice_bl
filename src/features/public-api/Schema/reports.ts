/** fork (A5): the reports, the tombstones and the Shopmonkey archive, for the OpenAPI document (docs/fork/API.md §4). */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** The query as the document shows it (the route's own schema also turns `completedOnly` into a boolean). */
const reportQuery = z
  .object({
    from: dayKey.optional().describe('First day, on the workshop’s calendar (YYYY-MM-DD)'),
    to: dayKey.optional().describe('Last day, included'),
    group: z.enum(['day', 'week', 'month']).optional().describe('month unless set; a week is named by its Monday'),
    completedOnly: z.enum(['true', 'false']).optional().describe('Only work orders marked completed'),
  })
  .strict()

const window = {
  timeZone: z.string().describe('The workshop’s IANA time zone'),
  from: z.string().describe('The window’s start, as an instant'),
  to: z.string().describe('The window’s end (exclusive), as an instant'),
  group: z.enum(['day', 'week', 'month']),
  completedOnly: z.boolean(),
}

const salesTotals = z.object({
  revenue: z.number().describe('Invoiced: what the work orders came to, tax included'),
  collected: z.number(),
  outstanding: z.number(),
  count: z.number().int(),
  tax: z.number(),
  discounts: z.number(),
  partsCost: z.number(),
  partsRevenue: z.number().describe('Net of tax and their share of the discount'),
  laborRevenue: z.number().describe('Net, without the shop fee lines'),
  fees: z.number().describe('Shop fee lines, net'),
  netProfit: z.number(),
})

export const salesReportSchema = z
  .object({
    ...window,
    periods: z.array(salesTotals.extend({ period: z.string() })),
    summary: salesTotals,
  })
  .meta({ id: 'SalesReport' })

const bucket = z.enum(['current', '1-30', '31-60', '61-90', 'over90'])

export const receivablesReportSchema = z
  .object({
    timeZone: z.string(),
    asOf: z.string(),
    totals: z.object({
      current: z.number(),
      '1-30': z.number(),
      '31-60': z.number(),
      '61-90': z.number(),
      over90: z.number(),
      open: z.number(),
      overdue: z.number(),
      invoices: z.number().int(),
      overdueInvoices: z.number().int(),
    }),
    invoices: z.array(
      z.object({
        workOrderId: z.string(),
        invoiceNumber: z.string().nullable(),
        customerId: z.string().nullable(),
        dueDate: dayKey.describe('On the workshop’s calendar'),
        daysPastDue: z.number().int(),
        bucket,
        total: z.number(),
        paid: z.number(),
        due: z.number(),
      })
    ),
  })
  .meta({ id: 'ReceivablesReport' })

const technicianTotals = z.object({
  soldHours: z.number().describe('Labor lines: a line’s own technician, else the job’s people sharing them'),
  clockedMinutes: z.number().int(),
  shiftMinutes: z.number().int(),
  jobsCompleted: z.number().int(),
})

export const techniciansReportSchema = z
  .object({
    ...window,
    technicians: z.array(
      z.object({
        technicianId: z.string(),
        name: z.string().nullable(),
        total: technicianTotals,
        periods: z.array(technicianTotals.extend({ period: z.string() })),
      })
    ),
  })
  .meta({ id: 'TechniciansReport' })

export const tombstoneSchema = z
  .object({
    id: z.string(),
    entityType: z.string().describe('work_order, quote, customer, payment, …'),
    entityId: z.string(),
    deletedAt: z.string(),
  })
  .meta({ id: 'Tombstone' })

export const sourceRecordSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    table: z.string(),
    remoteId: z.string(),
    payload: z.unknown().describe('As Shopmonkey sent it; keys starting with _ are the importer’s own'),
    remoteUpdatedAt: z.string().nullable(),
    remoteDeletedAt: z.string().nullable(),
    local: z.object({ entity: z.string(), id: z.string() }).nullable(),
    fetchedAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'SourceRecord' })

export const reportEndpoints: EndpointSpec[] = [
  {
    method: 'get',
    path: '/reports/sales',
    summary: 'What the work orders came to, by day, week or month',
    tag: 'Reports',
    query: reportQuery,
    response: salesReportSchema,
  },
  {
    method: 'get',
    path: '/reports/receivables',
    summary: 'Open invoices with aging buckets',
    tag: 'Reports',
    response: receivablesReportSchema,
  },
  {
    method: 'get',
    path: '/reports/technicians',
    summary: 'Per technician: hours sold, clocked and on shift, and jobs completed',
    tag: 'Reports',
    query: reportQuery,
    response: techniciansReportSchema,
  },
  {
    method: 'get',
    path: '/deleted',
    summary: 'Tombstones: what was deleted, oldest first',
    tag: 'Sync',
    query: z
      .object({
        since: z.string().optional(),
        entityType: z.string().optional(),
        limit: z.string().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    response: tombstoneSchema,
    paged: true,
  },
  {
    method: 'get',
    path: '/source-records',
    summary: 'Shopmonkey records as fetched, read-only',
    tag: 'Sync',
    query: z
      .object({
        table: z.string().optional(),
        remoteId: z.string().optional(),
        updatedSince: z.string().optional(),
        limit: z.string().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    response: sourceRecordSchema,
    paged: true,
  },
]
