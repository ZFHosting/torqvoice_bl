/**
 * fork (A5) `?include=source` (docs/fork/API.md §4, "Source records"): the record an imported row came from, as the
 * importer archived it. The row's `IntegrationLink` (entity type, connection of this workshop) names the source's
 * table and id (`<table>:<id>`); the archive (`SourceRecord`) holds the payload. A row with no link (made in
 * Torqvoice), or whose connection was removed since, has `source: null`; the archive itself stays reachable at
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

/** The source of each row that has one, by row id: two queries for the page, scoped by workshop. */
export async function sourcesOf(
  organizationId: string,
  entityType: string,
  ids: string[]
): Promise<Map<string, SourceOut>> {
  const out = new Map<string, SourceOut>()
  if (ids.length === 0) return out
  const links = await db.integrationLink.findMany({
    where: { entityType, entityId: { in: ids }, connection: { organizationId } },
    select: { entityId: true, remoteId: true, connection: { select: { connectorId: true } } },
    orderBy: { createdAt: 'asc' },
  })
  const wanted = new Map<string, string>()
  for (const link of links) {
    const at = link.remoteId.indexOf(':')
    if (at <= 0 || wanted.has(link.entityId)) continue
    wanted.set(link.entityId, `${link.connection.connectorId}\u0000${link.remoteId}`)
  }
  if (wanted.size === 0) return out
  const keys = [...new Set(wanted.values())].map((key) => {
    const [source, ref] = key.split('\u0000')
    const at = ref.indexOf(':')
    return { source, table: ref.slice(0, at), remoteId: ref.slice(at + 1) }
  })
  const records = await db.sourceRecord.findMany({
    where: { organizationId, OR: keys },
    select: {
      source: true,
      table: true,
      remoteId: true,
      payload: true,
      remoteUpdatedAt: true,
      remoteDeletedAt: true,
    },
  })
  const byKey = new Map(records.map((r) => [`${r.source}\u0000${r.table}:${r.remoteId}`, r]))
  for (const [entityId, key] of wanted) {
    const r = byKey.get(key)
    if (!r) continue
    out.set(entityId, {
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
