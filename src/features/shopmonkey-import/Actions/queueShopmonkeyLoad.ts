'use server'

import { z } from 'zod'
import { enqueueJob } from '@/features/integrations/Lib/jobs'
import { mergeState } from '@/integrations/shopmonkey/load/outcome'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

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
      if (connection.state.cutover) throw new Error('The import is cut over: nothing more is loaded.')
      const scope = { organizationId, connectionId: connection.id }
      await mergeState(scope, {
        loadRun: { status: 'queued', dryRun, at: new Date().toISOString() },
      })
      await enqueueJob({
        ...scope,
        kind: 'load.run',
        payload: { dryRun, userId },
        idempotencyKey: 'load.run',
        maxAttempts: 1,
      })
      return { queued: true }
    },
    { write: true }
  )
}
