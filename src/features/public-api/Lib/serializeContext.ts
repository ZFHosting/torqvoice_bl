/**
 * What every serializer needs besides its row (docs/fork/API.md §3): the workshop's currency, which every
 * document carries, and its time zone, for the calendar dates the workshop types. Read once a request.
 * The formatting helpers are pure, so `Serializers/` stay free of the database.
 */
import 'server-only'
import { SETTING_KEYS } from '@/features/settings/Schema/settingsSchema'
import { resolveCurrencyCode } from '@/lib/currencies'
import { db } from '@/lib/db'
import { workshopTimeZone } from '@/lib/workshop-timezone'
import type { SerializeContext } from './serializeFormat'

export type { SerializeContext } from './serializeFormat'

export async function serializeContext(organizationId: string): Promise<SerializeContext> {
  const [currency, timeZone] = await Promise.all([
    db.appSetting.findFirst({
      where: { organizationId, key: SETTING_KEYS.CURRENCY_CODE },
      select: { value: true },
    }),
    workshopTimeZone(organizationId),
  ])
  return { organizationId, currency: resolveCurrencyCode(currency?.value), timeZone }
}
