/**
 * @vitest-environment node
 *
 * fork: the public API's shared conventions (docs/fork/API.md §3): cursor paging over
 * (updatedAt, id), and ETags with If-Match.
 */
import { describe, expect, it } from 'vitest'
import { etagFor, ifMatchSatisfied } from '@/features/public-api/Lib/etag'
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  pageArgs,
  pageMeta,
  pageQuerySchema,
} from '@/features/public-api/Lib/pagination'

const row = (id: string, at: string) => ({ id, updatedAt: new Date(at) })

describe('paging', () => {
  it('defaults to 50 a page and refuses more than 200', () => {
    expect(pageQuerySchema.parse({}).limit).toBe(50)
    expect(pageQuerySchema.parse({ limit: '200' }).limit).toBe(200)
    expect(pageQuerySchema.safeParse({ limit: '201' }).success).toBe(false)
    expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
  })

  it('reads in a stable order and asks for one row more than the page', () => {
    const args = pageArgs(pageQuerySchema.parse({ limit: '10' }))
    expect(args.orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }])
    expect(args.take).toBe(11)
    expect(args.where).toEqual({})
  })

  it('continues after the last row, ties on updatedAt broken by id', () => {
    const cursor = encodeCursor(row('b', '2026-01-02T03:04:05.000Z'))
    const args = pageArgs(pageQuerySchema.parse({ cursor }))
    const at = new Date('2026-01-02T03:04:05.000Z')
    expect(args.where).toEqual({
      AND: [{ OR: [{ updatedAt: { gt: at } }, { updatedAt: at, id: { gt: 'b' } }] }],
    })
  })

  it('filters by updatedSince alongside the cursor', () => {
    const args = pageArgs(pageQuerySchema.parse({ updatedSince: '2026-01-01T00:00:00Z' }))
    expect(args.where).toEqual({
      AND: [{ updatedAt: { gte: new Date('2026-01-01T00:00:00Z') } }],
    })
  })

  it('says whether there is more and where the next page starts', () => {
    const rows = [
      row('a', '2026-01-01T00:00:00Z'),
      row('b', '2026-01-02T00:00:00Z'),
      row('c', '2026-01-03T00:00:00Z'),
    ]
    const page = pageMeta(rows, 2)
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(page.meta.hasMore).toBe(true)
    expect(decodeCursor(page.meta.nextCursor as string)).toEqual(rows[1])
    expect(pageMeta(rows, 3).meta).toEqual({ hasMore: false, nextCursor: null })
  })

  it('refuses a cursor it did not issue', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(InvalidCursorError)
    const forged = Buffer.from(JSON.stringify({ u: 'yesterday', i: 'x' })).toString('base64url')
    expect(() => decodeCursor(forged)).toThrow(InvalidCursorError)
  })
})

describe('ETags', () => {
  const record = row('rec-1', '2026-03-04T05:06:07.000Z')

  it('change when the record changes', () => {
    expect(etagFor(record)).toMatch(/^"[A-Za-z0-9_-]+"$/)
    expect(etagFor(record)).toBe(etagFor({ ...record }))
    expect(etagFor(row('rec-1', '2026-03-04T05:06:08.000Z'))).not.toBe(etagFor(record))
  })

  it('let a write through with no If-Match, *, or the current tag, and stop a stale one', () => {
    expect(ifMatchSatisfied(null, record)).toBe(true)
    expect(ifMatchSatisfied('*', record)).toBe(true)
    expect(ifMatchSatisfied(etagFor(record), record)).toBe(true)
    // If-Match compares strongly: a weak tag never matches (RFC 9110 §13.1.1).
    expect(ifMatchSatisfied(`W/${etagFor(record)}`, record)).toBe(false)
    expect(ifMatchSatisfied(`"old", ${etagFor(record)}`, record)).toBe(true)
    expect(ifMatchSatisfied('"old"', record)).toBe(false)
  })
})
