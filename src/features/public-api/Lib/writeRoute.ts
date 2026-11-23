/**
 * The handler of one public API write (docs/fork/milestones/A4-write-endpoints.md, docs/fork/API.md §3).
 *
 * It runs the same domain service the server action runs (A2), with the raw body (the service validates, as the
 * action's did), as the key's service user; then records the action's own audit event through `logAudit`, so
 * webhooks fire exactly as they do from the UI. Around that: the key's permission, `If-Match` on PATCH and DELETE
 * (412 on a stale tag), `Idempotency-Key` on POST, and the service's errors said the way API.md §3 says them. Every
 * refusal is a response, not a throw, so an idempotent POST that was refused replays the same refusal.
 */
import 'server-only'
import { ZodError } from 'zod'
import { CustomFieldsRefusedError } from '@/features/custom-fields/Lib/recordCustomFieldValues.server'
import {
  InvalidMeterReadingError,
  MeterNotOnJobError,
} from '@/features/meters/Lib/jobMeterReading.server'
import { AddPartError } from '@/features/vehicles/Lib/addPart'
import { type AuditEvent, logAudit } from '@/lib/audit'
import { RestoreInProgressError } from '@/lib/backup/freeze'
import { DocumentLockedError } from '@/lib/document-lock'
import { FeatureGatedError } from '@/lib/features'
import type { PermissionInput } from '@/lib/permissions'
import { clientAddress } from '@/lib/rate-limit'
import type { ServiceCtx } from '@/lib/service-context'
import { documentLockedResponse } from '@/lib/with-api-auth'
import { publicApiError, publicApiOk } from './errors'
import { ifMatchSatisfied } from './etag'
import { withIdempotency } from './idempotency'
import { type PublicApiContext, withPublicApi } from './withPublicApi'

export type WriteMethod = 'POST' | 'PATCH' | 'DELETE'

export interface WriteOptions<P extends Record<string, string>, R> {
  permission: PermissionInput
  /**
   * The record as it is now in the key's workshop, for `If-Match` (PATCH, DELETE). Null: it isn't this workshop's,
   * or doesn't exist, and the request is a 404 before the service runs.
   */
  current?: (ctx: PublicApiContext, params: P) => Promise<{ id: string; updatedAt: Date } | null>
  /** The domain service, given the raw body. */
  run: (svc: ServiceCtx, body: unknown, params: P, ctx: PublicApiContext) => Promise<R>
  /** The action's audit event for the result (its own builder), or nothing to record. */
  audit?: (result: R, body: unknown) => AuditEvent | null | undefined
  /** What the API answers: the record as A3 serializes it, with its status (200 unless set). */
  respond: (
    result: R,
    ctx: PublicApiContext,
    params: P
  ) => Promise<{ status?: number; data: unknown } | Response>
}

function isPrismaError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
}

/**
 * A service's error as an API answer (API.md §3), or null for one that is ours, not the caller's (a 500, said by
 * withPublicApi without its message).
 */
export function domainErrorResponse(err: unknown): Response | null {
  if (err instanceof DocumentLockedError) return documentLockedResponse(err)
  if (err instanceof ZodError) {
    return publicApiError(
      400,
      'invalid_request',
      'The request was not valid.',
      err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    )
  }
  if (err instanceof SyntaxError) {
    return publicApiError(400, 'invalid_request', 'The request body was not valid JSON.')
  }
  if (err instanceof FeatureGatedError) {
    return publicApiError(403, 'forbidden', err.message, {
      gate: err.feature,
      ...(err.limit !== undefined ? { limit: err.limit } : {}),
    })
  }
  if (err instanceof RestoreInProgressError) return publicApiError(409, 'conflict', err.message)
  if (err instanceof AddPartError) return publicApiError(404, 'not_found', err.message)
  if (
    err instanceof CustomFieldsRefusedError ||
    err instanceof InvalidMeterReadingError ||
    err instanceof MeterNotOnJobError
  ) {
    return publicApiError(400, 'invalid_request', err.message)
  }
  if (isPrismaError(err, 'P2002')) {
    return publicApiError(409, 'conflict', 'A record with these values already exists.')
  }
  if (isPrismaError(err, 'P2025')) return publicApiError(404, 'not_found', 'Not found.')
  // A plain Error is a refusal the action shows the person as it is ("Customer not found", "Quote is already
  // converted"): the caller's to read. Anything else (a driver's error, a bug) is ours.
  if (err instanceof Error && err.constructor === Error) {
    return /not found/i.test(err.message)
      ? publicApiError(404, 'not_found', err.message)
      : publicApiError(400, 'invalid_request', err.message)
  }
  return null
}

function parseBody(text: string): unknown {
  return text.trim() ? (JSON.parse(text) as unknown) : {}
}

export function writeRoute<P extends Record<string, string>, R>(
  method: WriteMethod,
  options: WriteOptions<P, R>
) {
  return (request: Request, { params }: { params: Promise<P> }) =>
    withPublicApi(
      request,
      async (ctx) => {
        const routeParams = await params
        const text = method === 'DELETE' ? '' : await request.text()
        const svc: ServiceCtx = {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          actor: 'api',
        }
        const exec = async (): Promise<Response> => {
          try {
            const body = parseBody(text)
            if (options.current) {
              const row = await options.current(ctx, routeParams)
              if (!row) return publicApiError(404, 'not_found', 'Not found.')
              if (!ifMatchSatisfied(request.headers.get('if-match'), row)) {
                return publicApiError(
                  412,
                  'precondition_failed',
                  'The record has changed since that ETag: read it again.'
                )
              }
            }
            const result = await options.run(svc, body, routeParams, ctx)
            const event = options.audit?.(result, body)
            if (event?.action) {
              // Awaited (the action's is fire-and-forget): the event, and the webhooks it fans out to, exist
              // when the API answers. logAudit never throws.
              await logAudit(
                { userId: ctx.userId, organizationId: ctx.organizationId },
                {
                  ...event,
                  ip: event.ip ?? clientAddress(request),
                  userAgent: event.userAgent ?? request.headers.get('user-agent'),
                }
              )
            }
            const out = await options.respond(result, ctx, routeParams)
            return out instanceof Response ? out : publicApiOk(out.data, { status: out.status })
          } catch (err) {
            const answer = domainErrorResponse(err)
            if (answer) return answer
            throw err
          }
        }
        return method === 'POST'
          ? withIdempotency(
              request,
              { organizationId: ctx.organizationId, apiKeyId: ctx.apiKeyId },
              text,
              exec
            )
          : exec()
      },
      { requiredPermissions: [options.permission] }
    )
}
