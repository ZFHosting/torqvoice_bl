'use server'

import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the write bodies and their audit events live beside the note service (A2)
import { noteCreatedEvent, noteDeletedEvent } from '../Lib/vehicleAuditEvents'
import {
  createNoteService,
  deleteNoteService,
  toggleNotePinService,
  updateNoteService,
} from '../Lib/noteService.server'

export async function getNotesPaginated(
  vehicleId: string,
  params: { page?: number; pageSize?: number }
) {
  return withAuth(
    async ({ organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 10
      const skip = (page - 1) * pageSize

      const vehicle = await db.vehicle.findFirst({
        where: { id: vehicleId, organizationId },
      })
      // Deleted or foreign-org vehicle: empty result instead of an error, since
      // this runs during the post-delete re-render of the vehicle page.
      if (!vehicle) {
        return { records: [], total: 0, page, pageSize, totalPages: 0 }
      }

      const [records, total] = await Promise.all([
        db.note.findMany({
          where: { vehicleId },
          orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
          skip,
          take: pageSize,
        }),
        db.note.count({ where: { vehicleId } }),
      ])

      return {
        records,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.VEHICLES }],
    }
  )
}

export async function createNote(input: unknown) {
  return withAuth(
    // fork: the body is createNoteService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createNoteService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.VEHICLES },
      ],
      audit: ({ result }) => noteCreatedEvent(result),
    }
  )
}

export async function updateNote(input: unknown) {
  return withAuth(
    // fork: the body is updateNoteService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateNoteService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.VEHICLES },
      ],
    }
  )
}

export async function toggleNotePin(noteId: string) {
  return withAuth(
    // fork: the body is toggleNotePinService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      toggleNotePinService({ organizationId, userId, actor: 'user' }, noteId),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.VEHICLES },
      ],
    }
  )
}

export async function deleteNote(noteId: string) {
  return withAuth(
    // fork: the body is deleteNoteService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteNoteService({ organizationId, userId, actor: 'user' }, noteId),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.VEHICLES },
      ],
      audit: ({ result }) => noteDeletedEvent(result),
    }
  )
}
