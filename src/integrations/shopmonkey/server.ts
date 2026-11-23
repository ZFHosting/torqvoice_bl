import type {
  ConnectorContext,
  ConnectorServer,
  SettingOption,
} from '@/features/integrations/Lib/types'
import { createShopmonkeyClient, ShopmonkeyError } from './client'
import { manifest } from './manifest'

/**
 * The Shopmonkey connector (docs/fork/milestones/M2-connector-and-client.md): proves the key, names
 * the company, lists its locations. Extracting, transforming and loading come in M3–M5 as jobs.
 */

/** The client for a connection: its key on every request, its log for every call. */
export function shopmonkeyClientFor(ctx: ConnectorContext) {
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
  })
}

interface UserMe {
  companyId?: string
  company?: { id?: string; name?: string }
  locations?: { id: string; name?: string }[]
}

export const connector: ConnectorServer = {
  manifest,

  // The client paces and retries itself, and logs without bodies; the framework does neither.
  shouldRetry: () => false,

  async test(ctx) {
    try {
      // PROVISIONAL(M0:S1): the status body isn't documented; 200 with success is a valid key.
      await shopmonkeyClientFor(ctx).get('/v3/auth/api_key/status')
      return { ok: true }
    } catch (err) {
      if (err instanceof ShopmonkeyError) {
        return { ok: false, message: err.shopmonkeyMessage ?? `Shopmonkey answered ${err.status}` }
      }
      throw err
    }
  },

  async identify(ctx) {
    const me = await shopmonkeyClientFor(ctx).get<UserMe>('/v3/user/me')
    const id = me.data.companyId ?? me.data.company?.id ?? ''
    return { id, name: me.data.company?.name ?? id }
  },

  remoteOptions: {
    async locations(ctx): Promise<SettingOption[]> {
      const client = shopmonkeyClientFor(ctx)
      // PROVISIONAL(M0:S1): GET /v3/location is only in archived docs; the key's own user lists the
      // locations it can reach either way.
      try {
        const list = await client.get<{ id: string; name?: string }[]>('/v3/location')
        if (Array.isArray(list.data) && list.data.length) {
          return list.data.map((l) => ({ value: l.id, label: l.name || l.id }))
        }
      } catch (err) {
        if (!(err instanceof ShopmonkeyError)) throw err
      }
      const me = await client.get<UserMe>('/v3/user/me')
      return (me.data.locations ?? []).map((l) => ({ value: l.id, label: l.name || l.id }))
    },
  },

  jobs: {},
}
