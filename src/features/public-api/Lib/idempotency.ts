/**
 * `Idempotency-Key` on POST (docs/fork/API.md §3).
 *
 * The first request with a key claims it (the unique index on `(apiKeyId, key)` decides who is
 * first), runs, and stores its response; the same key with the same request within 24 hours gets
 * that response again and nothing is created twice. The same key with a different request is
 * refused with 409 `idempotency_conflict`, and so is a repeat that arrives while the first is still
 * running. A request that fails with a server error gives the key back, so the client can retry; so
 * does one whose process died mid-request, once its claim is IN_FLIGHT_ABANDONED_MS old.
 */
import 'server-only'
import { createHash } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import { publicApiError } from './errors'

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_KEY_LENGTH = 255
/** `responseStatus` of a claim whose request hasn't finished. */
const IN_FLIGHT = 0
/** A claim still in flight after this long belongs to a request whose process died. */
export const IN_FLIGHT_ABANDONED_MS = 5 * 60 * 1000

function requestHash(request: Request, body: string): string {
  const url = new URL(request.url)
  return createHash('sha256')
    .update(`${request.method} ${url.pathname}${url.search}\n${body}`)
    .digest('hex')
}

const conflict = (message: string) => publicApiError(409, 'idempotency_conflict', message)

/** By shape, as the rest of the app checks it. */
function isUniqueViolation(err: unknown) {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

export async function withIdempotency(
  request: Request,
  scope: { organizationId: string; apiKeyId: string },
  body: string,
  run: () => Promise<Response>,
  now = new Date()
): Promise<Response> {
  const key = request.headers.get('idempotency-key')?.trim()
  if (!key) return run()
  if (key.length > MAX_KEY_LENGTH) {
    return publicApiError(
      400,
      'invalid_request',
      `Idempotency-Key is longer than ${MAX_KEY_LENGTH} characters.`
    )
  }
  const hash = requestHash(request, body)
  const where = { apiKeyId: scope.apiKeyId, key, organizationId: scope.organizationId }

  // An expired response, or a claim abandoned mid-request, is as good as none: drop it so this
  // request can claim the key afresh.
  await db.apiIdempotencyKey.deleteMany({
    where: {
      ...where,
      OR: [
        { createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_TTL_MS) } },
        {
          responseStatus: IN_FLIGHT,
          createdAt: { lt: new Date(now.getTime() - IN_FLIGHT_ABANDONED_MS) },
        },
      ],
    },
  })

  let claimId: string
  try {
    const claim = await db.apiIdempotencyKey.create({
      data: { ...where, requestHash: hash, responseStatus: IN_FLIGHT, responseBody: {} },
      select: { id: true },
    })
    claimId = claim.id
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const existing = await db.apiIdempotencyKey.findFirst({ where })
    if (!existing) return conflict('This Idempotency-Key is in use. Retry in a moment.')
    if (existing.requestHash !== hash) {
      return conflict('This Idempotency-Key was used with a different request.')
    }
    if (existing.responseStatus === IN_FLIGHT) {
      return conflict('A request with this Idempotency-Key is still being processed.')
    }
    return Response.json(existing.responseBody, {
      status: existing.responseStatus,
      headers: { 'Idempotent-Replayed': 'true' },
    })
  }

  let response: Response
  try {
    response = await run()
  } catch (err) {
    await release(claimId, scope.organizationId)
    throw err
  }
  if (response.status >= 500) {
    await release(claimId, scope.organizationId)
    return response
  }
  const stored = (await response
    .clone()
    .json()
    .catch(() => null)) as Prisma.InputJsonValue | null
  try {
    await db.apiIdempotencyKey.updateMany({
      where: { id: claimId, organizationId: scope.organizationId },
      data: { responseStatus: response.status, responseBody: stored ?? {} },
    })
  } catch (err) {
    // The write itself committed: answer as it did, rather than a 500 that invites a retry. The
    // claim stays in flight until it counts as abandoned, then the key is free again.
    console.error('[public-api] storing an idempotent response failed', { claimId }, err)
  }
  return response
}

async function release(id: string, organizationId: string) {
  await db.apiIdempotencyKey.deleteMany({ where: { id, organizationId } }).catch(() => {
    // Left behind, the claim expires with the 24-hour purge; the caller's answer matters more.
  })
}

/** Deletes stored responses older than 24 hours (src/lib/cron/purge-api-idempotency.ts). */
export async function purgeExpiredIdempotencyKeys(now = new Date()) {
  const { count } = await db.apiIdempotencyKey.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_TTL_MS) } },
  })
  return count
}
