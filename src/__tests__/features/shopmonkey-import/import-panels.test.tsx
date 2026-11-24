/**
 * fork (M8): what the import screen's cards do when the queue or a read says no. The history says it couldn't be
 * read instead of hiding every Undo; the mapping can't be saved while it reads again, and a failed re-read after a
 * save keeps the operator's choices on screen; Load and Dry run wait while a cutover is queued or runs. SYNTHETIC
 * data.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  mapping: vi.fn(),
  save: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/components/confirm-dialog', () => ({ useConfirm: () => vi.fn(async () => true) }))
vi.mock('@/components/upgrade-gate', () => ({ handleGated: () => false }))
vi.mock('@/features/shopmonkey-import/Actions/getShopmonkeyLoadHistory', () => ({
  getShopmonkeyLoadHistory: mocks.history,
}))
vi.mock('@/features/shopmonkey-import/Actions/undoShopmonkeyLoad', () => ({
  undoShopmonkeyLoad: vi.fn(),
}))
vi.mock('@/features/shopmonkey-import/Actions/getShopmonkeyMapping', () => ({
  getShopmonkeyMapping: mocks.mapping,
}))
vi.mock('@/features/shopmonkey-import/Actions/saveShopmonkeyMapping', () => ({
  saveShopmonkeyMapping: mocks.save,
}))
vi.mock('@/features/shopmonkey-import/Actions/queueShopmonkeyLoad', () => ({
  queueShopmonkeyLoad: vi.fn(),
}))
vi.mock('@/features/shopmonkey-import/Actions/resumeShopmonkeyExtract', () => ({
  resumeShopmonkeyExtract: vi.fn(),
}))
vi.mock('@/features/shopmonkey-import/Actions/startShopmonkeyImportExtract', () => ({
  startShopmonkeyImportExtract: vi.fn(),
}))
vi.mock('@/features/shopmonkey-import/Actions/stopShopmonkeyExtract', () => ({
  stopShopmonkeyExtract: vi.fn(),
}))

import { ImportHistoryRuns } from '@/features/shopmonkey-import/Components/ImportHistoryRuns'
import { ImportMappingCard } from '@/features/shopmonkey-import/Components/ImportMappingCard'
import { ImportRunCard } from '@/features/shopmonkey-import/Components/ImportRunCard'
import type { ImportView, MappingView } from '@/features/shopmonkey-import/Components/types'

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
}

const view = (over: Partial<ImportView> = {}): ImportView => ({
  connectionId: 'conn-1',
  status: 'active',
  webhookUrl: 'http://localhost/api/integrations/shopmonkey/conn-1/webhook',
  extract: {
    runId: 'run-1',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T11:00:00.000Z',
    stopped: false,
    sync: false,
    calls: 10,
    tables: [],
    perMinute: null,
    minutesLeft: null,
  },
  loadRun: null,
  lastDryRun: null,
  lastLoad: null,
  report: null,
  lastSync: null,
  cutoverRun: null,
  cutover: null,
  live: { extract: false, sync: false, load: false, cutover: false },
  ...over,
})

const mapping: MappingView = {
  statuses: [{ id: 'syn_wfs_1', name: 'Estimate', stage: 'pending', defaultStage: 'pending' }],
  users: [],
  technicians: [],
}

beforeEach(() => {
  mocks.history.mockReset()
  mocks.mapping.mockReset()
  mocks.save.mockReset()
})

describe('the import screen’s cards', () => {
  it('say the loads couldn’t be read, rather than hiding every Undo', async () => {
    mocks.history.mockResolvedValue({ success: false, error: 'Database unavailable' })
    wrap(<ImportHistoryRuns view={view()} onChanged={() => undefined} />)
    expect(await screen.findByTestId('shopmonkey-runs-error')).toHaveTextContent(
      'The loads could not be read.'
    )
  })

  it('list the loads with their Undo when they can be read', async () => {
    mocks.history.mockResolvedValue({
      success: true,
      data: [
        { runId: 'run-a', at: '2026-01-01T12:00:00.000Z', records: 4, undone: false, sync: false },
      ],
    })
    wrap(<ImportHistoryRuns view={view()} onChanged={() => undefined} />)
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeEnabled()
  })

  it('keep Load and Dry run shut while a cutover is queued or runs', () => {
    wrap(
      <ImportRunCard
        view={view({ live: { extract: false, sync: false, load: false, cutover: true } })}
        onChanged={() => undefined}
      />
    )
    expect(screen.getByRole('button', { name: 'Load' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled()
  })

  it('open Load and Dry run on a finished extract with nothing running', () => {
    wrap(<ImportRunCard view={view()} onChanged={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Load' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled()
  })

  it('save no mapping while it reads again, and keep the choices when the re-read fails', async () => {
    let answer: (value: unknown) => void = () => undefined
    mocks.mapping.mockResolvedValueOnce({ success: true, data: mapping })
    wrap(<ImportMappingCard runKey="run-1" onSaved={() => undefined} />)
    const save = await screen.findByTestId('shopmonkey-mapping-save')
    await waitFor(() => expect(save).toBeEnabled())

    // The save works; reading it back hangs, then fails.
    mocks.save.mockResolvedValue({ success: true, data: { saved: true } })
    mocks.mapping.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    fireEvent.click(save)
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(save).toBeDisabled())
    answer({ success: false, error: 'Database unavailable' })
    await waitFor(() => expect(save).toBeEnabled())
    // The card still shows the mapping it had, choices and all.
    expect(screen.getByText('Estimate')).toBeInTheDocument()
  })
})
