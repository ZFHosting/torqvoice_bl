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
 *   npx tsx --conditions=react-server scripts/shopmonkey/run.ts load --connection <id>  *     [--dry-run] [--apply-numbering] [--apply-settings] [--user <id>]
 *
 * Loads the archive into the workshop (M5): every record in its own transaction, idempotent, undoable by its run
 * id. `--dry-run` runs every transaction and rolls it back, and prints what would change. The numbering and
 * settings it proposes are applied only with `--apply-numbering` / `--apply-settings`. Writes to whatever database
 * DATABASE_URL names: point it at the workshop's own database, never at one you aren't migrating.
 */
import { randomUUID } from 'node:crypto'
import { loadConnection } from '@/features/integrations/Lib/connections'
import { saveExtractState } from '@/features/shopmonkey-import/Lib/extractState.server'
import { driveExtract, parseExtractArgs, runToDrive } from '@/integrations/shopmonkey/extract/cli'
import { formatLoadSummary, parseLoadArgs } from '@/integrations/shopmonkey/load/cli'
import { runLoad } from '@/integrations/shopmonkey/load/run'
import { extractDepsFor, recordExtractFinished } from '@/integrations/shopmonkey/server'
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

async function main() {
  if (process.argv[2] === 'load') return load()
  const args = parseExtractArgs(process.argv.slice(2))
  const { ctx } = await loadConnection(args.connection)
  if (ctx.connection.connectorId !== 'shopmonkey') {
    throw new Error('That connection is not a Shopmonkey connection')
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
