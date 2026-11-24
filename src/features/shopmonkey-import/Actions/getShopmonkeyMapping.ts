'use server'

import { mappingView } from '../Lib/importView.server'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

/** fork (M8): the workflow statuses and users staged from Shopmonkey, with what each becomes in the load. */
export async function getShopmonkeyMapping() {
  return withImportAuth(
    async ({ organizationId }) =>
      mappingView(organizationId, (await shopmonkeyConnection(organizationId)).state),
    { write: false }
  )
}
