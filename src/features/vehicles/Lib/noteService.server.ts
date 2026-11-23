/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { db } from '@/lib/db'
import { createNoteSchema, updateNoteSchema } from '../Schema/noteSchema'
import { revalidatePath } from 'next/cache'
import type { ServiceCtx } from '@/lib/service-context'

export async function createNoteService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = createNoteSchema.parse(input)
  const vehicle = await db.vehicle.findFirst({
    where: { id: data.vehicleId, organizationId },
  })
  if (!vehicle) throw new Error('Vehicle not found')

  const note = await db.note.create({ data })
  revalidatePath(`/vehicles/${data.vehicleId}`)
  return note
}

export async function updateNoteService(ctx: ServiceCtx, input: unknown) {
  const { organizationId } = ctx
  const data = updateNoteSchema.parse(input)
  const note = await db.note.findFirst({
    where: { id: data.id, vehicle: { organizationId } },
  })
  if (!note) throw new Error('Note not found')
  await db.note.update({ where: { id: data.id }, data })
  revalidatePath(`/vehicles/${note.vehicleId}`)
}

export async function toggleNotePinService(ctx: ServiceCtx, noteId: string) {
  const { organizationId } = ctx
  const note = await db.note.findFirst({
    where: { id: noteId, vehicle: { organizationId } },
  })
  if (!note) throw new Error('Note not found')

  await db.note.update({
    where: { id: noteId },
    data: { isPinned: !note.isPinned },
  })
  revalidatePath(`/vehicles/${note.vehicleId}`)
}

export async function deleteNoteService(ctx: ServiceCtx, noteId: string) {
  const { organizationId, userId } = ctx
  const note = await db.note.findFirst({
    where: { id: noteId, vehicle: { organizationId } },
  })
  if (!note) throw new Error('Note not found')

  await db.note.delete({ where: { id: noteId } })
  // fork: the tombstone an API client syncing by updatedSince learns the delete from.
  await db.deletedRecord.create({
    data: { organizationId, entityType: 'note', entityId: noteId, actorUserId: userId },
  })
  revalidatePath(`/vehicles/${note.vehicleId}`)
  return { noteId }
}
