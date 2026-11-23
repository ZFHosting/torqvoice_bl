import { listRoute } from '@/features/public-api/Lib/readResource'
import { laborPresetsResource } from '@/features/public-api/Resources/catalog'
import { createLaborPresetPOST } from '@/features/public-api/Writes/catalog'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/labor-presets` (docs/fork/API.md §4). */
export const GET = listRoute(laborPresetsResource)

/** `POST /api/v1/labor-presets` (docs/fork/API.md §4). */
export const POST = createLaborPresetPOST
