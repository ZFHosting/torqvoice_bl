'use server'

import { copyQuoteEquipmentToJob } from '@/features/equipment/Lib/equipmentWorkOn.server'
import {
  gateCustomerReference,
  isCustomerReferenceEnabled,
} from '@/features/customer-reference/Lib/referenceSetting'
import { ATTENTION_STATUSES } from '@/features/quotes/Lib/quoteStatus'
import { assertInvoiceEditable, getDocumentLockSettings } from '@/lib/document-lock.server'
import { invoiceLockState } from '@/lib/document-lock'
import { OPEN_SERVICE_STATUSES } from '@/lib/service-record'
import { discountAmountFor } from '@/lib/tax'
import { db } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'
import { taxComponentsForCopy } from '@/features/settings/Lib/workshopTax'
import { isShopFeeLine } from '@/features/settings/Lib/shopFee'
import { retotalServiceRecord } from '@/features/vehicles/Lib/retotalServiceRecord'
import { warrantyExpiryFor } from '@/features/settings/Lib/warrantyDefaults'
import { normalizeWarranty } from '@/lib/warranty'
import { withAuth } from '@/lib/with-auth'
import {
  copyQuoteAttachmentsToJob,
  copyQuoteLaborToJob,
  copyQuotePartsToJob,
} from '../Lib/copyQuoteToJob'
import {
  type ConversionConflict,
  conversionConflicts,
  resolutionsSchema,
  unresolvedConflicts,
} from '../Lib/conversionConflicts'
import { revalidatePath } from 'next/cache'
import { onInventoryChanged } from '@/features/inventory/Lib/onInventoryChanged'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { gateTypeKey, isTypeKeyEnabled } from '@/features/vehicles/Lib/typeKeySetting'
// fork: the write bodies and their audit events live beside the quote service (A2)
import {
  convertQuoteToServiceRecordEvent,
  createQuoteEvent,
  deleteQuoteEvent,
  updateQuoteEvent,
  updateQuoteStatusEvent,
} from '../Lib/quoteAuditEvents'
import {
  convertQuoteToServiceRecordService,
  createQuoteService,
  deleteQuoteService,
  updateQuoteService,
  updateQuoteStatusService,
} from '../Lib/quoteService.server'

/**
 * Default valid-until for new quotes: today plus workshop.quoteValidDays
 * (30 when unset). An explicit 0 or negative disables the prefill.
 */
export async function getQuotesPaginated(params: {
  page?: number
  pageSize?: number
  search?: string
  status?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 20
      const skip = (page - 1) * pageSize

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { organizationId }

      if (params.status === 'attention') {
        where.status = { in: ATTENTION_STATUSES }
      } else if (params.status && params.status !== 'all') {
        where.status = params.status
      }

      // The customer's reference / PO, for a workshop that uses the field.
      const referenceOn = await isCustomerReferenceEnabled(organizationId)
      if (params.search) {
        where.OR = [
          { title: { contains: params.search, mode: 'insensitive' } },
          { quoteNumber: { contains: params.search, mode: 'insensitive' } },
          { customer: { name: { contains: params.search, mode: 'insensitive' } } },
          ...(referenceOn
            ? [{ customerReference: { contains: params.search, mode: 'insensitive' } }]
            : []),
        ]
      }

      const [records, total, statusCounts] = await Promise.all([
        db.quote.findMany({
          where,
          include: {
            customer: { select: { id: true, name: true } },
            vehicle: {
              select: { id: true, make: true, model: true, year: true, licensePlate: true },
            },
          },
          orderBy: (() => {
            const dir = params.sortOrder || 'desc'
            switch (params.sortBy) {
              case 'quoteNumber':
                return { quoteNumber: { sort: dir, nulls: 'last' as const } }
              case 'title':
                return { title: dir }
              case 'customer':
                return { customer: { name: dir } }
              // Column shows "year make model"; sort make, model, year so
              // identical models group together
              case 'vehicle':
                return [
                  { vehicle: { make: dir } },
                  { vehicle: { model: dir } },
                  { vehicle: { year: dir } },
                ]
              case 'status':
                return { status: dir }
              case 'totalAmount':
                return { totalAmount: dir }
              case 'createdAt':
                return { createdAt: dir }
              default:
                return { createdAt: 'desc' as const }
            }
          })(),
          skip,
          take: pageSize,
        }),
        db.quote.count({ where }),
        db.quote.groupBy({
          by: ['status'],
          where: { organizationId },
          _count: true,
        }),
      ])

      const counts: Record<string, number> = {}
      for (const g of statusCounts) {
        counts[g.status] = g._count
      }
      counts.attention = ATTENTION_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0)

      return {
        records: records.map((record) => gateCustomerReference(record, referenceOn)),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        statusCounts: counts,
      }
    },
    { requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.QUOTES }] }
  )
}

export async function getVehicleQuotes(vehicleId: string) {
  return withAuth(
    async ({ organizationId }) => {
      return db.quote.findMany({
        where: { vehicleId, organizationId },
        select: {
          id: true,
          quoteNumber: true,
          title: true,
          status: true,
          totalAmount: true,
          createdAt: true,
          validUntil: true,
          customer: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
    },
    { requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.QUOTES }] }
  )
}

export async function getQuote(quoteId: string) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const quote = await db.quote.findFirst({
        where: { id: quoteId, organizationId },
        include: {
          partItems: { orderBy: { sortOrder: 'asc' } },
          laborItems: { orderBy: { sortOrder: 'asc' } },
          attachments: true,
          customer: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              address: true,
              company: true,
            },
          },
          vehicle: {
            select: {
              id: true,
              make: true,
              model: true,
              year: true,
              vin: true,
              licensePlate: true,
              hsn: true,
              tsn: true,
              mileage: true,
            },
          },
          inspection: {
            select: { id: true },
          },
        },
      })
      // Missing or foreign-org quote yields null rather than an error: the page
      // renders its not-found state, and this also runs during the post-delete
      // re-render of the quote route.
      if (!quote) return quote
      const shown = gateCustomerReference(quote, await isCustomerReferenceEnabled(organizationId))
      if (!shown.vehicle) return shown
      const enabled = await isTypeKeyEnabled(organizationId)
      return { ...shown, vehicle: gateTypeKey(shown.vehicle, enabled) }
    },
    { requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.QUOTES }] }
  )
}

export async function createQuote(input: unknown) {
  return withAuth(
    // fork: the body is createQuoteService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createQuoteService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [{ action: PermissionAction.CREATE, subject: PermissionSubject.QUOTES }],
      audit: ({ result }) => createQuoteEvent(result),
    }
  )
}

export async function updateQuote(input: unknown) {
  return withAuth(
    // fork: the body is updateQuoteService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateQuoteService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [{ action: PermissionAction.UPDATE, subject: PermissionSubject.QUOTES }],
      audit: ({ result }) => updateQuoteEvent(result),
    }
  )
}

export async function updateQuoteStatus(quoteId: string, status: string) {
  return withAuth(
    // fork: the body is updateQuoteStatusService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateQuoteStatusService({ organizationId, userId, actor: 'user' }, quoteId, status),
    {
      requiredPermissions: [{ action: PermissionAction.UPDATE, subject: PermissionSubject.QUOTES }],
      audit: ({ result }) => updateQuoteStatusEvent(result),
    }
  )
}

export async function deleteQuote(quoteId: string) {
  return withAuth(
    // fork: the body is deleteQuoteService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteQuoteService({ organizationId, userId, actor: 'user' }, quoteId),
    {
      requiredPermissions: [{ action: PermissionAction.DELETE, subject: PermissionSubject.QUOTES }],
      audit: ({ result }) => deleteQuoteEvent(result),
    }
  )
}

export async function convertQuoteToServiceRecord(quoteId: string, vehicleId: string) {
  return withAuth(
    // fork: the body is convertQuoteToServiceRecordService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      convertQuoteToServiceRecordService(
        { organizationId, userId, actor: 'user' },
        quoteId,
        vehicleId
      ),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.SERVICES },
      ],
      audit: ({ result }) => convertQuoteToServiceRecordEvent(result),
    }
  )
}

/**
 * The jobs a quote could be added to instead of raising a new one: the chosen
 * vehicle's open work orders that still take edits. Diagnostics usually come
 * first, so by the time the quote is accepted the car already has a job, and
 * a second one would split one visit across two invoices.
 */
export async function getWorkOrdersForQuoteConversion(vehicleId: string) {
  return withAuth(
    async ({ organizationId }) => {
      if (!vehicleId) return []
      const [records, lockSettings] = await Promise.all([
        db.serviceRecord.findMany({
          where: {
            organizationId,
            vehicleId,
            status: { in: [...OPEN_SERVICE_STATUSES] },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            title: true,
            invoiceNumber: true,
            status: true,
            serviceDate: true,
            sentAt: true,
            manuallyPaid: true,
            totalAmount: true,
            cost: true,
            editUnlockedAt: true,
            payments: { select: { amount: true } },
          },
        }),
        getDocumentLockSettings(organizationId),
      ])

      // A locked job would refuse the lines, so it is not offered.
      return records
        .filter((record) => !invoiceLockState(record, lockSettings).locked)
        .map((record) => ({
          id: record.id,
          title: record.title,
          invoiceNumber: record.invoiceNumber,
          status: record.status,
          serviceDate: record.serviceDate,
        }))
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SERVICES }],
    }
  )
}

const CONFLICT_QUOTE_SELECT = {
  discountAmount: true,
  taxRate: true,
  taxInclusive: true,
  taxComponents: true,
  warrantyStatus: true,
  warrantyMonths: true,
  warrantyMileage: true,
  warrantyNotes: true,
} as const

const CONFLICT_JOB_SELECT = {
  subtotal: true,
  discountType: true,
  discountValue: true,
  taxRate: true,
  taxInclusive: true,
  taxComponents: true,
  warrantyStatus: true,
  warrantyMonths: true,
  warrantyMileage: true,
  warrantyNotes: true,
} as const

/**
 * Where the quote and the chosen job disagree, for the dialog to ask about
 * before the quote is added: a discount that cannot be kept twice, a
 * different tax basis, a warranty the customer accepted that the job does
 * not state. Nothing is changed here.
 */
export async function getQuoteConversionConflicts(quoteId: string, serviceRecordId: string) {
  return withAuth(
    async ({ organizationId }): Promise<ConversionConflict[]> => {
      const [quote, job] = await Promise.all([
        db.quote.findFirst({
          where: { id: quoteId, organizationId },
          select: CONFLICT_QUOTE_SELECT,
        }),
        db.serviceRecord.findFirst({
          where: { id: serviceRecordId, organizationId },
          select: CONFLICT_JOB_SELECT,
        }),
      ])
      if (!quote) throw new Error('Quote not found')
      if (!job) throw new Error('Work order not found')
      return conversionConflicts(quote, job)
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.QUOTES },
        { action: PermissionAction.READ, subject: PermissionSubject.SERVICES },
      ],
    }
  )
}

/**
 * Puts an accepted quote onto a job that already exists, in place of raising
 * a new one. The quote's lines and files are added after the job's own, which
 * are left as they are, and the job is re-totalled.
 *
 * Where the two disagree on a standing answer (a percentage discount, the
 * tax basis, the warranty) the caller has to say which the job keeps; the
 * dialog asked, and an answer missing here means the job changed since it
 * did, so nothing is done. The job's title and shop fee were decided when it
 * was created and are not the quote's to change, nor is its Reference / PO:
 * a job without one takes the quote's, and one that has a different one keeps
 * it and the answer names both (`referenceKept`) for the page to say.
 */
export async function addQuoteToServiceRecord(
  quoteId: string,
  vehicleId: string,
  serviceRecordId: string,
  resolutions?: unknown
) {
  const parsedResolutions = resolutionsSchema.safeParse(resolutions ?? {})
  if (!parsedResolutions.success) return { success: false as const, error: 'Invalid choices' }
  const answers = parsedResolutions.data

  return withAuth(
    async ({ userId, organizationId }) => {
      const quote = await db.quote.findFirst({
        where: { id: quoteId, organizationId },
        include: {
          // Lines reach the job in the order the quote shows them.
          partItems: { orderBy: { sortOrder: 'asc' } },
          laborItems: { orderBy: { sortOrder: 'asc' } },
          attachments: true,
        },
      })
      if (!quote) throw new Error('Quote not found')
      // A second pass would put the same lines on the job twice.
      if (quote.status === 'converted') throw new Error('Quote is already converted')

      const vehicle = await db.vehicle.findFirst({
        where: { id: vehicleId, organizationId },
      })
      if (!vehicle) throw new Error('Vehicle not found')

      // Adds part and labor lines and retotals the job, so it is an edit to
      // what the invoice says it is owed and a locked one refuses it.
      await assertInvoiceEditable(serviceRecordId, organizationId)

      const record = await db.serviceRecord.findFirst({
        where: { id: serviceRecordId, organizationId },
        select: {
          id: true,
          title: true,
          invoiceNumber: true,
          vehicleId: true,
          status: true,
          inspectionId: true,
          tireSetId: true,
          serviceDate: true,
          customerReference: true,
          ...CONFLICT_JOB_SELECT,
        },
      })
      if (!record) throw new Error('Work order not found')
      if (record.vehicleId !== vehicleId) {
        throw new Error('That work order is for a different vehicle')
      }
      if (!(OPEN_SERVICE_STATUSES as readonly string[]).includes(record.status)) {
        throw new Error('That work order is no longer open')
      }

      // The job's own Reference / PO stands. One that differs from the
      // quote's is said in the answer, with both, so the quote's is not lost
      // without a word; only while the workshop uses the field.
      const jobReference = record.customerReference?.trim() || null
      const quoteReference = quote.customerReference?.trim() || null
      const referenceKept =
        jobReference &&
        quoteReference &&
        jobReference !== quoteReference &&
        (await isCustomerReferenceEnabled(organizationId))
          ? { job: jobReference, quote: quoteReference }
          : null

      // Every disagreement needs an answer. One the dialog never showed
      // means the job or the quote changed in the meantime; the dialog
      // reads them again rather than this guessing.
      const conflicts = conversionConflicts(quote, record)
      const unanswered = unresolvedConflicts(conflicts, answers)
      if (unanswered.length > 0) {
        throw new Error('The quote and the work order differ; choose what the work order keeps')
      }

      // Only a job with no inspection of its own takes the quote's, and only
      // when it is for the car that was inspected.
      const inspection =
        !record.inspectionId && quote.inspectionId
          ? await db.inspection.findFirst({
              where: { id: quote.inspectionId, organizationId, vehicleId },
              select: { id: true },
            })
          : null

      // The quote's discount was part of what the customer accepted, so it
      // comes across as the amount it came to: a percentage would start
      // applying to the lines the job already had. A job with a fixed
      // discount takes it on top; one with a percentage either keeps its
      // own and drops the quote's, or turns its percentage into the amount
      // it comes to as the job stands and adds the quote's, as answered.
      const jobDiscount =
        record.discountType === 'fixed' || record.discountType === 'percentage'
          ? record.discountType
          : 'none'
      let carriedDiscount: number | null = null
      if (quote.discountAmount > 0) {
        if (jobDiscount === 'percentage') {
          if (answers.discount === 'combine') {
            carriedDiscount =
              discountAmountFor(record.subtotal, 'percentage', record.discountValue) +
              quote.discountAmount
          }
        } else {
          carriedDiscount =
            (jobDiscount === 'fixed' ? record.discountValue : 0) + quote.discountAmount
        }
      }

      // The quote's tax basis and warranty, when the job is to take them.
      const taxFromQuote =
        answers.tax === 'useQuote'
          ? {
              taxRate: quote.taxRate,
              taxInclusive: quote.taxInclusive,
              taxComponents: taxComponentsForCopy(quote.taxComponents) ?? Prisma.DbNull,
            }
          : null
      let warrantyFromQuote: Record<string, unknown> | null = null
      if (answers.warranty === 'useQuote') {
        const warranty = normalizeWarranty(quote)
        const timeZone = await workshopTimeZone(organizationId)
        warrantyFromQuote = {
          ...warranty,
          warrantyExpiresAt: warrantyExpiryFor(warranty, record.serviceDate, timeZone),
        }
      }

      await db.$transaction(async (tx) => {
        // Marking it converted is what claims it: two clicks at once cannot
        // both put the lines on the job.
        const claimed = await tx.quote.updateMany({
          where: { id: quoteId, organizationId, status: { not: 'converted' } },
          data: { status: 'converted', convertedToId: record.id },
        })
        if (claimed.count === 0) throw new Error('Quote is already converted')

        await copyQuotePartsToJob(tx, {
          organizationId,
          userId,
          quote,
          partItems: quote.partItems,
          target: record,
        })

        // A job that already carries the shop fee does not get the quote's as
        // a second one; the re-total below prices the one it has. A job with
        // none takes the fee the customer accepted, and is not given the
        // workshop's default otherwise: that is applied when a job is created.
        const existingLabor = await tx.serviceLabor.findMany({
          where: { serviceRecordId: record.id },
          select: { pricingType: true },
        })
        const hasFee = existingLabor.some(isShopFeeLine)
        await copyQuoteLaborToJob(
          tx,
          record.id,
          quote.laborItems.filter((l) => !l.excluded && !(hasFee && isShopFeeLine(l)))
        )

        await copyQuoteAttachmentsToJob(tx, organizationId, record.id, quote.attachments)
        await copyQuoteEquipmentToJob(tx, {
          organizationId,
          quoteId: quote.id,
          jobId: record.id,
          vehicleId: record.vehicleId,
        })

        // Links the job did not have, and the answers to the conflicts. A
        // link it has is never rewritten.
        const changes = {
          ...(inspection ? { inspectionId: inspection.id } : {}),
          ...(!record.tireSetId && quote.tireSetId ? { tireSetId: quote.tireSetId } : {}),
          // The job's own reference / PO stands; one it lacks comes from the quote.
          ...(!record.customerReference && quote.customerReference
            ? { customerReference: quote.customerReference }
            : {}),
          ...(carriedDiscount !== null
            ? { discountType: 'fixed', discountValue: carriedDiscount }
            : {}),
          ...(taxFromQuote ?? {}),
          ...(warrantyFromQuote ?? {}),
        }
        if (Object.keys(changes).length > 0) {
          await tx.serviceRecord.update({ where: { id: record.id }, data: changes })
        }

        // Re-totalled from every line under whatever the job now carries:
        // the discount, the tax basis and the amounts are written together.
        await retotalServiceRecord(record.id, tx)
      })

      revalidatePath('/quotes')
      revalidatePath('/work-orders')
      revalidatePath(`/vehicles/${vehicleId}`)
      // Conversion consumed stock for any inventory-linked quote lines.
      await onInventoryChanged(organizationId)
      return {
        id: record.id,
        vehicleId,
        invoiceNumber: record.invoiceNumber,
        convertedFromQuoteId: quoteId,
        quoteRef: quote.quoteNumber ?? quoteId,
        /** Both references, when the job kept its own over a different one on the quote. */
        referenceKept,
      }
    },
    {
      // It changes an open job and closes the quote: the rights each edit
      // asks for on its own, not the right to raise a job.
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
        { action: PermissionAction.UPDATE, subject: PermissionSubject.QUOTES },
      ],
      audit: ({ result }) => ({
        action: 'quote.convert',
        entity: 'Quote',
        entityId: result.convertedFromQuoteId,
        details: {
          key: 'quote_convert_existing',
          params: { ref: result.quoteRef, jobRef: result.invoiceNumber ?? result.id },
        },
        metadata: {
          quoteId: result.convertedFromQuoteId,
          serviceRecordId: result.id,
          mergedIntoExisting: true,
        },
      }),
    }
  )
}
