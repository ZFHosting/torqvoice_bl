'use server'

import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the write bodies and their audit events live beside the technician service (A2)
import {
  createTechnicianEvent,
  deleteTechnicianEvent,
  updateTechnicianEvent,
} from '../Lib/technicianAuditEvents'
import {
  assignTechToUnassignedWorkOrdersService,
  createTechnicianService,
  deleteTechnicianService,
  updateTechnicianService,
} from '../Lib/technicianService.server'

export async function getTechnicians() {
  return withAuth(
    async ({ organizationId }) => {
      const technicians = await db.technician.findMany({
        where: { organizationId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          name: true,
          color: true,
          isActive: true,
          sortOrder: true,
          dailyCapacity: true,
          skills: true,
          userId: true,
          organizationId: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { name: true, email: true } },
        },
      })

      /**
       * The account's name wins over the copy stored on the row.
       *
       * A technician row carries its own name, written once when the row was
       * made and never since. Rename somebody, or attach an existing row to a
       * different account, and the two drift: the work board went on calling
       * one member "Petter" while the team page called the same person John
       * Doe, and nobody could tell they were looking at one person.
       *
       * Only when a row belongs to an account. A board-only technician has no
       * account to ask, and the stored name is the only name there is.
       */
      return technicians.map(({ user, ...technician }) => ({
        ...technician,
        name: user?.name || user?.email || technician.name,
      }))
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.WORK_BOARD },
      ],
    }
  )
}

export async function createTechnician(input: unknown) {
  return withAuth(
    // fork: the body is createTechnicianService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createTechnicianService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.WORK_BOARD },
      ],
      audit: ({ result }) => createTechnicianEvent(result),
    }
  )
}

export async function updateTechnician(input: unknown) {
  return withAuth(
    // fork: the body is updateTechnicianService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateTechnicianService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.WORK_BOARD },
      ],
      audit: ({ result }) => updateTechnicianEvent(result),
    }
  )
}

export async function deleteTechnician(id: string) {
  return withAuth(
    // fork: the body is deleteTechnicianService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteTechnicianService({ organizationId, userId, actor: 'user' }, id),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.WORK_BOARD },
      ],
      audit: ({ result }) => deleteTechnicianEvent(result),
    }
  )
}

export async function assignTechToUnassignedWorkOrders(technicianId: string) {
  return withAuth(
    // fork: the body is assignTechToUnassignedWorkOrdersService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      assignTechToUnassignedWorkOrdersService(
        { organizationId, userId, actor: 'user' },
        technicianId
      ),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.SERVICES },
      ],
    }
  )
}

export async function getOrgMembers() {
  return withAuth(async ({ organizationId }) => {
    const members = await db.organizationMember.findMany({
      where: { organizationId },
      select: {
        userId: true,
        user: { select: { id: true, name: true, email: true } },
      },
    })
    return members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
    }))
  })
}
