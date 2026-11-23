/**
 * fork: issuing a load's imported invoices (M5 task 6): only the ones not issued yet, a failure counted and left
 * for the next run, and the guard against connections that would be sent every invoice. SYNTHETIC values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  connections: vi.fn(),
  issueInvoice: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    serviceRecord: { findMany: mocks.findMany },
    integrationConnection: { findMany: mocks.connections },
  },
}))
vi.mock('@/features/invoices/Lib/issueInvoice', () => ({ issueInvoice: mocks.issueInvoice }))

import {
  connectionsHearingInvoices,
  issueInvoices,
  NOTIFIED_STATUSES,
} from '@/integrations/shopmonkey/load/finish'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('issuing imported invoices', () => {
  it('issues only those not issued yet, and counts a failure without stopping', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'sr-2' }, { id: 'sr-3' }])
    mocks.issueInvoice.mockImplementation(async (id: string) => {
      if (id === 'sr-3') throw new Error('boom')
      return true
    })
    expect(await issueInvoices('org-1', ['sr-1', 'sr-2', 'sr-3'])).toEqual({ issued: 1, failed: 1 })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['sr-1', 'sr-2', 'sr-3'] }, organizationId: 'org-1', issuedAt: null },
      select: { id: true },
    })
    expect(mocks.issueInvoice.mock.calls.map((c) => c[0])).toEqual(['sr-2', 'sr-3'])
    expect(mocks.issueInvoice).toHaveBeenCalledWith('sr-2', 'org-1', 'backfill')
  })
})

describe('connections that would hear every imported invoice', () => {
  it('are the ones upstream notifies: active, and in error', async () => {
    expect(NOTIFIED_STATUSES).toEqual(['active', 'error'])
    mocks.connections.mockResolvedValue([{ connectorId: 'xero' }, { connectorId: 'stripe' }])
    const names = await connectionsHearingInvoices('org-1')
    expect(mocks.connections).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: { in: ['active', 'error'] } },
      select: { connectorId: true },
    })
    expect(names).toEqual(['Xero'])
  })
})
