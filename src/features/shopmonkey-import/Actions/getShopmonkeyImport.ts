'use server'

import { importView } from '../Lib/importView.server'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

/** fork (M8): where the Shopmonkey import stands, polled by the import screen. */
export async function getShopmonkeyImport() {
  return withImportAuth(
    async ({ organizationId }) =>
      importView(organizationId, await shopmonkeyConnection(organizationId)),
    { write: false }
  )
}
