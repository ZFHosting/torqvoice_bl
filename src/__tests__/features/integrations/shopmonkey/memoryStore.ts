/**
 * fork: an in-memory SourceStore with the Prisma store's semantics (M3), so the extractor's tests run
 * without a database. `src/__tests__/db/shopmonkey-extract.db.test.ts` runs the same flows on Postgres.
 */
import {
  type PendingParent,
  payloadHash,
  remoteIdOf,
  type SourceStore,
  type StagedRow,
  sourceDates,
} from '@/integrations/shopmonkey/extract/stage'

export interface MemoryRow {
  id: string
  table: string
  remoteId: string
  payload: Record<string, unknown>
  payloadHash: string
  childrenHash: string | null
  remoteUpdatedAt: Date | null
  remoteDeletedAt: Date | null
}

function at(payload: unknown, pathParts: string[]): unknown {
  let value = payload
  for (const part of pathParts) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

export function createMemoryStore() {
  const rows = new Map<string, MemoryRow>()
  let sequence = 0
  let writes = 0
  const key = (table: string, remoteId: string) => `${table}\u0000${remoteId}`

  const store: SourceStore = {
    async stage(table, records) {
      const byId = new Map<string, { payload: Record<string, unknown>; hash: string }>()
      for (const r of records) {
        byId.set(remoteIdOf(table, r.payload), {
          payload: r.payload,
          hash: r.hash ?? payloadHash(r.payload),
        })
      }
      const out: StagedRow[] = []
      const now = new Date()
      for (const [remoteId, { payload, hash }] of byId) {
        const before = rows.get(key(table, remoteId))
        const dates = sourceDates(payload, now)
        if (
          before &&
          before.payloadHash === hash &&
          (!before.remoteDeletedAt || dates.remoteDeletedAt)
        ) {
          out.push({ remoteId, hash, result: 'unchanged' })
          continue
        }
        writes++
        rows.set(key(table, remoteId), {
          id: before?.id ?? `sr_${String(++sequence).padStart(8, '0')}`,
          table,
          remoteId,
          payload: structuredClone(payload),
          payloadHash: hash,
          childrenHash: before?.childrenHash ?? null,
          ...dates,
        })
        out.push({ remoteId, hash, result: before ? 'updated' : 'created' })
      }
      return out
    },

    async hashes(table, remoteIds) {
      const out = new Map<string, string>()
      for (const id of remoteIds) {
        const row = rows.get(key(table, id))
        if (row) out.set(id, row.payloadHash)
      }
      return out
    },

    async pendingChildren(table, afterId, limit) {
      return [...rows.values()]
        .filter((r) => r.table === table && r.childrenHash !== r.payloadHash)
        .filter((r) => afterId === null || r.id > afterId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(
          (r): PendingParent => ({
            id: r.id,
            remoteId: r.remoteId,
            payload: structuredClone(r.payload),
            payloadHash: r.payloadHash,
          })
        )
    },

    async markChildrenFetched(table, remoteId, hash) {
      const row = rows.get(key(table, remoteId))
      if (row && row.payloadHash === hash) {
        row.childrenHash = hash
        writes++
      }
    },

    async resetChildren(table) {
      for (const row of rows.values()) if (row.table === table) row.childrenHash = null
    },

    async markGone(table, parentPath, parentId, keep, when) {
      let count = 0
      for (const row of rows.values()) {
        if (row.table !== table || row.remoteDeletedAt || keep.includes(row.remoteId)) continue
        if (at(row.payload, parentPath) !== parentId) continue
        row.remoteDeletedAt = when
        writes++
        count++
      }
      return count
    },
  }

  return {
    store,
    rows,
    /** Rows written (created, updated, marked) since the store was made or `resetWrites`. */
    get writes() {
      return writes
    },
    resetWrites() {
      writes = 0
    },
    get(table: string, remoteId: string) {
      return rows.get(key(table, remoteId))
    },
    count(table?: string) {
      return [...rows.values()].filter((r) => !table || r.table === table).length
    },
  }
}
