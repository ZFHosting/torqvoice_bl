/**
 * One load at a time per connection (M7): the sync's jobs load on their own now, beside the CLI and the cutover, and
 * two loads at once could both create the record neither has linked yet. A PostgreSQL session advisory lock, taken on
 * a connection of its own (not one of the app's pool, and not inside `db.$transaction`, which would hold the pool
 * connection for the whole load and hold back every realtime announcement until it ended). Released when the load
 * ends, and by PostgreSQL itself if the process dies, since the lock goes with its connection.
 */
import { Client } from 'pg'

export class LoadBusy extends Error {
  constructor() {
    super('Another load of this connection is running; try again once it has finished.')
    this.name = 'LoadBusy'
  }
}

/** Runs `fn` holding the connection's load lock; throws `LoadBusy` at once when another load holds it. */
export async function withLoadLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  // A dropped connection (a restart, a terminated backend) is an 'error' event on the client: without a listener it
  // would end the process. The lock went with the connection; the load carries on, and says so when it's done.
  let lost: Error | null = null
  client.on('error', (err) => {
    lost = err
  })
  await client.connect()
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('shopmonkey_load'), hashtext($1)) AS "locked"`,
      [connectionId]
    )
    if (!rows[0]?.locked) throw new LoadBusy()
    try {
      const out = await fn()
      if (lost) console.warn('[shopmonkey] the load lock was lost while the load ran')
      return out
    } finally {
      await client
        .query(`SELECT pg_advisory_unlock(hashtext('shopmonkey_load'), hashtext($1))`, [
          connectionId,
        ])
        .catch(() => undefined)
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}
