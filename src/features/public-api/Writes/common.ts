/** Pieces every public API write shares (docs/fork/milestones/A4-write-endpoints.md). */
import 'server-only'
import { publicApiError } from '../Lib/errors'
import { readOne, type ReadResource } from '../Lib/readResource'

/** A PATCH body with the record's id from the path: the path wins over an `id` in the body. */
export function withId(body: unknown, id: string): unknown {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), id }
    : body
}

/** The record as its read endpoint serves it, with its new ETag: what a create or an update answers. */
export async function answerWith<Row extends { id: string; updatedAt: Date }, Out>(
  resource: ReadResource<Row, Out>,
  organizationId: string,
  id: string,
  status = 200
): Promise<Response> {
  const one = await readOne(resource, organizationId, id)
  if (!one) return publicApiError(404, 'not_found', 'Not found.')
  return Response.json({ data: one.data }, { status, headers: { ETag: one.etag } })
}

/** What a delete answers. */
export function deleted(id: string) {
  return { data: { id, deleted: true } }
}
