'use server'

import { reconcile } from '@/integrations/shopmonkey/reconcile/engine'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

/** fork (M8): the reconciliation report (M6), run now and kept as the connection's last one. */
export async function reconcileShopmonkeyImport() {
  return withImportAuth(
    async ({ organizationId }) => {
      const connection = await shopmonkeyConnection(organizationId)
      const report = await reconcile({ organizationId, connectionId: connection.id })
      return { passed: report.passed }
    },
    { write: true }
  )
}
