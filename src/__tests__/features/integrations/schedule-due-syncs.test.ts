// @vitest-environment node
/**
 * fork (M7): queuing a connector's timed job writes only `state.scheduleRuns`, in one statement, never the whole
 * state it read: a connector saving its own keys meanwhile (the Shopmonkey sync's checkpoints, its cutover) keeps
 * them. And a schedule whose last run is set as late as a date can be (the Shopmonkey cutover) is never due again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  executeRaw: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    integrationConnection: { findMany: mocks.findMany, update: mocks.update },
    integrationJob: { findUnique: mocks.findUnique, create: mocks.create },
    $executeRaw: mocks.executeRaw,
  },
}))
vi.mock('@/integrations/registry', () => ({
  getManifest: () => ({ id: 'shopmonkey', schedules: [{ job: 'sync.delta', everyMinutes: 10 }] }),
}))
vi.mock('@/lib/features', () => ({ getFeatures: vi.fn(async () => ({})) }))
vi.mock('@/features/integrations/Lib/plan', () => ({ connectorAllowed: () => true }))
vi.mock('@/features/integrations/Lib/connections', () => ({
  loadConnection: vi.fn(),
  setConnectionStatus: vi.fn(),
  writeLog: vi.fn(),
}))

import { scheduleDueSyncs } from '@/features/integrations/Lib/jobs'

const connection = (scheduleRuns: Record<string, number>) => ({
  id: 'conn-1',
  organizationId: 'org-1',
  connectorId: 'shopmonkey',
  state: { extract: { runId: 'run-1' }, cutover: null, scheduleRuns },
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findUnique.mockResolvedValue(null)
  mocks.create.mockResolvedValue({ id: 'job-1' })
  mocks.executeRaw.mockResolvedValue(1)
})

describe('scheduleDueSyncs', () => {
  it('queues a due job and sets only scheduleRuns, in one statement', async () => {
    mocks.findMany.mockResolvedValue([connection({})])
    expect(await scheduleDueSyncs()).toBe(1)
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'sync.delta',
          idempotencyKey: 'schedule:sync.delta',
        }),
      })
    )
    // No write of the whole state, which would put back the `extract` read above over a newer one.
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1)
    const [sql, ...values] = mocks.executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(sql.join('?')).toMatch(
      /jsonb_set\(COALESCE\("state", '\{\}'::jsonb\), '\{scheduleRuns\}'/
    )
    expect(JSON.parse(values[0] as string)).toEqual({ 'sync.delta': expect.any(Number) })
    expect(values[1]).toBe('conn-1')
  })

  it('never queues a schedule whose last run is as late as a date can be', async () => {
    mocks.findMany.mockResolvedValue([connection({ 'sync.delta': 8_640_000_000_000_000 })])
    expect(await scheduleDueSyncs()).toBe(0)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.executeRaw).not.toHaveBeenCalled()
  })
})
