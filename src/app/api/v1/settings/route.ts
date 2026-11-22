import { publicApiOk } from '@/features/public-api/Lib/errors'
import { withPublicApi } from '@/features/public-api/Lib/withPublicApi'
import { SETTINGS_KEYS, serializeSettings } from '@/features/public-api/Serializers/settings'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { workshopTimeZone } from '@/lib/workshop-timezone'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/v1/settings` (docs/fork/API.md §4): currency, time zone, tax setup, default labor rate
 * and numbering. Needs `read:settings`, because the numbering format isn't something every member
 * may read (MEMBER_READABLE_SETTINGS).
 */
export async function GET(request: Request) {
  return withPublicApi(
    request,
    async ({ organizationId }) => {
      const [rows, timeZone] = await Promise.all([
        db.appSetting.findMany({
          where: { organizationId, key: { in: [...SETTINGS_KEYS] } },
          select: { key: true, value: true },
        }),
        workshopTimeZone(organizationId),
      ])
      const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]))
      return publicApiOk(serializeSettings(settings, timeZone))
    },
    {
      requiredPermissions: [{ action: PermissionAction.READ, subject: PermissionSubject.SETTINGS }],
    }
  )
}
