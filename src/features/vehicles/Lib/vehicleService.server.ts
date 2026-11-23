/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { getTranslations } from 'next-intl/server'
import { FLEET_NUMBER_MAX_LENGTH, fleetNumberTooLong } from '@/features/vehicles/Lib/fleetNumber'
import { prepareRecordCustomFields } from '@/features/custom-fields/Lib/recordCustomFieldValues.server'
import { normalizeFleetNumber } from '@/features/vehicles/Lib/fleetNumber'
import { isFleetNumberEnabled } from '@/features/vehicles/Lib/fleetNumberSetting'
import {
  deleteCustomFieldValuesOf,
  workOrderIdsOfVehicles,
} from '@/features/custom-fields/Lib/deleteCustomFieldValues'
import {
  INSPECTION_CAPABILITY,
  recordRegistryAnswer,
} from '@/features/integrations/Lib/inspection-sync'
import { getManifest } from '@/integrations/registry'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import { assertOwnUploads } from '@/lib/upload-url'
import { toSafeWorkshopDate } from '@/lib/workshop-datetime'
import { db } from '@/lib/db'
import { unlinkMeterReadingsOfDeletedJobs } from '@/features/meters/Lib/jobMeterReading.server'
import { assertOwnedCustomer } from '@/lib/owned-records'
import { createVehicleSchema, updateVehicleSchema } from '../Schema/vehicleSchema'
import { holdsRegistryDate, lookupAppliesTo, type RegistryLookup } from '../Lib/registryLookup'
import { revalidatePath } from 'next/cache'
import { normalizePlate } from '@/lib/license-plate'
import { releaseFiles } from '@/lib/files/manager'
import { vehicleFileUrls } from '@/lib/files/collect'
import { READING_SET_BY_HAND } from '../Lib/vehicleReading'
import { vehicleName } from '@/lib/vehicle-name'
import type { ServiceCtx } from '@/lib/service-context'
import { cascadeTombstones } from '@/features/public-api/Lib/tombstones.server'

/** A connector id that is a registry able to keep inspection dates, or null for anything else. */
function inspectionRegistry(source: string | undefined): string | null {
  if (!source) return null
  const manifest = getManifest(source)
  return manifest?.capabilities.includes(INSPECTION_CAPABILITY) ? manifest.id : null
}

/**
 * The form's inspection date and the registry lookup behind it.
 *
 * A lookup made on the form is recorded whole, the way the hourly sync
 * records its own, with the registry's day read as a UTC day and the time of
 * the check, so the sync treats the vehicle as freshly checked instead of
 * spending a second lookup on it. Only when it was about this vehicle: a
 * plate retyped after the lookup gets no answer that was never about it.
 *
 * The date field is then saved by hand only when the workshop typed
 * something other than what the registry said; a date the lookup wrote and
 * nobody touched is never saved as typed, not even when the plate was retyped
 * underneath it. A typed date is kept beside
 * the registry's answer with its own source, so a workshop in a country
 * without a registry, or one that knows better than the register, can still
 * drive reminders; a registry date takes over again on the next sync.
 */
async function saveInspectionDate(
  organizationId: string,
  vehicleId: string,
  value: string | undefined,
  lookup: RegistryLookup | undefined,
  saved: { licensePlate?: string | null; vin?: string | null }
): Promise<void> {
  if (lookup) {
    const registry = lookupAppliesTo(lookup, saved) ? inspectionRegistry(lookup.connectorId) : null
    if (registry) {
      await recordRegistryAnswer({
        organizationId,
        vehicleId,
        source: registry,
        result: lookup.result,
      })
    }
    if (holdsRegistryDate(value, lookup.result)) return
  }
  if (value === undefined) return
  const trimmed = value.trim()
  if (!trimmed) {
    // Clearing only removes a date the workshop typed; a registry date stays.
    await db.vehicleInspectionStatus.updateMany({
      where: { vehicleId, organizationId, source: 'manual' },
      data: { dueAt: null },
    })
    return
  }
  const dueAt = toSafeWorkshopDate(trimmed, await workshopTimeZone(organizationId))
  if (!dueAt) throw new Error('Invalid inspection date')
  await db.vehicleInspectionStatus.upsert({
    where: { vehicleId },
    create: { organizationId, vehicleId, dueAt, source: 'manual', found: true },
    update: { dueAt, source: 'manual', lastError: null },
  })
}

/**
 * A fleet number over the limit, refused in the person's language before the
 * schema's own English one: the form refuses it too, this is for anything
 * else that calls the action.
 */
async function refuseLongFleetNumber(input: unknown): Promise<void> {
  const value = (input as { fleetNumber?: unknown } | null)?.fleetNumber
  if (typeof value !== 'string' || !fleetNumberTooLong(value)) return
  const t = await getTranslations('vehicles.form')
  throw new Error(t('fleetNumberTooLong', { max: FLEET_NUMBER_MAX_LENGTH }))
}

export async function createVehicleService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  await refuseLongFleetNumber(input)
  const { inspectionDueAt, registryLookup, customFields, ...data } =
    createVehicleSchema.parse(input)
  assertOwnUploads(data, organizationId)
  // The owner the vehicle is filed under must be one of our customers.
  await assertOwnedCustomer(data.customerId, organizationId)
  // The workshop's own fields, when the form sent them: checked first, so
  // a required one left empty stops the vehicle being made at all.
  const writeCustomFields = await prepareRecordCustomFields(
    organizationId,
    'vehicle',
    null,
    customFields
  )
  const timeZone = await workshopTimeZone(organizationId)
  const fleetNumberOn = await isFleetNumberEnabled(organizationId)
  const createWith = (store: Pick<typeof db, 'vehicle'>) =>
    store.vehicle.create({
      data: {
        ...data,
        licensePlate: normalizePlate(data.licensePlate),
        hsn: data.hsn || null,
        tsn: data.tsn || null,
        // Only a workshop that has the field: nobody else has a box for it.
        fleetNumber: fleetNumberOn ? normalizeFleetNumber(data.fleetNumber) : null,
        purchaseDate: toSafeWorkshopDate(data.purchaseDate, timeZone) ?? null,
        customerId: data.customerId || null,
        userId,
        organizationId,
      },
    })
  // With its fields, in one transaction: both are saved or neither is.
  const vehicle = writeCustomFields
    ? await db.$transaction(async (tx) => {
        const made = await createWith(tx)
        await writeCustomFields(tx, made.id)
        return made
      })
    : await createWith(db)
  await saveInspectionDate(organizationId, vehicle.id, inspectionDueAt, registryLookup, vehicle)
  revalidatePath('/')
  revalidatePath('/vehicles')
  return vehicle
}

export async function updateVehicleService(ctx: ServiceCtx, input: unknown) {
  const { organizationId, userId } = ctx
  await refuseLongFleetNumber(input)
  const { id, inspectionDueAt, registryLookup, customFields, ...data } =
    updateVehicleSchema.parse(input)
  // An edit that leaves the plate out leaves it alone; one that sends it
  // stores the same form a new vehicle gets.
  const licensePlate =
    data.licensePlate !== undefined ? normalizePlate(data.licensePlate) : undefined
  assertOwnUploads(data, organizationId)

  // Fetch current record for display/diff, and the image it had
  const before = await db.vehicle.findFirst({
    where: { id, organizationId },
    select: {
      year: true,
      make: true,
      model: true,
      licensePlate: true,
      vin: true,
      imageUrl: true,
      mileage: true,
    },
  })
  if (!before) throw new Error('Vehicle not found')
  await assertOwnedCustomer(data.customerId, organizationId)
  // The workshop's own fields, when the form sent them: checked before
  // anything is written.
  const writeCustomFields = await prepareRecordCustomFields(
    organizationId,
    'vehicle',
    id,
    customFields
  )

  const updateWith = async (store: Pick<typeof db, 'vehicle'>) =>
    store.vehicle.updateMany({
      where: { id, organizationId },
      data: {
        ...data,
        vin: data.vin !== undefined ? data.vin || null : undefined,
        licensePlate,
        color: data.color !== undefined ? data.color || null : undefined,
        fuelType: data.fuelType !== undefined ? data.fuelType || null : undefined,
        transmission: data.transmission !== undefined ? data.transmission || null : undefined,
        engineSize: data.engineSize !== undefined ? data.engineSize || null : undefined,
        engineCode: data.engineCode !== undefined ? data.engineCode || null : undefined,
        hsn: data.hsn !== undefined ? data.hsn || null : undefined,
        tsn: data.tsn !== undefined ? data.tsn || null : undefined,
        // Left as stored when the form did not send it, and when the
        // workshop has the field off: what was typed while it was on stays.
        fleetNumber:
          data.fleetNumber !== undefined && (await isFleetNumberEnabled(organizationId))
            ? normalizeFleetNumber(data.fleetNumber)
            : undefined,
        purchaseDate: toSafeWorkshopDate(data.purchaseDate, await workshopTimeZone(organizationId)),
        customerId: data.customerId !== undefined ? data.customerId || null : undefined,
        // An emptied photo is no photo, not an empty address.
        imageUrl: data.imageUrl !== undefined ? data.imageUrl || null : undefined,
        // A reading typed here is the vehicle's own, no longer a job's that
        // a correction on the job could take back (vehicleReading.ts). The
        // form sends the reading with every save; only a changed one counts.
        ...(data.mileage !== undefined && data.mileage !== before.mileage
          ? READING_SET_BY_HAND
          : {}),
      },
    })
  // With its fields, in one transaction: both are saved or neither is.
  const updateResult = writeCustomFields
    ? await db.$transaction(async (tx) => {
        const updated = await updateWith(tx)
        if (updated.count === 0) throw new Error('Vehicle not found')
        await writeCustomFields(tx, id)
        return updated
      })
    : await updateWith(db)
  if (updateResult.count === 0) throw new Error('Vehicle not found')
  // A replaced image is let go once the new one is saved; the file manager
  // keeps it if anything else still shows it.
  if (data.imageUrl !== undefined && before.imageUrl && before.imageUrl !== data.imageUrl) {
    await releaseFiles([before.imageUrl], { organizationId, reason: 'vehicle image replaced' })
  }
  await saveInspectionDate(organizationId, id, inspectionDueAt, registryLookup, {
    licensePlate: licensePlate !== undefined ? licensePlate : before.licensePlate,
    vin: data.vin !== undefined ? data.vin : before.vin,
  })
  const vehicleDisplay = `${vehicleName(before)}${before.licensePlate ? ` (${before.licensePlate})` : ''}`
  const changedKeys = Object.keys(data).filter(
    (k) => (data as Record<string, unknown>)[k] !== undefined
  )
  revalidatePath('/')
  revalidatePath('/vehicles')
  revalidatePath(`/vehicles/${id}`)
  return { id, count: updateResult.count, fields: changedKeys, vehicleDisplay }
}

export async function deleteVehicleService(ctx: ServiceCtx, vehicleId: string) {
  const { organizationId, userId } = ctx
  const vehicle = await db.vehicle.findFirst({
    where: { id: vehicleId, organizationId },
    select: { year: true, make: true, model: true, licensePlate: true },
  })
  if (!vehicle) throw new Error('Vehicle not found')

  // Everything the delete cascades to, read while it still exists, and
  // let go once the rows are gone.
  const files = await vehicleFileUrls(organizationId, [vehicleId])
  // Its work orders go with it by cascade; their custom field values hang
  // on the work order's id alone and have to be removed by name.
  const workOrderIds = await workOrderIdsOfVehicles(organizationId, [vehicleId])
  await db.$transaction(async (tx) => {
    // Readings its jobs took on equipment that has since moved to another
    // vehicle stay in that item's history, at the date they count at now.
    await unlinkMeterReadingsOfDeletedJobs(tx, {
      organizationId,
      jobIds: workOrderIds,
      vehicleId,
    })
    // fork: what the delete takes with it, read while it exists: the work orders' payments and time
    // entries, the vehicle's findings and inspections.
    const cascaded = await cascadeTombstones(
      tx,
      { organizationId, userId },
      { workOrderIds, vehicleId }
    )
    await tx.vehicle.deleteMany({ where: { id: vehicleId, organizationId } })
    await deleteCustomFieldValuesOf(tx, organizationId, 'service_record', workOrderIds)
    // And the vehicle's own.
    await deleteCustomFieldValuesOf(tx, organizationId, 'vehicle', [vehicleId])
    // fork: tombstones for API sync: the vehicle, and the work orders that went with it.
    await tx.deletedRecord.createMany({
      data: [
        { organizationId, entityType: 'vehicle', entityId: vehicleId, actorUserId: userId },
        ...workOrderIds.map((entityId) => ({
          organizationId,
          entityType: 'work_order',
          entityId,
          actorUserId: userId,
        })),
        ...cascaded,
      ],
    })
  })
  await releaseFiles(files, { organizationId, reason: 'vehicle deleted' })

  const vehicleDisplay = `${vehicleName(vehicle)}${vehicle.licensePlate ? ` (${vehicle.licensePlate})` : ''}`
  revalidatePath('/')
  revalidatePath('/vehicles')
  return { vehicleId, vehicleDisplay }
}
