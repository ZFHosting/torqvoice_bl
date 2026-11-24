/**
 * The import screen's own jobs (M8): a load (dry or real) and the cutover, queued by the operator and run by the job
 * queue, since either can take longer than a request. Each keeps where it stands in the connection's state, for the
 * screen to show: `state.loadRun`, `state.lastDryRun` (a dry run's summary) and `state.cutoverRun`.
 */
import { enqueueJob } from '@/features/integrations/Lib/jobs'
import type { ConnectorContext, JobHandler, JobOutcome } from '@/features/integrations/Lib/types'
import { db } from '@/lib/db'
import type { ExtractDeps } from '../extract/engine'
import { mergeState } from '../load/outcome'

/** A load put off by another one tries again after this. */
const BUSY_RETRY_S = 60
/**
 * How often a run tells the queue it is alive. The queue takes a job running ten minutes for stuck and runs it again
 * (`recoverStuckJobs`), and a load or a cutover can take longer.
 */
const HEARTBEAT_MS = 60_000
/** A run whose last heartbeat is older than the queue's stuck limit has no worker left. */
const STALE_MS = 10 * 60 * 1000
/** Failures kept in a dry run's summary; the count says how many there were. */
const FAILURES_KEPT = 50

/**
 * Where a run stands. `interrupted` is never stored: the import screen says it when the state says queued or running
 * and the job queue has no job for it (a paused connection, a plan that no longer has integrations).
 */
export type RunStatus = 'queued' | 'running' | 'done' | 'refused' | 'failed' | 'interrupted'

export interface LoadRunState {
  status: RunStatus
  dryRun: boolean
  at: string
  /** The queued run this is (the action's), so a second copy of its job knows it isn't needed. */
  token?: string
  /** The run's last heartbeat, while it runs. */
  beatAt?: string
  runId?: string
  /** Why it was refused: a sentence of the importer's own (never a record's data). */
  message?: string
}

export interface CutoverRunState {
  status: RunStatus
  dryRun: boolean
  at: string
  token?: string
  beatAt?: string
  completed?: boolean
  stoppedAt?: number | null
  steps?: { step: number; name: string; status: string; detail: string }[]
  message?: string
}

type Scope = { organizationId: string; connectionId: string }

const scopeOf = (ctx: ConnectorContext): Scope => ({
  organizationId: ctx.connection.organizationId,
  connectionId: ctx.connection.id,
})

const now = () => new Date().toISOString()

/** The connection's state, read now (a job's context was read when it started). */
async function stateOf(scope: Scope): Promise<Record<string, unknown>> {
  const row = await db.integrationConnection.findFirst({
    where: { id: scope.connectionId, organizationId: scope.organizationId },
    select: { state: true },
  })
  return (row?.state as Record<string, unknown> | null) ?? {}
}

/** The run the connection's state says is under way. */
async function runOf(scope: Scope, key: 'loadRun' | 'cutoverRun') {
  return ((await stateOf(scope))[key] ?? null) as {
    status?: string
    token?: string
    at?: string
    beatAt?: string
  } | null
}

/**
 * Whether this job is a copy of a run that already started: once a run with this token has left `queued` (the
 * action's, or a busy load's re-queue), only that first job runs it. `live` while its heartbeat is fresh, `crashed`
 * when the worker running it stopped without writing its end, `finished` once it wrote one; null for the first run.
 */
export async function copyOf(
  scope: Scope,
  key: 'loadRun' | 'cutoverRun',
  token: string
): Promise<'live' | 'crashed' | 'finished' | null> {
  if (!token) return null
  const run = await runOf(scope, key)
  if (!run || run.token !== token || run.status === 'queued') return null
  if (run.status !== 'running') return 'finished'
  const beat = Date.parse(run.beatAt ?? run.at ?? '')
  return Number.isFinite(beat) && Date.now() - beat < STALE_MS ? 'live' : 'crashed'
}

/**
 * While a run goes on: every minute, its job's lock is renewed, so the queue never takes it for stuck and starts it
 * again (and the screen, which reads the queue, keeps showing it), and `state.<key>.beatAt` says it is alive. Returns
 * the stop.
 */
export function keepAlive(
  scope: Scope,
  kind: 'load.run' | 'cutover.run',
  key: 'loadRun' | 'cutoverRun',
  everyMs = HEARTBEAT_MS
) {
  const beat = async () => {
    const at = new Date()
    await db.integrationJob.updateMany({
      where: {
        organizationId: scope.organizationId,
        connectionId: scope.connectionId,
        kind,
        status: 'running',
      },
      data: { lockedAt: at },
    })
    // Only the heartbeat, in one statement: the run's own state writes are never undone by it.
    await db.$executeRaw`
      UPDATE "public"."integration_connections"
      SET "state" = jsonb_set("state", ${`{${key},beatAt}`}::text[], to_jsonb(${at.toISOString()}::text))
      WHERE "id" = ${scope.connectionId} AND "organizationId" = ${scope.organizationId}
        AND "state" -> ${key} ->> 'status' = 'running'`
  }
  const timer = setInterval(() => {
    void beat().catch(() => undefined)
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** A copy's answer: a live run is left alone; one whose worker stopped is marked failed, for the operator to rerun. */
async function answerCopy(
  scope: Scope,
  key: 'loadRun' | 'cutoverRun',
  copy: 'live' | 'crashed' | 'finished',
  run: { dryRun: boolean; token: string },
  what: string
): Promise<JobOutcome> {
  if (copy === 'crashed') {
    await mergeState(scope, {
      [key]: { status: 'failed', dryRun: run.dryRun, at: now(), token: run.token },
    })
    return { summary: `The worker running this ${what} stopped: marked failed` }
  }
  return { summary: `This ${what} already ran or is running` }
}

/**
 * Why the screen won't load now, or null when it may: the archive is whole only once an extract has finished. A sync
 * run (`extract.sync`) follows a finished one. Checked when the load is queued and again when its job starts.
 */
export function extractBlocker(state: Record<string, unknown>): string | null {
  const extract = state.extract as { finishedAt?: string | null; sync?: boolean } | null | undefined
  if (!extract) return 'Nothing has been extracted from Shopmonkey yet: run the extract first.'
  if (!extract.sync && !extract.finishedAt) return 'The extract has not finished: load once it has.'
  return null
}

/** An error's class, never its message, which may quote a record. Refusals are the importer's own sentences. */
function refusal(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  return ['LoadRefused', 'CutoverRefused', 'UndoRefused'].includes(err.name) ? err.message : null
}

export function createRunJobs(deps: { depsFor(ctx: ConnectorContext): ExtractDeps }) {
  /** `load.run`: `{ dryRun, userId }`. */
  async function load(
    ctx: ConnectorContext,
    payload: Record<string, unknown>
  ): Promise<JobOutcome> {
    const scope = scopeOf(ctx)
    const dryRun = payload.dryRun === true
    const userId = typeof payload.userId === 'string' ? payload.userId : ''
    const token = typeof payload.token === 'string' ? payload.token : ''
    const copy = await copyOf(scope, 'loadRun', token)
    if (copy) return answerCopy(scope, 'loadRun', copy, { dryRun, token }, 'load')
    const blocked = extractBlocker(await stateOf(scope))
    if (blocked) {
      await mergeState(scope, {
        loadRun: { status: 'refused', dryRun, at: now(), message: blocked, token },
      })
      return { summary: `Load refused: ${blocked}` }
    }
    const { runLoad } = await import('../load/run')
    const { withLoadLock } = await import('../load/lock')
    await mergeState(scope, { loadRun: { status: 'running', dryRun, at: now(), token } })
    const stop = keepAlive(scope, 'load.run', 'loadRun')
    try {
      // A real load takes the load lock itself; a dry run takes it here, so it never runs beside a load either.
      const summary = dryRun
        ? await withLoadLock(scope.connectionId, () =>
            runLoad({ ...scope, runUserId: userId, dryRun })
          )
        : await runLoad({ ...scope, runUserId: userId, dryRun })
      if (dryRun) {
        await mergeState(scope, {
          lastDryRun: {
            at: now(),
            runId: summary.runId,
            counts: summary.counts,
            warnings: summary.warnings,
            failures: summary.failures.slice(0, FAILURES_KEPT),
            failureCount: summary.failures.length,
            proposals: summary.proposals,
          },
        })
      }
      const done: LoadRunState = {
        status: 'done',
        dryRun,
        at: now(),
        runId: summary.runId,
        token,
      }
      await mergeState(scope, { loadRun: done })
      return { summary: `${dryRun ? 'Dry run' : 'Load'} ${summary.runId} done` }
    } catch (err) {
      if (err instanceof Error && err.name === 'LoadBusy') {
        // Waits for the other load: queued again with its key and its one attempt, not the queue's own retry.
        await mergeState(scope, { loadRun: { status: 'queued', dryRun, at: now(), token } })
        await enqueueJob({
          ...scope,
          kind: 'load.run',
          payload: { dryRun, userId, token },
          idempotencyKey: 'load.run',
          maxAttempts: 1,
          runAfter: new Date(Date.now() + BUSY_RETRY_S * 1000),
        })
        return { summary: 'Another load is running: queued again' }
      }
      const message = refusal(err)
      const state: LoadRunState = message
        ? { status: 'refused', dryRun, at: now(), message, token }
        : { status: 'failed', dryRun, at: now(), token }
      await mergeState(scope, { loadRun: state })
      if (message) return { summary: `Load refused: ${message}` }
      throw err
    } finally {
      stop()
    }
  }

  /** `cutover.run`: `{ dryRun, userId }`. The screen's confirmation is the operator's word that the shop stopped. */
  async function cutover(
    ctx: ConnectorContext,
    payload: Record<string, unknown>
  ): Promise<JobOutcome> {
    const scope = scopeOf(ctx)
    const dryRun = payload.dryRun === true
    const userId = typeof payload.userId === 'string' ? payload.userId : ''
    const token = typeof payload.token === 'string' ? payload.token : ''
    const copy = await copyOf(scope, 'cutoverRun', token)
    if (copy) return answerCopy(scope, 'cutoverRun', copy, { dryRun, token }, 'cutover')
    const { runCutover } = await import('./cutover')
    await mergeState(scope, { cutoverRun: { status: 'running', dryRun, at: now(), token } })
    const stop = keepAlive(scope, 'cutover.run', 'cutoverRun')
    try {
      const result = await runCutover({
        ...scope,
        userId,
        shopStopped: true,
        dryRun,
        deps: deps.depsFor(ctx),
      })
      const state: CutoverRunState = {
        status: 'done',
        dryRun,
        at: now(),
        token,
        completed: result.completed,
        stoppedAt: result.stoppedAt,
        steps: result.steps,
      }
      await mergeState(scope, { cutoverRun: state })
      return {
        summary: result.completed
          ? `Cutover${dryRun ? ' dry run' : ''} done`
          : `Cutover${dryRun ? ' dry run' : ''} stopped at step ${result.stoppedAt}`,
      }
    } catch (err) {
      const message = refusal(err)
      const state: CutoverRunState = message
        ? { status: 'refused', dryRun, at: now(), message, token }
        : { status: 'failed', dryRun, at: now(), token }
      await mergeState(scope, { cutoverRun: state })
      if (message) return { summary: `Cutover refused: ${message}` }
      throw err
    } finally {
      stop()
    }
  }

  const handlers: Record<'load.run' | 'cutover.run', JobHandler> = {
    'load.run': load,
    'cutover.run': cutover,
  }
  return handlers
}
