import { listRoute } from '@/features/public-api/Lib/readResource'
import { vehiclesResource } from '@/features/public-api/Resources/vehicles'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/vehicles` (docs/fork/API.md §4). */
export const GET = listRoute(vehiclesResource)
