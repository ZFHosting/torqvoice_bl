/** `/api/v1/technicians` and `/api/v1/work-order-statuses`: how they read (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import type { ReadResource } from '../Lib/readResource'
import {
  type TechnicianOut,
  techniciansSpec,
  type WorkOrderStatusOut,
  workOrderStatusesSpec,
} from '../Schema/staff'
import {
  STATUS_SELECT,
  type StatusRow,
  serializeStatus,
  serializeTechnician,
  TECHNICIAN_SELECT,
  type TechnicianRow,
} from '../Serializers/staff'

export const techniciansResource: ReadResource<TechnicianRow, TechnicianOut> = {
  ...techniciansSpec,
  // The work board is where technicians are managed.
  permission: { action: PermissionAction.READ, subject: PermissionSubject.WORK_BOARD },
  scope: (organizationId) => ({ organizationId }),
  where: ({ active }) =>
    active === 'true' || active === 'false' ? { isActive: active === 'true' } : {},
  select: () => TECHNICIAN_SELECT,
  findMany: (args) => db.technician.findMany(args as never) as unknown as Promise<TechnicianRow[]>,
  findFirst: (args) =>
    db.technician.findFirst(args as never) as unknown as Promise<TechnicianRow | null>,
  serialize: (row) => serializeTechnician(row),
}

export const workOrderStatusesResource: ReadResource<StatusRow, WorkOrderStatusOut> = {
  ...workOrderStatusesSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.SERVICES },
  scope: (organizationId) => ({ organizationId }),
  select: () => STATUS_SELECT,
  findMany: (args) => db.workOrderStatus.findMany(args as never) as unknown as Promise<StatusRow[]>,
  findFirst: (args) =>
    db.workOrderStatus.findFirst(args as never) as unknown as Promise<StatusRow | null>,
  serialize: (row) => serializeStatus(row),
}
