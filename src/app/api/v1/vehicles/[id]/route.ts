import { getRoute } from '@/features/public-api/Lib/readResource'
import { vehiclesResource } from '@/features/public-api/Resources/vehicles'
import { deleteVehicleDELETE, updateVehiclePATCH } from '@/features/public-api/Writes/vehicles'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/vehicles/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(vehiclesResource)

/** `PATCH /api/v1/vehicles/{id}` (docs/fork/API.md §4). */
export const PATCH = updateVehiclePATCH

/** `DELETE /api/v1/vehicles/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteVehicleDELETE
