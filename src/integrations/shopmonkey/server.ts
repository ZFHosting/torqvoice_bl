import type {
  ConnectorContext,
  ConnectorServer,
  SettingOption,
} from '@/features/integrations/Lib/types'
import {
  BACKFILL_BUDGET,
  createShopmonkeyClient,
  INTERACTIVE_BUDGET,
  type RetryBudget,
  ShopmonkeyError,
} from './client'
import { manifest } from './manifest'

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

  jobs: {},
}
