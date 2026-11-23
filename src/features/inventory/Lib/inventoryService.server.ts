/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { db, type TxClient } from '@/lib/db'
import { assertOwnUploads } from '@/lib/upload-url'
import {
  createInventoryPartSchema,
  updateInventoryPartSchema,
  adjustStockSchema,
} from '../Schema/inventorySchema'
import { onInventoryChanged } from '../Lib/onInventoryChanged'
import { recordAbsoluteStockChange } from '../Lib/reconcileStock'
import { Prisma } from '@/generated/prisma/client'
import { releaseFiles } from '@/lib/files/manager'
import { inventoryPartFileUrls } from '@/lib/files/collect'
import { normalizeBarcode, withBarcodeConflictMessage } from '../Lib/barcode'
import { normalizePartTags } from '../Lib/partTags'
import type { ServiceCtx } from '@/lib/service-context'

export async function createInventoryPartService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const data = createInventoryPartSchema.parse(input)
  assertOwnUploads(data, organizationId)
  const { gallery, ...rest } = data
  const barcode = normalizeBarcode(rest.barcode)
  const part = await withBarcodeConflictMessage(organizationId, barcode, () =>
    db.inventoryPart.create({
      data: {
        ...rest,
        // A part that does not track stock has none to start with.
        quantity: rest.trackStock === false ? 0 : rest.quantity,
        partNumber: rest.partNumber || undefined,
        unit: rest.unit?.trim() || undefined,
        barcode: barcode ?? undefined,
        description: rest.description || undefined,
        category: rest.category || undefined,
        supplier: rest.supplier || undefined,
        supplierPhone: rest.supplierPhone || undefined,
        supplierEmail: rest.supplierEmail || undefined,
        supplierUrl: rest.supplierUrl || undefined,
        imageUrl: gallery?.[0]?.url || undefined,
        location: rest.location || undefined,
        tags: normalizePartTags(rest.tags ?? []),
        userId,
        organizationId,
      },
    })
  )

  if (gallery && gallery.length > 0) {
    await db.storedImage.createMany({
      data: gallery.map((img, i) => ({
        url: img.url,
        fileName: img.fileName || null,
        description: img.description || null,
        sortOrder: i,
        inventoryPartId: part.id,
      })),
    })
  }

  await onInventoryChanged(organizationId)
  return part
}

export async function updateInventoryPartService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const data = updateInventoryPartSchema.parse(input)
  assertOwnUploads(data, organizationId)
  const { id, gallery: galleryData, ...updateData } = data

  // The part has to be this workshop's before its gallery is touched: the
  // gallery rows are keyed by the part alone.
  const owned = await db.inventoryPart.findFirst({
    where: { id, organizationId },
    select: { id: true, trackStock: true },
  })
  if (!owned) throw new Error('Part not found')

  // Left out (a page opened before the switch existed), the part keeps
  // what it has.
  const tracksStock = updateData.trackStock ?? owned.trackStock
  const turningTrackingOff = owned.trackStock && !tracksStock

  // The images the part had before a change to them, let go at the end
  // once nothing uses them (the new gallery keeps the ones it still has).
  const replacedImages =
    galleryData !== undefined || 'imageUrl' in updateData
      ? await inventoryPartFileUrls(organizationId, [id])
      : []

  // Handle gallery updates
  if (galleryData !== undefined) {
    // Replace all gallery records, and the main image with the first, in
    // one transaction: never a moment where the part has no images and a
    // cleanup elsewhere would take them for unused.
    await db.$transaction([
      db.storedImage.deleteMany({ where: { inventoryPartId: id } }),
      ...(galleryData.length > 0
        ? [
            db.storedImage.createMany({
              data: galleryData.map((img, i) => ({
                url: img.url,
                fileName: img.fileName || null,
                description: img.description || null,
                sortOrder: i,
                inventoryPartId: id,
              })),
            }),
          ]
        : []),
      // Update imageUrl for backward compat
      db.inventoryPart.updateMany({
        where: { id, organizationId },
        data: { imageUrl: galleryData[0]?.url || null },
      }),
    ])
  }

  const nextBarcode =
    updateData.barcode !== undefined ? normalizeBarcode(updateData.barcode) : undefined
  const changes: Prisma.InventoryPartUpdateManyMutationInput = {
    ...updateData,
    // An untracked part holds no stock and is never low, whatever
    // the form sent. Turned back on, it starts from what is typed.
    ...(tracksStock ? {} : { quantity: 0, lowStockAlertedAt: null }),
    partNumber: updateData.partNumber !== undefined ? updateData.partNumber || null : undefined,
    unit: updateData.unit !== undefined ? updateData.unit.trim() || null : undefined,
    barcode: nextBarcode,
    description: updateData.description !== undefined ? updateData.description || null : undefined,
    category: updateData.category !== undefined ? updateData.category || null : undefined,
    supplier: updateData.supplier !== undefined ? updateData.supplier || null : undefined,
    supplierPhone:
      updateData.supplierPhone !== undefined ? updateData.supplierPhone || null : undefined,
    supplierEmail:
      updateData.supplierEmail !== undefined ? updateData.supplierEmail || null : undefined,
    supplierUrl: updateData.supplierUrl !== undefined ? updateData.supplierUrl || null : undefined,
    location: updateData.location !== undefined ? updateData.location || null : undefined,
    tags: updateData.tags !== undefined ? normalizePartTags(updateData.tags) : undefined,
  }
  const writePart = (client: Pick<TxClient, 'inventoryPart'>) =>
    client.inventoryPart.updateMany({ where: { id, organizationId }, data: changes })

  const result = await withBarcodeConflictMessage(organizationId, nextBarcode ?? null, () =>
    turningTrackingOff
      ? // Turning tracking off empties the shelf in the ledger first, while
        // the part still counts: one entry takes whatever was there (often
        // a large negative) to zero, so it stops showing in stock reports.
        db.$transaction(async (tx) => {
          await recordAbsoluteStockChange(
            tx,
            organizationId,
            id,
            0,
            { reason: 'stock_tracking_off', userId },
            // A part already at zero still gets the entry: the history
            // is where the day tracking stopped is read from.
            { recordUnchanged: true }
          )
          return writePart(tx)
        })
      : writePart(db)
  )
  if (result.count === 0) throw new Error('Part not found')
  await releaseFiles(replacedImages, { organizationId, reason: 'inventory images replaced' })
  await onInventoryChanged(organizationId)
  return { updated: true, partId: id }
}

export async function deleteInventoryPartService(ctx: ServiceCtx, partId: string) {
  const { userId, organizationId } = ctx
  const files = await inventoryPartFileUrls(organizationId, [partId])

  const result = await db.inventoryPart.deleteMany({
    where: { id: partId, organizationId },
  })
  if (result.count === 0) throw new Error('Part not found')
  // fork: the tombstone an API client syncing inventory learns the delete from.
  await db.deletedRecord.create({
    data: { organizationId, entityType: 'inventory_part', entityId: partId, actorUserId: userId },
  })
  await releaseFiles(files, { organizationId, reason: 'inventory part deleted' })

  await onInventoryChanged(organizationId)
  return { deleted: true, partId }
}

export async function deleteInventoryPartsService(ctx: ServiceCtx, partIds: string[]) {
  const { userId, organizationId } = ctx
  if (partIds.length === 0) throw new Error('No parts selected')

  const files = await inventoryPartFileUrls(organizationId, partIds)
  // fork: which of them are this workshop's, for their tombstones.
  const own = await db.inventoryPart.findMany({
    where: { id: { in: partIds }, organizationId },
    select: { id: true },
  })

  const result = await db.inventoryPart.deleteMany({
    where: { id: { in: partIds }, organizationId },
  })
  // fork: tombstones for API sync, one per part this workshop deleted.
  if (result.count > 0 && own.length > 0) {
    await db.deletedRecord.createMany({
      data: own.map(({ id }) => ({
        organizationId,
        entityType: 'inventory_part',
        entityId: id,
        actorUserId: userId,
      })),
    })
  }
  await releaseFiles(files, { organizationId, reason: 'inventory parts deleted' })

  await onInventoryChanged(organizationId)
  return { deleted: result.count }
}

export async function adjustInventoryStockService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const { id, adjustment } = adjustStockSchema.parse(input)
  const part = await db.inventoryPart.findFirst({
    where: { id, organizationId },
  })
  if (!part) throw new Error('Part not found')
  if (part.trackStock === false) throw new Error('This part does not track stock')

  const newQuantity = part.quantity + adjustment
  if (newQuantity < 0) throw new Error('Insufficient stock')

  // Tracking is checked again in the write itself: switched off between
  // the read above and here, the part must stay at zero.
  const written = await db.inventoryPart.updateMany({
    where: { id, organizationId, trackStock: true },
    data: { quantity: newQuantity },
  })
  if (written.count === 0) throw new Error('This part does not track stock')
  await onInventoryChanged(organizationId)
  return { quantity: newQuantity }
}
