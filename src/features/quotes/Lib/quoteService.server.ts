/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { copyQuoteEquipmentToJob } from '@/features/equipment/Lib/equipmentWorkOn.server'
import { assertQuoteEditable, getDocumentLockSettings } from '@/lib/document-lock.server'
import { DocumentLockedError, quoteLockState } from '@/lib/document-lock'
import { deleteCustomFieldValuesOf } from '@/features/custom-fields/Lib/deleteCustomFieldValues'
import { db } from '@/lib/db'
import { assertOwnedCustomer, assertOwnedVehicle } from '@/lib/owned-records'
import { parseTaxComponentDefinitions } from '@/lib/tax-components'
import { savedDocumentTax, taxComponentsForCopy } from '@/features/settings/Lib/workshopTax'
import { loadTaxApplies } from '@/features/settings/Lib/loadTaxApplies'
import { withTaxableLabor, withTaxableParts } from '@/lib/taxable-lines'
import { parseSentFields, sentId } from '@/lib/parse-sent-fields'
import {
  isShopFeeLine,
  newShopFeeLine,
  readShopFee,
  SHOP_FEE_SETTING_KEYS,
  shopFeeFor,
} from '@/features/settings/Lib/shopFee'
import { retotalServiceRecord } from '@/features/vehicles/Lib/retotalServiceRecord'
import {
  readWarrantyDefaults,
  WARRANTY_SETTING_KEYS,
  warrantyExpiryFor,
  warrantyFieldsForNewDocument,
} from '@/features/settings/Lib/warrantyDefaults'
import { normalizeWarranty } from '@/lib/warranty'
import { createQuoteSchema, quoteStatusSchema, updateQuoteSchema } from '../Schema/quoteSchema'
import { createQuoteRecord } from '../Lib/createQuoteRecord'
import {
  copyQuoteAttachmentsToJob,
  copyQuoteLaborToJob,
  copyQuotePartsToJob,
} from '../Lib/copyQuoteToJob'
import { revalidatePath } from 'next/cache'
import { onInventoryChanged } from '@/features/inventory/Lib/onInventoryChanged'
import { clearNextNumberSetting, JOB_NUMBER_SETTING_KEYS, nextJobNumber } from '@/lib/job-number'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { toSafeWorkshopDate } from '@/lib/workshop-datetime'
import { clearedToNull } from '@/lib/clearable'
import { releaseFiles } from '@/lib/files/manager'
import { quoteFileUrls } from '@/lib/files/collect'
import type { ServiceCtx } from '@/lib/service-context'

export async function createQuoteService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const data = createQuoteSchema.parse(input)
  const quote = await createQuoteRecord({ organizationId, userId }, data)
  revalidatePath('/quotes')
  return quote
}

export async function updateQuoteService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  // The lock answers before the input is read: a locked page sends a form
  // with its inputs off, and the person saving it is told about the lock,
  // not about a field that did not arrive.
  const quoteId = sentId(input)
  if (quoteId) await assertQuoteEditable(quoteId, organizationId)
  // Only what was sent: see parseSentFields for what the defaults did.
  const data = parseSentFields(updateQuoteSchema, input)
  const existing = await db.quote.findFirst({
    where: { id: data.id, organizationId },
  })
  if (!existing) throw new Error('Quote not found')
  // The customer and vehicle the quote is being pointed at must be ours.
  await assertOwnedCustomer(data.customerId, organizationId)
  await assertOwnedVehicle(data.vehicleId, organizationId)

  const {
    id,
    partItems,
    laborItems,
    warrantyStatus,
    warrantyMonths,
    warrantyMileage,
    warrantyNotes,
    ...quoteData
  } = data

  // The four warranty columns move together, as on a work order: naming
  // any of them restates the whole, with the row filling in the rest.
  const warrantyTouched =
    warrantyStatus !== undefined ||
    warrantyMonths !== undefined ||
    warrantyMileage !== undefined ||
    warrantyNotes !== undefined
  const warranty = warrantyTouched
    ? normalizeWarranty({
        warrantyStatus: warrantyStatus ?? existing.warrantyStatus,
        warrantyMonths: warrantyMonths ?? existing.warrantyMonths,
        warrantyMileage: warrantyMileage ?? existing.warrantyMileage,
        warrantyNotes: warrantyNotes ?? existing.warrantyNotes,
      })
    : {}

  // Same as the work order: a quote with tax components has its split
  // recomputed from the row, since the editor sends one combined figure.
  //
  // And the same for a quote with a line left out of the tax: what the
  // tax is charged on comes from the lines as they are about to be
  // stored. Lines the caller did not send are the ones already there.
  const linesSent = partItems !== undefined || laborItems !== undefined
  const taxApplies = linesSent ? await loadTaxApplies(organizationId) : null
  const taxedParts =
    partItems !== undefined && taxApplies ? withTaxableParts(partItems, taxApplies) : undefined
  const taxedLabor =
    laborItems !== undefined && taxApplies ? withTaxableLabor(laborItems, taxApplies) : undefined
  const moneyTouched =
    linesSent ||
    quoteData.subtotal !== undefined ||
    quoteData.discountAmount !== undefined ||
    quoteData.taxRate !== undefined
  const savedTax = moneyTouched
    ? savedDocumentTax({
        subtotal: quoteData.subtotal ?? existing.subtotal,
        discountAmount: quoteData.discountAmount ?? existing.discountAmount,
        // A quote with components keeps the rate they add up to.
        taxRate: parseTaxComponentDefinitions(existing.taxComponents)
          ? existing.taxRate
          : (quoteData.taxRate ?? existing.taxRate),
        taxInclusive: quoteData.taxInclusive ?? existing.taxInclusive,
        taxComponents: existing.taxComponents,
        parts:
          taxedParts ??
          (await db.quotePart.findMany({
            where: { quoteId: id },
            select: { total: true, taxable: true, excluded: true },
          })),
        labor:
          taxedLabor ??
          (await db.quoteLabor.findMany({
            where: { quoteId: id },
            select: { total: true, taxable: true, excluded: true, pricingType: true },
          })),
      })
    : null
  const restated =
    savedTax?.totals && (quoteData.subtotal !== undefined || savedTax.taxableSubtotal !== null)
      ? savedTax.totals
      : null
  if (restated) {
    if (restated.taxComponents) quoteData.taxRate = existing.taxRate
    quoteData.taxAmount = restated.taxAmount
    quoteData.totalAmount = restated.totalAmount
  }

  const quote = await db.$transaction(async (tx) => {
    const updated = await tx.quote.update({
      where: { id },
      // Fields left out of the input stay as they are; emptied ones are
      // cleared.
      data: {
        ...quoteData,
        ...warranty,
        taxComponents: restated?.taxComponents,
        ...(savedTax ? { taxableSubtotal: savedTax.taxableSubtotal } : {}),
        description: clearedToNull(quoteData.description),
        notes: clearedToNull(quoteData.notes),
        customerId: clearedToNull(quoteData.customerId),
        vehicleId: clearedToNull(quoteData.vehicleId),
        validUntil:
          quoteData.validUntil !== undefined
            ? (toSafeWorkshopDate(quoteData.validUntil, await workshopTimeZone(organizationId)) ??
              null)
            : undefined,
        discountType: quoteData.discountType === 'none' ? null : quoteData.discountType,
      },
    })

    // A quote moved to another vehicle (or to none) no longer works on the
    // old vehicle's equipment, as a job does when it moves. An item that
    // moved on its own while the quote stayed is still the quote's.
    if (updated.vehicleId !== existing.vehicleId) {
      await tx.quoteEquipment.deleteMany({
        where: {
          organizationId,
          quoteId: id,
          ...(updated.vehicleId ? { item: { vehicleId: { not: updated.vehicleId } } } : {}),
        },
      })
    }

    if (partItems !== undefined) {
      await tx.quotePart.deleteMany({ where: { quoteId: id } })
      if (taxedParts && taxedParts.length > 0) {
        await tx.quotePart.createMany({
          // The array order is the order the workshop arranged the lines in.
          data: taxedParts.map((p, index) => ({ ...p, sortOrder: index, quoteId: id })),
        })
      }
    }

    if (laborItems !== undefined) {
      await tx.quoteLabor.deleteMany({ where: { quoteId: id } })
      if (taxedLabor && taxedLabor.length > 0) {
        await tx.quoteLabor.createMany({
          data: taxedLabor.map((l, index) => ({ ...l, sortOrder: index, quoteId: id })),
        })
      }
    }

    return updated
  })

  revalidatePath('/quotes')
  revalidatePath(`/quotes/${id}`)
  return quote
}

export async function updateQuoteStatusService(ctx: ServiceCtx, quoteId: string, status: string) {
  const { userId, organizationId } = ctx
  const parsedStatus = quoteStatusSchema.parse(status)
  const quote = await db.quote.findFirst({
    where: { id: quoteId, organizationId },
  })
  if (!quote) throw new Error('Quote not found')

  // Status changes are workflow and stay open, except the ones that would
  // release the lock: the lock derives from the status, so moving an
  // accepted quote back to draft is the admin-only unlock in disguise.
  const settings = await getDocumentLockSettings(organizationId)
  const before = quoteLockState(quote, settings)
  const after = quoteLockState({ ...quote, status: parsedStatus }, settings)
  if (before.locked && !after.locked && before.reason) {
    throw new DocumentLockedError(before.reason)
  }

  await db.quote.updateMany({
    where: { id: quoteId, organizationId },
    data: { status: parsedStatus },
  })

  revalidatePath('/quotes')
  revalidatePath(`/quotes/${quoteId}`)
  return { success: true, quoteId, status }
}

export async function deleteQuoteService(ctx: ServiceCtx, quoteId: string) {
  const { userId, organizationId } = ctx
  await assertQuoteEditable(quoteId, organizationId)
  const quote = await db.quote.findFirst({
    where: { id: quoteId, organizationId },
  })
  if (!quote) throw new Error('Quote not found')

  // Its attachments cascade with it; their files are let go afterwards.
  const files = await quoteFileUrls(organizationId, [quoteId])
  // Its custom field values hang on its id alone, so nothing cascades.
  await db.$transaction(async (tx) => {
    await tx.quote.deleteMany({ where: { id: quoteId, organizationId } })
    await deleteCustomFieldValuesOf(tx, organizationId, 'quote', [quoteId])
    // fork: the tombstone an API client syncing by updatedSince learns the delete from.
    await tx.deletedRecord.create({
      data: { organizationId, entityType: 'quote', entityId: quoteId, actorUserId: userId },
    })
  })
  await releaseFiles(files, { organizationId, reason: 'quote deleted' })
  revalidatePath('/quotes')
  return { quoteId }
}

export async function convertQuoteToServiceRecordService(
  ctx: ServiceCtx,
  quoteId: string,
  vehicleId: string
) {
  const { userId, organizationId } = ctx
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
  // A second pass would raise a second job and take the parts out of
  // stock twice.
  if (quote.status === 'converted') throw new Error('Quote is already converted')

  const vehicle = await db.vehicle.findFirst({
    where: { id: vehicleId, organizationId },
  })
  if (!vehicle) throw new Error('Vehicle not found')

  // The inspection the quote was raised from goes with it, so the job
  // prints its marks and its invoice carries its certificate. Only when
  // the job is for the car that was inspected.
  const inspection = quote.inspectionId
    ? await db.inspection.findFirst({
        where: { id: quote.inspectionId, organizationId, vehicleId },
        select: { id: true },
      })
    : null

  // Get settings for invoice number
  const [settings, org] = await Promise.all([
    db.appSetting.findMany({
      where: {
        organizationId,
        key: {
          in: [...JOB_NUMBER_SETTING_KEYS, ...WARRANTY_SETTING_KEYS, ...SHOP_FEE_SETTING_KEYS],
        },
      },
    }),
    db.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    }),
  ])
  const settingsMap: Record<string, string> = {}
  for (const s of settings) settingsMap[s.key] = s.value
  const timeZone = await workshopTimeZone(organizationId)
  // The next number in the workshop's format, like any new job; see
  // src/lib/job-number.ts. It ignored "Next invoice number" before.
  const { invoiceNumber, usesNextNumberSetting } = await nextJobNumber({
    organizationId,
    settings: settingsMap,
    timeZone,
  })

  // What the customer was told on the quote is what the job carries, "not
  // included" as much as twelve months: they accepted on those words. A
  // quote that never mentioned warranty leaves the job to start like any
  // other, from the workshop's standing answer.
  const serviceDate = new Date()
  const warranty = quote.warrantyStatus
    ? normalizeWarranty(quote)
    : warrantyFieldsForNewDocument(readWarrantyDefaults(settingsMap), 'workOrder')

  const record = await db.$transaction(async (tx) => {
    const created = await tx.serviceRecord.create({
      data: {
        organizationId,
        createdById: userId,
        title: quote.title,
        description: quote.description,
        type: 'repair',
        status: 'pending',
        vehicleId,
        // Carried across so a job born from a tire hotel quote still knows
        // which set it is for, and which shelf it sits on. Losing it here
        // would put the technician back to asking.
        tireSetId: quote.tireSetId,
        inspectionId: inspection?.id ?? null,
        // The customer's reference / PO goes with the work it was given for.
        customerReference: quote.customerReference,
        shopName: org?.name || undefined,
        invoiceNumber,
        subtotal: quote.subtotal,
        taxComponents: taxComponentsForCopy(quote.taxComponents),
        taxableSubtotal: quote.taxableSubtotal,
        taxRate: quote.taxRate,
        taxAmount: quote.taxAmount,
        taxInclusive: quote.taxInclusive,
        totalAmount: quote.totalAmount,
        cost: quote.totalAmount,
        discountType: quote.discountType,
        discountValue: quote.discountValue,
        discountAmount: quote.discountAmount,
        ...warranty,
        warrantyExpiresAt: warrantyExpiryFor(warranty, serviceDate, timeZone),
        serviceDate,
        startDateTime: serviceDate,
      },
    })
    // Spent only once the job is written, in the same transaction.
    if (usesNextNumberSetting) await clearNextNumberSetting(organizationId, tx)

    const includedParts = await copyQuotePartsToJob(tx, {
      organizationId,
      userId,
      quote,
      partItems: quote.partItems,
      target: created,
    })

    const includedLabor = quote.laborItems.filter((l) => !l.excluded)
    await copyQuoteLaborToJob(tx, created.id, includedLabor)

    // A fee the workshop charges on work orders but not on quotes goes on
    // here, priced for what the customer accepted, and the job re-totalled.
    // A quote that carried the fee already brought it across above.
    const jobFee = shopFeeFor(readShopFee(settingsMap), 'workOrder')
    if (jobFee && !includedLabor.some(isShopFeeLine)) {
      const feeLine = newShopFeeLine(
        jobFee,
        {
          labor: includedLabor.reduce((sum, l) => sum + l.total, 0),
          parts: includedParts.reduce((sum, p) => sum + p.total, 0),
        },
        (await loadTaxApplies(organizationId, tx)).shopFee
      )
      await tx.serviceLabor.create({ data: { ...feeLine, serviceRecordId: created.id } })
      await retotalServiceRecord(created.id, tx)
    }

    // Copy attachments from quote to service record
    await copyQuoteAttachmentsToJob(tx, organizationId, created.id, quote.attachments)
    // And the equipment it is for.
    await copyQuoteEquipmentToJob(tx, {
      organizationId,
      quoteId: quote.id,
      jobId: created.id,
      vehicleId,
    })

    // Marking it converted is what claims it: two clicks at once cannot
    // both raise a job, since the second finds nothing left to claim and
    // its job is rolled back with it.
    const claimed = await tx.quote.updateMany({
      where: { id: quoteId, organizationId, status: { not: 'converted' } },
      data: { status: 'converted', convertedToId: created.id },
    })
    if (claimed.count === 0) throw new Error('Quote is already converted')

    return created
  })

  revalidatePath('/quotes')
  revalidatePath('/work-orders')
  revalidatePath(`/vehicles/${vehicleId}`)
  // Conversion consumed stock for any inventory-linked quote lines.
  await onInventoryChanged(organizationId)
  return { ...record, convertedFromQuoteId: quoteId }
}
