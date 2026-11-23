/**
 * `?include=customFields` (docs/fork/API.md §4): the custom field values of a page of records, read once for the
 * page. Values are kept by entity id with no relation to the record, so the workshop is checked on the field's
 * definition.
 */
import 'server-only'
import { db } from '@/lib/db'
import type { CustomFieldValueOut } from '../Serializers/common'

export type CustomFieldEntity = 'customer' | 'vehicle' | 'service_record' | 'quote'

/** Each record's values, as `{ customFields }`, for the `extra` a serializer receives. */
export async function customFieldsOf(
  organizationId: string,
  entityType: CustomFieldEntity,
  ids: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  if (!ids.length) return out
  const values = await db.customFieldValue.findMany({
    where: { entityType, entityId: { in: ids }, field: { organizationId, entityType } },
    select: {
      entityId: true,
      value: true,
      field: { select: { name: true, label: true, sortOrder: true } },
    },
  })
  values.sort(
    (a, b) => a.field.sortOrder - b.field.sortOrder || a.field.name.localeCompare(b.field.name)
  )
  const byEntity = new Map<string, CustomFieldValueOut[]>()
  for (const v of values) {
    const list = byEntity.get(v.entityId) ?? []
    list.push({ name: v.field.name, label: v.field.label, value: v.value })
    byEntity.set(v.entityId, list)
  }
  for (const id of ids) out.set(id, { customFields: byEntity.get(id) ?? [] })
  return out
}
