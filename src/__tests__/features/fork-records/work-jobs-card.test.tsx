/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 1): the Jobs card on the work order and quote pages. It
 * shows the lines under their jobs and "Other", saves job changes at once and moves lines in the form. (A workshop
 * without jobs never mounts it: its page reads that on the server; the work-jobs Playwright spec shows it.) SYNTHETIC
 * data.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/components/confirm-dialog'

const actions = vi.hoisted(() => ({
  getWorkJobs: vi.fn(),
  createWorkJob: vi.fn(),
  updateWorkJob: vi.fn(),
  deleteWorkJob: vi.fn(),
  reorderWorkJobs: vi.fn(),
}))
vi.mock('@/features/fork-records/Actions/getWorkJobs', () => ({ getWorkJobs: actions.getWorkJobs }))
vi.mock('@/features/fork-records/Actions/createWorkJob', () => ({
  createWorkJob: actions.createWorkJob,
}))
vi.mock('@/features/fork-records/Actions/updateWorkJob', () => ({
  updateWorkJob: actions.updateWorkJob,
}))
vi.mock('@/features/fork-records/Actions/deleteWorkJob', () => ({
  deleteWorkJob: actions.deleteWorkJob,
}))
vi.mock('@/features/fork-records/Actions/reorderWorkJobs', () => ({
  reorderWorkJobs: actions.reorderWorkJobs,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { WorkJobsCard } from '@/features/fork-records/Components/WorkJobsCard'

const JOBS = [
  {
    id: 'j1',
    name: 'Front brakes',
    note: 'Customer approved by phone',
    authorizationStatus: 'Authorized',
  },
  { id: 'j2', name: 'Oil change', note: null, authorizationStatus: null },
]
const parent = { kind: 'workOrder' as const, id: 'wo-1' }
const labor = [
  { description: 'Replace discs', total: 250, jobId: 'j1' },
  { description: 'Oil change labour', total: 70, jobId: 'j2' },
]
const parts = [
  { name: 'Brake disc', total: 150, jobId: 'j1' },
  { name: 'Wiper blade', total: 30, jobId: null },
]

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ConfirmProvider>{children}</ConfirmProvider>
    </QueryClientProvider>
  )
}

function renderCard(onMoveLine = vi.fn(), locked = false) {
  render(
    wrap(
      <WorkJobsCard
        parent={parent}
        initialJobs={JOBS}
        laborItems={labor}
        partItems={parts}
        onMoveLine={onMoveLine}
        locked={locked}
      />
    )
  )
  return onMoveLine
}

beforeEach(() => {
  vi.clearAllMocks()
  actions.getWorkJobs.mockResolvedValue({ success: true, data: { usesJobs: true, jobs: JOBS } })
  for (const write of [
    actions.createWorkJob,
    actions.updateWorkJob,
    actions.deleteWorkJob,
    actions.reorderWorkJobs,
  ]) {
    write.mockResolvedValue({ success: true, data: {} })
  }
})

describe('the Jobs card', () => {
  it('shows the jobs the page read on the server, without asking again', async () => {
    renderCard()
    expect(screen.getByRole('region', { name: 'Front brakes' })).toBeInTheDocument()
    expect(actions.getWorkJobs).not.toHaveBeenCalled()
  })

  it('shows each job with its note, status, subtotal and lines, and the lines of no job under Other', async () => {
    renderCard()
    const brakes = await screen.findByRole('region', { name: 'Front brakes' })
    expect(within(brakes).getByText('Customer approved by phone')).toBeInTheDocument()
    expect(within(brakes).getByText('Authorized')).toBeInTheDocument()
    expect(within(brakes).getByText('Replace discs')).toBeInTheDocument()
    expect(within(brakes).getByText('Brake disc')).toBeInTheDocument()
    expect(within(brakes).getByText('$400.00')).toBeInTheDocument()
    const other = screen.getByRole('region', { name: 'Other' })
    expect(within(other).getByText('Wiper blade')).toBeInTheDocument()
  })

  it('moves a job up at once, as a new order of all the jobs', async () => {
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Move Oil change up' }))
    await waitFor(() =>
      expect(actions.reorderWorkJobs).toHaveBeenCalledWith({ parent, jobIds: ['j2', 'j1'] })
    )
    expect(screen.getByRole('button', { name: 'Move Front brakes up' })).toBeDisabled()
  })

  it('adds a job with its name and note', async () => {
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Add job' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Alignment' } })
    fireEvent.change(within(dialog).getByLabelText('Note'), {
      target: { value: 'After the tyres' },
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    })
    expect(actions.createWorkJob).toHaveBeenCalledWith({
      parent,
      name: 'Alignment',
      note: 'After the tyres',
    })
  })

  it('deletes a job after asking, and moves its lines to Other in the form', async () => {
    const onMoveLine = renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Front brakes' }))
    const question = await screen.findByRole('alertdialog')
    await act(async () => {
      fireEvent.click(within(question).getByRole('button', { name: 'Delete' }))
    })
    expect(actions.deleteWorkJob).toHaveBeenCalledWith({ parent, jobId: 'j1' })
    await waitFor(() => expect(onMoveLine).toHaveBeenCalledWith('labor', 0, null))
    expect(onMoveLine).toHaveBeenCalledWith('part', 0, null)
    expect(onMoveLine).toHaveBeenCalledTimes(2)
  })

  it('is read only on a locked document', async () => {
    renderCard(vi.fn(), true)
    expect(await screen.findByRole('button', { name: 'Add job' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete Oil change' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Job for Brake disc' })).toBeDisabled()
  })
})
