import { getRoute } from '@/features/public-api/Lib/readResource'
import { laborPresetsResource } from '@/features/public-api/Resources/catalog'
import {
  deleteLaborPresetDELETE,
  updateLaborPresetPATCH,
} from '@/features/public-api/Writes/catalog'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/labor-presets/{id}` (docs/fork/API.md §4). */
export const GET = getRoute(laborPresetsResource)

/** `PATCH /api/v1/labor-presets/{id}` (docs/fork/API.md §4). */
export const PATCH = updateLaborPresetPATCH

/** `DELETE /api/v1/labor-presets/{id}` (docs/fork/API.md §4). */
export const DELETE = deleteLaborPresetDELETE
