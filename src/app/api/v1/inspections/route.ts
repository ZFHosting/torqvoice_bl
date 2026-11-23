import { listRoute } from '@/features/public-api/Lib/readResource'
import { inspectionsResource } from '@/features/public-api/Resources/inspections'

export const dynamic = 'force-dynamic'

/** `GET /api/v1/inspections` (docs/fork/API.md §4). */
export const GET = listRoute(inspectionsResource)
