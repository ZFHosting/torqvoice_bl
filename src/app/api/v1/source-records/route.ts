import { z } from 'zod'
import { publicApiOk } from '@/features/public-api/Lib/errors'
import { pageArgs, pageMeta, pageQuerySchema } from '@/features/public-api/Lib/pagination'
import { queryObject } from '@/features/public-api/Lib/readResource'
import { withPublicApi } from '@/features/public-api/Lib/withPublicApi'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const querySchema = pageQuerySchema.extend({
  /** A Shopmonkey table name as staged: `order`, `customer`, `order_file`, … */
  table: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  remoteId: z.string().min(1).max(200).optional(),
}).strict()

/**
 * fork (A5) `GET /api/v1/source-records?table=&remoteId=&updatedSince=` (docs/fork/API.md §4, X1): every Shopmonkey
 * record the import fetched, as fetched, read-only, paged by `(updatedAt, id)`. Keys starting with `_` are the
 * importer's own (MAPPING §1). Scoped by the key's workshop; needs `read:settings` (what's archived spans every kind of
 * record).
 */
export async function GET(request: Request) {
  return withPublicApi(
    request,
    async ({ organizationId }) => {
      const query = querySchema.parse(queryObject(request))
      const page = pageArgs(query)
      const rows = await db.sourceRecord.findMany({
        where: {
          AND: [
            { organizationId },
            ...(query.table ? [{ table: query.table }] : []),
            ...(query.remoteId ? [{ remoteId: query.remoteId }] : []),
            page.where,
          ],
        },
        orderBy: page.orderBy,
        take: page.take,
        select: {
          id: true,
          source: true,
          table: true,
          remoteId: true,
          payload: true,
          remoteUpdatedAt: true,
          remoteDeletedAt: true,
          localEntity: true,
          localId: true,
          fetchedAt: true,
          updatedAt: true,
        },
      })
      const { rows: items, meta } = pageMeta(rows, query.limit)
      return publicApiOk(
        items.map((r) => ({
          id: r.id,
          source: r.source,
          table: r.table,
          remoteId: r.remoteId,
          payload: r.payload,
          remoteUpdatedAt: r.remoteUpdatedAt?.toISOString() ?? null,
          remoteDeletedAt: r.remoteDeletedAt?.toISOString() ?? null,
          local: r.localEntity && r.localId ? { entity: r.localEntity, id: r.localId } : null,
          fetchedAt: r.fetchedAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        { meta }
      )
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SETTINGS }],
    }
  )
}
