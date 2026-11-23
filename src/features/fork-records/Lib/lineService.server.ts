/**
 * fork: one line on a work order, added, changed or removed on its own (docs/fork/API.md §4,
 * `/work-orders/{id}/lines`). The app saves its lines as a whole list from the form; the API changes one at a time,
 * with the fork's columns the form doesn't have (job, kind, technician, completion, cost, discount, note).
 *
 * Every change is the app's own arithmetic and bookkeeping: a locked invoice refuses it, a part goes through
 * `addPart` (stock movements, totals) and the stock alerts follow (`onInventoryChanged`), a changed or removed
 * inventory part's stock is reconciled the way the work order save does it, and the work order is re-totalled.
 */
import 'server-only'
import { onInventoryChanged } from '@/features/inventory/Lib/onInventoryChanged'
import { assertOwnInventoryParts } from './ownInventoryParts.server'
import { reconcileInventoryForParts } from '@/features/inventory/Lib/reconcileStock'
import { loadTaxApplies } from '@/features/settings/Lib/loadTaxApplies'
import { addPart } from '@/features/vehicles/Lib/addPart'
import { retotalServiceRecord } from '@/features/vehicles/Lib/retotalServiceRecord'
import type { AuditEvent } from '@/lib/audit'
import { db } from '@/lib/db'
import { assertInvoiceEditable } from '@/lib/document-lock.server'
import { roundMoney } from '@/lib/money'
import { parseSentFields } from '@/lib/parse-sent-fields'
import type { ServiceCtx } from '@/lib/service-context'
import {
  createLineSchema,
  isLabor,
  type LaborInput,
  type PartInput,
  updateLineSchema,
} from '../Schema/lineSchemas'

export interface LineResult {
  id: string
  serviceRecordId: string
  invoiceNumber: string | null
}

/** The work order's own audit event: a line changed is the work order changed, as when the app saves it. */
export function lineChangedEvent(result: LineResult): AuditEvent {
  return {
    action: 'service.update',
    entity: 'ServiceRecord',
    entityId: result.serviceRecordId,
    details: {
      key: 'service_update',
      params: { ref: result.invoiceNumber || result.serviceRecordId },
    },
    metadata: { serviceRecordId: result.serviceRecordId, lineId: result.id },
  }
}

async function ownWorkOrder(ctx: ServiceCtx, workOrderId: string) {
  const record = await db.serviceRecord.findFirst({
    where: { id: workOrderId, organizationId: ctx.organizationId },
    select: { id: true, invoiceNumber: true, title: true },
  })
  if (!record) throw new Error('Work order not found')
  await assertInvoiceEditable(record.id, ctx.organizationId)
  return record
}

async function checkReferences(
  ctx: ServiceCtx,
  serviceRecordId: string,
  refs: { jobId?: string | null; technicianId?: string | null; inventoryPartId?: string | null }
) {
  await assertOwnInventoryParts([{ inventoryPartId: refs.inventoryPartId }], ctx.organizationId)
  if (refs.jobId) {
    const job = await db.workJob.count({
      where: { id: refs.jobId, serviceRecordId, organizationId: ctx.organizationId },
    })
    if (!job) throw new Error('Job not found')
  }
  if (refs.technicianId) {
    const technician = await db.technician.count({
      where: { id: refs.technicianId, organizationId: ctx.organizationId },
    })
    if (!technician) throw new Error('Technician not found')
  }
}

/** The fields only one kind of line has. */
const LABOR_ONLY = [
  'hours',
  'rate',
  'pricingType',
  'technicianId',
  'completed',
  'costHours',
  'costRate',
]
const PART_ONLY = ['partNumber', 'quantity', 'unit', 'category', 'unitPrice', 'unitCost', 'note']

const lineTotal = (amount: number, discount: number | null | undefined) =>
  roundMoney(Math.max(0, amount - (discount ?? 0)))

export async function createLineService(
  ctx: ServiceCtx,
  workOrderId: string,
  input: unknown
): Promise<LineResult> {
  const parsed = createLineSchema.parse(input) as LaborInput | PartInput
  const record = await ownWorkOrder(ctx, workOrderId)
  await checkReferences(ctx, record.id, {
    jobId: parsed.jobId,
    technicianId: isLabor(parsed) ? parsed.technicianId : null,
    inventoryPartId: isLabor(parsed) ? null : parsed.inventoryPartId,
  })
  const result = (id: string) => ({
    id,
    serviceRecordId: record.id,
    invoiceNumber: record.invoiceNumber,
  })

  if (isLabor(parsed)) {
    const data = parsed
    // A fee, EPA or shop supplies line is the amount sent: `shopFee` would make it the workshop's own shop fee, which
    // the re-total prices again from the settings. Sent explicitly, it is.
    const pricingType = data.pricingType ?? (data.kind === 'labor' ? 'hourly' : 'service')
    const applies = await loadTaxApplies(ctx.organizationId)
    const line = await db.serviceLabor.create({
      data: {
        serviceRecordId: record.id,
        description: data.description,
        hours: data.hours,
        rate: data.rate,
        total: lineTotal(data.hours * data.rate, data.discountAmount),
        pricingType,
        taxable: data.taxable ?? (data.kind === 'labor' ? applies.labor : applies.shopFee),
        jobId: data.jobId ?? null,
        lineKind: data.kind,
        technicianId: data.technicianId ?? null,
        completed: data.completed ?? null,
        costHours: data.costHours ?? null,
        costRate: data.costRate ?? null,
        discountAmount: data.discountAmount ?? null,
      },
      select: { id: true },
    })
    await retotalServiceRecord(record.id)
    return result(line.id)
  }

  // A part: the app's own path, stock movements included; then the fork's columns on the line it made.
  const data = parsed
  const { part } = await addPart({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    input: {
      serviceRecordId: record.id,
      partNumber: data.partNumber ?? null,
      name: data.description,
      quantity: data.quantity,
      unit: data.unit ?? null,
      category: data.category ?? null,
      unitPrice: data.unitPrice,
      total: lineTotal(data.quantity * data.unitPrice, data.discountAmount),
      unitCost: data.unitCost ?? 0,
      inventoryPartId: data.inventoryPartId ?? null,
      ...(data.taxable !== undefined ? { taxable: data.taxable } : {}),
    },
  })
  await db.servicePart.updateMany({
    where: { id: part.id, serviceRecordId: record.id },
    data: {
      jobId: data.jobId ?? null,
      lineKind: data.kind,
      discountAmount: data.discountAmount ?? null,
      note: data.note ?? null,
    },
  })
  if (data.inventoryPartId) await onInventoryChanged(ctx.organizationId)
  return result(part.id)
}

export async function updateLineService(
  ctx: ServiceCtx,
  workOrderId: string,
  lineId: string,
  input: unknown
): Promise<LineResult> {
  const data = parseSentFields(updateLineSchema, input)
  const record = await ownWorkOrder(ctx, workOrderId)
  await checkReferences(ctx, record.id, { jobId: data.jobId, technicianId: data.technicianId })
  const result = { id: lineId, serviceRecordId: record.id, invoiceNumber: record.invoiceNumber }

  const labor = await db.serviceLabor.findFirst({
    where: { id: lineId, serviceRecordId: record.id },
    select: { hours: true, rate: true, discountAmount: true },
  })
  const part = labor
    ? null
    : await db.servicePart.findFirst({
        where: { id: lineId, serviceRecordId: record.id },
        select: { quantity: true, unitPrice: true, discountAmount: true, inventoryPartId: true },
      })
  if (!labor && !part) throw new Error('Line not found')
  // A field the line's kind doesn't have is refused, not ignored: the client would think it changed.
  const foreign = (labor ? PART_ONLY : LABOR_ONLY).filter((key) => key in data)
  if (foreign.length) {
    throw new Error(`A ${labor ? 'labor' : 'part'} line has no ${foreign.join(', ')}`)
  }
  if (labor) {
    const hours = data.hours ?? labor.hours
    const rate = data.rate ?? labor.rate
    const discount = data.discountAmount !== undefined ? data.discountAmount : labor.discountAmount
    await db.serviceLabor.updateMany({
      where: { id: lineId, serviceRecordId: record.id },
      data: {
        ...(data.description !== undefined ? { description: data.description } : {}),
        hours,
        rate,
        total: lineTotal(hours * rate, discount),
        ...(data.pricingType !== undefined ? { pricingType: data.pricingType } : {}),
        ...(data.taxable !== undefined ? { taxable: data.taxable } : {}),
        ...(data.jobId !== undefined ? { jobId: data.jobId } : {}),
        ...(data.technicianId !== undefined ? { technicianId: data.technicianId } : {}),
        ...(data.completed !== undefined ? { completed: data.completed } : {}),
        ...(data.costHours !== undefined ? { costHours: data.costHours } : {}),
        ...(data.costRate !== undefined ? { costRate: data.costRate } : {}),
        discountAmount: discount,
      },
    })
    await retotalServiceRecord(record.id)
    return result
  }

  if (!part) throw new Error('Line not found')
  const quantity = data.quantity ?? part.quantity
  const unitPrice = data.unitPrice ?? part.unitPrice
  const discount = data.discountAmount !== undefined ? data.discountAmount : part.discountAmount
  await db.$transaction(async (tx) => {
    const previous = await tx.servicePart.findMany({
      where: { serviceRecordId: record.id },
      select: { id: true, inventoryPartId: true, quantity: true },
    })
    await tx.servicePart.updateMany({
      where: { id: lineId, serviceRecordId: record.id },
      data: {
        ...(data.description !== undefined ? { name: data.description } : {}),
        ...(data.partNumber !== undefined ? { partNumber: data.partNumber } : {}),
        quantity,
        unitPrice,
        total: lineTotal(quantity * unitPrice, discount),
        ...(data.unit !== undefined ? { unit: data.unit } : {}),
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.unitCost !== undefined ? { unitCost: data.unitCost } : {}),
        ...(data.taxable !== undefined ? { taxable: data.taxable } : {}),
        ...(data.jobId !== undefined ? { jobId: data.jobId } : {}),
        ...(data.note !== undefined ? { note: data.note } : {}),
        discountAmount: discount,
      },
    })
    if (part.inventoryPartId && quantity !== part.quantity) {
      const next = previous.map((p) => (p.id === lineId ? { ...p, quantity } : p))
      await reconcileInventoryForParts(tx, ctx.organizationId, previous, next, {
        reason: 'service_record',
        userId: ctx.userId,
        serviceRecordId: record.id,
        serviceRecordLabel: record.invoiceNumber || record.title,
      })
    }
    await retotalServiceRecord(record.id, tx)
  })
  if (part.inventoryPartId && quantity !== part.quantity)
    await onInventoryChanged(ctx.organizationId)
  return result
}

export async function deleteLineService(
  ctx: ServiceCtx,
  workOrderId: string,
  lineId: string
): Promise<LineResult> {
  const record = await ownWorkOrder(ctx, workOrderId)
  const result = { id: lineId, serviceRecordId: record.id, invoiceNumber: record.invoiceNumber }
  const tombstone = (tx: Pick<typeof db, 'deletedRecord'>) =>
    tx.deletedRecord.create({
      data: {
        organizationId: ctx.organizationId,
        entityType: 'work_order_line',
        entityId: lineId,
        actorUserId: ctx.userId,
      },
    })
  const labor = await db.$transaction(async (tx) => {
    const gone = await tx.serviceLabor.deleteMany({
      where: { id: lineId, serviceRecordId: record.id },
    })
    if (gone.count) await tombstone(tx)
    return gone
  })
  if (labor.count) {
    await retotalServiceRecord(record.id)
    return result
  }
  let restocked = false
  await db.$transaction(async (tx) => {
    const previous = await tx.servicePart.findMany({
      where: { serviceRecordId: record.id },
      select: { id: true, inventoryPartId: true, quantity: true },
    })
    const removed = previous.find((p) => p.id === lineId)
    if (!removed) throw new Error('Line not found')
    await tx.servicePart.deleteMany({ where: { id: lineId, serviceRecordId: record.id } })
    await tombstone(tx)
    if (removed.inventoryPartId) {
      // The part goes back on the shelf, as when the line is removed in the app.
      await reconcileInventoryForParts(
        tx,
        ctx.organizationId,
        previous,
        previous.filter((p) => p.id !== lineId),
        {
          reason: 'service_record',
          userId: ctx.userId,
          serviceRecordId: record.id,
          serviceRecordLabel: record.invoiceNumber || record.title,
        }
      )
      restocked = true
    }
    await retotalServiceRecord(record.id, tx)
  })
  if (restocked) await onInventoryChanged(ctx.organizationId)
  return result
}
