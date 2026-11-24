/**
 * fork (M8): the integration job queue, run until nothing is due soon. The suite's server runs with
 * DISABLE_BACKGROUND_JOBS=1, so a spec that queues connector work (the Shopmonkey import) calls the processor itself
 * through this, as e2e/README.md asks. Run by `support/shopmonkey.ts` with the server's environment:
 *
 *   node node_modules/tsx/dist/cli.mjs --import ./scripts/shopmonkey/register.mjs e2e/support/run-jobs.ts
 */
import { runDueJobs } from '@/features/integrations/Lib/jobs'
import { db } from '@/lib/db'
import { endProcess } from '../../scripts/shopmonkey/exit'

const DEADLINE = Date.now() + Number(process.env.E2E_JOBS_TIMEOUT_MS ?? 150_000)
/** A job rescheduled this soon (an extract's next unit) is waited for; a later one is left. */
const SOON_MS = 5_000

async function main() {
  for (;;) {
    if (Date.now() > DEADLINE) throw new Error('Integration jobs were still queued at the deadline')
    if ((await runDueJobs(50)) > 0) continue
    const soon = await db.integrationJob.count({
      where: { status: 'queued', runAfter: { lte: new Date(Date.now() + SOON_MS) } },
    })
    if (soon === 0) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => endProcess(() => db.$disconnect()))
