/**
 * The wrapper every public API route runs in (docs/fork/API.md §2–3).
 *
 * It accepts only `tvk_` bearer keys (any other bearer token is the technician app's, served by
 * withApiAuth), resolves the key's service user and workshop, refuses a workshop whose plan has no
 * API, applies a per-key rate limit, and checks the route's permissions against the service user's
 * role exactly as withAuth does for a person. Like withApiAuth, it answers in HTTP status codes with
 * the shared error shape, holds writes while the workshop is being restored, and never lets an
 * internal message reach the wire.
 */
import 'server-only'
import { ZodError } from 'zod'
import { RESTORE_IN_PROGRESS_MESSAGE, isRestoring } from '@/lib/backup/freeze'
import { db } from '@/lib/db'
import { DocumentLockedError } from '@/lib/document-lock'
import { getFeatures } from '@/lib/features'
import { hasAllPermissions, type PermissionInput } from '@/lib/permissions'
import { clientAddress } from '@/lib/rate-limit'
import { runAsActor } from '@/lib/realtime/actor.server'
import { documentLockedResponse } from '@/lib/with-api-auth'
import { framesOf } from './errorFrames'
import { publicApiError } from './errors'
import { verifyApiKey } from './keys.server'
import { InvalidCursorError } from './pagination'
import {
  type Budget,
  consumeKeyBudget,
  failedAuthRetryAfter,
  recordFailedAuth,
  recordGoodAuth,
} from './rateLimit'

/** The part of a key that names it, safe to keep in memory: the 8 characters after `tvk_`. */
const KEY_PREFIX = /^tvk_([a-z0-9]{8})_/

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface PublicApiContext {
  organizationId: string
  /** The key's service user: the actor on every record the request writes. */
  userId: string
  apiKeyId: string
  /** The service user's role's permissions. */
  permissions: { action: string; subject: string }[]
  /** The role is an admin role: every permission. */
  isAdmin: boolean
}

export interface PublicApiOptions {
  requiredPermissions?: PermissionInput[]
  /** Requests per window for this key; 120 a minute unless set. */
  rateLimit?: { limit?: number; windowMs?: number }
}

const REFUSED = {
  missing: [401, 'unauthorized', 'Send an API key: Authorization: Bearer tvk_…'],
  malformed: [401, 'unauthorized', 'The API key is not valid.'],
  unknown: [401, 'unauthorized', 'The API key is not valid.'],
  revoked: [401, 'unauthorized', 'The API key has been revoked.'],
  expired: [401, 'unauthorized', 'The API key has expired.'],
  ip_not_allowed: [
    403,
    'forbidden',
    'Requests from this address are not allowed for this API key.',
  ],
} as const

function refuse(reason: keyof typeof REFUSED) {
  const [status, code, message] = REFUSED[reason]
  return publicApiError(status, code, message)
}

export async function withPublicApi(
  request: Request,
  handler: (ctx: PublicApiContext) => Promise<Response>,
  options: PublicApiOptions = {}
): Promise<Response> {
  const header = request.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token.startsWith('tvk_')) return refuse('missing')

  // Cheap refusal first: an address that keeps presenting bad keys gets no lookup at all, unless this key has
  // authenticated from it lately (rateLimit.ts).
  const address = clientAddress(request)
  const prefix = KEY_PREFIX.exec(token)?.[1] ?? null
  const blockedFor = failedAuthRetryAfter(address, prefix)
  if (blockedFor !== null) {
    return publicApiError(
      429,
      'rate_limited',
      'Too many failed attempts from this address.',
      undefined,
      {
        'Retry-After': String(blockedFor),
      }
    )
  }

  let budget: Budget | null = null
  /** Every answer after the key's budget is counted says what is left of it (API.md §3). */
  const withBudget = (response: Response) => {
    if (budget) {
      response.headers.set('X-RateLimit-Limit', String(budget.limit))
      response.headers.set('X-RateLimit-Remaining', String(budget.remaining))
    }
    return response
  }

  try {
    const verified = await verifyApiKey(token, address === 'unknown' ? null : address)
    if (!verified.ok) {
      recordFailedAuth(address, prefix)
      return refuse(verified.reason)
    }
    if (prefix) recordGoodAuth(address, prefix)

    budget = consumeKeyBudget(verified.apiKeyId, options.rateLimit)
    if (!budget.allowed) {
      return withBudget(
        publicApiError(429, 'rate_limited', 'Too many requests for this API key.', undefined, {
          'Retry-After': String(budget.retryAfterSeconds),
        })
      )
    }

    const { organizationId, serviceUserId: userId, apiKeyId } = verified
    const features = await getFeatures(organizationId)
    if (!features.api) {
      return withBudget(
        publicApiError(403, 'forbidden', "This workshop's plan does not include the API.", {
          gate: 'api',
        })
      )
    }

    // The key's access is its service user's membership: revoking removes it, and the roles screen
    // changes it, both on the next request.
    const membership = await db.organizationMember.findFirst({
      where: { organizationId, userId },
      select: {
        role: true,
        customRole: {
          select: { isAdmin: true, permissions: { select: { action: true, subject: true } } },
        },
      },
    })
    if (!membership) return withBudget(refuse('revoked'))
    const isAdmin =
      membership.role === 'owner' ||
      membership.role === 'admin' ||
      membership.customRole?.isAdmin === true
    const permissions = membership.customRole?.permissions ?? []
    if (
      options.requiredPermissions?.length &&
      !isAdmin &&
      !hasAllPermissions(permissions, options.requiredPermissions)
    ) {
      return withBudget(
        publicApiError(403, 'forbidden', "This API key's role does not allow this.")
      )
    }

    if (!SAFE_METHODS.has(request.method) && isRestoring(organizationId)) {
      return withBudget(publicApiError(409, 'conflict', RESTORE_IN_PROGRESS_MESSAGE))
    }

    // Inside the actor, so the workshop's open screens learn of the change and who made it.
    const response = await runAsActor({ userId, name: null, source: 'system' }, () =>
      handler({ organizationId, userId, apiKeyId, permissions, isAdmin })
    )
    return withBudget(response)
  } catch (err) {
    // The key lookup, the plan and the membership too: a database error before the handler is
    // answered in the same shape as one inside it.
    return withBudget(errorResponse(request, err))
  }
}

/** A thrown error as a response: the caller's own mistakes said plainly, ours said not at all. */
function errorResponse(request: Request, err: unknown): Response {
  if (err instanceof DocumentLockedError) return documentLockedResponse(err)
  if (err instanceof InvalidCursorError) return publicApiError(400, 'invalid_request', err.message)
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
  // Ids and the path only: never a body, a header or a key. Nor the error itself (A6, SECURITY-REVIEW.md): its message
  // or a Prisma error's meta can quote what was sent; its class, code and the frames below the message say where it
  // came from.
  console.error('[public-api] request failed', {
    method: request.method,
    path: new URL(request.url).pathname,
    error: err instanceof Error ? err.name : 'unknown',
    code: (err as { code?: unknown } | null)?.code ?? null,
    at: framesOf(err),
  })
  return publicApiError(500, 'server_error', 'Something went wrong. Try again.')
}
