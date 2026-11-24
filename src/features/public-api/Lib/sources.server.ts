/**
 * fork (A5) `?include=source` (docs/fork/API.md §4, "Source records"): the record an imported row came from, as the
 * importer archived it. The archive says which local row each record was loaded as (`SourceRecord.localEntity` and
 * `localId`, set by the load and cleared by an undo), so a page's sources are one query, scoped by workshop, and stay
 * there after the connection is removed. A row made in Torqvoice has `source: null`; the archive itself is at
 * `/api/v1/source-records`.
 */
import 'server-only'
import { db } from '@/lib/db'

export interface SourceOut {
  /** The source system, `shopmonkey`. */
  source: string
  table: string
  remoteId: string
  payload: unknown
  remoteUpdatedAt: string | null
  remoteDeletedAt: string | null
}

/** The source of each row that has one, by row id. A row loaded from two records (rare) gets the first fetched. */
export async function sourcesOf(
  organizationId: string,
  entityType: string,
  ids: string[]
): Promise<Map<string, SourceOut>> {
  const out = new Map<string, SourceOut>()
  if (ids.length === 0) return out
  const records = await db.sourceRecord.findMany({
    where: { organizationId, localEntity: entityType, localId: { in: ids } },
    orderBy: [{ fetchedAt: 'asc' }, { id: 'asc' }],
    select: {
      localId: true,
      source: true,
      table: true,
      remoteId: true,
      payload: true,
      remoteUpdatedAt: true,
      remoteDeletedAt: true,
    },
  })
  for (const r of records) {
    if (!r.localId || out.has(r.localId)) continue
    out.set(r.localId, {
      source: r.source,
      table: r.table,
      remoteId: r.remoteId,
      payload: r.payload,
      remoteUpdatedAt: r.remoteUpdatedAt?.toISOString() ?? null,
      remoteDeletedAt: r.remoteDeletedAt?.toISOString() ?? null,
    })
  }
  return out
}
