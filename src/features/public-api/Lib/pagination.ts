/**
 * Cursor paging for every public API list (docs/fork/API.md §3, "Paging" and "Sync").
 *
 * Lists are read in a stable order, `(updatedAt, id)` ascending, so a client walking the pages sees
 * every record exactly once even while records change: a record updated during the walk moves to the
 * end, where the walk reaches it again with its new state. The cursor is the last row's
 * `(updatedAt, id)`, base64url-encoded JSON, opaque to clients.
 */
import { z } from 'zod'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
  updatedSince: z.iso.datetime({ offset: true }).optional(),
})
export type PageQuery = z.infer<typeof pageQuerySchema>

const cursorSchema = z.object({ u: z.iso.datetime({ offset: true }), i: z.string().min(1) })

export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not one this API issued.')
    this.name = 'InvalidCursorError'
  }
}

export function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ u: row.updatedAt.toISOString(), i: row.id })).toString(
    'base64url'
  )
}

export function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'))
    )
    return { updatedAt: new Date(parsed.u), id: parsed.i }
  } catch {
    throw new InvalidCursorError()
  }
}

/**
 * Prisma arguments for one page: the `where` to AND with the resource's own filters, the stable
 * order, and `take: limit + 1` so `pageMeta` can tell whether there is more.
 */
export function pageArgs(query: PageQuery) {
  const and: Record<string, unknown>[] = []
  if (query.updatedSince) and.push({ updatedAt: { gte: new Date(query.updatedSince) } })
  if (query.cursor) {
    const { updatedAt, id } = decodeCursor(query.cursor)
    and.push({ OR: [{ updatedAt: { gt: updatedAt } }, { updatedAt, id: { gt: id } }] })
  }
  return {
    where: and.length ? { AND: and } : {},
    orderBy: [{ updatedAt: 'asc' as const }, { id: 'asc' as const }],
    take: query.limit + 1,
  }
}

/** Trims the extra row `pageArgs` asked for and says where the next page starts. */
export function pageMeta<T extends { updatedAt: Date; id: string }>(
  rows: T[],
  limit: number
): { rows: T[]; meta: { hasMore: boolean; nextCursor: string | null } } {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return { rows: page, meta: { hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null } }
}
