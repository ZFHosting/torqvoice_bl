/**
 * One load at a time per connection (M7): the sync's jobs load on their own now, beside the CLI and the cutover, and
 * two loads at once could both create the record neither has linked yet. A PostgreSQL advisory lock taken inside a
 * transaction that stays open while the load runs (its own connection from the pool, writing nothing): released when
 * the load ends, and by PostgreSQL itself if the process dies, so a crash never leaves it held.
 */
import { db } from '@/lib/db'

/** Longer than any load: the transaction holding the lock is closed by Prisma after this. */
const HOLD_MS = 24 * 60 * 60_000

export class LoadBusy extends Error {
  constructor() {
    super('Another load of this connection is running; try again once it has finished.')
    this.name = 'LoadBusy'
  }
}

/** Runs `fn` holding the connection's load lock; throws `LoadBusy` at once when another load holds it. */
export async function withLoadLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  let held = false
  let out: T | undefined
  await db.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext('shopmonkey_load'), hashtext(${connectionId})) AS "locked"`
      if (!row?.locked) return
      held = true
      out = await fn()
    },
    { maxWait: 30_000, timeout: HOLD_MS }
  )
  if (!held) throw new LoadBusy()
  return out as T
}
