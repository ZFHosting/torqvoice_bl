'use server'

import { startShopmonkeyExtract } from '../Lib/startExtract.server'
import { demoGuard } from '@/lib/demo'
import { mergeState } from '@/integrations/shopmonkey/load/outcome'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'
import { liveJobs } from '../Lib/liveJobs.server'

/** fork (M8): a new extract of everything, run by the job queue. Replaces a run in progress. */
export async function startShopmonkeyImportExtract() {
  return withImportAuth(
    async ({ organizationId }) => {
      demoGuard()
      const connection = await shopmonkeyConnection(organizationId)
      if (connection.state.cutover)
        throw new Error('The import is cut over: nothing more comes from Shopmonkey.')
      // Not under a load or the cutover: they read the archive the extract writes.
      const live = await liveJobs(organizationId, connection.id)
      if (live.load || live.cutover) throw new Error('Wait for the load or the cutover to finish.')
      await mergeState({ organizationId, connectionId: connection.id }, { extractStop: null })
      return startShopmonkeyExtract({ organizationId, connectionId: connection.id })
    },
    { write: true }
  )
}
