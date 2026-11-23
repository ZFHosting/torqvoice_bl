/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import {
  unlinkJobMeterReadingsFromOtherVehicles,
  unlinkMeterReadingsOfDeletedJobs,
} from '@/features/meters/Lib/jobMeterReading.server'
import { assertInvoiceHasRequiredReference } from '@/features/customer-reference/Lib/invoiceGuard.server'
import {
  assertRequiredMetersRead,
  missingRequiredMetersForNewJob,
  requiredMetersRefusal,
} from '@/features/meters/Lib/requiredMeters.server'
import { db } from '@/lib/db'
import { concernStoryData } from '@/features/vehicles/Lib/concernStory'
import {
  readWorkshopTax,
  savedDocumentTax,
  taxFieldsForNewDocument,
  WORKSHOP_TAX_SETTING_KEYS,
} from '@/features/settings/Lib/workshopTax'
import { loadTaxApplies } from '@/features/settings/Lib/loadTaxApplies'
import { withTaxableLabor, withTaxableParts } from '@/lib/taxable-lines'
import {
  readWarrantyDefaults,
  WARRANTY_SETTING_KEYS,
  warrantyExpiryFor,
  warrantyFieldsForNewDocument,
} from '@/features/settings/Lib/warrantyDefaults'
import { EMPTY_WARRANTY, normalizeWarranty } from '@/lib/warranty'
import { parseTaxComponentDefinitions } from '@/lib/tax-components'
import { issueInvoice } from '@/features/invoices/Lib/issueInvoice'
import { parseSentFields, sentId } from '@/lib/parse-sent-fields'
import { createServiceSchema, updateServiceSchema } from '../Schema/serviceSchema'
import { revalidatePath } from 'next/cache'
import { isSystemStatus, statusColumns } from '@/features/work-order-statuses/Lib/stages'
import { onInventoryChanged } from '@/features/inventory/Lib/onInventoryChanged'
import { randomUUID } from 'crypto'
// fork: the imported line columns the form doesn't send, carried over a save (M5 task 12)
import {
  carryLineColumns,
  forkColumnsOf,
  LABOR_LINE_COLUMNS,
  laborColumnsSelect,
  LABOR_MATCH,
  PART_LINE_COLUMNS,
  partColumnsSelect,
  PART_MATCH,
} from '@/integrations/shopmonkey/schema/lineColumns'
import { releaseFiles } from '@/lib/files/manager'
import { serviceRecordFileUrls } from '@/lib/files/collect'
import { clearNextNumberSetting, JOB_NUMBER_SETTING_KEYS, nextJobNumber } from '@/lib/job-number'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { toSafeWorkshopDate } from '@/lib/workshop-datetime'
import { notificationBus } from '@/lib/notification-bus'
import { reconcileInventoryForParts } from '@/features/inventory/Lib/reconcileStock'
import { assertInvoiceEditable, getDocumentLockSettings } from '@/lib/document-lock.server'
import { DocumentLockedError, invoiceLockState } from '@/lib/document-lock'
import { deleteCustomFieldValuesOf } from '@/features/custom-fields/Lib/deleteCustomFieldValues'
import {
  applyJobReading,
  forgetJobReading,
  jobReadingDate,
  lockJobReading,
} from '@/features/vehicles/Lib/vehicleReading'
import { FRESH_SHARE_LINK } from '@/lib/share-expiry'
import type { ServiceCtx } from '@/lib/service-context'
import { cascadeTombstones } from '@/features/public-api/Lib/tombstones.server'

export async function createServiceRecordService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const data = createServiceSchema.parse(input)
  const timeZone = await workshopTimeZone(organizationId)

  // Two shapes: a vehicle-linked work order, or a counter sale (no vehicle)
  // that must be linked directly to a customer instead.
  let vehicle: { id: string; mileage: number; customer: { taxExempt: boolean } | null } | null =
    null
  let directCustomer: { id: string; taxExempt: boolean } | null = null
  if (data.vehicleId) {
    vehicle = await db.vehicle.findFirst({
      where: { id: data.vehicleId, organizationId },
      select: { id: true, mileage: true, customer: { select: { taxExempt: true } } },
    })
    if (!vehicle) throw new Error('Vehicle not found')
  } else {
    if (!data.customerId) throw new Error('A customer is required for a sale without a vehicle')
    directCustomer = await db.customer.findFirst({
      where: { id: data.customerId, organizationId },
      select: { id: true, taxExempt: true },
    })
    if (!directCustomer) throw new Error('Customer not found')
  }
  // Made completed straight away: a job that does not exist yet has no
  // reading of the vehicle's required meters, so it is refused, naming
  // them. Made open, it is completed once they are read.
  if (data.status === 'completed' && vehicle) {
    const missing = await missingRequiredMetersForNewJob(organizationId, vehicle.id)
    if (missing.length > 0) throw await requiredMetersRefusal('complete', missing)
  }

  // Auto-populate shop name and invoice prefix from settings
  const [settings, org] = await Promise.all([
    db.appSetting.findMany({
      where: {
        organizationId,
        key: {
          in: [...JOB_NUMBER_SETTING_KEYS, ...WORKSHOP_TAX_SETTING_KEYS, ...WARRANTY_SETTING_KEYS],
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

  const shopName = data.shopName || org?.name || undefined

  // If the caller didn't pass taxInclusive, inherit the org's current setting.
  // Existing callers (vehicle-detail-client, ServiceForm) don't send the field,
  // so they pick up the workshop default; explicit values are respected.
  const inputObj = (input ?? {}) as Record<string, unknown>
  const taxInclusive =
    'taxInclusive' in inputObj ? data.taxInclusive : settingsMap['workshop.taxInclusive'] === 'true'

  // Tax-exempt customer: force taxRate to 0 (overrides whatever the caller sent).
  const customerExempt = Boolean(vehicle?.customer?.taxExempt || directCustomer?.taxExempt)
  if (customerExempt) {
    data.taxRate = 0
    data.taxAmount = 0
  }

  // A job at the workshop's own rate carries its tax components, so a
  // split-tax workshop's invoice prints GST and QST apart from the start.
  // A rate the caller set by hand is one figure and stays one.
  const workshopTax = readWorkshopTax(settingsMap)
  const atWorkshopRate = !customerExempt && data.taxRate > 0 && data.taxRate === workshopTax.rate
  // Each line is stored saying whether it is taxed: what the caller chose
  // for it, or the workshop's rule for its kind. The tax is then the
  // server's to state whenever the lines decide it (see savedDocumentTax).
  const taxedParts = withTaxableParts(data.partItems ?? [], workshopTax.applies)
  const taxedLabor = withTaxableLabor(data.laborItems ?? [], workshopTax.applies)
  const savedTax = savedDocumentTax({
    subtotal: data.subtotal,
    discountAmount: data.discountAmount,
    taxRate: data.taxRate,
    taxInclusive,
    taxComponents: atWorkshopRate ? taxFieldsForNewDocument(workshopTax).taxComponents : null,
    parts: taxedParts,
    labor: taxedLabor,
  })

  // The next number in the workshop's format; see src/lib/job-number.ts.
  const { invoiceNumber, usesNextNumberSetting } = await nextJobNumber({
    organizationId,
    settings: settingsMap,
    timeZone,
  })

  const {
    concerns,
    partItems,
    laborItems,
    attachments,
    serviceDate,
    invoiceDate,
    invoiceDueDate,
    warrantyStatus,
    warrantyMonths,
    warrantyMileage,
    warrantyNotes,
    ...recordData
  } = data

  // A caller that says nothing about warranty gets the workshop's standing
  // answer, as a job opened from the board does; one that says anything is
  // taken at its word. Counter sales are not repairs and start empty.
  const warrantyUnstated =
    warrantyStatus === undefined &&
    warrantyMonths === undefined &&
    warrantyMileage === undefined &&
    warrantyNotes === undefined
  const warranty = !warrantyUnstated
    ? normalizeWarranty({ warrantyStatus, warrantyMonths, warrantyMileage, warrantyNotes })
    : data.vehicleId
      ? warrantyFieldsForNewDocument(readWarrantyDefaults(settingsMap), 'workOrder')
      : EMPTY_WARRANTY
  const startsAt = toSafeWorkshopDate(serviceDate, timeZone) ?? new Date()
  const warrantyStartsOn = startsAt

  const record = await db.$transaction(async (tx) => {
    const created = await tx.serviceRecord.create({
      data: {
        ...recordData,
        organizationId,
        createdById: userId,
        // Only vehicle-less records link a customer directly; vehicle-linked
        // records always resolve their customer through the vehicle.
        customerId: data.vehicleId ? null : data.customerId,
        taxInclusive,
        ...(savedTax.totals
          ? {
              taxComponents: savedTax.totals.taxComponents,
              taxAmount: savedTax.totals.taxAmount,
              totalAmount: savedTax.totals.totalAmount,
            }
          : {}),
        taxableSubtotal: savedTax.taxableSubtotal,
        shopName,
        invoiceNumber,
        serviceDate: startsAt,
        // Reports and the calendar find a job by when it started; a job
        // without a start is in none of them.
        startDateTime: startsAt,
        invoiceDate:
          toSafeWorkshopDate(invoiceDate, timeZone) ??
          toSafeWorkshopDate(serviceDate, timeZone) ??
          new Date(),
        invoiceDueDate: toSafeWorkshopDate(invoiceDueDate, timeZone),
        ...warranty,
        warrantyExpiresAt: warrantyExpiryFor(warranty, warrantyStartsOn, timeZone),
      },
    })
    // Spent only once the job is written, in the same transaction.
    if (usesNextNumberSetting) await clearNextNumberSetting(organizationId, tx)

    if (partItems && partItems.length > 0) {
      // Enrich parts with unitCost from inventory (stock movement is handled
      // by reconcileInventoryForParts below).
      const enrichedParts = []
      for (const p of taxedParts) {
        let resolvedUnitCost = p.unitCost ?? 0
        if (p.inventoryPartId) {
          const invPart = await tx.inventoryPart.findFirst({
            where: { id: p.inventoryPartId, organizationId },
          })
          if (invPart) {
            resolvedUnitCost = invPart.unitCost ?? resolvedUnitCost
          }
        }
        enrichedParts.push({
          partNumber: p.partNumber,
          name: p.name,
          quantity: p.quantity,
          unit: p.unit ?? null,
          category: p.category ?? null,
          unitPrice: p.unitPrice,
          total: p.total,
          unitCost: resolvedUnitCost,
          markupPercent: p.markupPercent ?? 0,
          inventoryPartId: p.inventoryPartId || null,
          taxable: p.taxable,
          serviceRecordId: created.id,
        })
      }

      await tx.servicePart.createMany({ data: enrichedParts })

      // Deduct stock for inventory-linked parts (delta from an empty set).
      await reconcileInventoryForParts(tx, organizationId, [], partItems, {
        reason: 'service_record',
        userId,
        serviceRecordId: created.id,
        serviceRecordLabel: created.invoiceNumber || created.title,
      })
    }

    if (concerns && concerns.length > 0) {
      const now = new Date()
      await tx.serviceConcern.createMany({
        data: concerns.map((concern, index) => ({
          description: concern.description,
          sortOrder: concern.sortOrder ?? index,
          serviceRecordId: created.id,
          ...concernStoryData(concern, null, userId, now),
        })),
      })
    }

    if (laborItems && laborItems.length > 0) {
      await tx.serviceLabor.createMany({
        data: taxedLabor.map((l) => ({
          ...l,
          serviceRecordId: created.id,
        })),
      })
    }

    if (attachments && attachments.length > 0) {
      await tx.serviceAttachment.createMany({
        data: attachments.map((a) => ({
          ...a,
          serviceRecordId: created.id,
        })),
      })
    }

    return created
  })

  // Revalidate inventory if any parts were sourced from inventory
  const hasInventoryParts = partItems?.some((p) => p.inventoryPartId)
  if (hasInventoryParts) {
    await onInventoryChanged(organizationId)
  }

  // A new job resets maintenance dismissed, and its reading may become the
  // vehicle's: the rule is in vehicleReading.ts.
  if (vehicle) {
    await db.vehicle.update({
      where: { id: vehicle.id },
      data: { maintenanceDismissed: false, maintenanceDismissedAt: null },
    })
    await db.$transaction((tx) =>
      applyJobReading(tx, {
        organizationId,
        vehicleId: vehicle.id,
        jobId: record.id,
        jobDate: jobReadingDate(record),
        reading: data.mileage,
      })
    )
  }

  revalidatePath('/')
  if (data.vehicleId) revalidatePath(`/vehicles/${data.vehicleId}`)
  revalidatePath('/services')
  return record
}

export async function updateServiceRecordService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  // Refused before anything is read or written: this is the main way the
  // money on an invoice changes. Before the input is parsed too, so a
  // locked invoice says it is locked whatever the form sent with it.
  const recordId = sentId(input)
  if (recordId) await assertInvoiceEditable(recordId, organizationId)
  // Only what was sent: see parseSentFields for what the defaults did.
  const data = parseSentFields(updateServiceSchema, input)
  const timeZone = await workshopTimeZone(organizationId)
  const existing = await db.serviceRecord.findFirst({
    where: { id: data.id, organizationId },
    include: {
      attachments: { select: { fileUrl: true, category: true } },
      vehicle: {
        select: {
          id: true,
          mileage: true,
          make: true,
          model: true,
          year: true,
          licensePlate: true,
        },
      },
    },
  })
  if (!existing) throw new Error('Service record not found')
  // A save that leaves the job completed asks for its required meters
  // first, on the vehicle it will be on, when it completes the job or
  // moves a completed one to another vehicle; nothing of the save is
  // written without them. Any other save is never asked.
  const vehicleAfter = data.vehicleId !== undefined ? data.vehicleId : existing.vehicleId
  const statusAfter = data.status ?? existing.status
  if (
    statusAfter === 'completed' &&
    (existing.status !== 'completed' || vehicleAfter !== existing.vehicleId)
  ) {
    await assertRequiredMetersRead(
      organizationId,
      existing.id,
      existing.status === 'completed' ? 'move' : 'complete',
      { vehicleId: vehicleAfter }
    )
  }

  const {
    id,
    partItems,
    laborItems,
    concerns,
    attachments,
    customerId: _cid,
    serviceDate: _sd,
    invoiceDate: _id,
    invoiceDueDate: _idd,
    warrantyStatus: _ws,
    warrantyMonths: _wm,
    warrantyMileage: _wmil,
    warrantyNotes: _wn,
    ...recordData
  } = data

  // The four warranty columns move together. A save that names any of them
  // restates the whole warranty, with the row filling in what was left
  // out, so they can never be left contradicting each other; and the
  // expiry follows the service date even when only the date was changed.
  const warrantyTouched =
    data.warrantyStatus !== undefined ||
    data.warrantyMonths !== undefined ||
    data.warrantyMileage !== undefined ||
    data.warrantyNotes !== undefined
  const warranty = warrantyTouched
    ? normalizeWarranty({
        warrantyStatus: data.warrantyStatus ?? existing.warrantyStatus,
        warrantyMonths: data.warrantyMonths ?? existing.warrantyMonths,
        warrantyMileage: data.warrantyMileage ?? existing.warrantyMileage,
        warrantyNotes: data.warrantyNotes ?? existing.warrantyNotes,
      })
    : null
  const movedServiceDate =
    data.serviceDate !== undefined ? toSafeWorkshopDate(data.serviceDate, timeZone) : undefined
  const warrantyExpiresAt =
    warranty || movedServiceDate
      ? warrantyExpiryFor(
          warranty ?? normalizeWarranty(existing),
          movedServiceDate ?? existing.serviceDate,
          timeZone
        )
      : undefined

  // A job totalled with tax components keeps its split in step with the
  // lines the client sent: the amounts are recomputed here from the
  // components on the row, because the editor only knows the combined
  // rate and must not leave the printed GST and QST lines stale.
  //
  // The same goes for a job with a line left out of the tax: what the
  // tax is charged on comes from the lines as they are about to be
  // stored, so it is worked out here and never taken from the caller.
  // Lines the caller did not send are the ones already on the job.
  const linesSent = partItems !== undefined || laborItems !== undefined
  const taxApplies = linesSent ? await loadTaxApplies(organizationId) : null
  const taxedParts =
    partItems !== undefined && taxApplies ? withTaxableParts(partItems, taxApplies) : undefined
  const taxedLabor =
    laborItems !== undefined && taxApplies ? withTaxableLabor(laborItems, taxApplies) : undefined
  const moneyTouched =
    linesSent ||
    recordData.subtotal !== undefined ||
    recordData.discountAmount !== undefined ||
    recordData.taxRate !== undefined
  const savedTax = moneyTouched
    ? savedDocumentTax({
        subtotal: recordData.subtotal ?? existing.subtotal,
        discountAmount: recordData.discountAmount ?? existing.discountAmount,
        // A job with components keeps the rate they add up to.
        taxRate: parseTaxComponentDefinitions(existing.taxComponents)
          ? existing.taxRate
          : (recordData.taxRate ?? existing.taxRate),
        taxInclusive: recordData.taxInclusive ?? existing.taxInclusive,
        taxComponents: existing.taxComponents,
        parts:
          taxedParts ??
          (await db.servicePart.findMany({
            where: { serviceRecordId: id },
            select: { total: true, taxable: true },
          })),
        labor:
          taxedLabor ??
          (await db.serviceLabor.findMany({
            where: { serviceRecordId: id },
            select: { total: true, taxable: true, pricingType: true },
          })),
      })
    : null
  // The split is restated only by a save that restates the subtotal, as
  // before; a job with untaxed lines is restated by any save that touches
  // its money, since any of them moves what the tax is charged on.
  const restated =
    savedTax?.totals && (recordData.subtotal !== undefined || savedTax.taxableSubtotal !== null)
      ? savedTax.totals
      : null
  if (restated) {
    if (restated.taxComponents) recordData.taxRate = existing.taxRate
    recordData.taxAmount = restated.taxAmount
    recordData.totalAmount = restated.totalAmount
  }

  // A null vehicleId from the client means "no vehicle" (counter sale) —
  // treat it as no-change rather than detaching an existing vehicle.
  if (recordData.vehicleId == null) {
    delete recordData.vehicleId
  } else if (recordData.vehicleId !== existing.vehicleId) {
    // Moving the record to another vehicle: it must belong to this org, and
    // the record's customer then follows the vehicle again.
    const targetVehicle = await db.vehicle.findFirst({
      where: { id: recordData.vehicleId, organizationId },
      select: { id: true },
    })
    if (!targetVehicle) throw new Error('Vehicle not found')
  }

  // Determine which categories are being replaced and which files were removed
  let removedFileUrls: string[] = []
  let categoriesToReplace: string[] = []
  if (attachments !== undefined) {
    categoriesToReplace = [...new Set(attachments.map((a) => a.category || 'diagnostic'))]
    const existingInCategories = existing.attachments.filter((a) =>
      categoriesToReplace.includes(a.category)
    )
    const newFileUrls = new Set(attachments.map((a) => a.fileUrl))
    removedFileUrls = existingInCategories
      .map((a) => a.fileUrl)
      .filter((url) => !newFileUrls.has(url))
  }

  const record = await db.$transaction(async (tx) => {
    // What the job read before this save, under its row lock, so two
    // saves of the job at once take turns on the vehicle's reading too.
    const before = await lockJobReading(tx, { organizationId, jobId: id })
    const updated = await tx.serviceRecord.update({
      where: { id },
      data: {
        ...recordData,
        // The form carries the stage, not the workshop's own status, which
        // is chosen and saved on its own. So a save that moves the stage
        // drops a status that belonged to the old one, and a save that
        // leaves the stage alone leaves the status alone.
        ...(recordData.status !== undefined && recordData.status !== existing.status
          ? { customStatusId: null, customStatusSince: null }
          : {}),
        taxComponents: restated?.taxComponents,
        ...(savedTax ? { taxableSubtotal: savedTax.taxableSubtotal } : {}),
        // Attaching a vehicle to a counter sale: the direct customer link is
        // cleared so the invoice follows the vehicle's customer again.
        customerId:
          recordData.vehicleId && recordData.vehicleId !== existing.vehicleId && existing.customerId
            ? null
            : undefined,
        description:
          recordData.description !== undefined ? recordData.description || null : undefined,
        techName: recordData.techName !== undefined ? recordData.techName || null : undefined,
        diagnosticNotes:
          recordData.diagnosticNotes !== undefined ? recordData.diagnosticNotes || null : undefined,
        invoiceNotes:
          recordData.invoiceNotes !== undefined ? recordData.invoiceNotes || null : undefined,
        invoiceNumber:
          recordData.invoiceNumber !== undefined ? recordData.invoiceNumber || null : undefined,
        mileage: recordData.mileage !== undefined ? (recordData.mileage ?? null) : undefined,
        serviceDate: toSafeWorkshopDate(data.serviceDate, timeZone),
        // An emptied date clears it; the invoice then falls back to the
        // scheduled start or the service date, as it did before one was set.
        invoiceDate:
          data.invoiceDate !== undefined
            ? (toSafeWorkshopDate(data.invoiceDate, timeZone) ?? null)
            : undefined,
        invoiceDueDate:
          data.invoiceDueDate !== undefined
            ? (toSafeWorkshopDate(data.invoiceDueDate, timeZone) ?? null)
            : undefined,
        ...(warranty ?? {}),
        warrantyExpiresAt,
      },
    })

    // Replace parts if provided
    if (partItems !== undefined) {
      // Snapshot the parts being replaced BEFORE deleting them, so inventory
      // can be reconciled by the delta between the old and new linked parts
      // (this is what keeps stock correct when parts are added, edited,
      // reduced or removed on an existing work order).
      const previousParts = await tx.servicePart.findMany({
        where: { serviceRecordId: id },
        select: { inventoryPartId: true, quantity: true },
      })

      // fork: the job, kind, note and source fields of the lines being replaced
      const forkParts = await tx.servicePart.findMany({
        where: { serviceRecordId: id },
        orderBy: { id: 'asc' },
        select: partColumnsSelect,
      })
      await tx.servicePart.deleteMany({ where: { serviceRecordId: id } })
      if (taxedParts && taxedParts.length > 0) {
        await tx.servicePart.createMany({
          // fork: carryLineColumns
          data: carryLineColumns(forkParts, taxedParts, PART_MATCH, PART_LINE_COLUMNS).map((p) => ({
            partNumber: p.partNumber,
            name: p.name,
            quantity: p.quantity,
            unit: p.unit ?? null,
            category: p.category ?? null,
            unitPrice: p.unitPrice,
            total: p.total,
            unitCost: p.unitCost ?? 0,
            markupPercent: p.markupPercent ?? 0,
            inventoryPartId: p.inventoryPartId || null,
            taxable: p.taxable,
            // fork: the carried columns
            ...forkColumnsOf(p, PART_LINE_COLUMNS),
            serviceRecordId: id,
          })),
        })
      }

      await reconcileInventoryForParts(tx, organizationId, previousParts, partItems, {
        reason: 'service_record',
        userId,
        serviceRecordId: id,
        serviceRecordLabel: existing.invoiceNumber || existing.title,
      })
    }

    /**
     * Reconcile concerns by id, rather than replacing them like the rows
     * above.
     *
     * Parts and labour can be deleted and rewritten on every save because
     * nothing points at them. Findings point at concerns, and the relation
     * is SetNull, so deleting the whole list on an autosave would silently
     * cut every diagnosis loose from the question it answered. The rows
     * that survive an edit have to keep their ids.
     */
    if (concerns !== undefined) {
      const existingConcerns = await tx.serviceConcern.findMany({
        where: { serviceRecordId: id },
        select: { id: true, confirmedAt: true, confirmedById: true },
      })
      const existingById = new Map(existingConcerns.map((concern) => [concern.id, concern]))
      const now = new Date()
      const keptIds = new Set(
        concerns.map((concern) => concern.id).filter((cid): cid is string => Boolean(cid))
      )

      const removedIds = existingConcerns
        .map((concern) => concern.id)
        .filter((cid) => !keptIds.has(cid))
      if (removedIds.length > 0) {
        await tx.serviceConcern.deleteMany({ where: { id: { in: removedIds } } })
      }

      for (const [index, concern] of concerns.entries()) {
        const sortOrder = concern.sortOrder ?? index
        // An id the client sent that is not on this job is not ours to
        // trust: fall through to a create rather than updating by id.
        if (concern.id && keptIds.has(concern.id)) {
          const { count } = await tx.serviceConcern.updateMany({
            where: { id: concern.id, serviceRecordId: id },
            data: {
              description: concern.description,
              sortOrder,
              ...concernStoryData(concern, existingById.get(concern.id) ?? null, userId, now),
            },
          })
          if (count > 0) continue
        }
        await tx.serviceConcern.create({
          data: {
            description: concern.description,
            sortOrder,
            serviceRecordId: id,
            ...concernStoryData(concern, null, userId, now),
          },
        })
      }
    }

    // Replace labor if provided
    if (laborItems !== undefined) {
      // fork: the job, kind, technician, cost and source fields of the lines being replaced
      const forkLabor = await tx.serviceLabor.findMany({
        where: { serviceRecordId: id },
        orderBy: { id: 'asc' },
        select: laborColumnsSelect,
      })
      await tx.serviceLabor.deleteMany({ where: { serviceRecordId: id } })
      if (taxedLabor && taxedLabor.length > 0) {
        await tx.serviceLabor.createMany({
          // fork: carryLineColumns
          data: carryLineColumns(forkLabor, taxedLabor, LABOR_MATCH, LABOR_LINE_COLUMNS).map(
            (l) => ({
              ...l,
              serviceRecordId: id,
            })
          ),
        })
      }
    }

    // Replace attachments if provided (only for the categories included in the payload)
    if (attachments !== undefined) {
      if (categoriesToReplace.length > 0) {
        await tx.serviceAttachment.deleteMany({
          where: { serviceRecordId: id, category: { in: categoriesToReplace } },
        })
      }
      if (attachments.length > 0) {
        await tx.serviceAttachment.createMany({
          data: attachments.map((a) => ({
            ...a,
            serviceRecordId: id,
          })),
        })
      }
    }

    // The job's reading may become the vehicle's, or correct it: the rule
    // is in vehicleReading.ts. A job that moved to another vehicle in this
    // save speaks for that vehicle, with whatever reading it now carries;
    // the vehicle it left keeps its reading, which is no longer the job's.
    const vehicleBefore = before ? before.vehicleId : existing.vehicleId
    const sameVehicle = updated.vehicleId === vehicleBefore
    if (!sameVehicle && vehicleBefore) {
      await forgetJobReading(tx, { organizationId, jobId: id })
      // Its meter readings stay in the old vehicle's history, no longer the job's.
      await unlinkJobMeterReadingsFromOtherVehicles(tx, {
        organizationId,
        jobId: id,
        vehicleId: updated.vehicleId,
      })
      // And it no longer works on the old vehicle's equipment.
      await tx.serviceRecordEquipment.deleteMany({
        where: {
          organizationId,
          serviceRecordId: id,
          ...(updated.vehicleId ? { item: { vehicleId: { not: updated.vehicleId } } } : {}),
        },
      })
    }
    if (updated.vehicleId && (recordData.mileage !== undefined || !sameVehicle)) {
      await applyJobReading(tx, {
        organizationId,
        vehicleId: updated.vehicleId,
        jobId: id,
        jobDate: jobReadingDate(updated),
        reading: updated.mileage,
        previousReading: sameVehicle ? (before ? before.mileage : existing.mileage) : undefined,
      })
    }

    return updated
  })

  // Files of removed attachments, let go after the transaction committed.
  await releaseFiles(removedFileUrls, {
    organizationId,
    reason: 'work order attachments replaced',
  })

  // Notify workboard if status changed
  if (record.status !== existing.status) {
    notificationBus.emit('workboard', {
      type: 'job_status_changed',
      organizationId,
      serviceRecordId: id,
      status: record.status,
      serviceRecord: {
        id: existing.id,
        title: record.title || existing.title,
        status: record.status,
        vehicle: existing.vehicle,
      },
    })
  }

  revalidatePath('/')
  if (existing.vehicleId) {
    revalidatePath(`/vehicles/${existing.vehicleId}`)
    revalidatePath(`/vehicles/${existing.vehicleId}/service/${id}`)
  } else {
    revalidatePath(`/sales/${id}`)
  }
  revalidatePath('/services')
  // Parts may have been added, changed or removed on this record.
  await onInventoryChanged(organizationId)
  return record
}

export async function updateServiceStatusService(
  ctx: ServiceCtx,
  recordId: string,
  status: string,
  customStatusId: string | null = null
) {
  const { organizationId } = ctx
  // Written as it arrived until now; every screen that reads it keeps a
  // closed list, so a stray value made the job vanish from half of them.
  if (!isSystemStatus(status)) throw new Error('Unknown status')
  const custom = customStatusId
    ? await db.workOrderStatus.findFirst({
        where: { id: customStatusId, organizationId, archivedAt: null },
        select: { id: true, name: true, stage: true },
      })
    : null
  if (customStatusId && !custom) throw new Error('Status not found')
  if (custom && custom.stage !== status) {
    throw new Error('That status belongs to another stage')
  }

  const record = await db.serviceRecord.findFirst({
    where: { id: recordId, organizationId },
    include: {
      vehicle: {
        select: { id: true, make: true, model: true, year: true, licensePlate: true },
      },
    },
  })
  if (!record) throw new Error('Record not found')
  if (status === 'completed' && record.status !== 'completed') {
    await assertRequiredMetersRead(organizationId, record.id, 'complete')
  }

  await db.serviceRecord.update({
    where: { id: recordId },
    data: statusColumns(status, custom),
  })

  notificationBus.emit('workboard', {
    type: 'job_status_changed',
    organizationId,
    serviceRecordId: recordId,
    status,
    serviceRecord: {
      id: record.id,
      title: record.title,
      status,
      vehicle: record.vehicle,
    },
  })

  revalidatePath('/')
  revalidatePath('/work-orders')
  revalidatePath('/services')
  if (record.vehicleId) revalidatePath(`/vehicles/${record.vehicleId}`)
  else revalidatePath(`/sales/${recordId}`)
  return { success: true, recordId, status, customStatus: custom?.name ?? null }
}

export async function updateInternalNotesService(ctx: ServiceCtx, recordId: string, html: string) {
  const { organizationId } = ctx
  if (typeof html !== 'string' || html.length > 200_000) throw new Error('Invalid notes')
  const notes = html
  const record = await db.serviceRecord.findFirst({
    where: { id: recordId, organizationId },
    select: { id: true, invoiceNumber: true, vehicleId: true },
  })
  if (!record) throw new Error('Record not found')

  await db.serviceRecord.update({
    where: { id: record.id },
    // The editor reports an emptied box as one empty paragraph.
    data: { diagnosticNotes: notes && notes !== '<p></p>' ? notes : null },
  })

  if (record.vehicleId) revalidatePath(`/vehicles/${record.vehicleId}`)
  else revalidatePath(`/sales/${record.id}`)
  return { id: record.id, invoiceNumber: record.invoiceNumber }
}

export async function updateServiceRecordTitleService(
  ctx: ServiceCtx,
  recordId: string,
  title: string
) {
  const { organizationId } = ctx
  const next = typeof title === 'string' ? title.trim() : ''
  if (!next || next.length > 200) throw new Error('Invalid title')
  await assertInvoiceEditable(recordId, organizationId)
  const record = await db.serviceRecord.findFirst({
    where: { id: recordId, organizationId },
    select: { id: true, invoiceNumber: true, vehicleId: true },
  })
  if (!record) throw new Error('Record not found')

  await db.serviceRecord.update({ where: { id: record.id }, data: { title: next } })

  revalidatePath('/work-orders')
  if (record.vehicleId) revalidatePath(`/vehicles/${record.vehicleId}`)
  else revalidatePath(`/sales/${record.id}`)
  return { id: record.id, invoiceNumber: record.invoiceNumber, title: next }
}

export async function toggleManuallyPaidService(ctx: ServiceCtx, recordId: string) {
  const { organizationId } = ctx
  const record = await db.serviceRecord.findFirst({
    where: { id: recordId, organizationId },
    include: { payments: { select: { amount: true } } },
  })
  if (!record) throw new Error('Record not found')

  // Marking paid is always allowed — it only ever locks the document
  // further. But a flip that would *release* the lock is the admin-only
  // unlock in disguise: without this check, anyone with edit permission
  // could unmark a locked invoice, rewrite it, and mark it paid again,
  // leaving no unlock in the audit trail.
  const settings = await getDocumentLockSettings(organizationId)
  const before = invoiceLockState(record, settings)
  const after = invoiceLockState({ ...record, manuallyPaid: !record.manuallyPaid }, settings)
  if (before.locked && !after.locked && before.reason) {
    throw new DocumentLockedError(before.reason)
  }

  await db.serviceRecord.update({
    where: { id: recordId },
    // The day goes with the mark: a share link set to expire "after
    // payment" counts from it.
    data: {
      manuallyPaid: !record.manuallyPaid,
      manuallyPaidAt: record.manuallyPaid ? null : new Date(),
    },
  })
  // A paid invoice is the customer's document whether or not it was ever
  // sent through the app.
  if (!record.manuallyPaid) await issueInvoice(recordId, organizationId, 'paid')

  revalidatePath('/')
  revalidatePath('/services')
  if (record.vehicleId) {
    revalidatePath(`/vehicles/${record.vehicleId}`)
    revalidatePath(`/vehicles/${record.vehicleId}/service/${recordId}`)
  } else {
    revalidatePath(`/sales/${recordId}`)
  }
  return { success: true, manuallyPaid: !record.manuallyPaid }
}

export async function deleteServiceRecordService(ctx: ServiceCtx, recordId: string) {
  const { userId, organizationId } = ctx
  // A locked invoice cannot be edited into nothing either.
  await assertInvoiceEditable(recordId, organizationId)
  const record = await db.serviceRecord.findFirst({
    where: { id: recordId, organizationId },
  })
  if (!record) throw new Error('Record not found')

  // Its attachments and status report videos, read now and let go once
  // the record is gone. A tire set's photo on this job is shared with the
  // set and stays, as does anything else still in use.
  const files = await serviceRecordFileUrls(organizationId, [recordId])

  // Restock any inventory-linked parts, then delete the record (its parts
  // cascade-delete). Both happen in one transaction so stock is only
  // returned if the delete actually commits.
  await db.$transaction(async (tx) => {
    const parts = await tx.servicePart.findMany({
      where: { serviceRecordId: recordId },
      select: { inventoryPartId: true, quantity: true },
    })
    await reconcileInventoryForParts(tx, organizationId, parts, [], {
      reason: 'service_record_deleted',
      userId,
      // Deliberately no serviceRecordId: the record is deleted in this same
      // transaction, so the FK would immediately null out. The label is what
      // preserves "this stock came back from job X".
      serviceRecordLabel: record.invoiceNumber || record.title,
    })
    // Its meter readings stay in the history, at the date they count at now.
    await unlinkMeterReadingsOfDeletedJobs(tx, { organizationId, jobIds: [recordId] })
    // fork: what the delete takes with it (its payments, its time entries), read while it exists.
    const cascaded = await cascadeTombstones(
      tx,
      { organizationId, userId },
      { workOrderIds: [recordId] }
    )
    await tx.serviceRecord.delete({ where: { id: recordId } })
    // Its custom field values hang on its id alone, so nothing cascades.
    await deleteCustomFieldValuesOf(tx, organizationId, 'service_record', [recordId])
    // fork: the tombstones an API client syncing by updatedSince learns the deletes from.
    await tx.deletedRecord.createMany({
      data: [
        { organizationId, entityType: 'work_order', entityId: recordId, actorUserId: userId },
        ...cascaded,
      ],
    })
  })
  await releaseFiles(files, { organizationId, reason: 'work order deleted' })

  revalidatePath('/')
  if (record.vehicleId) revalidatePath(`/vehicles/${record.vehicleId}`)
  revalidatePath('/services')
  // Deleting the record restocked its linked parts.
  await onInventoryChanged(organizationId)
  return { recordId }
}

export async function deleteServiceAttachmentService(ctx: ServiceCtx, attachmentId: string) {
  const { organizationId, userId } = ctx
  const attachment = await db.serviceAttachment.findFirst({
    where: { id: attachmentId, serviceRecord: { organizationId } },
    include: { serviceRecord: { select: { vehicleId: true, id: true } } },
  })
  if (!attachment) throw new Error('Attachment not found')

  await db.serviceAttachment.delete({ where: { id: attachmentId } })
  // fork: the tombstone for API sync of a work order's attachments.
  await db.deletedRecord.create({
    data: { organizationId, entityType: 'attachment', entityId: attachmentId, actorUserId: userId },
  })

  // Then the file, unless something still uses it: a tire hotel copy points
  // at the tire set's own upload, which the set keeps; a photo sent on
  // WhatsApp stays for the conversation.
  await releaseFiles([attachment.fileUrl], { organizationId, reason: 'attachment deleted' })

  const { vehicleId, id: serviceId } = attachment.serviceRecord
  revalidatePath(vehicleId ? `/vehicles/${vehicleId}/service/${serviceId}` : `/sales/${serviceId}`)
  return { deleted: true }
}

export async function generatePublicLinkService(ctx: ServiceCtx, serviceRecordId: string) {
  const { organizationId } = ctx
  const record = await db.serviceRecord.findFirst({
    where: { id: serviceRecordId, organizationId },
  })
  if (!record) throw new Error('Record not found')
  // A customer who needs their PO on the invoice does not get one without it.
  await assertInvoiceHasRequiredReference(organizationId, serviceRecordId)
  // Nor before the readings the workshop requires are on the job.
  await assertRequiredMetersRead(organizationId, serviceRecordId, 'share')

  // The link is a way of sending the invoice, so what it shows is frozen
  // now, before the stamp below locks it.
  await issueInvoice(serviceRecordId, organizationId, 'sent')

  const token = randomUUID()
  await db.serviceRecord.update({
    where: { id: serviceRecordId },
    data: {
      publicToken: token,
      sharedAt: new Date(),
      ...FRESH_SHARE_LINK,
      // Handing over a link is a way of sending the invoice, so it counts
      // for "lock when sent". Unlike sharedAt this is never cleared:
      // revoking the link does not unsend what the customer already saw.
      // It tracks the latest share, so re-sharing after an unlock locks
      // the document again. Kept inline (rather than markInvoiceSent,
      // which owns every other channel) so the token and the stamp land
      // in one write.
      sentAt: new Date(),
    },
  })

  revalidatePath(
    record.vehicleId
      ? `/vehicles/${record.vehicleId}/service/${serviceRecordId}`
      : `/sales/${serviceRecordId}`
  )
  return { token, organizationId }
}

export async function revokePublicLinkService(ctx: ServiceCtx, serviceRecordId: string) {
  const { organizationId } = ctx
  const record = await db.serviceRecord.findFirst({
    where: { id: serviceRecordId, organizationId },
  })
  if (!record) throw new Error('Record not found')

  await db.serviceRecord.update({
    where: { id: serviceRecordId },
    data: {
      publicToken: null,
      sharedAt: null,
      viewCount: 0,
      lastViewedAt: null,
      ...FRESH_SHARE_LINK,
    },
  })

  revalidatePath(`/vehicles/${record.vehicleId}/service/${serviceRecordId}`)
  return { revoked: true }
}
