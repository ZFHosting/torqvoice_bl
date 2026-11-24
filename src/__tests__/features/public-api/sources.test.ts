/**
 * @vitest-environment node
 *
 * fork (A5, `include=source`): an imported row's source is the archived record that was loaded as it
 * (`SourceRecord.localEntity`/`localId`), one query for a page, scoped by workshop; a row loaded from none has none.
 * SYNTHETIC data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ records: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ db: { sourceRecord: { findMany: mocks.records } } }))

import { sourcesOf } from '@/features/public-api/Lib/sources.server'

beforeEach(() => {
  mocks.records.mockReset()
})

const record = (localId: string, remoteId: string) => ({
  localId,
  source: 'shopmonkey',
  table: 'customer',
  remoteId,
  payload: { id: remoteId },
  remoteUpdatedAt: new Date('2026-01-02T03:04:05.000Z'),
  remoteDeletedAt: null,
})

describe('sourcesOf', () => {
  it('reads the records loaded as this page’s rows, in this workshop, and pairs them by row', async () => {
    mocks.records.mockResolvedValue([record('cus-1', 'syn_cus_1')])
    const out = await sourcesOf('org-1', 'Customer', ['cus-1', 'cus-2'])
    expect(mocks.records).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          localEntity: 'Customer',
          localId: { in: ['cus-1', 'cus-2'] },
        },
      })
    )
    expect(out.get('cus-1')).toEqual({
      source: 'shopmonkey',
      table: 'customer',
      remoteId: 'syn_cus_1',
      payload: { id: 'syn_cus_1' },
      remoteUpdatedAt: '2026-01-02T03:04:05.000Z',
      remoteDeletedAt: null,
    })
    // Never imported.
    expect(out.has('cus-2')).toBe(false)
  })

  it('asks nothing for an empty page', async () => {
    expect((await sourcesOf('org-1', 'Customer', [])).size).toBe(0)
    expect(mocks.records).not.toHaveBeenCalled()
  })

  it('gives a row loaded from two records the first one fetched', async () => {
    mocks.records.mockResolvedValue([
      { ...record('tech-1', 'syn_usr_1'), table: 'user' },
      { ...record('tech-1', 'syn_tec_1'), table: 'technician' },
    ])
    const out = await sourcesOf('org-1', 'Technician', ['tech-1'])
    expect(out.get('tech-1')).toMatchObject({ table: 'user', remoteId: 'syn_usr_1' })
  })
})
