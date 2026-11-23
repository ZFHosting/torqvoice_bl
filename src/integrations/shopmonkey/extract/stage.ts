/**
 * Staging (docs/fork/milestones/M3-extract-and-stage.md, task 2): every Shopmonkey object, unchanged,
 * into `SourceRecord` before anything is transformed (FORK.md, "Lossless by construction").
 *
 * One row per source object per workshop, keyed `(organizationId, source, table, remoteId)`;
 * `connectionId` says which connection fetched it last (a reconnect makes a new one). The payload's
 * hash is over canonical JSON (keys sorted at every level), so a record Shopmonkey sends back
 * unchanged, in whatever key order, writes nothing.
 *
 * `childrenHash` records which payload a parent's children were fetched for: the extractor sweeps the
 * parents where it differs from `payloadHash`, so children are refetched only for a changed parent, and
 * a crash or a failed fetch is picked up by the next sweep.
 */
import { createHash } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'

export const SOURCE = 'shopmonkey'

/** JSON with every object's keys sorted, so equal data always serialises the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const object = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortKeys(object[key])])
    )
  }
  return value
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export type StageResult = 'created' | 'updated' | 'unchanged'

export interface StageInput {
  payload: Record<string, unknown>
  /** The hash to compare on, when it isn't the whole payload's (a file whose download URL is signed). */
  hash?: string
}

export interface StagedRow {
  remoteId: string
  hash: string
  result: StageResult
}

export interface PendingParent {
  id: string
  remoteId: string
  payload: Record<string, unknown>
  payloadHash: string
}

/** What the extractor needs from the archive. The app's is Prisma; tests use an in-memory one. */
export interface SourceStore {
  /** One table's records: one read for their hashes, a write for each new or changed one. */
  stage(table: string, records: StageInput[]): Promise<StagedRow[]>
  /** The staged hash of each of these that is staged at all. */
  hashes(table: string, remoteIds: string[]): Promise<Map<string, string>>
  /** Parents whose children are still to fetch, in id order after `afterId`. */
  pendingChildren(table: string, afterId: string | null, limit: number): Promise<PendingParent[]>
  markChildrenFetched(table: string, remoteId: string, hash: string): Promise<void>
  /** Forget every parent's children fetch for a table: what its children are has changed (a setting). */
  resetChildren(table: string): Promise<void>
  /**
   * Children that came back from a parent before and don't now (a service removed from an order):
   * marked deleted at `at`, never removed. Returns how many.
   */
  markGone(
    table: string,
    /** Where the parent's id sits in a child's payload: `['orderId']`, `['_parent', 'remoteId']`. */
    parentPath: string[],
    parentId: string,
    keep: string[],
    at: Date
  ): Promise<number>
}

export function remoteIdOf(table: string, payload: Record<string, unknown>): string {
  const id = payload.id
  if (typeof id === 'string' && id) return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  throw new Error(`A ${table} record without an id can't be staged`)
}

/** What the row says about the source's own dates and deletion. */
export function sourceDates(payload: Record<string, unknown>, now: Date) {
  return {
    remoteUpdatedAt: dateOrNull(payload.updatedDate),
    remoteDeletedAt: payload.deleted === true ? (dateOrNull(payload.deletedDate) ?? now) : null,
  }
}

/** The archive in the database, for one workshop and the connection doing the fetch. */
export function prismaSourceStore(
  scope: { organizationId: string; connectionId: string },
  client: Pick<typeof db, 'sourceRecord' | '$queryRaw'> = db
): SourceStore {
  const { organizationId, connectionId } = scope
  const keyOf = (table: string, remoteId: string) => ({
    organizationId_source_table_remoteId: { organizationId, source: SOURCE, table, remoteId },
  })

  return {
    async stage(table, records) {
      // One row per id: a page that repeats a record stages its last copy.
      const byId = new Map<string, { payload: Record<string, unknown>; hash: string }>()
      for (const record of records) {
        byId.set(remoteIdOf(table, record.payload), {
          payload: record.payload,
          hash: record.hash ?? payloadHash(record.payload),
        })
      }
      if (byId.size === 0) return []
      const current = await client.sourceRecord.findMany({
        where: { organizationId, source: SOURCE, table, remoteId: { in: [...byId.keys()] } },
        select: { remoteId: true, payloadHash: true, remoteDeletedAt: true },
      })
      const known = new Map(current.map((row) => [row.remoteId, row]))
      const now = new Date()
      const out: StagedRow[] = []
      for (const [remoteId, { payload, hash }] of byId) {
        const before = known.get(remoteId)
        const dates = sourceDates(payload, now)
        // Unchanged, and not marked gone since: nothing is written, not even `connectionId`.
        if (
          before &&
          before.payloadHash === hash &&
          (!before.remoteDeletedAt || dates.remoteDeletedAt)
        ) {
          out.push({ remoteId, hash, result: 'unchanged' })
          continue
        }
        const data = {
          connectionId,
          payload: payload as Prisma.InputJsonValue,
          payloadHash: hash,
          ...dates,
          fetchedAt: now,
        }
        await client.sourceRecord.upsert({
          where: keyOf(table, remoteId),
          create: { organizationId, source: SOURCE, table, remoteId, ...data },
          update: data,
        })
        out.push({ remoteId, hash, result: before ? 'updated' : 'created' })
      }
      return out
    },

    async hashes(table, remoteIds) {
      if (remoteIds.length === 0) return new Map()
      const rows = await client.sourceRecord.findMany({
        where: { organizationId, source: SOURCE, table, remoteId: { in: remoteIds } },
        select: { remoteId: true, payloadHash: true },
      })
      return new Map(rows.map((r) => [r.remoteId, r.payloadHash]))
    },

    async pendingChildren(table, afterId, limit) {
      // Prisma can't compare two columns with a null on one side, so this one is SQL.
      return client.$queryRaw<PendingParent[]>`
        SELECT "id", "remoteId", "payload", "payloadHash"
        FROM "source_records"
        WHERE "organizationId" = ${organizationId}
          AND "source" = ${SOURCE}
          AND "table" = ${table}
          AND "childrenHash" IS DISTINCT FROM "payloadHash"
          AND (${afterId}::text IS NULL OR "id" > ${afterId})
        ORDER BY "id"
        LIMIT ${limit}`
    },

    async markChildrenFetched(table, remoteId, hash) {
      // Only for the payload whose children these were: a parent restaged since stays pending.
      await client.sourceRecord.updateMany({
        where: { organizationId, source: SOURCE, table, remoteId, payloadHash: hash },
        data: { childrenHash: hash },
      })
    },

    async resetChildren(table) {
      await client.sourceRecord.updateMany({
        where: { organizationId, source: SOURCE, table, childrenHash: { not: null } },
        data: { childrenHash: null },
      })
    },

    async markGone(table, parentPath, parentId, keep, at) {
      const result = await client.sourceRecord.updateMany({
        where: {
          organizationId,
          source: SOURCE,
          table,
          remoteDeletedAt: null,
          remoteId: { notIn: keep },
          payload: { path: parentPath, equals: parentId },
        },
        data: { remoteDeletedAt: at },
      })
      return result.count
    },
  }
}
