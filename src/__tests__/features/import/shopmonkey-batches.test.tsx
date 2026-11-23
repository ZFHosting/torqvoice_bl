/**
 * fork: a Shopmonkey load's batches in Settings → Data (M5 review). They're listed, labelled (the inspections
 * batch too), and never offered the spreadsheet Undo, which covers three of the tables a load writes; the action
 * refuses it as well. A Shopmonkey load is undone as a whole by its own undo.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/components/confirm-dialog'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/demo', () => ({ demoGuard: vi.fn() }))
vi.mock('@/lib/with-auth', () => ({
  withAuth: async (fn: (ctx: { organizationId: string; userId: string }) => unknown) => {
    try {
      return { success: true, data: await fn({ organizationId: 'org-1', userId: 'user-1' }) }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  },
}))
vi.mock('@/lib/db', () => ({
  db: {
    importBatch: { findFirst: mocks.findFirst },
    customer: { deleteMany: mocks.deleteMany },
    vehicle: { deleteMany: mocks.deleteMany, findMany: vi.fn(async () => []) },
    serviceRecord: { deleteMany: mocks.deleteMany, findMany: vi.fn(async () => []) },
    $transaction: vi.fn(),
  },
}))

const batch = (over: Record<string, unknown>) => ({
  id: 'b1',
  source: 'spreadsheet',
  entity: 'customers',
  fileName: 'customers-2026.csv',
  status: 'completed',
  createdAt: new Date('2026-11-01T10:00:00Z'),
  created: 3,
  updated: 0,
  skipped: 0,
  failed: 0,
  attached: { customers: 3, vehicles: 0, serviceRecords: 0 },
  ...over,
})

// The list is stubbed; the undo action is the real one.
vi.mock('@/features/import/Actions/importActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/import/Actions/importActions')>()),
  listImportBatches: async () => ({
    success: true,
    data: [
      batch({ id: 'sm1', source: 'shopmonkey', fileName: 'Shopmonkey import' }),
      batch({
        id: 'sm2',
        source: 'shopmonkey',
        entity: 'inspections',
        fileName: 'Shopmonkey import',
        attached: { customers: 0, vehicles: 0, serviceRecords: 0 },
      }),
      batch({ id: 'b1' }),
    ],
  }),
}))

import { undoImportBatch } from '@/features/import/Actions/importActions'
import { ImportHistoryCard } from '@/features/import/Components/ImportHistoryCard'

describe('a Shopmonkey load in the import history', () => {
  it('is listed with its entity, and offers no Undo', async () => {
    render(<ImportHistoryCard />, { wrapper: ConfirmProvider })
    expect(await screen.findAllByText('Shopmonkey import')).toHaveLength(2)
    expect(screen.getByText('inspections')).toBeInTheDocument()
    // Only the spreadsheet's batch can be undone from here.
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1)
  })

  it('is refused by the spreadsheet undo, which deletes nothing', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'sm1', source: 'shopmonkey', status: 'completed' })
    const result = await undoImportBatch('sm1')
    expect(result).toMatchObject({
      success: false,
      error: 'A Shopmonkey import is undone as a whole, with the Shopmonkey importer',
    })
    expect(mocks.deleteMany).not.toHaveBeenCalled()
  })
})
