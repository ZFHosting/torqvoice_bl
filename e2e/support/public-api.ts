import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'

/**
 * fork (A6): the public API spec's helpers: its fixtures in the suite's workshop (`public-api-fixtures.ts`, with the
 * app's server modules), and the webhook deliveries an event made.
 */

const AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? 'k3Qb8vZ1hN7pXtR2yJm5Ls9CwD4gFa6UeH0iOoT+PbY='

function fixtures(step: 'setup' | 'cleanup'): string {
  const databaseUrl = process.env.E2E_DATABASE_URL
  if (!databaseUrl) throw new Error('E2E_DATABASE_URL is not set. See e2e/README.md.')
  return execFileSync(
    process.execPath,
    [
      resolve('node_modules/tsx/dist/cli.mjs'),
      '--import',
      pathToFileURL(resolve('scripts/shopmonkey/register.mjs')).href,
      resolve('e2e/support/public-api-fixtures.ts'),
      step,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: AUTH_SECRET,
        TORQVOICE_MODE: 'self-hosted',
        DEMO_MODE: 'false',
      },
      encoding: 'utf-8',
      timeout: 120_000,
    }
  )
}

/** A full-access role for the spec's key and a webhook taking every event; their ids. */
export function setUpPublicApi(): { organizationId: string; roleId: string; webhookId: string } {
  const out = fixtures('setup').trim().split('\n').pop() ?? '{}'
  return JSON.parse(out)
}

/** Removes the spec's role, webhook, keys and the keys' service users. */
export function cleanUpPublicApi(): void {
  fixtures('cleanup')
}

/** The events a webhook was sent, oldest first. */
export async function deliveredEvents(webhookId: string): Promise<string[]> {
  const db = new Client({ connectionString: process.env.E2E_DATABASE_URL })
  await db.connect()
  try {
    const result = await db.query<{ event: string }>(
      `select event from webhook_deliveries where "webhookId" = $1 order by "createdAt", id`,
      [webhookId]
    )
    return result.rows.map((r) => r.event)
  } finally {
    await db.end()
  }
}
