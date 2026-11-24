'use server'

import type { ExtractState } from '@/integrations/shopmonkey/extract/plan'
import { mergeState } from '@/integrations/shopmonkey/load/outcome'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

/** fork (M8): stops the extract in progress after the unit it is on; a resume carries on from there. */
export async function stopShopmonkeyExtract() {
  return withImportAuth(
    async ({ organizationId }) => {
      const connection = await shopmonkeyConnection(organizationId)
      const extract = connection.state.extract as ExtractState | undefined
      if (!extract?.runId || extract.finishedAt) throw new Error('No extract is running.')
      if (extract.sync)
        throw new Error('The ten-minute sync’s run isn’t stopped here; it ends on its own.')
      await mergeState(
        { organizationId, connectionId: connection.id },
        { extractStop: { runId: extract.runId } }
      )
      return { runId: extract.runId }
    },
    { write: true }
  )
}
