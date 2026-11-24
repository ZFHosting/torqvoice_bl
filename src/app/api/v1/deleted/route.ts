import { z } from 'zod'
import { publicApiOk } from '@/features/public-api/Lib/errors'
import {
  DEFAULT_LIMIT,
  decodeCursor,
  encodeCursor,
  MAX_LIMIT,
} from '@/features/public-api/Lib/pagination'
import { queryObject } from '@/features/public-api/Lib/readResource'
import { MARKER_TYPES } from '@/features/public-api/Lib/resets.server'
import { withPublicApi } from '@/features/public-api/Lib/withPublicApi'
import { db } from '@/lib/db'
import { hasPermission, PermissionAction, PermissionSubject } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const read = (subject: PermissionSubject) => ({ action: PermissionAction.READ, subject })

/**
 * Who may learn of a delete: whoever may read that kind of record through the API (the resources' own permissions,
 * `features/public-api/Resources`). A kind not listed needs `read:settings`.
 */
const READ_TO_SEE: Record<string, PermissionSubject> = {
  work_order: PermissionSubject.SERVICES,
  work_order_line: PermissionSubject.SERVICES,
  attachment: PermissionSubject.SERVICES,
  appointment: PermissionSubject.SERVICES,
  payment: PermissionSubject.BILLING,
  quote: PermissionSubject.QUOTES,
  customer: PermissionSubject.CUSTOMERS,
  customer_contact: PermissionSubject.CUSTOMERS,
  vehicle: PermissionSubject.VEHICLES,
  note: PermissionSubject.VEHICLES,
  finding: PermissionSubject.VEHICLES,
  inventory_part: PermissionSubject.INVENTORY,
  labor_preset: PermissionSubject.LABOR_PRESETS,
  inspection: PermissionSubject.INSPECTIONS,
  time_entry: PermissionSubject.TIME_TRACKING,
  technician_shift: PermissionSubject.TIME_TRACKING,
}

const querySchema = z
  .object({
    since: z.iso.datetime({ offset: true }).optional(),
    entityType: z
      .string()
      .regex(/^[a-z_]{1,40}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()

/**
 * fork (A5) `GET /api/v1/deleted?since=&entityType=&cursor=&limit=` (docs/fork/API.md §4): the tombstones a delete
 * leaves (`DeletedRecord`), oldest first, paged by `(deletedAt, id)`, so a client syncing with `updatedSince` learns
 * what went. Only the kinds of record the key may read; any read permission lets a key ask.
 */
export async function GET(request: Request) {
  return withPublicApi(request, async ({ organizationId, permissions, isAdmin }) => {
    const query = querySchema.parse(queryObject(request))
    const may = (type: string) =>
      isAdmin || hasPermission(permissions, read(READ_TO_SEE[type] ?? PermissionSubject.SETTINGS))
    const types = Object.keys(READ_TO_SEE).filter(may)
    const settings = may('__settings__')
    // The kinds this key may see: those listed it may read, and every other kind with `read:settings`. The restore
    // and reset markers name no record: every key sees them, so every client knows to resync.
    const visible = settings
      ? { NOT: { entityType: { in: Object.keys(READ_TO_SEE).filter((t) => !may(t)) } } }
      : { entityType: { in: [...types, ...MARKER_TYPES] } }
    const and: Record<string, unknown>[] = [{ organizationId }, visible]
    if (query.entityType) and.push({ entityType: query.entityType })
    if (query.since) and.push({ deletedAt: { gte: new Date(query.since) } })
    if (query.cursor) {
      const { updatedAt, id } = decodeCursor(query.cursor)
      and.push({ OR: [{ deletedAt: { gt: updatedAt } }, { deletedAt: updatedAt, id: { gt: id } }] })
    }
    const rows = await db.deletedRecord.findMany({
      where: { AND: and },
      orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      select: { id: true, entityType: true, entityId: true, deletedAt: true },
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return publicApiOk(
      page.map((r) => ({
        id: r.id,
        entityType: r.entityType,
        entityId: r.entityId,
        deletedAt: r.deletedAt.toISOString(),
      })),
      {
        meta: {
          hasMore: rows.length > query.limit,
          nextCursor:
            rows.length > query.limit && last
              ? encodeCursor({ updatedAt: last.deletedAt, id: last.id })
              : null,
        },
      }
    )
  })
}
