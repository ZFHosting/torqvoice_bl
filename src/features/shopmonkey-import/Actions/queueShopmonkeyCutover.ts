'use server'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { enqueueJob } from '@/features/integrations/Lib/jobs'
import { demoGuard } from '@/lib/demo'
import { mergeState } from '@/integrations/shopmonkey/load/outcome'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'
import { liveJobs } from '../Lib/liveJobs.server'

/**
 * fork (M8): the cutover (M7, docs/fork/CUTOVER.md), or a dry run of it, queued for the job queue. The screen asks
 * the operator to confirm the shop has stopped editing Shopmonkey before it calls this: that confirmation is step 1.
 */
const inputSchema = z.object({ dryRun: z.boolean(), shopStopped: z.literal(true) })

export async function queueShopmonkeyCutover(input: unknown) {
  return withImportAuth(
    async ({ organizationId, userId }) => {
      demoGuard()
      const { dryRun } = inputSchema.parse(input)
      const connection = await shopmonkeyConnection(organizationId)
      if (connection.state.cutover) throw new Error('The import is already cut over.')
      const scope = { organizationId, connectionId: connection.id }
      // One at a time: a second cutover would start its own final delta over the first's.
      const live = await liveJobs(organizationId, connection.id)
      if (live.cutover || live.load)
        throw new Error('A load or the cutover is already queued or running.')
      const token = randomUUID()
      await mergeState(scope, {
        cutoverRun: { status: 'queued', dryRun, at: new Date().toISOString(), token },
      })
      await enqueueJob({
        ...scope,
        kind: 'cutover.run',
        payload: { dryRun, userId, token },
        idempotencyKey: 'cutover.run',
        maxAttempts: 1,
      })
      return { queued: true }
    },
    { write: true, plan: true }
  )
}
