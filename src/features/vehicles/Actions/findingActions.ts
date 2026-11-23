'use server'

import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { typeKeySearch } from '@/features/vehicles/Lib/typeKeySetting'
// fork: the write bodies and their audit events live beside the finding service (A2)
import {
  createFindingEvent,
  deleteFindingEvent,
  resolveFindingEvent,
  updateFindingEvent,
} from '../Lib/findingAuditEvents'
import {
  createFindingService,
  deleteFindingService,
  resolveFindingService,
  updateFindingService,
} from '../Lib/findingService.server'

export async function getObservationsPaginated(params: {
  page?: number
  pageSize?: number
  search?: string
  status?: string
  severity?: string
}) {
  return withAuth(
    async ({ organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 25
      const skip = (page - 1) * pageSize

      const search = params.search?.trim()
      // VehicleFinding has no organizationId of its own — findings are always
      // vehicle-scoped, so the org check must go through the vehicle relation.
      const where = {
        vehicle: { organizationId },
        ...(params.status && params.status !== 'all' ? { status: params.status } : {}),
        ...(params.severity && params.severity !== 'all' ? { severity: params.severity } : {}),
        ...(search
          ? {
              OR: [
                { description: { contains: search, mode: 'insensitive' as const } },
                { notes: { contains: search, mode: 'insensitive' as const } },
                { vehicle: { licensePlate: { contains: search, mode: 'insensitive' as const } } },
                ...(await typeKeySearch(organizationId, search)).map((vehicle) => ({ vehicle })),
                { vehicle: { make: { contains: search, mode: 'insensitive' as const } } },
                { vehicle: { model: { contains: search, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      }

      const [records, total] = await Promise.all([
        db.vehicleFinding.findMany({
          where,
          include: {
            vehicle: {
              select: {
                id: true,
                make: true,
                model: true,
                year: true,
                licensePlate: true,
              },
            },
            serviceRecord: { select: { id: true, title: true } },
            resolvedServiceRecord: { select: { id: true, title: true } },
          },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          skip,
          take: pageSize,
        }),
        db.vehicleFinding.count({ where }),
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

export async function getRecentObservations(limit = 10) {
  return withAuth(
    async ({ organizationId }) => {
      return db.vehicleFinding.findMany({
        where: {
          status: 'open',
          vehicle: { organizationId },
        },
        include: {
          vehicle: {
            select: {
              id: true,
              make: true,
              model: true,
              year: true,
              licensePlate: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.VEHICLES }],
    }
  )
}

export async function getServiceFindings(serviceRecordId: string) {
  return withAuth(
    async ({ organizationId }) => {
      return db.vehicleFinding.findMany({
        where: {
          serviceRecordId,
          vehicle: { organizationId },
        },
        orderBy: { createdAt: 'desc' },
      })
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.VEHICLES }],
    }
  )
}

export async function getVehicleFindings(
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
        db.vehicleFinding.findMany({
          where: { vehicleId },
          include: {
            serviceRecord: { select: { id: true, title: true } },
            resolvedServiceRecord: { select: { id: true, title: true } },
          },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          skip,
          take: pageSize,
        }),
        db.vehicleFinding.count({ where: { vehicleId } }),
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

/**
 * A concern id is only usable if it belongs to this workshop.
 *
 * Without this check the id travels straight from the client into a foreign
 * key, and a finding on one workshop's vehicle could be pointed at another
 * workshop's concern. Nothing renders it across the boundary, but it is a
 * cross-organization write, and those do not get to depend on the UI for
 * their safety.
 */
export async function createFinding(input: unknown) {
  return withAuth(
    // fork: the body is createFindingService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createFindingService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        {
          action: PermissionAction.UPDATE,
          subject: PermissionSubject.VEHICLES,
        },
      ],
      audit: ({ result }) => createFindingEvent(result),
    }
  )
}

export async function updateFinding(input: unknown) {
  return withAuth(
    // fork: the body is updateFindingService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateFindingService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        {
          action: PermissionAction.UPDATE,
          subject: PermissionSubject.VEHICLES,
        },
      ],
      audit: ({ result }) => updateFindingEvent(result),
    }
  )
}

export async function resolveFinding(input: unknown) {
  return withAuth(
    // fork: the body is resolveFindingService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      resolveFindingService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        {
          action: PermissionAction.UPDATE,
          subject: PermissionSubject.VEHICLES,
        },
      ],
      audit: ({ result }) => resolveFindingEvent(result),
    }
  )
}

export async function deleteFinding(findingId: string) {
  return withAuth(
    // fork: the body is deleteFindingService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteFindingService({ organizationId, userId, actor: 'user' }, findingId),
    {
      requiredPermissions: [
        {
          action: PermissionAction.UPDATE,
          subject: PermissionSubject.VEHICLES,
        },
      ],
      audit: ({ result }) => deleteFindingEvent(result),
    }
  )
}
