/**
 * Cutover (M7 task 5, docs/fork/CUTOVER.md): the end of the sync window, in the brief's order. It stops at the first
 * step that fails, so nothing after a failing reconciliation changes the workshop.
 *   1. The shop has stopped editing Shopmonkey (the operator says so: `shopStopped`).
 *   2. A final delta for every table, then a load and the delete policy.
 *   3. The reconciliation; any gate failing stops the cutover.
 *   4. The numbering proposal (MAPPING §9) applied.
 *   5. `state.cutover` set: the banners go (M8) and the sync stops for good.
 *   6. The sync's queued jobs cancelled; the schedule and the webhook do nothing from now on.
 *   7. A reminder: delete the webhook in Shopmonkey and revoke the API key.
 * A dry run goes through every step and changes nothing in the workshop: its load is rolled back, its proposals
 * aren't applied, nothing is set or cancelled. Its delta does stage what changed, as the sync would; its
 * reconciliation is of what is loaded now, so changes the delta staged count as differences until a real run loads
 * them.
 */
import { randomUUID } from 'node:crypto'
import { saveExtractState } from '@/features/shopmonkey-import/Lib/extractState.server'
import { auditDetails, logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import type { ExtractDeps } from '../extract/engine'
import type { ExtractState } from '../extract/plan'
import type { Tx } from '../load/context'
import { LoadRefused } from '../load/finish'
import { LoadBusy } from '../load/lock'
import { mergeState } from '../load/outcome'
import { applySettingChanges, proposeNumbering } from '../load/proposals'
import { runLoad } from '../load/run'
import { reconcile } from '../reconcile/engine'
import type { ReconciliationReport } from '../reconcile/types'
import { applyRemoteDeletes } from './deletes'
import { changedRecords, deltaStart, driveDelta } from './delta'
import type { CutoverState } from './jobs'

/** The sync's own jobs: cancelled at cutover. */
export const SYNC_JOBS = ['refetch', 'sync.delta', 'sync.load']

export const CUTOVER_STEPS = [
  'The shop has stopped editing Shopmonkey',
  'Final delta and load',
  'Reconciliation',
  'Numbering',
  'Cutover recorded',
  'Sync off',
  'Reminder',
] as const

export interface CutoverStep {
  step: number
  name: string
  /** `would`: what a dry run would have done. */
  status: 'done' | 'would' | 'failed'
  detail: string
}

export interface CutoverResult {
  dryRun: boolean
  /** Every step ran (in a dry run: would have). */
  completed: boolean
  /** The step that failed, or null. */
  stoppedAt: number | null
  steps: CutoverStep[]
  reconciliation: ReconciliationReport | null
}

export const REMINDER =
  'In Shopmonkey, delete the webhook pointing at Torqvoice (Settings, Integration, Webhooks) and revoke the API ' +
  'key the import used (Settings, Integration, API Keys).'

export class CutoverRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CutoverRefused'
  }
}

export async function runCutover(options: {
  organizationId: string
  connectionId: string
  /** The member doing it: the load's user, the audit event's. */
  userId: string
  shopStopped: boolean
  dryRun: boolean
  deps: ExtractDeps
  print?: (line: string) => void
}): Promise<CutoverResult> {
  const scope = { organizationId: options.organizationId, connectionId: options.connectionId }
  const dry = options.dryRun
  const connection = await db.integrationConnection.findFirst({
    where: {
      id: scope.connectionId,
      organizationId: scope.organizationId,
      connectorId: 'shopmonkey',
    },
    select: { state: true },
  })
  if (!connection) throw new CutoverRefused('That is not a Shopmonkey connection of this workshop.')
  const member = await db.organizationMember.findFirst({
    where: { organizationId: scope.organizationId, userId: options.userId },
    select: { id: true },
  })
  if (!member) throw new CutoverRefused('A cutover is done by a member of the workshop.')
  const state = (connection.state ?? {}) as {
    extract?: ExtractState
    lastLoad?: unknown
    cutover?: CutoverState
  }
  if (state.cutover) throw new CutoverRefused(`Already cut over at ${state.cutover.at}.`)

  const steps: CutoverStep[] = []
  let reconciliation: ReconciliationReport | null = null
  const record = (status: CutoverStep['status'], detail: string) => {
    const step = { step: steps.length + 1, name: CUTOVER_STEPS[steps.length], status, detail }
    steps.push(step)
    options.print?.(`${step.step}. ${step.name}: ${status}. ${detail}`)
    return status !== 'failed'
  }
  const finish = (): CutoverResult => {
    const failed = steps.find((s) => s.status === 'failed')
    return {
      dryRun: dry,
      completed: !failed && steps.length === CUTOVER_STEPS.length,
      stoppedAt: failed?.step ?? null,
      steps,
      reconciliation,
    }
  }
  const done = dry ? 'would' : 'done'

  // 1. The operator's word that nobody edits in Shopmonkey any more: what changes after the final delta is lost.
  if (!options.shopStopped) {
    record('failed', 'Stop editing in Shopmonkey first, then run it again with --shop-stopped.')
    return finish()
  }
  record('done', 'Confirmed by the operator.')

  // 2. The final delta, then the load (rolled back in a dry run) and the delete policy.
  const previous = state.extract
  if (!previous?.finishedAt && !previous?.sync) {
    record('failed', previous ? 'An extract is still running.' : 'No extract has finished yet.')
    return finish()
  }
  if (!state.lastLoad) {
    record('failed', 'Run the first load (run.ts load) before cutting over.')
    return finish()
  }
  // Marked a sync run: if this stops halfway, the sync carries it on instead of waiting on it for ever.
  const run = previous.finishedAt
    ? deltaStart(previous, { runId: randomUUID(), now: new Date(), sync: true })
    : previous
  if (run !== previous) await mergeState(scope, { extract: run })
  const extracted = await driveDelta(options.deps, run, {
    budgetMs: Number.POSITIVE_INFINITY,
    save: (next) => saveExtractState(scope, next),
  })
  if (extracted.replaced) {
    record('failed', 'Another extract replaced the final delta; run the cutover again.')
    return finish()
  }
  const changed = changedRecords(extracted.state)
  let loadDetail: string
  try {
    const summary = await runLoad({ ...scope, runUserId: options.userId, dryRun: dry })
    const written = Object.values(summary.counts).reduce((a, c) => a + c.created + c.updated, 0)
    loadDetail = `${changed} records changed in Shopmonkey; the load ${dry ? 'would write' : 'wrote'} ${written}, ${summary.failures.length} failed.`
    if (!dry) {
      const deletes = await applyRemoteDeletes({ ...scope, runId: summary.runId }, options.userId)
      loadDetail += ` ${deletes.deleted.length} deleted in Torqvoice, ${deletes.kept.length} deletes kept.`
    }
  } catch (err) {
    if (err instanceof LoadBusy || err instanceof LoadRefused) {
      record('failed', err.message)
      return finish()
    }
    throw err
  }
  record(done, loadDetail)

  // 3. The reconciliation: any gate failing stops it here.
  reconciliation = await reconcile(scope)
  const failing = Object.entries(reconciliation.gates).filter(([, gate]) => !gate.passed)
  if (failing.length) {
    record(
      'failed',
      `Gates failing: ${failing.map(([name, gate]) => `${name} (${gate.summary})`).join('; ')}`
    )
    return finish()
  }
  record('done', 'Every gate passes.')

  // 4. Numbering (MAPPING §9): the next invoice follows Shopmonkey's last.
  const numbering = await proposeNumbering(db as unknown as Tx, scope.organizationId)
  const changes = numbering.changes.map((c) => `${c.key} ${c.current ?? '(unset)'} → ${c.proposed}`)
  if (!dry) await applySettingChanges(scope.organizationId, options.userId, numbering.changes)
  record(done, changes.length ? changes.join('; ') : 'Nothing to change.')

  // 5. Cut over: the banners go and the sync stops.
  const at = new Date().toISOString()
  if (!dry) {
    const cutover: CutoverState = { at, userId: options.userId }
    await mergeState(scope, { cutover })
  }
  record(done, `The connection is marked cut over${dry ? '' : ` at ${at}`}.`)

  // 6. The sync's waiting jobs cancelled; from now on the schedule and the webhook find `cutover` and do nothing.
  const where = { connectionId: scope.connectionId, status: 'queued', kind: { in: SYNC_JOBS } }
  const cancelled = dry
    ? await db.integrationJob.count({ where })
    : (
        await db.integrationJob.updateMany({
          where,
          data: { status: 'failed', finishedAt: new Date(), error: 'Cut over' },
        })
      ).count
  record(done, `${cancelled} queued sync jobs ${dry ? 'would be ' : ''}cancelled.`)

  // 7. What only the operator can do, in Shopmonkey.
  record('done', REMINDER)

  if (!dry) {
    await logAudit(
      { userId: options.userId, organizationId: scope.organizationId },
      {
        action: 'shopmonkey.cutover',
        entity: 'integration_connection',
        entityId: scope.connectionId,
        details: auditDetails('shopmonkey_cutover'),
        metadata: { at, numbering: numbering.changes.map((c) => c.key), cancelled },
      }
    )
  }
  return finish()
}
