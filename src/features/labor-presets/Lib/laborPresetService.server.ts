/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { db } from '@/lib/db'
import { createLaborPresetSchema, updateLaborPresetSchema } from '../Schema/laborPresetSchema'
import { revalidatePath } from 'next/cache'
import type { ServiceCtx } from '@/lib/service-context'

export async function createLaborPresetService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const data = createLaborPresetSchema.parse(input)
  const resolvedName = data.name?.trim() || data.items[0]?.description || 'Untitled'
  const preset = await db.laborPreset.create({
    data: {
      name: resolvedName,
      description: data.description || undefined,
      userId,
      organizationId,
      items: {
        create: data.items.map((item, index) => ({
          description: item.description,
          hours: item.hours,
          rate: item.rate,
          pricingType: item.pricingType || 'hourly',
          sortOrder: index,
        })),
      },
      parts: data.parts?.length
        ? {
            create: data.parts.map((part, index) => ({
              name: part.name,
              partNumber: part.partNumber || null,
              quantity: part.quantity,
              unit: part.unit ?? null,
              category: part.category ?? null,
              unitPrice: part.unitPrice,
              inventoryPartId: part.inventoryPartId || null,
              sortOrder: index,
            })),
          }
        : undefined,
    },
    include: { items: true, parts: true },
  })
  revalidatePath('/labor-presets')
  return preset
}

export async function updateLaborPresetService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const data = updateLaborPresetSchema.parse(input)
  const { id, items, parts, ...updateData } = data
  // Resolve name from first item if not provided
  if (updateData.name !== undefined) {
    updateData.name = updateData.name?.trim() || items?.[0]?.description || 'Untitled'
  }

  const existing = await db.laborPreset.findFirst({
    where: { id, organizationId },
  })
  if (!existing) throw new Error('Preset not found')

  await db.$transaction(async (tx) => {
    // Delete old items and parts
    await tx.laborPresetItem.deleteMany({ where: { presetId: id } })
    await tx.laborPresetPart.deleteMany({ where: { presetId: id } })

    // Update preset and create new items/parts
    return tx.laborPreset.update({
      where: { id },
      data: {
        ...updateData,
        description:
          updateData.description !== undefined ? updateData.description || null : undefined,
        items: items
          ? {
              create: items.map((item, index) => ({
                description: item.description,
                hours: item.hours,
                rate: item.rate,
                pricingType: item.pricingType || 'hourly',
                sortOrder: index,
              })),
            }
          : undefined,
        parts: parts?.length
          ? {
              create: parts.map((part, index) => ({
                name: part.name,
                partNumber: part.partNumber || null,
                quantity: part.quantity,
                unit: part.unit ?? null,
                category: part.category ?? null,
                unitPrice: part.unitPrice,
                inventoryPartId: part.inventoryPartId || null,
                sortOrder: index,
              })),
            }
          : undefined,
      },
      include: { items: true, parts: true },
    })
  })

  revalidatePath('/labor-presets')
  return { updated: true, presetId: id }
}

export async function deleteLaborPresetService(ctx: ServiceCtx, presetId: string) {
  const { userId, organizationId } = ctx
  const result = await db.laborPreset.deleteMany({
    where: { id: presetId, organizationId },
  })
  if (result.count === 0) throw new Error('Preset not found')
  // fork: the tombstone an API client syncing labor presets learns the delete from.
  await db.deletedRecord.create({
    data: { organizationId, entityType: 'labor_preset', entityId: presetId, actorUserId: userId },
  })
  revalidatePath('/labor-presets')
  return { deleted: true, presetId }
}
