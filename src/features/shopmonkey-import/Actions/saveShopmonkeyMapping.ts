'use server'

import { z } from 'zod'
import { STAGES } from '@/features/work-order-statuses/Lib/stages'
import { db } from '@/lib/db'
import { mergeState } from '@/integrations/shopmonkey/load/outcome'
import { shopmonkeyConnection, withImportAuth } from '../Lib/importAuth.server'

const remoteId = z.string().min(1).max(100)
const inputSchema = z.object({
  statusStageMap: z.record(remoteId, z.enum(STAGES)),
  /** A technician of the workshop, `create`, or left out for the load's own choice. */
  technicianMap: z.record(remoteId, z.string().min(1).max(100)),
})

/**
 * fork (M8): the operator's stage per Shopmonkey workflow status and technician per Shopmonkey user, saved on the
 * connection (`state.mapping`) for every load to use: the screen's, the CLI's and the sync's.
 */
export async function saveShopmonkeyMapping(input: unknown) {
  return withImportAuth(
    async ({ organizationId }) => {
      const mapping = inputSchema.parse(input)
      const connection = await shopmonkeyConnection(organizationId)
      // A technician id from the browser has to be this workshop's.
      const chosen = [...new Set(Object.values(mapping.technicianMap))].filter(
        (v) => v !== 'create'
      )
      const own = await db.technician.findMany({
        where: { organizationId, id: { in: chosen } },
        select: { id: true },
      })
      if (own.length !== chosen.length)
        throw new Error('That technician is not one of this workshop.')
      await mergeState({ organizationId, connectionId: connection.id }, { mapping })
      return { saved: true }
    },
    { write: true }
  )
}
