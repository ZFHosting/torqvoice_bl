/**
 * Optimistic concurrency for single records (docs/fork/API.md §3, "Concurrency"). A `GET` returns an
 * `ETag` derived from the record's id and `updatedAt`; a `PATCH` or `DELETE` that sends `If-Match`
 * with an older tag gets 412 `precondition_failed` instead of overwriting someone else's change.
 */
import { createHash } from 'node:crypto'

export function etagFor(record: { id: string; updatedAt: Date }): string {
  const digest = createHash('sha256')
    .update(`${record.id}:${record.updatedAt.toISOString()}`)
    .digest('base64url')
    .slice(0, 27)
  return `"${digest}"`
}

/**
 * Whether a write may go ahead. No `If-Match` means the client didn't ask for the check (allowed);
 * `*` matches any existing record; otherwise one of the listed tags must be the current one, by
 * strong comparison (RFC 9110 §13.1.1): a weak tag (`W/"..."`) never matches.
 */
export function ifMatchSatisfied(
  header: string | null,
  record: { id: string; updatedAt: Date }
): boolean {
  if (header === null || header.trim() === '') return true
  const current = etagFor(record)
  return header
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || tag === current)
}
