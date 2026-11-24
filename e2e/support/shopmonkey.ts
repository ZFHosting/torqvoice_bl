import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'

/**
 * fork (M8): what the Shopmonkey import spec needs besides a browser: the job queue run (the server's timers are off)
 * and a look up of the row a Shopmonkey record became.
 */

/** The stand-in Shopmonkey (`e2e/shopmonkey-standin.ts`), as playwright.config.ts starts it. */
export const shopmonkeyStandinUrl = `http://127.0.0.1:${process.env.E2E_SHOPMONKEY_PORT ?? '8027'}`

/** The secret the app server signs sessions with (and seals connector keys from): the config's fallback when unset. */
const AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? 'k3Qb8vZ1hN7pXtR2yJm5Ls9CwD4gFa6UeH0iOoT+PbY='

/** Runs every integration job that is due, and those due within seconds, as the server's cron would. */
export function runQueuedJobs(): void {
  const databaseUrl = process.env.E2E_DATABASE_URL
  if (!databaseUrl) throw new Error('E2E_DATABASE_URL is not set. See e2e/README.md.')
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/tsx/dist/cli.mjs'),
      '--import',
      pathToFileURL(resolve('scripts/shopmonkey/register.mjs')).href,
      resolve('e2e/support/run-jobs.ts'),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: AUTH_SECRET,
        SHOPMONKEY_API_BASE_URL: shopmonkeyStandinUrl,
        TZ: process.env.E2E_TZ ?? 'Europe/Oslo',
        TORQVOICE_MODE: 'self-hosted',
        DEMO_MODE: 'false',
      },
      stdio: 'inherit',
      timeout: 180_000,
    }
  )
}

/** The id of the row a Shopmonkey record was loaded as (its link), or null. */
export async function loadedRow(
  model: string,
  table: string,
  remoteId: string
): Promise<string | null> {
  const db = new Client({ connectionString: process.env.E2E_DATABASE_URL })
  await db.connect()
  try {
    const result = await db.query<{ entityId: string }>(
      `select l."entityId" from integration_links l
         join integration_connections c on c.id = l."connectionId"
        where c."connectorId" = 'shopmonkey' and l."entityType" = $1 and l."remoteId" = $2
        limit 1`,
      [model, `${table}:${remoteId}`]
    )
    return result.rows[0]?.entityId ?? null
  } finally {
    await db.end()
  }
}
