/** Quotes, field by field (docs/fork/API.md §4). Never the share token. */
import { day, iso, isoAlways, money } from '../Lib/serializeFormat'
import type { SerializeContext } from '../Lib/serializeFormat'
import type { QuoteOut } from '../Schema/quotes'
import {
  customFieldsFrom,
  JOB_SELECT,
  type JobRow,
  LABOR_LINE_SELECT,
  type LaborLineRow,
  PART_LINE_SELECT,
  type PartLineRow,
  serializeJob,
  serializeLines,
} from './common'
import { JOB_ORDER, serializeTaxComponents } from './workOrders'

/** The order the workshop arranged the lines in. */
const BY_SORT = [{ sortOrder: 'asc' }, { id: 'asc' }] as const

export function quoteSelect(includes: ReadonlySet<string>) {
  return {
    id: true,
    quoteNumber: true,
    title: true,
    description: true,
    status: true,
    validUntil: true,
    customerId: true,
    vehicleId: true,
    inspectionId: true,
    convertedToId: true,
    customerReference: true,
    notes: true,
    subtotal: true,
    discountType: true,
    discountValue: true,
    discountAmount: true,
    taxRate: true,
    taxAmount: true,
    taxInclusive: true,
    taxComponents: true,
    totalAmount: true,
    warrantyStatus: true,
    warrantyMonths: true,
    warrantyMileage: true,
    warrantyNotes: true,
    sentAt: true,
    createdAt: true,
    updatedAt: true,
    ...(includes.has('jobs') ? { workJobs: { select: JOB_SELECT, orderBy: [...JOB_ORDER] } } : {}),
    ...(includes.has('lines')
      ? {
          laborItems: { select: { ...LABOR_LINE_SELECT, excluded: true }, orderBy: [...BY_SORT] },
          partItems: { select: { ...PART_LINE_SELECT, excluded: true }, orderBy: [...BY_SORT] },
        }
      : {}),
  }
}

export interface QuoteRow {
  id: string
  quoteNumber: string | null
  title: string
  description: string | null
  status: string
  validUntil: Date | null
  customerId: string | null
  vehicleId: string | null
  inspectionId: string | null
  convertedToId: string | null
  customerReference: string | null
  notes: string | null
  subtotal: number
  discountType: string | null
  discountValue: number
  discountAmount: number
  taxRate: number
  taxAmount: number
  taxInclusive: boolean
  taxComponents: unknown
  totalAmount: number
  warrantyStatus: string | null
  warrantyMonths: number | null
  warrantyMileage: number | null
  warrantyNotes: string | null
  sentAt: Date | null
  createdAt: Date
  updatedAt: Date
  workJobs?: JobRow[]
  laborItems?: LaborLineRow[]
  partItems?: PartLineRow[]
}

export function serializeQuote(
  row: QuoteRow,
  ctx: SerializeContext,
  includes: ReadonlySet<string>,
  extra: Record<string, unknown>
): QuoteOut {
  return {
    id: row.id,
    quoteNumber: row.quoteNumber,
    title: row.title,
    description: row.description,
    status: row.status,
    validUntil: iso(row.validUntil),
    validUntilDay: day(row.validUntil, ctx.timeZone),
    customerId: row.customerId,
    vehicleId: row.vehicleId,
    inspectionId: row.inspectionId,
    convertedToId: row.convertedToId,
    customerReference: row.customerReference,
    notes: row.notes,
    currency: ctx.currency,
    subtotal: money(row.subtotal),
    discountType: row.discountType,
    discountValue: row.discountValue,
    discountAmount: money(row.discountAmount),
    taxRate: row.taxRate,
    taxAmount: money(row.taxAmount),
    taxInclusive: row.taxInclusive,
    taxComponents: serializeTaxComponents(row.taxComponents),
    totalAmount: money(row.totalAmount),
    warrantyStatus: row.warrantyStatus,
    warrantyMonths: row.warrantyMonths,
    warrantyMileage: row.warrantyMileage,
    warrantyNotes: row.warrantyNotes,
    sentAt: iso(row.sentAt),
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
    ...(includes.has('jobs') ? { jobs: (row.workJobs ?? []).map(serializeJob) } : {}),
    ...(includes.has('lines')
      ? { lines: serializeLines(row.laborItems ?? [], row.partItems ?? []) }
      : {}),
    ...(includes.has('customFields') ? { customFields: customFieldsFrom(extra) } : {}),
  }
}
