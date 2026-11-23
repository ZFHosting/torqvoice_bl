'use server'

import { db } from '@/lib/db'
import { withAuth } from '@/lib/with-auth'
import { onInventoryChanged } from '../Lib/onInventoryChanged'
import { Prisma } from '@/generated/prisma/client'
import { z } from 'zod'
import { releaseFiles, parseStoredFileUrl } from '@/lib/files/manager'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { distinctTags } from '../Lib/partTags'
import { partIdsWithTag, partIdsWithTagContaining } from '../Lib/tagSearch.server'
import { SETTING_KEYS } from '@/features/settings/Schema/settingsSchema'
// fork: the write bodies and their audit events live beside the inventory service (A2)
import {
  createInventoryPartEvent,
  deleteInventoryPartEvent,
  deleteInventoryPartsEvent,
  updateInventoryPartEvent,
} from '../Lib/inventoryAuditEvents'
import {
  adjustInventoryStockService,
  createInventoryPartService,
  deleteInventoryPartService,
  deleteInventoryPartsService,
  updateInventoryPartService,
} from '../Lib/inventoryService.server'

/** Words of a list search looked at; the rest of a pasted paragraph is ignored. */
const MAX_SEARCH_WORDS = 8

export async function getInventoryPartsPaginated(params: {
  page?: number
  pageSize?: number
  search?: string
  category?: string
  /** Restrict to parts carrying this tag, in any case. */
  tag?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  /** Restrict to parts at or below their reorder point. */
  lowStock?: boolean
}) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const page = params.page || 1
      const pageSize = params.pageSize || 20
      const skip = (page - 1) * pageSize
      const mode = 'insensitive' as Prisma.QueryMode

      const where: Prisma.InventoryPartWhereInput = { organizationId, isArchived: false }
      const and: Prisma.InventoryPartWhereInput[] = []

      // Every word has to match some field or tag, in any order, so "filter
      // hilux" finds the fuel filter tagged Hilux.
      const words = (params.search ?? '').trim().split(/\s+/).filter(Boolean)
      if (words.length > 0) {
        const searched = words.slice(0, MAX_SEARCH_WORDS)
        const tagged = await Promise.all(
          searched.map((word) => partIdsWithTagContaining(organizationId, word))
        )
        searched.forEach((word, i) => {
          and.push({
            OR: [
              { name: { contains: word, mode } },
              { partNumber: { contains: word, mode } },
              { barcode: { contains: word, mode } },
              { description: { contains: word, mode } },
              { supplier: { contains: word, mode } },
              { location: { contains: word, mode } },
              { id: { in: tagged[i] } },
            ],
          })
        })
      }

      if (params.category && params.category !== 'all') {
        where.category = params.category
      }

      if (params.tag?.trim()) {
        and.push({ id: { in: await partIdsWithTag(organizationId, params.tag) } })
      }

      if (params.lowStock) {
        // Prisma cannot compare two columns of the same row in a `where`, so the
        // matching ids are resolved in SQL first. The low-stock set is small by
        // definition (parts at or below their reorder point), so the extra query
        // stays cheap and pagination/sorting below is unaffected.
        // Same rule as isLow() in Lib/lowStockAlerts and the dashboard count:
        // the part's own reorder point wins, else the org-wide default.
        const thresholdRow = await db.appSetting.findFirst({
          where: { organizationId, key: SETTING_KEYS.LOW_STOCK_DEFAULT_THRESHOLD },
          select: { value: true },
        })
        const parsedDefault = Number(thresholdRow?.value)
        const lowStockDefault =
          Number.isFinite(parsedDefault) && parsedDefault > 0 ? parsedDefault : 0

        const lowRows = await db.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "public"."inventory_parts"
        WHERE "organizationId" = ${organizationId}
          AND "isArchived" = false
          AND "trackStock" = true
          AND COALESCE(NULLIF("minQuantity", 0), ${lowStockDefault}) > 0
          AND "quantity" <= COALESCE(NULLIF("minQuantity", 0), ${lowStockDefault})
      `
        and.push({ id: { in: lowRows.map((r) => r.id) } })
      }

      if (and.length > 0) where.AND = and

      const dir = params.sortOrder || 'desc'
      const sortableColumns = [
        'name',
        'partNumber',
        'category',
        'quantity',
        'unitCost',
        'sellPrice',
        'supplier',
        'location',
        'updatedAt',
      ]
      const sortColumn =
        params.sortBy && sortableColumns.includes(params.sortBy) ? params.sortBy : 'updatedAt'

      const [parts, total] = await Promise.all([
        db.inventoryPart.findMany({
          where,
          orderBy: { [sortColumn]: dir },
          skip,
          take: pageSize,
          include: { gallery: { orderBy: { sortOrder: 'asc' } } },
        }),
        db.inventoryPart.count({ where }),
      ])

      return {
        parts,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.INVENTORY },
      ],
    }
  )
}

export async function getInventoryPart(partId: string) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const part = await db.inventoryPart.findFirst({
        where: { id: partId, organizationId },
        include: { gallery: { orderBy: { sortOrder: 'asc' } } },
      })
      if (!part) throw new Error('Part not found')
      return part
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.INVENTORY },
      ],
    }
  )
}

export async function createInventoryPart(input: unknown) {
  return withAuth(
    // fork: the body is createInventoryPartService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      createInventoryPartService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.CREATE, subject: PermissionSubject.INVENTORY },
      ],
      audit: ({ result }) => createInventoryPartEvent(result),
    }
  )
}

export async function updateInventoryPart(input: unknown) {
  return withAuth(
    // fork: the body is updateInventoryPartService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      updateInventoryPartService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.INVENTORY },
      ],
      audit: ({ result }) => updateInventoryPartEvent(result),
    }
  )
}

export async function deleteInventoryPart(partId: string) {
  return withAuth(
    // fork: the body is deleteInventoryPartService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteInventoryPartService({ organizationId, userId, actor: 'user' }, partId),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.INVENTORY },
      ],
      audit: ({ result }) => deleteInventoryPartEvent(result),
    }
  )
}

export async function deleteInventoryParts(partIds: string[]) {
  return withAuth(
    // fork: the body is deleteInventoryPartsService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      deleteInventoryPartsService({ organizationId, userId, actor: 'user' }, partIds),
    {
      requiredPermissions: [
        { action: PermissionAction.DELETE, subject: PermissionSubject.INVENTORY },
      ],
      audit: ({ result }) => deleteInventoryPartsEvent(result, partIds),
    }
  )
}

export async function adjustInventoryStock(input: unknown) {
  return withAuth(
    // fork: the body is adjustInventoryStockService (A2), shared with the public API
    async ({ organizationId, userId }) =>
      adjustInventoryStockService({ organizationId, userId, actor: 'user' }, input),
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.INVENTORY },
      ],
    }
  )
}

export async function getInventoryCategories() {
  return withAuth(
    async ({ userId, organizationId }) => {
      const results = await db.inventoryPart.findMany({
        where: { organizationId, category: { not: null }, isArchived: false },
        select: { category: true },
        distinct: ['category'],
        orderBy: { category: 'asc' },
      })
      return results.map((r) => r.category).filter(Boolean) as string[]
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.INVENTORY },
      ],
    }
  )
}

/**
 * Every tag the workshop's parts carry, sorted, for the list's tag filter and
 * the suggestions under the part form's tag field.
 */
export async function getInventoryTags() {
  return withAuth(
    async ({ organizationId }) => {
      const rows = await db.inventoryPart.findMany({
        where: { organizationId, isArchived: false, tags: { isEmpty: false } },
        select: { tags: true },
      })
      return distinctTags(rows.map((row) => row.tags))
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.INVENTORY },
      ],
    }
  )
}

export async function getInventoryPartsList() {
  return withAuth(
    async ({ userId, organizationId }) => {
      // Include out-of-stock and backordered (negative) parts too — the picker
      // shows their stock state so a part can still be added to a work order
      // when depleted (which then correctly drives stock negative / backorder).
      return db.inventoryPart.findMany({
        where: { organizationId, isArchived: false },
        select: {
          id: true,
          partNumber: true,
          barcode: true,
          name: true,
          description: true,
          unit: true,
          unitCost: true,
          sellPrice: true,
          quantity: true,
          trackStock: true,
          category: true,
          tags: true,
          gallery: {
            select: { id: true, url: true, sortOrder: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      })
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.INVENTORY },
      ],
    }
  )
}

const applyMarkupSchema = z.object({
  multiplier: z.number().positive('Multiplier must be greater than 0'),
  overrideExisting: z.boolean().default(false),
})

export async function applyMarkupToAll(input: unknown) {
  return withAuth(
    async ({ userId, organizationId }) => {
      const { multiplier, overrideExisting } = applyMarkupSchema.parse(input)

      // Use raw SQL to avoid Prisma's @updatedAt auto-update which changes sort order
      const result = await db.$executeRaw`
      UPDATE "public"."inventory_parts"
      SET "sellPrice" = ROUND(("unitCost" * ${multiplier})::numeric, 2)
      WHERE "organizationId" = ${organizationId}
        AND "isArchived" = false
        ${overrideExisting ? Prisma.sql`` : Prisma.sql`AND ("sellPrice" = 0 OR "sellPrice" IS NULL)`}
    `

      await onInventoryChanged(organizationId)
      return { updated: result }
    },
    {
      requiredPermissions: [
        { action: PermissionAction.UPDATE, subject: PermissionSubject.INVENTORY },
      ],
    }
  )
}

/**
 * Images uploaded on the part form and then abandoned (the form was
 * cancelled). Only this workshop's inventory images, and only those no row
 * uses: the file manager checks both, so a URL naming another workshop, a
 * saved part's image or a path with `..` in it is left alone.
 */
export async function deleteOrphanedUploads(fileUrls: string[]) {
  return withAuth(async ({ organizationId }) => {
    const inventoryOnly = (Array.isArray(fileUrls) ? fileUrls : []).filter(
      (url) => parseStoredFileUrl(url)?.folder === 'inventory'
    )
    await releaseFiles(inventoryOnly, { organizationId, reason: 'abandoned inventory uploads' })
    return { success: true }
  })
}

/**
 * Whether low-stock tracking can produce results at all: either the org has a
 * default reorder point, or at least one part defines its own.
 *
 * Used to tell "nothing is low right now" apart from "nothing is being
 * watched", so the Low filter can explain an empty result instead of just
 * showing a blank table.
 */
export async function hasAnyReorderPoint() {
  return withAuth(
    async ({ organizationId }) => {
      const setting = await db.appSetting.findFirst({
        where: { organizationId, key: SETTING_KEYS.LOW_STOCK_DEFAULT_THRESHOLD },
        select: { value: true },
      })
      if ((Number(setting?.value) || 0) > 0) return true

      const configured = await db.inventoryPart.count({
        where: { organizationId, isArchived: false, trackStock: true, minQuantity: { gt: 0 } },
      })
      return configured > 0
    },
    {
      requiredPermissions: [
        { action: PermissionAction.READ, subject: PermissionSubject.INVENTORY },
      ],
    }
  )
}
