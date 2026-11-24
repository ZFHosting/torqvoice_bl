import type {
  ConnectorContext,
  ConnectorServer,
  JobHandler,
  SettingOption,
} from '@/features/integrations/Lib/types'
import { saveExtractState } from '@/features/shopmonkey-import/Lib/extractState.server'
import { auditDetails, logAudit } from '@/lib/audit'
import {
  BACKFILL_BUDGET,
  createShopmonkeyClient,
  INTERACTIVE_BUDGET,
  type RetryBudget,
  ShopmonkeyError,
} from './client'
import { type ExtractDeps, extractFor, extractSettings } from './extract/engine'
import { createFileStager } from './extract/files'
import type { ExtractState } from './extract/plan'
import { prismaSourceStore } from './extract/stage'
import { manifest } from './manifest'

/** How long one job run keeps extracting before it hands back to the queue (the cron runs each minute). */
const EXTRACT_BUDGET_MS = 45_000

/**
 * The Shopmonkey connector (docs/fork/milestones/M2-connector-and-client.md): proves the key, names
 * the company, lists its locations. Extracting, transforming and loading come in M3–M5 as jobs.
 */

/**
 * The client for a connection: its key on every request, its log for failures and retries. A job
 * takes the backfill budget (waits out a rate limit); a connect check, with someone watching, gives up
 * fast.
 */
export function shopmonkeyClientFor(ctx: ConnectorContext, budget: RetryBudget = BACKFILL_BUDGET) {
  const apiKey = typeof ctx.credentials.apiKey === 'string' ? ctx.credentials.apiKey : ''
  return createShopmonkeyClient({
    fetch: (url, init) =>
      ctx.http.fetch(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          Authorization: `Bearer ${apiKey}`,
        },
      }),
    log: (level, message, details) => ctx.log(level, message, details),
    budget,
  })
}

/**
 * PROVISIONAL(M0:S1): the shape of `GET /v3/user/me` is from Shopmonkey's docs, not a recorded
 * response; `companyId` or `company.id`, and the locations the key can reach.
 */
interface UserMe {
  companyId?: string
  company?: { id?: string; name?: string }
  locations?: { id: string; name?: string }[]
}

type Location = { id: string; name?: string }
const toOption = (l: Location): SettingOption => ({ value: l.id, label: l.name || l.id })

/** What the extractor needs, from a connection's context: the same code the CLI and the tests drive. */
export function extractDepsFor(ctx: ConnectorContext): ExtractDeps {
  const scope = { organizationId: ctx.connection.organizationId, connectionId: ctx.connection.id }
  return {
    client: shopmonkeyClientFor(ctx),
    store: prismaSourceStore(scope),
    files: createFileStager({ connectionId: ctx.connection.id }),
    settings: extractSettings(ctx.connection.settings, ctx.timezone),
    companyId: ctx.connection.externalAccountId,
    log: (level, message, details) => ctx.log(level, message, details),
  }
}

/** Records written in a run: new or changed, the tables' own and their children. */
export function recordsWritten(state: ExtractState): number {
  let total = 0
  for (const cp of Object.values(state.steps)) {
    total += cp.counts.created + cp.counts.updated + cp.children.created + cp.children.updated
  }
  return total
}

/** The one audit event a finished run records (the job and the CLI both call it). */
export async function recordExtractFinished(ctx: ConnectorContext, state: ExtractState) {
  await logAudit(
    { userId: '', organizationId: ctx.connection.organizationId },
    {
      action: 'shopmonkey.extract',
      entity: 'integration_connection',
      entityId: ctx.connection.id,
      details: auditDetails('shopmonkey_extract', {
        records: recordsWritten(state),
        count: state.calls,
      }),
      metadata: { runId: state.runId, since: state.since, only: state.only },
    }
  )
}

/**
 * One job run of an extract started by `startShopmonkeyExtract` (features/shopmonkey-import): units of
 * work for up to EXTRACT_BUDGET_MS, then the queue runs it again. A run another start replaced (its
 * `runId` no longer the state's) stops quietly. One audit event when the run finishes; never one per
 * record, which would fire a webhook per row (FORK.md).
 */
async function extractStepJob(ctx: ConnectorContext, payload: Record<string, unknown>) {
  const state = ctx.connection.state.extract as ExtractState | undefined
  if (!state || state.runId !== payload.runId || state.finishedAt) {
    return { summary: 'No extract to continue' }
  }
  try {
    const result = await extractFor(extractDepsFor(ctx), state, {
      budgetMs: EXTRACT_BUDGET_MS,
      // Only while this is still the connection's run: a new start or the CLI replaces it.
      save: (next) =>
        saveExtractState(
          { connectionId: ctx.connection.id, organizationId: ctx.connection.organizationId },
          next
        ),
    })
    if (result.replaced) return { summary: 'Replaced by a newer extract' }
    if (!result.done) {
      // A line for the log when a table changes hands, not one per unit.
      const moved = result.state.step !== state.step
      return { rescheduleInSeconds: 1, ...(moved ? { summary: result.summary } : {}) }
    }
    await recordExtractFinished(ctx, result.state)
    return { summary: result.summary }
  } catch (err) {
    // A rate limit longer than the client waits out: come back when Shopmonkey says to.
    if (err instanceof ShopmonkeyError && err.status === 429 && err.retryAfterS !== null) {
      return { summary: 'Rate limited by Shopmonkey', rescheduleInSeconds: err.retryAfterS + 1 }
    }
    throw err
  }
}

/** M7: a sync job, its module loaded on its first run (the registry loads every connector's server). */
function syncJob(kind: 'refetch' | 'sync.delta' | 'sync.load'): JobHandler {
  return async (ctx, payload) => {
    const { createSyncJobs } = await import('./sync/jobs')
    return createSyncJobs({ depsFor: extractDepsFor, extractFinished: recordExtractFinished })[
      kind
    ](ctx, payload)
  }
}

export const connector: ConnectorServer = {
  manifest,

  // The client paces and retries itself, and logs without bodies; the framework does neither.
  shouldRetry: () => false,

  async test(ctx) {
    try {
      // PROVISIONAL(M0:S1): the status body isn't documented; 200 with success is a valid key.
      await shopmonkeyClientFor(ctx, INTERACTIVE_BUDGET).get('/v3/auth/api_key/status')
      return { ok: true }
    } catch (err) {
      if (err instanceof ShopmonkeyError) {
        return { ok: false, message: err.shopmonkeyMessage ?? `Shopmonkey answered ${err.status}` }
      }
      throw err
    }
  },

  // PROVISIONAL(M0:S1): the company comes from the key's own user; see UserMe.
  async identify(ctx) {
    const me = await shopmonkeyClientFor(ctx, INTERACTIVE_BUDGET).get<UserMe>('/v3/user/me')
    const id = me.data?.companyId ?? me.data?.company?.id
    // The company id keys every import of this workshop's history; never store a connection without it.
    if (!id) throw new Error('Shopmonkey did not say which company this key belongs to')
    return { id, name: me.data?.company?.name || id }
  },

  remoteOptions: {
    async locations(ctx): Promise<SettingOption[]> {
      const client = shopmonkeyClientFor(ctx, INTERACTIVE_BUDGET)
      // PROVISIONAL(M0:S1): GET /v3/location is only in archived docs; the key's own user lists the
      // locations it can reach either way.
      try {
        const list = await client.get<Location[]>('/v3/location', { limit: 100 })
        if (Array.isArray(list.data) && list.data.length) return list.data.map(toOption)
      } catch (err) {
        if (!(err instanceof ShopmonkeyError)) throw err
      }
      const me = await client.get<UserMe>('/v3/user/me')
      return (me.data?.locations ?? []).map(toOption)
    },
  },

  jobs: {
    'extract.step': extractStepJob,
    // M7: the sync window (webhook refetches, the ten-minute delta, a load put off).
    refetch: syncJob('refetch'),
    'sync.delta': syncJob('sync.delta'),
    'sync.load': syncJob('sync.load'),
  },
  // Loaded when a delivery comes: the registry loads every connector's server, so this one stays light.
  webhook: {
    receive: async (request, ctx) => (await import('./webhook')).receive(request, ctx),
  },
}
