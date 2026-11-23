'use server'

import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { Prisma } from '@/generated/prisma/client'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
// fork: the write bodies and their audit events live beside the labor preset service (A2)
import {
  createLaborPresetEvent,
  deleteLaborPresetEvent,
  updateLaborPresetEvent,
} from '../Lib/laborPresetAuditEvents'
import {
  createLaborPresetService,
  deleteLaborPresetService,
  updateLaborPresetService,
} from '../Lib/laborPresetService.server'

export async function getLaborPresetsPaginated(params: {
  page?: number
  pageSize?: number
  search?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 20
      const skip = (page - 1) * pageSize
      const mode = 'insensitive' as Prisma.QueryMode

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { organizationId, isArchived: false }

      if (params.search) {
        const q = params.search.trim()
        where.OR = [{ name: { contains: q, mode } }, { description: { contains: q, mode } }]
      }

      const dir = params.sortOrder || 'desc'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orderBy: any = (() => {
        switch (params.sortBy) {
          case 'name':
            return { name: dir }
          case 'description':
            return { description: dir }
          case 'createdAt':
            return { createdAt: dir }
          default:
            return { updatedAt: dir }
        }
      })()

      const [presets, total] = await Promise.all([
        db.laborPreset.findMany({
          where,
          orderBy,
          skip,
          take: pageSize,
          include: {
            _count: { select: { items: true, parts: true } },
            items: { select: { hours: true, pricingType: true } },
          },
        }),
        db.laborPreset.count({ where }),
      ])

      return {
        presets,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.LABOR_PRESETS },
      ],
    }
  )
}

export async function getLaborPreset(presetId: string) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const preset = await db.laborPreset.findFirst({
        where: { id: presetId, organizationId },
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
          parts: { orderBy: { sortOrder: 'asc' } },
        },
      })
      if (!preset) throw new Error('Preset not found')
      return preset
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.LABOR_PRESETS },
      ],
    }
  )
}

export async function createLaborPreset(input: unknown) {
  return withAuth(
    // fork: the body is createLaborPresetService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createLaborPresetService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.LABOR_PRESETS },
      ],
      audit: ({ result }) => createLaborPresetEvent(result),
    }
  )
}

export async function updateLaborPreset(input: unknown) {
  return withAuth(
    // fork: the body is updateLaborPresetService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateLaborPresetService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.LABOR_PRESETS },
      ],
      audit: ({ result }) => updateLaborPresetEvent(result),
    }
  )
}

export async function deleteLaborPreset(presetId: string) {
  return withAuth(
    // fork: the body is deleteLaborPresetService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteLaborPresetService({ organizationId, userId, actor: 'user' }, presetId),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.LABOR_PRESETS },
      ],
      audit: ({ result }) => deleteLaborPresetEvent(result),
    }
  )
}

export async function getLaborPresetsList() {
  return withAuth(
    async ({ userId, organizationId }) => {
      return db.laborPreset.findMany({
        where: { organizationId, isArchived: false },
        select: {
          id: true,
          name: true,
          description: true,
          items: {
            select: {
              description: true,
              hours: true,
              rate: true,
              pricingType: true,
              sortOrder: true,
            },
            orderBy: { sortOrder: 'asc' },
          },
          parts: {
            select: {
              name: true,
              partNumber: true,
              quantity: true,
              unit: true,
              category: true,
              unitPrice: true,
              inventoryPartId: true,
              sortOrder: true,
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      })
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.LABOR_PRESETS },
      ],
    }
  )
}
