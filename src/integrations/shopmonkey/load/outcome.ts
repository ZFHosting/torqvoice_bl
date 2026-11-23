/**
 * What a load leaves behind for the reconciliation (M6): why each record it left out was left out, on the record's
 * `SourceRecord.loadSkip`, and the run's warnings, failures and counts in the connection's `state.lastLoad`, so the
 * report can list every warning by code with examples without loading anything again.
 */
import 'server-only'
import { db } from '@/lib/db'
import type { Warning } from '../transform/types'
import type { Counts, LoadContext } from './context'

const SOURCE = 'shopmonkey'
const CHUNK = 5_000
/** Examples kept per warning code: the report shows the first 20 (M6 brief). */
export const WARNING_EXAMPLES = 20
/** Failures kept by name (a run that fails everything shouldn't write megabytes of state). */
const FAILURES_KEPT = 1_000

/**
 * Writes each left-out record's reason, grouped so a run that leaves out thousands is a few statements, and clears
 * the reason of a record loaded without a link of its own (a payment) this time.
 */
export async function recordSkips(lc: LoadContext): Promise<void> {
  const loaded = new Map<string, Set<string>>()
  for (const { table, remoteId } of lc.loadedUnlinked) {
    loaded.set(table, (loaded.get(table) ?? new Set()).add(remoteId))
  }
  for (const [table, ids] of loaded) {
    const all = [...ids]
    for (let i = 0; i < all.length; i += CHUNK) {
      await db.sourceRecord.updateMany({
        where: {
          organizationId: lc.scope.organizationId,
          source: SOURCE,
          table,
          remoteId: { in: all.slice(i, i + CHUNK) },
          loadSkip: { not: null },
        },
        data: { loadSkip: null },
      })
    }
  }
  const groups = new Map<string, { table: string; reason: string; ids: Set<string> }>()
  for (const skip of lc.skips) {
    const key = `${skip.table} ${skip.reason}`
    const group = groups.get(key) ?? { table: skip.table, reason: skip.reason, ids: new Set() }
    group.ids.add(skip.remoteId)
    groups.set(key, group)
  }
  for (const { table, reason, ids } of groups.values()) {
    const all = [...ids]
    for (let i = 0; i < all.length; i += CHUNK) {
      await db.sourceRecord.updateMany({
        where: {
          organizationId: lc.scope.organizationId,
          source: SOURCE,
          table,
          remoteId: { in: all.slice(i, i + CHUNK) },
          // A record linked in this run (a later stage loaded it) keeps its link and no reason.
          localId: null,
        },
        data: { loadSkip: reason },
      })
    }
  }
}

export interface WarningGroup {
  count: number
  examples: Warning[]
}

/** Warnings by code: how many, and the first few as they were given. */
export function groupWarnings(warnings: Warning[]): Record<string, WarningGroup> {
  const out: Record<string, WarningGroup> = {}
  for (const w of warnings) {
    const group = (out[w.code] ??= { count: 0, examples: [] })
    group.count++
    if (group.examples.length < WARNING_EXAMPLES) group.examples.push(w)
  }
  return out
}

export interface LastLoad {
  runId: string
  finishedAt: string
  counts: Record<string, Counts>
  warnings: Record<string, WarningGroup>
  /**
   * Orders whose Shopmonkey lines and subtotal disagree (`money_mismatch` on `subtotal`), with what the work
   * order's lines came to as loaded, in cents: the reconciliation explains a lines difference at that amount only.
   */
  mismatchedLines: Record<string, number>
  failures: { table: string; remoteId: string; error: string }[]
  failureCount: number
  issued: number
  issueFailed: number
}

/** Keeps the run's outcome in the connection's state, beside what the extract keeps there. */
export async function saveLastLoad(
  scope: { organizationId: string; connectionId: string },
  lc: LoadContext,
  run: { runId: string; issued: number; issueFailed: number; now?: Date }
): Promise<LastLoad> {
  const lastLoad: LastLoad = {
    runId: run.runId,
    finishedAt: (run.now ?? new Date()).toISOString(),
    counts: lc.counts,
    warnings: groupWarnings(lc.warnings),
    mismatchedLines: Object.fromEntries(lc.mismatchedLines),
    failures: lc.failures.slice(0, FAILURES_KEPT),
    failureCount: lc.failures.length,
    issued: run.issued,
    issueFailed: run.issueFailed,
  }
  await mergeState(scope, { lastLoad })
  return lastLoad
}

/**
 * Sets keys of the connection's `state`, one statement each, as the extract saves its own: a read, merge and write
 * of the whole state could put an older `extract` back over a run that saved meanwhile.
 */
export async function mergeState(
  scope: { organizationId: string; connectionId: string },
  patch: Record<string, unknown>
): Promise<void> {
  for (const [key, value] of Object.entries(patch)) {
    await db.$executeRaw`
      UPDATE "public"."integration_connections"
      SET "state" = jsonb_set(COALESCE("state", '{}'::jsonb), ARRAY[${key}]::text[], ${JSON.stringify(value)}::jsonb),
          "updatedAt" = now()
      WHERE "id" = ${scope.connectionId} AND "organizationId" = ${scope.organizationId}`
  }
}
