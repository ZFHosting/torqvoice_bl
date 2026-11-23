/**
 * `POST /vehicles`, `PATCH /vehicles/{id}`, `DELETE /vehicles/{id}` (docs/fork/API.md §4): the vehicle services the
 * actions run (A2), with the actions' own audit events. A `customerId` of another workshop is refused by the
 * service as "Customer not found": a 404, like any id the key can't see.
 */
import 'server-only'
import {
  vehicleCreatedEvent,
  vehicleDeletedEvent,
  vehicleUpdatedEvent,
} from '@/features/vehicles/Lib/vehicleAuditEvents'
import {
  createVehicleService,
  deleteVehicleService,
  updateVehicleService,
} from '@/features/vehicles/Lib/vehicleService.server'
import { db } from '@/lib/db'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { writeRoute } from '../Lib/writeRoute'
import { vehiclesResource } from '../Resources/vehicles'
import { answerWith, deleted, withId } from './common'

const subject = PermissionSubject.VEHICLES
const current = (ctx: { organizationId: string }, { id }: { id: string }) =>
  db.vehicle.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, updatedAt: true },
  })

export const createVehiclePOST = writeRoute('POST', {
  permission: { action: PermissionAction.CREATE, subject },
  run: (svc, body) => createVehicleService(svc, body),
  audit: (result) => vehicleCreatedEvent(result),
  respond: async (result, ctx) => answerWith(vehiclesResource, ctx.organizationId, result.id, 201),
})

export const updateVehiclePATCH = writeRoute('PATCH', {
  permission: { action: PermissionAction.UPDATE, subject },
  current,
  run: (svc, body, { id }) => updateVehicleService(svc, withId(body, id)),
  audit: (result) => vehicleUpdatedEvent(result),
  respond: async (_result, ctx, { id }) => answerWith(vehiclesResource, ctx.organizationId, id),
})

export const deleteVehicleDELETE = writeRoute('DELETE', {
  permission: { action: PermissionAction.DELETE, subject },
  current,
  run: (svc, _body, { id }) => deleteVehicleService(svc, id),
  audit: (result) => vehicleDeletedEvent(result),
  respond: async (_result, _ctx, { id }) => deleted(id),
})
