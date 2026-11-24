'use server'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { enqueueJob } from '@/features/integrations/Lib/jobs'
import { mergeState } from '@/integrations/shopmonkey/load/outcome'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'
import { liveJobs } from '../Lib/liveJobs.server'

const inputSchema = z.object({ dryRun: z.boolean() })

/**
 * fork (M8): a load of the archive into the workshop, or a dry run of one, queued for the job queue (it can take
 * longer than a request). The person queuing it is the load's user.
 */
export async function queueShopmonkeyLoad(input: unknown) {
  return withImportAuth(
    async ({ organizationId, userId }) => {
      const { dryRun } = inputSchema.parse(input)
      const connection = await shopmonkeyConnection(organizationId)
      if (connection.state.cutover)
        throw new Error('The import is cut over: nothing more is loaded.')
      const scope = { organizationId, connectionId: connection.id }
      // One at a time, whichever tab asks: a second would wait on the first's lock and then run it all again.
      const live = await liveJobs(organizationId, connection.id)
      if (live.load || live.cutover)
        throw new Error('A load or the cutover is already queued or running.')
      const token = randomUUID()
      await mergeState(scope, {
        loadRun: { status: 'queued', dryRun, at: new Date().toISOString(), token },
      })
      await enqueueJob({
        ...scope,
        kind: 'load.run',
        payload: { dryRun, userId, token },
        idempotencyKey: 'load.run',
        maxAttempts: 1,
      })
      return { queued: true }
    },
    { write: true }
  )
}
