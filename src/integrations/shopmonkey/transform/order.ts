/**
 * Orders (MAPPING §6): an Estimate becomes a `Quote`, a RepairOrder or Invoice a `ServiceRecord` with its
 * `ServiceRecordMeta`, and both get their services as `WorkJob`s with lines. Shopmonkey's totals are
 * stored as they are; the lines are checked against them and a difference is a `money_mismatch` warning
 * with both numbers, never a correction. Deleted orders aren't imported.
 */
import { centsToAmount } from '../money'
import type { CustomFieldValueRow } from './customer'
import { date, entries, type FieldSpec, num, records, str, unmappedFields, warn } from './fields'
import { transformTaxConfig } from './catalog'
import { type JobRows, type LineKind, transformService } from './lines'
import type { Row, Stage, TransformContext, TransformResult, Warning } from './types'

export const ORDER_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'number',
    'name',
    'coalescedName',
    'generatedName',
    'complaint',
    'recommendation',
    'status',
    'workflowStatusId',
    'workflowStatusDate',
    'orderCreatedDate',
    'repairOrderDate',
    'createdDate',
    'invoicedDate',
    'dueDate',
    'paymentDueDate',
    'mileageIn',
    'mileageOut',
    'customerId',
    'vehicleId',
    'assignedTechnicianIds',
    'serviceWriterId',
    'purchaseOrderNumber',
    'labels',
    'discountCents',
    'discountPercent',
    'appliedDiscountCents',
    'appliedDiscountPercent',
    'appliedDiscountValueType',
    'taxCents',
    'gstCents',
    'pstCents',
    'hstCents',
    'totalCostCents',
    'laborCents',
    'partsCents',
    'tiresCents',
    'subcontractsCents',
    'feesCents',
    'epaCents',
    'shopSuppliesCents',
    'authorized',
    'authorizedDate',
    'completedDate',
    'fullyPaidDate',
    'messagedDate',
    'customFields',
    'deleted',
  ],
  archive: [
    'archived',
    'companyId',
    'deletedDate',
    'deletedReason',
    // Loaded from the staged `order_file` records (M3), as ServiceAttachments (M5).
    'files',
    'hasPayments',
    'invoiceLockState',
    'invoiced',
    'locationId',
    'metadata',
    'paid',
    'paidCostCents',
    'publicId',
    'remainingCostCents',
    'taxConfigId',
    'updatedDate',
    'workflowStatusPosition',
  ],
}

/** The Torqvoice quote statuses an imported estimate can have (quoteStatusSchema). */
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired'

export interface OrderInputs {
  services: Row[]
  /** Shopmonkey's id of the vehicle's current owner (§3): the order's customer is set only when different. */
  vehicleOwnerRemoteId: string | null
  /** The location's tax config (S6): its rate, and whether EPA and shop supplies are taxed. */
  taxConfig: Row | null
  /** Shopmonkey user id → display name, for the service writer. */
  userNames: Record<string, string>
  /** Authorization rows of the order (§3): the earliest date is `authorizedAt`. */
  authorizations: Row[]
}

interface Money {
  subtotal: number
  taxRate: number
  taxAmount: number
  taxComponents: { name: string; rate: number; amount: number }[] | null
  discountType: 'percent' | 'fixed' | null
  discountValue: number
  discountAmount: number
  totalAmount: number
}

export type OrderRows =
  | {
      kind: 'serviceRecord'
      record: Money & {
        title: string
        invoiceNumber: string | null
        invoiceNotes: string | null
        status: Stage
        customStatusId: string | null
        customStatusSince: Date | null
        serviceDate: Date
        createdAt: Date | undefined
        invoiceDate: Date | null
        sentAt: Date | null
        invoiceDueDate: Date | null
        mileage: number | null
        vehicleId: string | null
        customerId: string | null
        technicianId: string | null
        customerReference: string | null
        cost: number
        organizationId: string
      }
      meta: {
        sourceStatus: string | null
        /** A local user id; the importer creates no logins, so always null (the name is kept). */
        serviceWriterUserId: null
        serviceWriterName: string | null
        mileageOut: number | null
        labels: string[]
        authorizedAt: Date | null
        completedAt: Date | null
        fullyPaidAt: Date | null
        purchaseOrderNumber: string | null
        organizationId: string
      }
      /** The complaint, as the record's one ServiceConcern. */
      concern: string | null
      /** Technicians after the first: ServiceRecordHelper rows. */
      helperTechnicianIds: string[]
      jobs: JobRows[]
      customFields: CustomFieldValueRow[]
      /** Needs `issueInvoice(id, org, 'backfill')` once written (MAPPING §6.1, RESULTS T5). */
      issueAsInvoice: boolean
    }
  | {
      kind: 'quote'
      quote: Money & {
        title: string
        quoteNumber: string | null
        description: string | null
        notes: string | null
        status: QuoteStatus
        validUntil: Date | null
        customerId: string | null
        vehicleId: string | null
        customerReference: string | null
        createdAt: Date | undefined
        userId: string
        organizationId: string
      }
      jobs: JobRows[]
      customFields: CustomFieldValueRow[]
    }

const cents = (value: unknown) => Math.round(num(value) ?? 0)

function title(order: Row, services: Row[]): string {
  return (
    str(order.name) ??
    str(order.coalescedName) ??
    str(order.generatedName) ??
    str([...services].sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0))[0]?.name) ??
    `Order #${str(order.number) ?? String(order.id)}`
  )
}

function money(order: Row, jobs: JobRows[], taxConfig: Row | null, warnings: Warning[]): Money {
  const remoteId = String(order.id)
  const counted = jobs.filter((j) => j.counts)
  const sum = (kinds: LineKind[]) =>
    counted.reduce((a, j) => a + kinds.reduce((b, k) => b + j.cents[k], 0), 0)
  const subtotalCents = sum(['labor', 'fee', 'epa', 'shopSupplies', 'part', 'tire', 'subcontract'])
  const theirSubtotal =
    cents(order.laborCents) +
    cents(order.partsCents) +
    cents(order.tiresCents) +
    cents(order.subcontractsCents) +
    cents(order.feesCents) +
    cents(order.epaCents) +
    cents(order.shopSuppliesCents)
  if (subtotalCents !== theirSubtotal) {
    warnings.push(
      warn(
        'order',
        remoteId,
        'money_mismatch',
        `Lines add up to ${subtotalCents}, Shopmonkey's subtotal is ${theirSubtotal}`,
        'subtotal'
      )
    )
  }
  const discountCents = cents(order.discountCents)
  const taxCents = cents(order.taxCents)
  const totalCents = cents(order.totalCostCents)
  // PROVISIONAL(M0:S5): subtotal − discount + tax = total, as Shopmonkey stores them (the identity holds
  // whether the discount was taken before or after tax).
  if (theirSubtotal - discountCents + taxCents !== totalCents) {
    warnings.push(
      warn(
        'order',
        remoteId,
        'money_mismatch',
        `Subtotal ${theirSubtotal} − discount ${discountCents} + tax ${taxCents} ≠ total ${totalCents}`,
        'totalCostCents'
      )
    )
  }
  const components = (
    [
      ['GST', 'gstCents', 'gstPercent'],
      ['PST', 'pstCents', 'pstPercent'],
      ['HST', 'hstCents', 'hstPercent'],
    ] as const
  )
    .filter(([, key]) => cents(order[key]) !== 0)
    .map(([name, key, rate]) => ({
      name,
      rate: num(taxConfig?.[rate]) ?? 0,
      amount: centsToAmount(cents(order[key])),
    }))
  const percent = order.appliedDiscountValueType === 'Percent'
  return {
    subtotal: centsToAmount(subtotalCents),
    // The tax config's rate (US `taxPercent`, or the Canadian components'), RESULTS S6.
    taxRate: taxConfig ? transformTaxConfig(taxConfig).rate : 0,
    taxAmount: centsToAmount(taxCents),
    taxComponents: components.length > 1 ? components : null,
    discountType: discountCents ? (percent ? 'percent' : 'fixed') : null,
    discountValue: discountCents
      ? percent
        ? (num(order.appliedDiscountPercent) ?? num(order.discountPercent) ?? 0)
        : centsToAmount(discountCents)
      : 0,
    discountAmount: centsToAmount(discountCents),
    totalAmount: centsToAmount(totalCents),
  }
}

function orderCustomFields(
  order: Row,
  entityType: 'service_record' | 'quote'
): CustomFieldValueRow[] {
  const out: CustomFieldValueRow[] = []
  for (const [name, value] of entries(order.customFields)) {
    const text = value === null || value === undefined ? null : String(value).trim()
    if (text) out.push({ entityType, name, value: text })
  }
  return out
}

function quoteStatus(order: Row, services: Row[], now: Date): QuoteStatus {
  if (order.authorized === true) return 'accepted'
  if (services.length && services.every((s) => s.authorizationStatus === 'Declined'))
    return 'rejected'
  const due = date(order.dueDate)
  if (due && due.getTime() < now.getTime()) return 'expired'
  if (date(order.messagedDate)) return 'sent'
  return 'draft'
}

export function transformOrder(
  order: Row,
  inputs: OrderInputs,
  ctx: TransformContext,
  now: Date
): TransformResult<OrderRows | null> {
  const remoteId = String(order.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(order, ORDER_FIELDS)
  if (order.deleted === true) return { rows: null, warnings, unmapped }
  const leftOut = new Set(unmapped)

  const tax = inputs.taxConfig
  const jobs = [...inputs.services]
    .sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0))
    .map((service) => {
      const result = transformService(
        service,
        ctx,
        tax?.epaTaxable === true,
        tax?.shopSuppliesTaxable === true
      )
      warnings.push(...result.warnings)
      for (const field of result.unmapped) leftOut.add(field)
      return result.rows
    })
  const totals = money(order, jobs, tax, warnings)
  const vehicleRemote = str(order.vehicleId)
  const customerRemote = str(order.customerId)
  const vehicleId = vehicleRemote ? ctx.resolve('vehicle', vehicleRemote) : null
  const customerId = customerRemote ? ctx.resolve('customer', customerRemote) : null
  if (vehicleRemote && !vehicleId) {
    warnings.push(
      warn(
        'order',
        remoteId,
        'order_vehicle_unresolved',
        'Its vehicle was not imported',
        'vehicleId'
      )
    )
  }
  if (customerRemote && !customerId) {
    warnings.push(
      warn(
        'order',
        remoteId,
        'order_customer_unresolved',
        'Its customer was not imported',
        'customerId'
      )
    )
  }

  if (order.status === 'Estimate') {
    return {
      rows: {
        kind: 'quote',
        quote: {
          ...totals,
          title: title(order, inputs.services),
          quoteNumber: str(order.number),
          description: str(order.complaint),
          notes: str(order.recommendation),
          status: quoteStatus(order, inputs.services, now),
          validUntil: date(order.dueDate),
          customerId,
          vehicleId,
          customerReference: str(order.purchaseOrderNumber),
          createdAt: date(order.createdDate) ?? undefined,
          userId: ctx.runUserId,
          organizationId: ctx.organizationId,
        },
        jobs,
        customFields: orderCustomFields(order, 'quote'),
      },
      warnings,
      unmapped: [...leftOut].sort(),
    }
  }

  // A RepairOrder takes its workflow status's stage; an Invoice, or anything completed, is completed.
  const workflowStatus = str(order.workflowStatusId)
  let status: Stage = 'completed'
  if (order.status !== 'Invoice' && !date(order.completedDate)) {
    const mapped = workflowStatus ? ctx.settings.statusStageMap[workflowStatus] : undefined
    if (!mapped) {
      warnings.push(
        warn(
          'order',
          remoteId,
          'order_status_unmapped',
          'Its workflow status has no stage',
          'workflowStatusId'
        )
      )
    }
    status = mapped ?? 'in-progress'
  }
  const technicians = (
    Array.isArray(order.assignedTechnicianIds) ? order.assignedTechnicianIds : []
  )
    .map((id) => (typeof id === 'string' ? ctx.resolve('user', id) : null))
    .filter((id): id is string => !!id)
  const writer = str(order.serviceWriterId)
  const authorizedAt =
    date(order.authorizedDate) ??
    records(inputs.authorizations)
      .map((a) => date(a.date) ?? date(a.createdDate))
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0] ??
    null
  const invoiced = date(order.invoicedDate)
  const isInvoice = order.status === 'Invoice'
  // §6.1: the order's customer is set only when it isn't the vehicle's current owner (or there's no vehicle).
  const differentBillTo =
    !vehicleRemote || (customerRemote !== null && customerRemote !== inputs.vehicleOwnerRemoteId)
  const mileageIn = num(order.mileageIn)
  const mileageOut = num(order.mileageOut)
  const serviceDate =
    date(order.repairOrderDate) ?? date(order.orderCreatedDate) ?? date(order.createdDate)
  if (!serviceDate) {
    warnings.push(
      warn(
        'order',
        remoteId,
        'order_missing_date',
        'No order date: the run date is used',
        'createdDate'
      )
    )
  }
  if (isInvoice && !invoiced) {
    warnings.push(
      warn(
        'order',
        remoteId,
        'invoice_not_issued',
        'An invoice with no invoice date is left unissued',
        'invoicedDate'
      )
    )
  }
  return {
    rows: {
      kind: 'serviceRecord',
      record: {
        ...totals,
        title: title(order, inputs.services),
        invoiceNumber: str(order.number),
        // PROVISIONAL(M0:S4): whether `recommendation` prints on Shopmonkey's invoice is unconfirmed.
        invoiceNotes: str(order.recommendation),
        status,
        customStatusId: workflowStatus ? ctx.resolve('workflow_status', workflowStatus) : null,
        customStatusSince: date(order.workflowStatusDate),
        serviceDate: serviceDate ?? now,
        createdAt: date(order.createdDate) ?? undefined,
        invoiceDate: isInvoice ? invoiced : null,
        sentAt: isInvoice ? invoiced : null,
        invoiceDueDate: date(order.dueDate) ?? date(order.paymentDueDate),
        mileage: mileageIn === null ? null : Math.round(mileageIn),
        vehicleId,
        customerId: differentBillTo ? customerId : null,
        technicianId: technicians[0] ?? null,
        customerReference: str(order.purchaseOrderNumber),
        cost: totals.totalAmount,
        organizationId: ctx.organizationId,
      },
      meta: {
        sourceStatus: str(order.status),
        serviceWriterUserId: null,
        serviceWriterName: writer ? (inputs.userNames[writer] ?? null) : null,
        mileageOut: mileageOut === null ? null : Math.round(mileageOut),
        // PROVISIONAL(M0:S4): `labels` read as `{ id: name }`.
        labels: entries(order.labels)
          .map(([, label]) => str(label))
          .filter((label): label is string => !!label),
        authorizedAt,
        completedAt: date(order.completedDate),
        fullyPaidAt: date(order.fullyPaidDate),
        purchaseOrderNumber: str(order.purchaseOrderNumber),
        organizationId: ctx.organizationId,
      },
      concern: str(order.complaint),
      // `technicians.prisma`: the technician is never also a helper.
      helperTechnicianIds: [...new Set(technicians.slice(1))].filter((id) => id !== technicians[0]),
      jobs,
      customFields: orderCustomFields(order, 'service_record'),
      issueAsInvoice: isInvoice && invoiced !== null,
    },
    warnings,
    unmapped: [...leftOut].sort(),
  }
}
