/**
 * The sync window's jobs (M7): Shopmonkey stays the source of truth while the shop still works in it, and Torqvoice
 * follows.
 * - `refetch` (queued by a webhook, one per record while it waits): reads the record, and its children, from the API
 *   (never from the webhook's payload), stages them and, as the last refetch of a burst, loads.
 * - `sync.delta` (every ten minutes, the backstop for a webhook that never came): a delta extract from each table's
 *   watermark, then a load when it changed anything.
 * - `sync.load`: a load put off because another one was running.
 * A load runs only once the operator has run the first one (`state.lastLoad`), never while another extract runs,
 * and never after cutover. After each, the delete policy (`deletes.ts`).
 */
import { randomUUID } from 'node:crypto'
import { enqueueJob } from '@/features/integrations/Lib/jobs'
import type { ConnectorContext, JobHandler, JobOutcome } from '@/features/integrations/Lib/types'
import { saveExtractState } from '@/features/shopmonkey-import/Lib/extractState.server'
import { db } from '@/lib/db'
import { ShopmonkeyError } from '../client'
import { type ExtractDeps, refetchRecord } from '../extract/engine'
import type { ExtractState } from '../extract/plan'
import { mergeState } from '../load/outcome'
import type { LoadSummary } from '../load/run'
import type { KeptDelete } from './deletes'
import { changedRecords, deltaStart, driveDelta } from './delta'

/** How long one `sync.delta` run extracts before it hands back to the queue. */
const SYNC_BUDGET_MS = 45_000
/** A load put off by another one tries again after this. */
const BUSY_RETRY_MS = 60_000
/** Kept deletes stored for the report; the count says how many there were. */
const KEPT_LISTED = 200

export interface LastSync {
  at: string
  /** The load's run, or null when nothing was loaded. */
  runId: string | null
  records: number
  deleted: number
  keptDeletes: KeptDelete[]
  keptDeleteCount: number
}

/** What the connection's state says about the cutover (M7 step 5). */
export interface CutoverState {
  at: string
  userId: string
}

type Scope = { organizationId: string; connectionId: string }

const scopeOf = (ctx: ConnectorContext): Scope => ({
  organizationId: ctx.connection.organizationId,
  connectionId: ctx.connection.id,
})

/** The connection's state as it is now: a job's context was read when the job started. */
async function currentState(scope: Scope) {
  const row = await db.integrationConnection.findFirst({
    where: { id: scope.connectionId, organizationId: scope.organizationId },
    select: { state: true, createdById: true },
  })
  return {
    state: ((row?.state as Record<string, unknown>) ?? {}) as {
      extract?: ExtractState
      lastLoad?: unknown
      cutover?: CutoverState
      syncPending?: boolean
    },
    createdById: row?.createdById ?? null,
  }
}

/** The latest time a Date can hold (ms): a schedule whose last run is this is never due again. */
export const NEVER_AGAIN = 8_640_000_000_000_000

/**
 * Puts the ten-minute sync off for good (cutover): its last run in `state.scheduleRuns` set as late as a date can be,
 * which `scheduleDueSyncs` never finds due. That one key, in one statement, beside whatever else the scheduler keeps.
 */
export async function stopSyncSchedule(scope: Scope): Promise<void> {
  await db.$executeRaw`
    UPDATE "public"."integration_connections"
    SET "state" = jsonb_set(
          COALESCE("state", '{}'::jsonb),
          '{scheduleRuns}',
          COALESCE("state"->'scheduleRuns', '{}'::jsonb) || jsonb_build_object('sync.delta', ${NEVER_AGAIN}::bigint)
        ),
        "updatedAt" = now()
    WHERE "id" = ${scope.connectionId} AND "organizationId" = ${scope.organizationId}`
}

/** Why the sync won't load now, or null when it may. */
export function loadBlocker(state: {
  extract?: ExtractState
  lastLoad?: unknown
  cutover?: CutoverState
}): string | null {
  if (state.cutover) return 'the connection is cut over'
  if (!state.lastLoad) return 'the first load has not been run'
  if (state.extract && !state.extract.finishedAt && !state.extract.sync) {
    return 'an extract is running'
  }
  return null
}

/** The member a sync load acts as: whoever made the connection, while still a member of the workshop. */
async function runUser(scope: Scope, createdById: string | null): Promise<string | null> {
  if (!createdById) return null
  const member = await db.organizationMember.findFirst({
    where: { organizationId: scope.organizationId, userId: createdById },
    select: { userId: true },
  })
  return member?.userId ?? null
}

/** A load and the delete policy, when the sync may load. One line for the job log. */
export async function syncLoad(ctx: ConnectorContext): Promise<string> {
  const scope = scopeOf(ctx)
  const { state, createdById } = await currentState(scope)
  const blocked = loadBlocker(state)
  if (blocked) return `not loaded: ${blocked}`
  const userId = await runUser(scope, createdById)
  if (!userId) {
    await ctx.log(
      'warn',
      'Sync not loaded: the member who connected Shopmonkey has left the workshop'
    )
    return 'not loaded: no member to load as'
  }
  // Cleared first: a refetch staging while this load runs sets it again, and the next run loads that.
  await mergeState(scope, { syncPending: false })
  // Loaded when a load runs: the registry loads every connector's server, and the load reaches most of the app.
  const [{ runLoad }, { applyRemoteDeletes }] = await Promise.all([
    import('../load/run'),
    import('./deletes'),
  ])
  let summary: LoadSummary
  try {
    // Quiet: a sync load that wrote nothing records no audit event (one would fire every ten minutes).
    summary = await runLoad({ ...scope, runUserId: userId, quiet: true })
  } catch (err) {
    if (err instanceof Error && err.name === 'LoadBusy') {
      await mergeState(scope, { syncPending: true })
      await enqueueJob({
        ...scope,
        kind: 'sync.load',
        idempotencyKey: 'sync.load',
        runAfter: new Date(Date.now() + BUSY_RETRY_MS),
      })
      return 'another load is running: queued again'
    }
    if (err instanceof Error && err.name === 'LoadRefused') {
      await mergeState(scope, { syncPending: true })
      await ctx.log('warn', `Sync not loaded: ${err.message}`)
      return `not loaded: ${err.message}`
    }
    // Whatever went wrong, what was staged is still to load: the next run tries again.
    await mergeState(scope, { syncPending: true })
    throw err
  }
  const deletes = await applyRemoteDeletes({ ...scope, runId: summary.runId }, userId)
  const records = Object.values(summary.counts).reduce((a, c) => a + c.created + c.updated, 0)
  const lastSync: LastSync = {
    at: new Date().toISOString(),
    runId: summary.runId,
    records,
    deleted: deletes.deleted.length,
    keptDeletes: deletes.kept.slice(0, KEPT_LISTED),
    keptDeleteCount: deletes.kept.length,
  }
  await mergeState(scope, { lastSync })
  return `loaded ${records} changed, ${deletes.deleted.length} deleted, ${deletes.kept.length} deletes kept`
}

/** A rate limit longer than the client waits out: come back when Shopmonkey says to. */
function rateLimited(err: unknown): JobOutcome | null {
  if (err instanceof ShopmonkeyError && err.status === 429 && err.retryAfterS !== null) {
    return { summary: 'Rate limited by Shopmonkey', rescheduleInSeconds: err.retryAfterS + 1 }
  }
  return null
}

export interface SyncJobDeps {
  depsFor(ctx: ConnectorContext): ExtractDeps
  /** The one audit event a finished extract records. */
  extractFinished(ctx: ConnectorContext, state: ExtractState): Promise<void>
}

export function createSyncJobs(deps: SyncJobDeps) {
  /** `refetch`: one record a webhook named, read again from Shopmonkey. */
  async function refetch(ctx: ConnectorContext, payload: Record<string, unknown>) {
    const scope = scopeOf(ctx)
    const table = typeof payload.table === 'string' ? payload.table : ''
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (!table || !id) return { summary: 'Nothing to refetch' }
    const { state } = await currentState(scope)
    if (state.cutover) return { summary: `${table} ${id}: not refetched, cut over` }
    let outcome: string
    try {
      const result = await refetchRecord(deps.depsFor(ctx), table, id)
      outcome = result.outcome
    } catch (err) {
      const later = rateLimited(err)
      if (later) return later
      throw err
    }
    await mergeState(scope, { syncPending: true })
    // The last refetch of a burst loads; the ones before it leave that to the one still waiting.
    const waiting = await db.integrationJob.count({
      where: {
        ...scope,
        kind: 'refetch',
        status: 'queued',
        runAfter: { lte: new Date() },
      },
    })
    const load = waiting ? 'load left to the next refetch' : await syncLoad(ctx)
    return { summary: `${table} ${id}: ${outcome}; ${load}` }
  }

  /** `sync.delta`: what changed since the last run, then a load if anything did. */
  async function delta(ctx: ConnectorContext): Promise<JobOutcome> {
    const scope = scopeOf(ctx)
    const { state } = await currentState(scope)
    if (state.cutover) {
      // A scheduler that read the state before the cutover put its stop may have written `now` back over it.
      await stopSyncSchedule(scope)
      return { summary: 'Cut over: no sync' }
    }
    const previous = state.extract
    if (!previous) return { summary: 'No extract yet: nothing to sync from' }
    let run: ExtractState
    if (previous.finishedAt) {
      run = deltaStart(previous, { runId: randomUUID(), now: new Date(), sync: true })
      await mergeState(scope, { extract: run })
    } else if (previous.sync) {
      run = previous
    } else {
      return { summary: 'An extract is running: sync skipped' }
    }
    try {
      const result = await driveDelta(deps.depsFor(ctx), run, {
        budgetMs: SYNC_BUDGET_MS,
        save: (next) => saveExtractState(scope, next),
      })
      if (result.replaced) return { summary: 'Replaced by another extract' }
      if (!result.done) return { rescheduleInSeconds: 1 }
      const changed = changedRecords(result.state)
      if (changed) await deps.extractFinished(ctx, result.state)
      const pending = (await currentState(scope)).state.syncPending === true
      const load = changed || pending ? await syncLoad(ctx) : 'nothing changed'
      return { summary: `${changed} records changed in Shopmonkey; ${load}` }
    } catch (err) {
      const later = rateLimited(err)
      if (later) return later
      throw err
    }
  }

  /** `sync.load`: a load put off while another ran. */
  async function load(ctx: ConnectorContext): Promise<JobOutcome> {
    return { summary: await syncLoad(ctx) }
  }

  const handlers: Record<'refetch' | 'sync.delta' | 'sync.load', JobHandler> = {
    refetch,
    'sync.delta': delta,
    'sync.load': load,
  }
  return handlers
}
