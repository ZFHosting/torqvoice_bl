/** `/api/v1/inspections`: how it reads (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import type { ReadResource } from '../Lib/readResource'
import { type InspectionOut, inspectionsSpec } from '../Schema/inspections'
import {
  type InspectionRow,
  inspectionSelect,
  serializeInspection,
} from '../Serializers/inspections'

export const inspectionsResource: ReadResource<InspectionRow, InspectionOut> = {
  ...inspectionsSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.INSPECTIONS },
  scope: (organizationId) => ({ organizationId }),
  where: ({ vehicleId, status }) => ({
    ...(typeof vehicleId === 'string' ? { vehicleId } : {}),
    ...(typeof status === 'string' ? { status } : {}),
  }),
  select: inspectionSelect,
  findMany: (args) => db.inspection.findMany(args as never) as unknown as Promise<InspectionRow[]>,
  findFirst: (args) =>
    db.inspection.findFirst(args as never) as unknown as Promise<InspectionRow | null>,
  serialize: (row, _ctx, includes) => serializeInspection(row, includes),
}
