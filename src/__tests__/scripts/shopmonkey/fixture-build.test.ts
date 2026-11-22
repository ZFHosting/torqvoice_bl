/**
 * @vitest-environment node
 *
 * The core of the fixture CLI (scripts/shopmonkey/fixture-build.ts): the same Shopmonkey record
 * arrives from a list, a search and its own "Find" endpoint, and the fixture must keep everything any
 * of them carried; and nothing is produced while a replaced or deny-listed value is still present.
 */
import { describe, expect, it } from 'vitest'
import { buildFixtures, mergeRecords } from '../../../../scripts/shopmonkey/fixture-build'
import type { RawResponseFile } from '../../../../scripts/shopmonkey/raw'

const SALT = 'test-salt-for-fixture-build-0123456789'

function raw(label: string, table: string, data: unknown, meta?: unknown): RawResponseFile {
  return {
    table,
    label,
    request: { method: 'GET', path: '/v3/order' },
    status: 200,
    headers: {},
    durationMs: 1,
    body: { success: true, data, ...(meta ? { meta } : {}) },
    recordedAt: '2026-11-22T00:00:00.000Z',
  }
}

const findOrder = raw('get-v3-order-o1', 'order', {
  id: 'o1',
  number: '1001',
  status: 'Invoice',
  files: [{ id: 'f1', fileName: 'scan.pdf', fileType: 'application/pdf' }],
  customer: { id: 'c1', firstName: 'Zebulon' },
})
// Sorts after the Find response by label, and carries no files.
const listPage = raw(
  's4-orders',
  'order',
  [
    { id: 'o1', number: '1001', status: 'Invoice', files: [], workflowStatusId: 'w1' },
    { id: 'o2', number: '1002', status: 'Estimate' },
  ],
  { hasMore: false, total: 2 }
)

describe('buildFixtures', () => {
  it('merges every response for a record instead of keeping whichever came last', () => {
    const { files, counts, leaks } = buildFixtures([findOrder, listPage], { salt: SALT })
    expect(leaks).toEqual([])
    expect(counts).toEqual({ order: 2 })
    const fixture = JSON.parse(files.get('order.json') as string)
    expect(fixture.total).toBe(2)
    const o1 = fixture.records.find((r: { id: string }) => r.id === 'o1')
    expect(o1.files).toHaveLength(1)
    expect(o1.files[0].fileType).toBe('application/pdf')
    expect(o1.workflowStatusId).toBe('w1')
    expect(o1.customer.firstName).not.toBe('Zebulon')
    expect(fixture.anonymized).toBe(true)
  })

  it('produces nothing when a deny-listed value is still in the output', () => {
    const result = buildFixtures([findOrder, listPage], { salt: SALT, deny: ['application/pdf'] })
    expect(result.leaks).toEqual(['application/pdf'])
    expect(result.files.size).toBe(0)
  })

  it('ignores failed responses and responses without a table', () => {
    const failed = { ...findOrder, status: 404 }
    const untabled = { ...listPage, table: null }
    expect(buildFixtures([failed, untabled], { salt: SALT }).files.size).toBe(0)
  })
})

describe('mergeRecords', () => {
  it('keeps non-null values, merges objects and never lets an empty list replace a full one', () => {
    expect(
      mergeRecords(
        { a: 1, b: null, c: { x: 1 }, list: [1], keep: 'k' },
        { a: 2, b: 'set', c: { y: 2 }, list: [], keep: null }
      )
    ).toEqual({ a: 2, b: 'set', c: { x: 1, y: 2 }, list: [1], keep: 'k' })
  })
})
