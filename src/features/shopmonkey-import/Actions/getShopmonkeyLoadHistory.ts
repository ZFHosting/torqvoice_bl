'use server'

import { loadHistory } from '../Lib/importView.server'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

/**
 * fork (M8): the loads of the Shopmonkey connection with whether each was undone, for the import screen's history.
 * Not polled: the screen reads it when it opens and when a load or an undo ends.
 */
export async function getShopmonkeyLoadHistory() {
  return withImportAuth(
    async ({ organizationId }) => {
      const connection = await shopmonkeyConnection(organizationId)
      return loadHistory(organizationId, connection.id)
    },
    { write: false }
  )
}
