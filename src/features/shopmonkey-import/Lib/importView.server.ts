/**
 * fork: what the Shopmonkey import screen shows (docs/fork/milestones/M8-import-ui.md), read from the connection's
 * state and the archive. `importView` is polled every few seconds, so it reads only the state and a page of audit
 * rows; `mappingView` scans the archive for the users the history names, so it is read when the mapping opens.
 */
import { appUrl } from '@/features/integrations/Lib/connections'
import type { Stage } from '@/features/work-order-statuses/Lib/stages'
import { db } from '@/lib/db'
import { type LiveJobs, liveJobs } from './liveJobs.server'
import { type ExtractState, planFor } from '@/integrations/shopmonkey/extract/plan'
import { SOURCE } from '@/integrations/shopmonkey/extract/stage'
import type { LastLoad } from '@/integrations/shopmonkey/load/outcome'
import { referencedUsers } from '@/integrations/shopmonkey/load/people'
import { savedMapping } from '@/integrations/shopmonkey/load/run'
import type { ReconciliationReport } from '@/integrations/shopmonkey/reconcile/types'
import type { CutoverState, LastSync } from '@/integrations/shopmonkey/sync/jobs'
import type { CutoverRunState, LoadRunState } from '@/integrations/shopmonkey/sync/runs'
import { defaultStages } from '@/integrations/shopmonkey/transform/staff'

export interface TableProgress {
  key: string
  table: string
  stage: 'waiting' | 'list' | 'children' | 'done'
  /** Records of its list read. */
  read: number
  /** What Shopmonkey said the list holds, when it said. */
  total: number | null
  /** New or changed records staged, its children included. */
  written: number
  /** Parents whose children were read. */
  parents: number
  skippedReason: string | null
}

export interface ExtractView {
  runId: string
  startedAt: string
  finishedAt: string | null
  stopped: boolean
  /** A run the sync started (the ten-minute delta), not the operator. */
  sync: boolean
  calls: number
  tables: TableProgress[]
  /** List records read per minute so far, and the minutes the lists still need at that rate (children aside). */
  perMinute: number | null
  minutesLeft: number | null
}

export interface LoadRunView {
  runId: string
  at: string
  records: number
  undone: boolean
}

export interface ImportView {
  connectionId: string
  status: string
  webhookUrl: string
  extract: ExtractView | null
  loadRun: LoadRunState | null
  lastDryRun: {
    at: string
    counts: LastLoad['counts']
    warnings: Record<string, number>
    failureCount: number
  } | null
  lastLoad: Pick<LastLoad, 'runId' | 'finishedAt' | 'counts' | 'failureCount' | 'issued'> | null
  report: ReconciliationReport | null
  lastSync: LastSync | null
  cutoverRun: CutoverRunState | null
  cutover: CutoverState | null
  runs: LoadRunView[]
  /** What the job queue has queued or running for the import: what the buttons and the polling go by. */
  live: LiveJobs
}

const RUNS_LISTED = 20

function extractView(
  state: ExtractState | undefined,
  stop: unknown,
  live: LiveJobs,
  now: Date
): ExtractView | null {
  if (!state?.runId) return null
  let plan: ReturnType<typeof planFor>
  try {
    plan = planFor(state.only)
  } catch {
    plan = planFor(null)
  }
  const tables: TableProgress[] = plan.map((step, index) => {
    const cp = state.steps?.[step.key]
    if (!cp) {
      return {
        key: step.key,
        table: step.table,
        stage: index < state.step ? 'done' : 'waiting',
        read: 0,
        total: null,
        written: 0,
        parents: 0,
        skippedReason: null,
      }
    }
    return {
      key: step.key,
      table: step.table,
      stage: index < state.step ? 'done' : cp.stage,
      read: cp.skip,
      total: cp.total,
      written: cp.counts.created + cp.counts.updated + cp.children.created + cp.children.updated,
      parents: cp.children.parents,
      skippedReason: cp.skippedReason ?? null,
    }
  })
  const end = state.finishedAt ? new Date(state.finishedAt) : now
  const minutes = (end.getTime() - new Date(state.startedAt).getTime()) / 60_000
  const read = tables.reduce((a, t) => a + t.read, 0)
  const perMinute = minutes > 0.05 && read > 0 ? read / minutes : null
  const left = tables.reduce(
    (a, t) => a + (t.stage === 'done' || t.total === null ? 0 : Math.max(t.total - t.read, 0)),
    0
  )
  return {
    runId: state.runId,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    // Stopped once asked to and its job has ended (a stop takes effect after the unit under way).
    stopped:
      (stop as { runId?: string } | null)?.runId === state.runId &&
      !state.finishedAt &&
      !live.extract,
    sync: state.sync === true,
    calls: state.calls,
    tables,
    perMinute,
    minutesLeft: state.finishedAt || !perMinute ? null : left / perMinute,
  }
}

export async function importView(
  organizationId: string,
  connection: { id: string; status: string; state: Record<string, unknown> },
  now = new Date()
): Promise<ImportView> {
  const state = connection.state
  const lastLoad = (state.lastLoad as LastLoad | undefined) ?? null
  const live = await liveJobs(organizationId, connection.id)
  const dry = state.lastDryRun as ImportView['lastDryRun'] | undefined
  const audits = await db.auditLog.findMany({
    where: {
      organizationId,
      entityId: connection.id,
      action: { in: ['shopmonkey.import', 'shopmonkey.import_undo'] },
    },
    orderBy: { timestamp: 'desc' },
    take: RUNS_LISTED * 2,
    select: { action: true, timestamp: true, metadata: true, message: true },
  })
  const undone = new Set(
    audits
      .filter((a) => a.action === 'shopmonkey.import_undo')
      .map((a) => (a.metadata as { runId?: string } | null)?.runId)
  )
  const runs = audits
    .filter((a) => a.action === 'shopmonkey.import')
    .slice(0, RUNS_LISTED)
    .map((a) => {
      const meta = (a.metadata as { runId?: string; counts?: LastLoad['counts'] } | null) ?? {}
      const records = Object.values(meta.counts ?? {}).reduce(
        (n, c) => n + (c?.created ?? 0) + (c?.updated ?? 0),
        0
      )
      return {
        runId: meta.runId ?? '',
        at: a.timestamp.toISOString(),
        records,
        undone: undone.has(meta.runId),
      }
    })
    .filter((r) => r.runId)
  return {
    connectionId: connection.id,
    status: connection.status,
    webhookUrl: `${appUrl()}/api/integrations/shopmonkey/${connection.id}/webhook`,
    extract: extractView(state.extract as ExtractState | undefined, state.extractStop, live, now),
    loadRun: (state.loadRun as LoadRunState | undefined) ?? null,
    lastDryRun: dry
      ? {
          at: dry.at,
          counts: dry.counts,
          warnings: dry.warnings,
          failureCount: dry.failureCount,
        }
      : null,
    lastLoad: lastLoad
      ? {
          runId: lastLoad.runId,
          finishedAt: lastLoad.finishedAt,
          counts: lastLoad.counts,
          failureCount: lastLoad.failureCount,
          issued: lastLoad.issued,
        }
      : null,
    report: (state.lastReconciliation as ReconciliationReport | undefined) ?? null,
    lastSync: (state.lastSync as LastSync | undefined) ?? null,
    cutoverRun: (state.cutoverRun as CutoverRunState | undefined) ?? null,
    cutover: (state.cutover as CutoverState | undefined) ?? null,
    runs,
    live,
  }
}

export interface MappingView {
  statuses: { id: string; name: string; stage: Stage; defaultStage: Stage }[]
  users: { id: string; name: string; referenced: boolean; choice: string }[]
  technicians: { id: string; name: string }[]
}

const nameOf = (payload: Record<string, unknown>) =>
  [payload.firstName, payload.lastName]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' ') || String(payload.id)

/** The workflow statuses and users staged from Shopmonkey, with what each will become. */
export async function mappingView(
  organizationId: string,
  state: Record<string, unknown>
): Promise<MappingView> {
  const staged = (table: string) =>
    db.sourceRecord.findMany({
      where: { organizationId, source: SOURCE, table, remoteDeletedAt: null },
      orderBy: { id: 'asc' },
      select: { remoteId: true, payload: true },
    })
  const [statusRows, userRows, technicians, named] = await Promise.all([
    staged('workflow_status'),
    staged('user'),
    db.technician.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    referencedUsers({ scope: { organizationId, connectionId: '', runId: '' } }),
  ])
  const saved = savedMapping(state)
  const defaults = defaultStages(statusRows.map((r) => r.payload as Record<string, unknown>))
  return {
    statuses: statusRows.map((r) => {
      const payload = r.payload as Record<string, unknown>
      const defaultStage = defaults.get(r.remoteId) ?? 'pending'
      return {
        id: r.remoteId,
        name: typeof payload.name === 'string' && payload.name ? payload.name : r.remoteId,
        defaultStage,
        stage: saved.statusStageMap?.[r.remoteId] ?? defaultStage,
      }
    }),
    users: userRows.map((r) => ({
      id: r.remoteId,
      name: nameOf(r.payload as Record<string, unknown>),
      referenced: named.has(r.remoteId),
      choice: saved.technicianMap?.[r.remoteId] ?? '',
    })),
    technicians,
  }
}
