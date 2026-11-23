/** `/api/v1/vehicles`: how it reads (docs/fork/API.md §4). */
import 'server-only'
import { db } from '@/lib/db'
import { normalizePlate } from '@/lib/license-plate'
import { PermissionAction, PermissionSubject } from '@/lib/permissions'
import { customFieldsOf } from '../Lib/customFields.server'
import type { ReadResource } from '../Lib/readResource'
import { type VehicleOut, vehiclesSpec } from '../Schema/vehicles'
import { serializeVehicle, type VehicleRow, vehicleSelect } from '../Serializers/vehicles'

export const vehiclesResource: ReadResource<VehicleRow, VehicleOut> = {
  ...vehiclesSpec,
  permission: { action: PermissionAction.READ, subject: PermissionSubject.VEHICLES },
  scope: (organizationId) => ({ organizationId }),
  where: ({ customerId, vin, plate }) => ({
    ...(typeof customerId === 'string' ? { customerId } : {}),
    ...(typeof vin === 'string' ? { vin: { equals: vin, mode: 'insensitive' } } : {}),
    // Stored normalised (lib/license-plate), so the query is normalised the same way.
    ...(typeof plate === 'string'
      ? { licensePlate: { equals: normalizePlate(plate) ?? plate, mode: 'insensitive' } }
      : {}),
  }),
  select: vehicleSelect,
  findMany: (args) => db.vehicle.findMany(args as never) as unknown as Promise<VehicleRow[]>,
  findFirst: (args) => db.vehicle.findFirst(args as never) as unknown as Promise<VehicleRow | null>,
  expand: async (rows, ctx, includes) =>
    includes.has('customFields')
      ? customFieldsOf(
          ctx.organizationId,
          'vehicle',
          rows.map((r) => r.id)
        )
      : new Map(),
  serialize: (row, _ctx, includes, extra) => serializeVehicle(row, includes, extra),
}
