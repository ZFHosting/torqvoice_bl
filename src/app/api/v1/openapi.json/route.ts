import { NextResponse } from 'next/server'
import { publicApiDocument } from '@/features/public-api/Lib/openapi'

/**
 * `GET /api/v1/openapi.json` (docs/fork/API.md §1.4): the public API's OpenAPI 3.1 document.
 * Unauthenticated, like any API description, and the same for every caller, so it may be cached.
 */
export function GET() {
  return NextResponse.json(publicApiDocument(), {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
