/**
 * The public API's error and success shapes: the same envelope as the technician app's API
 * (`apiError` / `apiOk` in src/lib/with-api-auth.ts), with the codes API.md §3 adds.
 */
import { NextResponse } from 'next/server'
import type { ApiErrorCode } from '@/lib/with-api-auth'

export type PublicApiErrorCode =
  | ApiErrorCode
  | 'rate_limited'
  | 'precondition_failed'
  | 'idempotency_conflict'

export function publicApiError(
  status: number,
  code: PublicApiErrorCode,
  message: string,
  details?: unknown,
  headers?: Record<string, string>
) {
  return NextResponse.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status, headers }
  )
}

export function publicApiOk<T>(
  data: T,
  init: { status?: number; meta?: Record<string, unknown>; headers?: Record<string, string> } = {}
) {
  return NextResponse.json(
    { data, ...(init.meta ? { meta: init.meta } : {}) },
    { status: init.status ?? 200, headers: init.headers }
  )
}
