/**
 * The import screen's own jobs (M8): a load (dry or real) and the cutover, queued by the operator and run by the job
 * queue, since either can take longer than a request. Each keeps where it stands in the connection's state, for the
 * screen to show: `state.loadRun`, `state.lastDryRun` (a dry run's summary) and `state.cutoverRun`.
 */
import type { ConnectorContext, JobHandler, JobOutcome } from '@/features/integrations/Lib/types'
import type { ExtractDeps } from '../extract/engine'
import { mergeState } from '../load/outcome'

/** A load put off by another one tries again after this. */
const BUSY_RETRY_S = 60
/** Failures kept in a dry run's summary; the count says how many there were. */
const FAILURES_KEPT = 50

export type RunStatus = 'queued' | 'running' | 'done' | 'refused' | 'failed'

export interface LoadRunState {
  status: RunStatus
  dryRun: boolean
  at: string
  runId?: string
  /** Why it was refused: a sentence of the importer's own (never a record's data). */
  message?: string
}

export interface CutoverRunState {
  status: RunStatus
  dryRun: boolean
  at: string
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
    const { runLoad } = await import('../load/run')
    await mergeState(scope, { loadRun: { status: 'running', dryRun, at: now() } })
    try {
      const summary = await runLoad({ ...scope, runUserId: userId, dryRun })
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
      const done: LoadRunState = { status: 'done', dryRun, at: now(), runId: summary.runId }
      await mergeState(scope, { loadRun: done })
      return { summary: `${dryRun ? 'Dry run' : 'Load'} ${summary.runId} done` }
    } catch (err) {
      if (err instanceof Error && err.name === 'LoadBusy') {
        await mergeState(scope, { loadRun: { status: 'queued', dryRun, at: now() } })
        return { summary: 'Another load is running', rescheduleInSeconds: BUSY_RETRY_S }
      }
      const message = refusal(err)
      const state: LoadRunState = message
        ? { status: 'refused', dryRun, at: now(), message }
        : { status: 'failed', dryRun, at: now() }
      await mergeState(scope, { loadRun: state })
      if (message) return { summary: `Load refused: ${message}` }
      throw err
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
    const { runCutover } = await import('./cutover')
    await mergeState(scope, { cutoverRun: { status: 'running', dryRun, at: now() } })
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
        ? { status: 'refused', dryRun, at: now(), message }
        : { status: 'failed', dryRun, at: now() }
      await mergeState(scope, { cutoverRun: state })
      if (message) return { summary: `Cutover refused: ${message}` }
      throw err
    }
  }

  const handlers: Record<'load.run' | 'cutover.run', JobHandler> = {
    'load.run': load,
    'cutover.run': cutover,
  }
  return handlers
}
