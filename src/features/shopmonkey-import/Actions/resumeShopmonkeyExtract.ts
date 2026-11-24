'use server'

import { enqueueJob } from '@/features/integrations/Lib/jobs'
import { demoGuard } from '@/lib/demo'
import type { ExtractState } from '@/integrations/shopmonkey/extract/plan'
import { mergeState } from '@/integrations/shopmonkey/load/outcome'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'
import { liveJobs } from '../Lib/liveJobs.server'

/** fork (M8): carries a stopped extract on from its last saved unit. */
export async function resumeShopmonkeyExtract() {
  return withImportAuth(
    async ({ organizationId }) => {
      demoGuard()
      const connection = await shopmonkeyConnection(organizationId)
      const extract = connection.state.extract as ExtractState | undefined
      if (!extract?.runId || extract.finishedAt) throw new Error('No extract to carry on.')
      // The sync carries its own runs on; and a stop takes effect after the unit under way: until its job has ended,
      // a resume would start a second job on the same run.
      if (extract.sync) throw new Error('The ten-minute sync carries its own runs on.')
      if ((await liveJobs(organizationId, connection.id)).extract) {
        throw new Error('The extract is still stopping; try again in a moment.')
      }
      const scope = { organizationId, connectionId: connection.id }
      await mergeState(scope, { extractStop: null })
      await enqueueJob({
        ...scope,
        kind: 'extract.step',
        payload: { runId: extract.runId },
        idempotencyKey: `extract:${extract.runId}`,
      })
      return { runId: extract.runId }
    },
    { write: true }
  )
}
