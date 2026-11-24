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
import { createHash } from 'node:crypto'
import { ZodError } from 'zod'
import type { CustomFieldsRefusedError } from '@/features/custom-fields/Lib/recordCustomFieldValues.server'
import {
  InvalidMeterReadingError,
  MeterNotOnJobError,
} from '@/features/meters/Lib/jobMeterReading.server'
import type { RequiredMetersRefusedError } from '@/features/meters/Lib/requiredMeters.server'
import { TimeEntryError } from '@/features/time-tracking/Lib/timeEntries'
import { AddPartError } from '@/features/vehicles/Lib/addPart'
import { type AuditEvent, logAudit } from '@/lib/audit'
import { RestoreInProgressError } from '@/lib/backup/freeze'
import { assertContentLength } from '@/lib/backup/zip-guard'
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
  /**
   * A POST whose body is `multipart/form-data` (an upload), at most this many bytes: `run` is given the `FormData`.
   * A body over the limit is a 413 before it is read when it says its length, and after otherwise.
   */
  multipart?: { maxBytes: number }
  /** A POST's answer as kept for an `Idempotency-Key` replay, when not as sent (a secret shown once). */
  replayAs?: (body: unknown) => unknown
}

/** The body, or null as soon as it passes `maxBytes` (the rest is not read). */
export async function readBounded(
  request: Request,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(new ArrayBuffer(0))
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(new ArrayBuffer(size))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/**
 * The most a JSON body may hold. The app's own server actions take at most 1 MB (Next's default), and `/api/v1` is
 * outside the proxy whose body limit covers the rest of the app, so the API takes the same.
 */
export const MAX_JSON_BYTES = 1024 * 1024

/**
 * A JSON body as text, or a 413 once it passes `MAX_JSON_BYTES`: before it is read when it says its length, and as it
 * arrives otherwise, so no body is held whole before its size is known (A6, SECURITY-REVIEW.md item 7).
 */
export async function readJsonBody(request: Request): Promise<string | Response> {
  const tooLarge = () =>
    publicApiError(
      413,
      'invalid_request',
      `The request body is larger than ${MAX_JSON_BYTES} bytes.`
    )
  try {
    assertContentLength(request, MAX_JSON_BYTES)
  } catch {
    return tooLarge()
  }
  const bytes = await readBounded(request, MAX_JSON_BYTES)
  if (!bytes) return tooLarge()
  return new TextDecoder().decode(bytes)
}

/**
 * An upload's form, and what `Idempotency-Key` compares it by: its fields and files in order, not its bytes, since a
 * client sending it again picks a new multipart boundary.
 */
async function readMultipart(
  request: Request,
  maxBytes: number
): Promise<{ form: FormData; text: string } | Response> {
  const tooLarge = () =>
    publicApiError(413, 'invalid_request', `The upload is larger than ${maxBytes} bytes.`)
  try {
    assertContentLength(request, maxBytes)
  } catch {
    return tooLarge()
  }
  // Read as it arrives and stopped past the limit (A6, SECURITY-REVIEW.md): a body sent without a Content-Length is
  // never held whole before its size is known.
  const bytes = await readBounded(request, maxBytes)
  if (!bytes) return tooLarge()
  let form: FormData
  try {
    form = await new Response(bytes, {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData()
  } catch {
    return publicApiError(
      400,
      'invalid_request',
      'The request body was not valid multipart/form-data.'
    )
  }
  const hash = createHash('sha256')
  for (const [name, value] of form.entries()) {
    const part =
      typeof value === 'string'
        ? [name, value]
        : [
            name,
            value.name,
            value.type,
            createHash('sha256')
              .update(new Uint8Array(await value.arrayBuffer()))
              .digest('hex'),
          ]
    hash.update(`${JSON.stringify(part)}\n`)
  }
  return { form, text: `multipart:${hash.digest('hex')}` }
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
  if (err instanceof TimeEntryError) {
    return err.code === 'job_not_found'
      ? publicApiError(404, 'not_found', err.message)
      : err.code === 'invalid_range'
        ? publicApiError(400, 'invalid_request', err.message)
        : publicApiError(409, 'conflict', err.message)
  }
  // The app's own refusals that name what to fix: what it hands the form goes in `details`. Matched by name, as
  // withAuth matches them.
  if (err instanceof Error && err.name === 'RequiredMetersRefusedError') {
    return publicApiError(400, 'invalid_request', err.message, {
      meters: (err as RequiredMetersRefusedError).meters,
    })
  }
  if (err instanceof Error && err.name === 'CustomFieldsRefusedError') {
    return publicApiError(400, 'invalid_request', err.message, {
      fields: (err as CustomFieldsRefusedError).fieldErrors,
    })
  }
  if (err instanceof InvalidMeterReadingError || err instanceof MeterNotOnJobError) {
    return publicApiError(400, 'invalid_request', err.message)
  }
  if (isPrismaError(err, 'P2002')) {
    return publicApiError(409, 'conflict', 'A record with these values already exists.')
  }
  if (isPrismaError(err, 'P2025')) return publicApiError(404, 'not_found', 'Not found.')
  // A plain Error is a refusal the action shows the person as it is ("Customer not found", "Quote is already
  // converted"): the caller's to read. Anything else (a driver's error, a bug) is ours, and so is a system call's
  // failure, though Node throws it as a plain Error: a full disk is not the caller's, and its message names the path.
  if (err instanceof Error && err.constructor === Error && !isSystemError(err)) {
    return /not found/i.test(err.message)
      ? publicApiError(404, 'not_found', err.message)
      : publicApiError(400, 'invalid_request', err.message)
  }
  return null
}

/** Node's file system and network errors: plain Errors that carry what the system said. */
export function isSystemError(err: Error): boolean {
  return 'code' in err || 'errno' in err || 'syscall' in err
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
        let upload: FormData | null = null
        let text = ''
        if (options.multipart) {
          const read = await readMultipart(request, options.multipart.maxBytes)
          if (read instanceof Response) return read
          upload = read.form
          text = read.text
        } else if (method !== 'DELETE') {
          const read = await readJsonBody(request)
          if (read instanceof Response) return read
          text = read
        }
        const svc: ServiceCtx = {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          actor: 'api',
        }
        const exec = async (): Promise<Response> => {
          try {
            const body = upload ?? parseBody(text)
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
              // Awaited (the action's is fire-and-forget): the audit row exists when the API answers. The webhook
              // deliveries it fans out to go out in the background, as they do for the app. logAudit never throws.
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
              exec,
              undefined,
              options.replayAs
            )
          : exec()
      },
      { requiredPermissions: [options.permission] }
    )
}
