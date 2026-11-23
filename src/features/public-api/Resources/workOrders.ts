/** `/api/v1/work-orders`: how it reads (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { customFieldsOf } from '../Lib/customFields.server'
import type { ReadResource } from '../Lib/readResource'
import { type WorkOrderOut, workOrdersSpec } from '../Schema/workOrders'
import { serializeWorkOrder, type WorkOrderRow, workOrderSelect } from '../Serializers/workOrders'

export const WORK_ORDER_PERMISSION = {
  action: PermissionAction.READ,
  subject: PermissionSubject.SERVICES,
}

export const workOrdersResource: ReadResource<WorkOrderRow, WorkOrderOut> = {
  ...workOrdersSpec,
  // The app reads its work orders (service records) under services.
  permission: WORK_ORDER_PERMISSION,
  scope: (organizationId) => ({ organizationId }),
  where: ({ status, customerId, vehicleId, invoiceNumber, technicianId, openOnly }) => ({
    AND: [
      typeof status === 'string' ? { status } : {},
      typeof customerId === 'string' ? { customerId } : {},
      typeof vehicleId === 'string' ? { vehicleId } : {},
      typeof invoiceNumber === 'string' ? { invoiceNumber } : {},
      typeof technicianId === 'string' ? { technicianId } : {},
      // Together with `status`, not over it.
      openOnly === 'true' ? { status: { not: 'completed' } } : {},
    ],
  }),
  select: workOrderSelect,
  findMany: (args) =>
    db.serviceRecord.findMany(args as never) as unknown as Promise<WorkOrderRow[]>,
  findFirst: (args) =>
    db.serviceRecord.findFirst(args as never) as unknown as Promise<WorkOrderRow | null>,
  expand: async (rows, ctx, includes) =>
    includes.has('customFields')
      ? customFieldsOf(
          ctx.organizationId,
          'service_record',
          rows.map((r) => r.id)
        )
      : new Map(),
  serialize: (row, ctx, includes, extra) => serializeWorkOrder(row, ctx, includes, extra),
}
