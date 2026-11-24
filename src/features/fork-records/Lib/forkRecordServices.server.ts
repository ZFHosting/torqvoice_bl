/**
 * fork: writing the fork's own records (docs/fork/milestones/A4-write-endpoints.md, "New services"): a customer's
 * other emails and phones (X4), a work order's jobs (X2), a technician's shifts (X6). Like A2's services: scoped to
 * the workshop on every query, lookups by id included (an id the workshop doesn't own is "… not found"); the
 * caller checks permissions and records the audit event; a delete leaves a tombstone for API sync.
 */
import 'server-only'
import { ZodError, z } from 'zod'
import { db, type TxClient } from '@/lib/db'
import { assertInvoiceEditable, assertQuoteEditable } from '@/lib/document-lock.server'
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
import type { JobParent } from '../Schema/workJobActionSchemas'

/** A delete and its tombstone, in one transaction: a sync never misses a delete, nor hears of one that didn't happen. */
async function removeWithTombstone(
  ctx: ServiceCtx,
  entityType: string,
  entityId: string,
  remove: (tx: TxClient) => Promise<{ count: number }>,
  notFound: string
) {
  await db.$transaction(async (tx) => {
    const { count } = await remove(tx)
    if (count === 0) throw new Error(notFound)
    await tx.deletedRecord.create({
      data: { organizationId: ctx.organizationId, entityType, entityId, actorUserId: ctx.userId },
    })
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
  // An email stays an email: checked against the kind it will have, sent or stored.
  if (data.kind !== undefined || data.value !== undefined) {
    const own = await db.customerContact.findFirst({
      where: { id: contactId, customerId, organizationId: ctx.organizationId },
      select: { kind: true, value: true },
    })
    if (!own) throw new Error('Contact not found')
    const kind = data.kind ?? own.kind
    const value = data.value ?? own.value
    if (kind === 'email' && !z.email().safeParse(value).success) {
      throw new ZodError([
        { code: 'custom', path: ['value'], message: 'Invalid email', input: value },
      ])
    }
  }
  const { count } = await db.customerContact.updateMany({
    where: { id: contactId, customerId, organizationId: ctx.organizationId },
    data,
  })
  if (count === 0) throw new Error('Contact not found')
  return { id: contactId, customerId }
}

export async function deleteContactService(ctx: ServiceCtx, customerId: string, contactId: string) {
  await removeWithTombstone(
    ctx,
    'customer_contact',
    contactId,
    (tx) =>
      tx.customerContact.deleteMany({
        where: { id: contactId, customerId, organizationId: ctx.organizationId },
      }),
    'Contact not found'
  )
  return { id: contactId, customerId }
}

/* ---------- jobs on a work order or a quote (X2) ---------- */

/** What a job belongs to: a work order (the API's `/work-orders/{id}/jobs`, the work order page) or a quote (M9). */
export type { JobParent }

type JobOwner =
  | { serviceRecordId: string; quoteId: null }
  | { serviceRecordId: null; quoteId: string }

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

/** The work order or quote, this workshop's and open to edits, that a job belongs to. */
async function ownJobParent(ctx: ServiceCtx, parent: JobParent): Promise<JobOwner> {
  if (parent.kind === 'workOrder') {
    return { serviceRecordId: await ownWorkOrder(ctx, parent.id), quoteId: null }
  }
  const quote = await db.quote.findFirst({
    where: { id: parent.id, organizationId: ctx.organizationId },
    select: { id: true },
  })
  if (!quote) throw new Error('Quote not found')
  // A quote sent to the customer is locked like its lines.
  await assertQuoteEditable(quote.id, ctx.organizationId)
  return { serviceRecordId: null, quoteId: quote.id }
}

const ofOwner = (owner: JobOwner) =>
  owner.serviceRecordId ? { serviceRecordId: owner.serviceRecordId } : { quoteId: owner.quoteId }

const JOB_REF = { id: true, serviceRecordId: true, quoteId: true } as const

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

/** A new job, last in its document unless the input places it. */
export async function createJobOn(ctx: ServiceCtx, parent: JobParent, input: unknown) {
  const data = createJobSchema.parse(input)
  const owner = await ownJobParent(ctx, parent)
  const last = await db.workJob.findFirst({
    where: { ...ofOwner(owner), organizationId: ctx.organizationId },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  })
  return db.workJob.create({
    data: {
      organizationId: ctx.organizationId,
      ...ofOwner(owner),
      name: data.name,
      ordinal: data.ordinal ?? (last ? last.ordinal + 1 : 0),
      ...jobData({ ...data, ordinal: undefined, name: undefined }),
    },
    select: JOB_REF,
  })
}

export async function updateJobOn(
  ctx: ServiceCtx,
  parent: JobParent,
  jobId: string,
  input: unknown
) {
  const data = parseSentFields(updateJobSchema, input)
  const owner = await ownJobParent(ctx, parent)
  const { count } = await db.workJob.updateMany({
    where: { id: jobId, ...ofOwner(owner), organizationId: ctx.organizationId },
    data: jobData(data),
  })
  if (count === 0) throw new Error('Job not found')
  return { id: jobId, ...owner }
}

/** The job goes; its lines stay on the document, ungrouped (the relation is SetNull). */
export async function deleteJobOn(ctx: ServiceCtx, parent: JobParent, jobId: string) {
  const owner = await ownJobParent(ctx, parent)
  await removeWithTombstone(
    ctx,
    'work_job',
    jobId,
    (tx) =>
      tx.workJob.deleteMany({
        where: { id: jobId, ...ofOwner(owner), organizationId: ctx.organizationId },
      }),
    'Job not found'
  )
  return { id: jobId, ...owner }
}

/**
 * The document's jobs in this order (M9): `jobIds` must name every one of its jobs, once. Only the jobs whose place
 * changed are written, and returned, so each is one `job.update`, as a PATCH of its `ordinal` through the API is.
 */
export async function reorderJobsOn(ctx: ServiceCtx, parent: JobParent, jobIds: string[]) {
  const owner = await ownJobParent(ctx, parent)
  const jobs = await db.workJob.findMany({
    where: { ...ofOwner(owner), organizationId: ctx.organizationId },
    select: { id: true, ordinal: true },
  })
  const known = new Set(jobs.map((job) => job.id))
  if (jobIds.length !== jobs.length || new Set(jobIds).size !== jobIds.length) {
    throw new Error('The jobs have changed: reload and try again')
  }
  if (jobIds.some((id) => !known.has(id))) throw new Error('Job not found')
  const was = new Map(jobs.map((job) => [job.id, job.ordinal]))
  const moved = jobIds.flatMap((id, ordinal) => (was.get(id) === ordinal ? [] : [{ id, ordinal }]))
  await db.$transaction(
    moved.map(({ id, ordinal }) =>
      db.workJob.updateMany({
        where: { id, ...ofOwner(owner), organizationId: ctx.organizationId },
        data: { ordinal },
      })
    )
  )
  return moved.map(({ id }) => ({ id, ...owner }))
}

/**
 * The document's jobs in order, for its screen (M9), and whether the workshop uses jobs at all (has any): a workshop
 * that has none sees no jobs on its screens. Reading needs no lock: a locked document shows its jobs.
 */
export async function jobsOf(ctx: ServiceCtx, parent: JobParent) {
  const where =
    parent.kind === 'workOrder'
      ? { serviceRecordId: parent.id, serviceRecord: { organizationId: ctx.organizationId } }
      : { quoteId: parent.id, quote: { organizationId: ctx.organizationId } }
  const jobs = await db.workJob.findMany({
    where: { ...where, organizationId: ctx.organizationId },
    orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, note: true, authorizationStatus: true },
  })
  const usesJobs =
    jobs.length > 0 ||
    (await db.workJob.findFirst({
      where: { organizationId: ctx.organizationId },
      select: { id: true },
    })) !== null
  return { usesJobs, jobs }
}

export const createJobService = (ctx: ServiceCtx, workOrderId: string, input: unknown) =>
  createJobOn(ctx, { kind: 'workOrder', id: workOrderId }, input)

export const updateJobService = (
  ctx: ServiceCtx,
  workOrderId: string,
  jobId: string,
  input: unknown
) => updateJobOn(ctx, { kind: 'workOrder', id: workOrderId }, jobId, input)

export const deleteJobService = (ctx: ServiceCtx, workOrderId: string, jobId: string) =>
  deleteJobOn(ctx, { kind: 'workOrder', id: workOrderId }, jobId)

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
  await removeWithTombstone(
    ctx,
    'technician_shift',
    shift.id,
    (tx) =>
      tx.technicianShift.deleteMany({
        where: { id: shift.id, organizationId: ctx.organizationId },
      }),
    'Shift not found'
  )
  return shift
}
