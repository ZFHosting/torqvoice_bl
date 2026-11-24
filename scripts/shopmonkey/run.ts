/**
 * fork: the Shopmonkey importer's command line (docs/fork/milestones/M3-extract-and-stage.md, task 7).
 *
 *   npx tsx --conditions=react-server scripts/shopmonkey/run.ts extract --connection <id> \
 *     [--tables customer,order] [--since 2026-01-01T00:00:00Z] [--restart]
 *
 * Drives the same extract steps the job queue runs, in-process and without the queue's pauses, saving
 * the checkpoint after every unit: stop it at any time and run it again to carry on. It takes over from
 * a run the queue was driving (that run's next save fails, and it stops). Reads Shopmonkey only; writes the
 * workshop's own archive (`SourceRecord`) and the staging folder, in whatever database DATABASE_URL names.
 * `--conditions=react-server` lets it load the app's server-only modules outside Next.js.
 *
 *   npx tsx --conditions=react-server scripts/shopmonkey/run.ts load --connection <id> \
 *     [--dry-run] [--apply-numbering] [--apply-settings] [--user <id>]
 *
 * Loads the archive into the workshop (M5): every record in its own transaction, idempotent, undoable by its run
 * id. `--dry-run` runs every transaction and rolls it back, and prints what would change. The numbering and
 * settings it proposes are applied only with `--apply-numbering` / `--apply-settings`. Writes to whatever database
 * DATABASE_URL names: point it at the workshop's own database, never at one you aren't migrating.
 *
 *   npx tsx --conditions=react-server scripts/shopmonkey/run.ts undo --connection <id> --run <run id> [--user <id>]
 *
 * Removes what that load created (and nothing the workshop uses since); settings it applied stay.
 *
 *   npx tsx --conditions=react-server scripts/shopmonkey/run.ts reconcile --connection <id> [--json]
 *
 * Reconciles the import (M6): every staged record accounted for, money per work order and by month, receivables,
 * spot checks, warnings and unmapped fields, and the gates cutover waits on. Kept as the connection's
 * `state.lastReconciliation`; `--json` prints the whole report. Exits 2 when a gate fails. Writes nothing else.
 *
 *   npx tsx --conditions=react-server scripts/shopmonkey/run.ts cutover --connection <id> --shop-stopped \
 *     [--dry-run] [--user <id>]
 *
 * Ends the sync window (M7, docs/fork/CUTOVER.md): a final delta and load, the reconciliation (stops on a failing
 * gate, exit 2), numbering, the connection marked cut over, the sync's jobs cancelled, and a reminder of what to do in
 * Shopmonkey. `--dry-run` goes through every step and changes nothing in the workshop.
 */
import { randomUUID } from 'node:crypto'
import { loadConnection } from '@/features/integrations/Lib/connections'
import { saveExtractState } from '@/features/shopmonkey-import/Lib/extractState.server'
import { driveExtract, parseExtractArgs, runToDrive } from '@/integrations/shopmonkey/extract/cli'
import {
  formatLoadSummary,
  formatUndoSummary,
  parseLoadArgs,
  parseUndoArgs,
} from '@/integrations/shopmonkey/load/cli'
import { runLoad } from '@/integrations/shopmonkey/load/run'
import { reconcile } from '@/integrations/shopmonkey/reconcile/engine'
import { formatReport, parseReconcileArgs } from '@/integrations/shopmonkey/reconcile/format'
import { undoLoad } from '@/integrations/shopmonkey/load/undo'
import { extractDepsFor, recordExtractFinished } from '@/integrations/shopmonkey/server'
import { formatCutoverResult, parseCutoverArgs } from '@/integrations/shopmonkey/sync/cli'
import { runCutover } from '@/integrations/shopmonkey/sync/cutover'
import { db } from '@/lib/db'

async function load() {
  const args = parseLoadArgs(process.argv.slice(2))
  const connection = await db.integrationConnection.findUnique({
    where: { id: args.connection },
    select: { id: true, organizationId: true, connectorId: true, createdById: true },
  })
  if (!connection || connection.connectorId !== 'shopmonkey') {
    throw new Error('That connection is not a Shopmonkey connection')
  }
  const userId = args.user ?? connection.createdById
  const member = await db.organizationMember.findFirst({
    where: { organizationId: connection.organizationId, userId },
    select: { id: true },
  })
  if (!member) throw new Error('The run must act as a member of the workshop: pass --user <id>')
  const summary = await runLoad({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    runUserId: userId,
    dryRun: args.dryRun,
    applyNumbering: args.applyNumbering,
    applySettings: args.applySettings,
  })
  for (const line of formatLoadSummary(summary)) console.log(line)
}

async function undo() {
  const args = parseUndoArgs(process.argv.slice(2))
  const connection = await db.integrationConnection.findUnique({
    where: { id: args.connection },
    select: { id: true, organizationId: true, connectorId: true, createdById: true },
  })
  if (!connection || connection.connectorId !== 'shopmonkey') {
    throw new Error('That connection is not a Shopmonkey connection')
  }
  // undoLoad refuses anyone who isn't a member of the workshop.
  const result = await undoLoad({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    runId: args.run,
    userId: args.user ?? connection.createdById,
  })
  for (const line of formatUndoSummary(args.run, result)) console.log(line)
}

async function reconcileCommand() {
  const args = parseReconcileArgs(process.argv.slice(2))
  const connection = await db.integrationConnection.findUnique({
    where: { id: args.connection },
    select: { id: true, organizationId: true, connectorId: true },
  })
  if (!connection || connection.connectorId !== 'shopmonkey') {
    throw new Error('That connection is not a Shopmonkey connection')
  }
  const report = await reconcile({
    organizationId: connection.organizationId,
    connectionId: connection.id,
  })
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else for (const line of formatReport(report)) console.log(line)
  if (!report.passed) process.exitCode = 2
}

async function cutover() {
  const args = parseCutoverArgs(process.argv.slice(2))
  const { ctx } = await loadConnection(args.connection)
  if (ctx.connection.connectorId !== 'shopmonkey') {
    throw new Error('That connection is not a Shopmonkey connection')
  }
  const connection = await db.integrationConnection.findUniqueOrThrow({
    where: { id: args.connection },
    select: { createdById: true },
  })
  // runCutover refuses anyone who isn't a member of the workshop.
  const result = await runCutover({
    organizationId: ctx.connection.organizationId,
    connectionId: ctx.connection.id,
    userId: args.user ?? connection.createdById,
    shopStopped: args.shopStopped,
    dryRun: args.dryRun,
    deps: extractDepsFor(ctx),
    print: (line) => console.log(line),
  })
  for (const line of formatCutoverResult(result)) console.log(line)
  if (!result.completed) process.exitCode = 2
}

async function main() {
  if (process.argv[2] === 'load') return load()
  if (process.argv[2] === 'cutover') return cutover()
  if (process.argv[2] === 'reconcile') return reconcileCommand()
  if (process.argv[2] === 'undo') return undo()
  const args = parseExtractArgs(process.argv.slice(2))
  const { ctx } = await loadConnection(args.connection)
  if (ctx.connection.connectorId !== 'shopmonkey') {
    throw new Error('That connection is not a Shopmonkey connection')
  }
  // M7: after cutover nothing more is read from Shopmonkey.
  if (ctx.connection.state.cutover) {
    throw new Error('The import is cut over: nothing more is read from Shopmonkey.')
  }
  const { state, resumed } = runToDrive(
    ctx.connection.state.extract as never,
    args,
    randomUUID(),
    new Date()
  )
  await ctx.saveState({ extract: state })
  console.log(resumed ? 'Carrying on from the last checkpoint.' : 'Starting a new extract.')
  const scope = { connectionId: ctx.connection.id, organizationId: ctx.connection.organizationId }
  const { state: finished, replaced } = await driveExtract({
    deps: extractDepsFor(ctx),
    state,
    // Only while this is still the connection's run: a start from the app replaces it.
    save: (next) => saveExtractState(scope, next),
    print: (line) => console.log(line),
  })
  if (replaced) {
    console.log('Another extract was started for this connection; this one stopped.')
    return
  }
  await recordExtractFinished(ctx, finished)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
