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

/** Writes each left-out record's reason, grouped so a run that leaves out thousands is a few statements. */
export async function recordSkips(lc: LoadContext): Promise<void> {
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

/**
 * Warning codes the reconciliation explains money differences by (MAPPING §6.6): every order warned with each,
 * not only the first examples.
 */
export const EXPLAINING_CODES = ['money_mismatch'] as const

export interface LastLoad {
  runId: string
  finishedAt: string
  counts: Record<string, Counts>
  warnings: Record<string, WarningGroup>
  /** By explaining code: the orders warned with it. */
  warnedOrders: Record<string, string[]>
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
    warnedOrders: Object.fromEntries(
      EXPLAINING_CODES.map((code) => [
        code,
        [
          ...new Set(
            lc.warnings.filter((w) => w.code === code && w.table === 'order').map((w) => w.remoteId)
          ),
        ],
      ])
    ),
    failures: lc.failures.slice(0, FAILURES_KEPT),
    failureCount: lc.failures.length,
    issued: run.issued,
    issueFailed: run.issueFailed,
  }
  await mergeState(scope, { lastLoad })
  return lastLoad
}

/** Merges keys into the connection's `state` (the connector context's `saveState` does the same for the extract). */
export async function mergeState(
  scope: { organizationId: string; connectionId: string },
  patch: Record<string, unknown>
): Promise<void> {
  const connection = await db.integrationConnection.findFirst({
    where: { id: scope.connectionId, organizationId: scope.organizationId },
    select: { state: true },
  })
  if (!connection) return
  const state = { ...((connection.state as Record<string, unknown>) ?? {}), ...patch }
  await db.integrationConnection.updateMany({
    where: { id: scope.connectionId, organizationId: scope.organizationId },
    data: { state: state as object },
  })
}
