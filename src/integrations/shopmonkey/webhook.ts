/**
 * fork: Shopmonkey's webhooks (docs/fork/milestones/M7-delta-and-cutover.md, MAPPING §1). Deliveries are signed per
 * the Standard Webhooks spec: `webhook-id`, `webhook-timestamp` (seconds) and `webhook-signature` (one or more
 * `v1,<base64>`, space-separated, so a rotated secret can sign beside the old one), an HMAC-SHA256 of
 * `id.timestamp.body` keyed with the secret (`whsec_<base64>`). PROVISIONAL(M0:S1): from the docs; re-check with a
 * recorded delivery.
 *
 * The payload is never trusted: a verified delivery only says which record to fetch again (`refetch`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { enqueueJob } from '@/features/integrations/Lib/jobs'
import type { ConnectorContext } from '@/features/integrations/Lib/types'
import { db } from '@/lib/db'
import { recordPath } from './extract/tables'

/** How far a delivery's timestamp may be from now, either way: older is a replay, newer a wrong clock. */
export const TOLERANCE_SECONDS = 5 * 60

export type SignatureCheck =
  | { ok: true }
  | {
      ok: false
      reason: 'missing_headers' | 'bad_timestamp' | 'stale' | 'bad_secret' | 'no_match'
    }

/** The key bytes of a Standard Webhooks secret: base64 after the `whsec_` prefix (or the whole value without one). */
export function secretKey(secret: string): Buffer | null {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null
  const key = Buffer.from(raw, 'base64')
  return key.length ? key : null
}

export function sign(key: Buffer, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')
}

/** Whether a delivery is signed with this secret and recent: one `v1` signature of the list matching is enough. */
export function verifySignature(input: {
  id: string | null
  timestamp: string | null
  signature: string | null
  body: string
  secret: string
  now?: Date
}): SignatureCheck {
  const { id, timestamp, signature, body } = input
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' }
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale' }
  }
  const key = secretKey(input.secret)
  if (!key) return { ok: false, reason: 'bad_secret' }
  const expected = Buffer.from(sign(key, id, timestamp, body), 'base64')
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',')
    if (version !== 'v1' || !value) continue
    const given = Buffer.from(value, 'base64')
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true }
  }
  return { ok: false, reason: 'no_match' }
}

/** How long a delivery's id is remembered: Shopmonkey retries for far less (PROVISIONAL(M0:S1)). */
export const DELIVERY_KEPT_MS = 7 * 24 * 60 * 60_000

type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The record a delivery is about, to read again: its `table` and `data.id`. A payment is read with its order (a
 * payment is staged from its order's payment search). Null for a table no record is read from by id.
 * PROVISIONAL(M0:S1): the body is `{ operation, table, data, diff }` with Shopmonkey's table names.
 */
export function refetchTarget(body: unknown): { table: string; id: string } | null {
  if (!isRow(body) || typeof body.table !== 'string' || !isRow(body.data)) return null
  const { table, data } = body
  if (table === 'payment') {
    return typeof data.orderId === 'string' && data.orderId
      ? { table: 'order', id: data.orderId }
      : null
  }
  if (!recordPath(table) || typeof data.id !== 'string' || !data.id) return null
  return { table, id: data.id }
}

const ok = (extra: Row = {}) =>
  new Response(JSON.stringify({ ok: true, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'

/**
 * `webhook.receive` (M7 task 1): a signed delivery queues a `refetch` of the record it names, once per delivery id,
 * and answers at once (Shopmonkey gives up on a delivery after 55 s). A refused signature throws: the route answers
 * 400 and logs the reason, never the body.
 */
export async function receive(
  request: Request,
  ctx: ConnectorContext
): Promise<{ jobs: { kind: string; payload?: Record<string, unknown> }[]; response?: Response }> {
  const secret =
    typeof ctx.credentials.webhookSecret === 'string' ? ctx.credentials.webhookSecret : ''
  if (!secret) throw new Error('This connection has no webhook secret')
  const body = await request.text()
  const deliveryId = request.headers.get('webhook-id')
  const check = verifySignature({
    id: deliveryId,
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
    body,
    secret,
  })
  if (!check.ok) throw new Error(`Signature refused (${check.reason})`)
  const scope = { connectionId: ctx.connection.id, organizationId: ctx.connection.organizationId }
  if (ctx.connection.state.cutover) return { jobs: [], response: ok({ ignored: 'cut over' }) }

  // Once per delivery: a retry or a replay of one already taken finds its id and queues nothing.
  try {
    await db.inboundWebhookDelivery.create({
      data: { connectionId: scope.connectionId, deliveryId: deliveryId as string },
    })
  } catch (err) {
    if (isUniqueViolation(err)) return { jobs: [], response: ok({ duplicate: true }) }
    throw err
  }
  await db.inboundWebhookDelivery.deleteMany({
    where: {
      connectionId: scope.connectionId,
      receivedAt: { lt: new Date(Date.now() - DELIVERY_KEPT_MS) },
    },
  })

  let parsed: unknown = null
  try {
    parsed = JSON.parse(body)
  } catch {
    // Signed but not JSON: nothing to act on.
  }
  const target = refetchTarget(parsed)
  if (!target) {
    const table = isRow(parsed) && typeof parsed.table === 'string' ? parsed.table : 'unknown'
    await ctx.log('info', `Shopmonkey webhook for ${table} not acted on`, { table })
    return { jobs: [], response: ok({ ignored: table }) }
  }
  try {
    // One job per record while it waits: a burst of edits to one order reads it once.
    await enqueueJob({
      ...scope,
      kind: 'refetch',
      payload: target,
      idempotencyKey: `refetch:${target.table}:${target.id}`,
    })
  } catch (err) {
    // Not queued, so not taken: Shopmonkey's retry of it is acted on.
    await db.inboundWebhookDelivery.deleteMany({
      where: { connectionId: scope.connectionId, deliveryId: deliveryId as string },
    })
    throw err
  }
  return { jobs: [], response: ok() }
}
