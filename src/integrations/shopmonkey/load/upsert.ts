/**
 * Writing one loaded record (M5 task 1): skip it when the source hash is the one it was loaded from, update its row
 * when the source changed, create it when it was never loaded (or its row was deleted in the app). Every write is
 * scoped by the workshop, inside the caller's transaction, and recorded with `markLoaded`.
 */
import type { Prisma } from '@/generated/prisma/client'
import { findLoaded, type LoadScope, type LocalModel, markLoaded } from './links'

export type UpsertResult = 'created' | 'updated' | 'unchanged'

export async function upsertLinked(
  tx: Prisma.TransactionClient,
  scope: LoadScope,
  record: { table: string; model: LocalModel; remoteId: string; hash: string },
  write: { create: () => Promise<string>; update: (localId: string) => Promise<void> }
): Promise<{ localId: string; result: UpsertResult }> {
  const found = await findLoaded(tx, scope, record.table, record.model, record.remoteId)
  if (found && found.hash === record.hash) return { localId: found.localId, result: 'unchanged' }
  if (found) {
    await write.update(found.localId)
    await markLoaded(tx, scope, { ...record, localId: found.localId, created: false })
    return { localId: found.localId, result: 'updated' }
  }
  const localId = await write.create()
  await markLoaded(tx, scope, { ...record, localId, created: true })
  return { localId, result: 'created' }
}
