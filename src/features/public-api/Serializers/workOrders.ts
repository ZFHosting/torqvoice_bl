/**
 * Work orders and what hangs off them, field by field (docs/fork/API.md §4). Never the share token, the frozen
 * invoice snapshot or who unlocked it: only what an integration needs and may see.
 */
import { parseTaxComponents } from '@/lib/tax-components'
import { day, iso, isoAlways, money, moneyOrNull } from '../Lib/serializeFormat'
import type { SerializeContext } from '../Lib/serializeFormat'
import type {
  AttachmentOut,
  ConcernOut,
  TaxComponentAmountOut,
  WorkOrderMetaOut,
  WorkOrderOut,
} from '../Schema/workOrders'
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
import { PAYMENT_SELECT, type PaymentRow, serializePayment } from './records'
import { serializeTimeEntry, TIME_ENTRY_SELECT, type TimeEntryRow } from './schedule'

export const CONCERN_SELECT = {
  id: true,
  description: true,
  cause: true,
  correction: true,
  confirmation: true,
  confirmedAt: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface ConcernRow {
  id: string
  description: string
  cause: string | null
  correction: string | null
  confirmation: string | null
  confirmedAt: Date | null
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

export const ATTACHMENT_SELECT = {
  id: true,
  fileName: true,
  fileType: true,
  fileSize: true,
  category: true,
  description: true,
  includeInInvoice: true,
  concernId: true,
  createdAt: true,
} as const

export interface AttachmentRow {
  id: string
  fileName: string
  fileType: string
  fileSize: number
  category: string
  description: string | null
  includeInInvoice: boolean
  concernId: string | null
  createdAt: Date
}

const META_SELECT = {
  sourceStatus: true,
  serviceWriterUserId: true,
  serviceWriterName: true,
  mileageOut: true,
  labels: true,
  authorizedAt: true,
  completedAt: true,
  fullyPaidAt: true,
  purchaseOrderNumber: true,
} as const

interface MetaRow {
  sourceStatus: string | null
  serviceWriterUserId: string | null
  serviceWriterName: string | null
  mileageOut: number | null
  labels: string[]
  authorizedAt: Date | null
  completedAt: Date | null
  fullyPaidAt: Date | null
  purchaseOrderNumber: string | null
}

/** The order lines are stored in: as they were written. */
const BY_ID = [{ id: 'asc' }] as const

export const JOB_ORDER = [{ ordinal: 'asc' }, { id: 'asc' }] as const

export function workOrderSelect(includes: ReadonlySet<string>) {
  return {
    id: true,
    invoiceNumber: true,
    title: true,
    description: true,
    type: true,
    status: true,
    customStatusId: true,
    vehicleId: true,
    customerId: true,
    technicianId: true,
    techName: true,
    inspectionId: true,
    mileage: true,
    serviceDate: true,
    startDateTime: true,
    endDateTime: true,
    promisedAt: true,
    invoiceDate: true,
    invoiceDueDate: true,
    customerReference: true,
    diagnosticNotes: true,
    invoiceNotes: true,
    subtotal: true,
    discountType: true,
    discountValue: true,
    discountAmount: true,
    taxRate: true,
    taxAmount: true,
    taxInclusive: true,
    taxComponents: true,
    totalAmount: true,
    manuallyPaid: true,
    manuallyPaidAt: true,
    issuedAt: true,
    sentAt: true,
    warrantyStatus: true,
    warrantyMonths: true,
    warrantyMileage: true,
    warrantyExpiresAt: true,
    warrantyNotes: true,
    createdAt: true,
    updatedAt: true,
    ...(includes.has('jobs') ? { workJobs: { select: JOB_SELECT, orderBy: [...JOB_ORDER] } } : {}),
    ...(includes.has('lines')
      ? {
          laborItems: { select: LABOR_LINE_SELECT, orderBy: [...BY_ID] },
          partItems: { select: PART_LINE_SELECT, orderBy: [...BY_ID] },
        }
      : {}),
    ...(includes.has('concerns')
      ? { concerns: { select: CONCERN_SELECT, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } }
      : {}),
    ...(includes.has('payments')
      ? { payments: { select: PAYMENT_SELECT, orderBy: [{ date: 'asc' }, { id: 'asc' }] } }
      : {}),
    ...(includes.has('attachments')
      ? {
          attachments: {
            select: ATTACHMENT_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        }
      : {}),
    ...(includes.has('timeEntries')
      ? {
          timeEntries: {
            select: TIME_ENTRY_SELECT,
            orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
          },
        }
      : {}),
    ...(includes.has('meta') ? { meta: { select: META_SELECT } } : {}),
  }
}

export interface WorkOrderRow {
  id: string
  invoiceNumber: string | null
  title: string
  description: string | null
  type: string
  status: string
  customStatusId: string | null
  vehicleId: string | null
  customerId: string | null
  technicianId: string | null
  techName: string | null
  inspectionId: string | null
  mileage: number | null
  serviceDate: Date
  startDateTime: Date | null
  endDateTime: Date | null
  promisedAt: Date | null
  invoiceDate: Date | null
  invoiceDueDate: Date | null
  customerReference: string | null
  diagnosticNotes: string | null
  invoiceNotes: string | null
  subtotal: number
  discountType: string | null
  discountValue: number
  discountAmount: number
  taxRate: number
  taxAmount: number
  taxInclusive: boolean
  taxComponents: unknown
  totalAmount: number
  manuallyPaid: boolean
  manuallyPaidAt: Date | null
  issuedAt: Date | null
  sentAt: Date | null
  warrantyStatus: string | null
  warrantyMonths: number | null
  warrantyMileage: number | null
  warrantyExpiresAt: Date | null
  warrantyNotes: string | null
  createdAt: Date
  updatedAt: Date
  workJobs?: JobRow[]
  laborItems?: LaborLineRow[]
  partItems?: PartLineRow[]
  concerns?: ConcernRow[]
  payments?: PaymentRow[]
  attachments?: AttachmentRow[]
  timeEntries?: TimeEntryRow[]
  meta?: MetaRow | null
}

export function serializeTaxComponents(stored: unknown): TaxComponentAmountOut[] | null {
  const parsed = parseTaxComponents(stored)
  if (!parsed) return null
  return parsed.map((c) => ({
    name: c.name,
    rate: c.rate,
    amount: money(c.amount),
    compound: c.compound === true,
    registrationNumber: c.registrationNumber ?? null,
  }))
}

export function serializeConcern(row: ConcernRow): ConcernOut {
  return {
    id: row.id,
    description: row.description,
    cause: row.cause,
    correction: row.correction,
    confirmation: row.confirmation,
    confirmedAt: iso(row.confirmedAt),
    sortOrder: row.sortOrder,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
  }
}

/** The API path an attachment's file downloads from, with the same key. */
export function attachmentContentUrl(workOrderId: string, attachmentId: string): string {
  return `/api/v1/work-orders/${encodeURIComponent(workOrderId)}/attachments/${encodeURIComponent(attachmentId)}/content`
}

export function serializeAttachment(workOrderId: string, row: AttachmentRow): AttachmentOut {
  return {
    id: row.id,
    fileName: row.fileName,
    fileType: row.fileType,
    fileSize: row.fileSize,
    category: row.category,
    description: row.description,
    includeInInvoice: row.includeInInvoice,
    concernId: row.concernId,
    contentUrl: attachmentContentUrl(workOrderId, row.id),
    createdAt: isoAlways(row.createdAt),
  }
}

function serializeMeta(row: MetaRow): WorkOrderMetaOut {
  return {
    sourceStatus: row.sourceStatus,
    serviceWriterUserId: row.serviceWriterUserId,
    serviceWriterName: row.serviceWriterName,
    mileageOut: row.mileageOut,
    labels: [...row.labels],
    authorizedAt: iso(row.authorizedAt),
    completedAt: iso(row.completedAt),
    fullyPaidAt: iso(row.fullyPaidAt),
    purchaseOrderNumber: row.purchaseOrderNumber,
  }
}

export function serializeWorkOrder(
  row: WorkOrderRow,
  ctx: SerializeContext,
  includes: ReadonlySet<string>,
  extra: Record<string, unknown>
): WorkOrderOut {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    customStatusId: row.customStatusId,
    vehicleId: row.vehicleId,
    customerId: row.customerId,
    technicianId: row.technicianId,
    techName: row.techName,
    inspectionId: row.inspectionId,
    mileage: row.mileage,
    serviceDate: isoAlways(row.serviceDate),
    startDateTime: iso(row.startDateTime),
    endDateTime: iso(row.endDateTime),
    promisedAt: iso(row.promisedAt),
    invoiceDate: iso(row.invoiceDate),
    invoiceDay: day(row.invoiceDate, ctx.timeZone),
    invoiceDueDate: iso(row.invoiceDueDate),
    invoiceDueDay: day(row.invoiceDueDate, ctx.timeZone),
    customerReference: row.customerReference,
    diagnosticNotes: row.diagnosticNotes,
    invoiceNotes: row.invoiceNotes,
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
    manuallyPaid: row.manuallyPaid,
    manuallyPaidAt: iso(row.manuallyPaidAt),
    issuedAt: iso(row.issuedAt),
    sentAt: iso(row.sentAt),
    warrantyStatus: row.warrantyStatus,
    warrantyMonths: row.warrantyMonths,
    warrantyMileage: row.warrantyMileage,
    warrantyExpiresAt: iso(row.warrantyExpiresAt),
    warrantyNotes: row.warrantyNotes,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
    ...(includes.has('jobs') ? { jobs: (row.workJobs ?? []).map(serializeJob) } : {}),
    ...(includes.has('lines')
      ? { lines: serializeLines(row.laborItems ?? [], row.partItems ?? []) }
      : {}),
    ...(includes.has('concerns') ? { concerns: (row.concerns ?? []).map(serializeConcern) } : {}),
    ...(includes.has('payments')
      ? { payments: (row.payments ?? []).map((p) => serializePayment(p, ctx)) }
      : {}),
    ...(includes.has('attachments')
      ? { attachments: (row.attachments ?? []).map((a) => serializeAttachment(row.id, a)) }
      : {}),
    ...(includes.has('timeEntries')
      ? { timeEntries: (row.timeEntries ?? []).map(serializeTimeEntry) }
      : {}),
    ...(includes.has('meta') ? { meta: row.meta ? serializeMeta(row.meta) : null } : {}),
    ...(includes.has('customFields') ? { customFields: customFieldsFrom(extra) } : {}),
  }
}

export { LABOR_LINE_SELECT, PART_LINE_SELECT, JOB_SELECT, PAYMENT_SELECT, BY_ID }
