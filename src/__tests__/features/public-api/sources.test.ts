/**
 * @vitest-environment node
 *
 * fork (A5, `include=source`): an imported row's source is found through its import link (this workshop's
 * connections only) and the archive, two queries for a page; a row without a link, or whose archived record is gone,
 * has none. SYNTHETIC data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ links: vi.fn(), records: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({
  db: {
    integrationLink: { findMany: mocks.links },
    sourceRecord: { findMany: mocks.records },
  },
}))

import { sourcesOf } from '@/features/public-api/Lib/sources.server'

beforeEach(() => {
  mocks.links.mockReset()
  mocks.records.mockReset()
})

describe('sourcesOf', () => {
  it('reads the links of this workshop’s connections, then the archive, and pairs them by row', async () => {
    mocks.links.mockResolvedValue([
      {
        entityId: 'cus-1',
        remoteId: 'customer:syn_cus_1',
        connection: { connectorId: 'shopmonkey' },
      },
      {
        entityId: 'cus-2',
        remoteId: 'customer:syn_cus_2',
        connection: { connectorId: 'shopmonkey' },
      },
    ])
    mocks.records.mockResolvedValue([
      {
        source: 'shopmonkey',
        table: 'customer',
        remoteId: 'syn_cus_1',
        payload: { id: 'syn_cus_1' },
        remoteUpdatedAt: new Date('2026-01-02T03:04:05.000Z'),
        remoteDeletedAt: null,
      },
    ])
    const out = await sourcesOf('org-1', 'Customer', ['cus-1', 'cus-2', 'cus-3'])
    expect(mocks.links).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType: 'Customer',
          entityId: { in: ['cus-1', 'cus-2', 'cus-3'] },
          connection: { organizationId: 'org-1' },
        },
      })
    )
    expect(mocks.records).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          OR: [
            { source: 'shopmonkey', table: 'customer', remoteId: 'syn_cus_1' },
            { source: 'shopmonkey', table: 'customer', remoteId: 'syn_cus_2' },
          ],
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
    // Linked, but its archived record is gone; and never imported.
    expect(out.has('cus-2')).toBe(false)
    expect(out.has('cus-3')).toBe(false)
  })

  it('asks nothing for an empty page, or when no row was imported', async () => {
    expect((await sourcesOf('org-1', 'Customer', [])).size).toBe(0)
    expect(mocks.links).not.toHaveBeenCalled()
    mocks.links.mockResolvedValue([])
    expect((await sourcesOf('org-1', 'Customer', ['cus-1'])).size).toBe(0)
    expect(mocks.records).not.toHaveBeenCalled()
  })

  it('keeps a row’s first link when it has two, and skips a link that names no table', async () => {
    mocks.links.mockResolvedValue([
      { entityId: 'tech-1', remoteId: 'user:syn_usr_1', connection: { connectorId: 'shopmonkey' } },
      {
        entityId: 'tech-1',
        remoteId: 'technician:syn_tec_1',
        connection: { connectorId: 'shopmonkey' },
      },
      { entityId: 'tech-2', remoteId: 'no-table', connection: { connectorId: 'shopmonkey' } },
    ])
    mocks.records.mockResolvedValue([])
    await sourcesOf('org-1', 'Technician', ['tech-1', 'tech-2'])
    expect(mocks.records.mock.calls[0][0].where.OR).toEqual([
      { source: 'shopmonkey', table: 'user', remoteId: 'syn_usr_1' },
    ])
  })
})
