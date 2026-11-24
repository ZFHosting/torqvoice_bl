'use server'

import { enqueueJob } from '@/features/integrations/Lib/jobs'
import { demoGuard } from '@/lib/demo'
import type { ExtractState } from '@/integrations/shopmonkey/extract/plan'
import { mergeState } from '@/integrations/shopmonkey/load/outcome'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

/** fork (M8): carries a stopped extract on from its last saved unit. */
export async function resumeShopmonkeyExtract() {
  return withImportAuth(
    async ({ organizationId }) => {
      demoGuard()
      const connection = await shopmonkeyConnection(organizationId)
      const extract = connection.state.extract as ExtractState | undefined
      if (!extract?.runId || extract.finishedAt) throw new Error('No extract to carry on.')
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
