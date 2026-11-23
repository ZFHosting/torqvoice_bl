/**
 * fork: writing the fork's own records (docs/fork/milestones/A4-write-endpoints.md, "New services"): a customer's
 * other emails and phones (X4), a work order's jobs (X2), a technician's shifts (X6). Like A2's services: scoped to
 * the workshop on every query, lookups by id included (an id the workshop doesn't own is "… not found"); the
 * caller checks permissions and records the audit event; a delete leaves a tombstone for API sync.
 */
import 'server-only'
import { db } from '@/lib/db'
import { assertInvoiceEditable } from '@/lib/document-lock.server'
import { parseSentFields } from '@/lib/parse-sent-fields'
import type { ServiceCtx } from '@/lib/service-context'
import {
  createContactSchema,
  createJobSchema,
  createShiftSchema,
  updateContactSchema,
  updateJobSchema,
  updateShiftSchema,
} from '../Schema/forkRecordSchemas'

async function tombstone(ctx: ServiceCtx, entityType: string, entityId: string) {
  await db.deletedRecord.create({
    data: {
      organizationId: ctx.organizationId,
      entityType,
      entityId,
      actorUserId: ctx.userId,
    },
  })
}

/* ---------- customer contacts (X4) ---------- */

async function ownCustomer(ctx: ServiceCtx, customerId: string) {
  const customer = await db.customer.findFirst({
    where: { id: customerId, organizationId: ctx.organizationId },
    select: { id: true },
  })
  if (!customer) throw new Error('Customer not found')
  return customer.id
}

export async function createContactService(ctx: ServiceCtx, customerId: string, input: unknown) {
  const data = createContactSchema.parse(input)
  const owner = await ownCustomer(ctx, customerId)
  return db.customerContact.create({
    data: {
      organizationId: ctx.organizationId,
      customerId: owner,
      kind: data.kind,
      value: data.value,
      label: data.label ?? null,
      isPrimary: data.isPrimary ?? false,
      marketingOptIn: data.marketingOptIn ?? null,
      subscribed: data.subscribed ?? null,
    },
    select: { id: true, customerId: true },
  })
}

export async function updateContactService(
  ctx: ServiceCtx,
  customerId: string,
  contactId: string,
  input: unknown
) {
  const data = parseSentFields(updateContactSchema, input)
  const { count } = await db.customerContact.updateMany({
    where: { id: contactId, customerId, organizationId: ctx.organizationId },
    data,
  })
  if (count === 0) throw new Error('Contact not found')
  return { id: contactId, customerId }
}

export async function deleteContactService(ctx: ServiceCtx, customerId: string, contactId: string) {
  const { count } = await db.customerContact.deleteMany({
    where: { id: contactId, customerId, organizationId: ctx.organizationId },
  })
  if (count === 0) throw new Error('Contact not found')
  await tombstone(ctx, 'customer_contact', contactId)
  return { id: contactId, customerId }
}

/* ---------- work order jobs (X2) ---------- */

async function ownWorkOrder(ctx: ServiceCtx, workOrderId: string) {
  const record = await db.serviceRecord.findFirst({
    where: { id: workOrderId, organizationId: ctx.organizationId },
    select: { id: true },
  })
  if (!record) throw new Error('Work order not found')
  // An issued invoice's jobs are part of what it printed: locked like its lines.
  await assertInvoiceEditable(record.id, ctx.organizationId)
  return record.id
}

function jobData(data: Partial<ReturnType<typeof createJobSchema.parse>>) {
  return {
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.note !== undefined ? { note: data.note } : {}),
    ...(data.ordinal !== undefined ? { ordinal: data.ordinal } : {}),
    ...(data.authorizationStatus !== undefined
      ? { authorizationStatus: data.authorizationStatus }
      : {}),
    ...(data.recommended !== undefined ? { recommended: data.recommended } : {}),
    ...(data.hidden !== undefined ? { hidden: data.hidden } : {}),
    ...(data.lumpSum !== undefined ? { lumpSum: data.lumpSum } : {}),
    ...(data.fixedPrice !== undefined ? { fixedPrice: data.fixedPrice } : {}),
    ...(data.deferredDate !== undefined
      ? { deferredDate: data.deferredDate ? new Date(data.deferredDate) : null }
      : {}),
    ...(data.deferredReason !== undefined ? { deferredReason: data.deferredReason } : {}),
  }
}

export async function createJobService(ctx: ServiceCtx, workOrderId: string, input: unknown) {
  const data = createJobSchema.parse(input)
  const serviceRecordId = await ownWorkOrder(ctx, workOrderId)
  const last = await db.workJob.findFirst({
    where: { serviceRecordId, organizationId: ctx.organizationId },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  })
  return db.workJob.create({
    data: {
      organizationId: ctx.organizationId,
      serviceRecordId,
      name: data.name,
      ordinal: data.ordinal ?? (last ? last.ordinal + 1 : 0),
      ...jobData({ ...data, ordinal: undefined, name: undefined }),
    },
    select: { id: true, serviceRecordId: true },
  })
}

export async function updateJobService(
  ctx: ServiceCtx,
  workOrderId: string,
  jobId: string,
  input: unknown
) {
  const data = parseSentFields(updateJobSchema, input)
  const serviceRecordId = await ownWorkOrder(ctx, workOrderId)
  const { count } = await db.workJob.updateMany({
    where: { id: jobId, serviceRecordId, organizationId: ctx.organizationId },
    data: jobData(data),
  })
  if (count === 0) throw new Error('Job not found')
  return { id: jobId, serviceRecordId }
}

/** The job goes; its lines stay on the work order, ungrouped (the relation is SetNull). */
export async function deleteJobService(ctx: ServiceCtx, workOrderId: string, jobId: string) {
  const serviceRecordId = await ownWorkOrder(ctx, workOrderId)
  const { count } = await db.workJob.deleteMany({
    where: { id: jobId, serviceRecordId, organizationId: ctx.organizationId },
  })
  if (count === 0) throw new Error('Job not found')
  await tombstone(ctx, 'work_job', jobId)
  return { id: jobId, serviceRecordId }
}

/* ---------- technician shifts (X6) ---------- */

async function ownTechnician(ctx: ServiceCtx, technicianId: string) {
  const technician = await db.technician.findFirst({
    where: { id: technicianId, organizationId: ctx.organizationId },
    select: { id: true },
  })
  if (!technician) throw new Error('Technician not found')
  return technician.id
}

function minutesBetween(start: Date, end: Date | null): number | null {
  if (!end) return null
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))
}

export async function createShiftService(ctx: ServiceCtx, input: unknown) {
  const data = createShiftSchema.parse(input)
  const technicianId = await ownTechnician(ctx, data.technicianId)
  const clockIn = new Date(data.clockIn)
  const clockOut = data.clockOut ? new Date(data.clockOut) : null
  if (clockOut && clockOut < clockIn) throw new Error('A shift can’t end before it starts')
  return db.technicianShift.create({
    data: {
      organizationId: ctx.organizationId,
      technicianId,
      clockIn,
      clockOut,
      durationMinutes: minutesBetween(clockIn, clockOut),
      note: data.note ?? null,
      source: 'api',
    },
    select: { id: true, technicianId: true },
  })
}

export async function updateShiftService(ctx: ServiceCtx, shiftId: string, input: unknown) {
  const data = parseSentFields(updateShiftSchema, input)
  const shift = await db.technicianShift.findFirst({
    where: { id: shiftId, organizationId: ctx.organizationId },
    select: { id: true, technicianId: true, clockIn: true, clockOut: true },
  })
  if (!shift) throw new Error('Shift not found')
  const technicianId =
    data.technicianId !== undefined
      ? await ownTechnician(ctx, data.technicianId)
      : shift.technicianId
  const clockIn = data.clockIn !== undefined ? new Date(data.clockIn) : shift.clockIn
  const clockOut =
    data.clockOut !== undefined ? (data.clockOut ? new Date(data.clockOut) : null) : shift.clockOut
  if (clockOut && clockOut < clockIn) throw new Error('A shift can’t end before it starts')
  await db.technicianShift.updateMany({
    where: { id: shift.id, organizationId: ctx.organizationId },
    data: {
      technicianId,
      clockIn,
      clockOut,
      durationMinutes: minutesBetween(clockIn, clockOut),
      ...(data.note !== undefined ? { note: data.note } : {}),
    },
  })
  return { id: shift.id, technicianId }
}

export async function deleteShiftService(ctx: ServiceCtx, shiftId: string) {
  const shift = await db.technicianShift.findFirst({
    where: { id: shiftId, organizationId: ctx.organizationId },
    select: { id: true, technicianId: true },
  })
  if (!shift) throw new Error('Shift not found')
  await db.technicianShift.deleteMany({
    where: { id: shift.id, organizationId: ctx.organizationId },
  })
  await tombstone(ctx, 'technician_shift', shift.id)
  return shift
}
