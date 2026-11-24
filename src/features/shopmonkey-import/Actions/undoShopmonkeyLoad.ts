'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { undoLoad } from '@/integrations/shopmonkey/load/undo'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

const inputSchema = z.object({ runId: z.string().uuid() })

/** fork (M8): removes what one load created (M5), and nothing the workshop uses since. Not after cutover. */
export async function undoShopmonkeyLoad(input: unknown) {
  return withImportAuth(
    async ({ organizationId, userId }) => {
      const { runId } = inputSchema.parse(input)
      const connection = await shopmonkeyConnection(organizationId)
      if (connection.state.cutover) throw new Error('The import is cut over: its loads can no longer be undone here.')
      const result = await undoLoad({ organizationId, connectionId: connection.id, runId, userId })
      revalidatePath('/')
      return result
    },
    { write: true }
  )
}
