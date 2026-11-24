/**
 * @vitest-environment node
 *
 * fork (M8 acceptance): every action of the Shopmonkey import screen is the owner's or an admin's. A member gets
 * `forbidden`, whatever their role's permissions; reads need the settings read permission and everything else the
 * settings update permission; the connection is always the caller's own workshop's. A load waits for a finished
 * extract, and an undo for the load or cutover under way. On a plan without integrations, what changes anything is
 * refused as `gated`; the screen can still be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ctx: {
    userId: 'user-1',
    organizationId: 'org-1',
    role: 'member',
    isSuperAdmin: false,
    isAdmin: false,
  },
  options: [] as unknown[],
  findUnique: vi.fn(),
  jobs: vi.fn(),
  technicians: vi.fn(),
  features: { integrations: true } as Record<string, boolean>,
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: async (fn: (ctx: unknown) => Promise<unknown>, options: unknown) => {
    mocks.options.push(options)
    try {
      return { success: true, data: await fn(mocks.ctx) }
    } catch (err) {
      // As the real one: a plan refusal comes back as `gated`.
      if (err instanceof Error && err.name === 'FeatureGatedError') {
        return {
          success: false,
          error: err.message,
          gated: { feature: (err as { feature?: string }).feature },
        }
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}))
vi.mock('@/lib/db', () => ({
  db: {
    integrationConnection: { findUnique: mocks.findUnique },
    auditLog: { findMany: vi.fn(async () => []) },
    sourceRecord: { findMany: vi.fn(async () => []) },
    technician: { findMany: mocks.technicians },
    integrationJob: { findMany: mocks.jobs },
    // The import view's load lists.
    $queryRaw: vi.fn(async () => []),
  },
}))
vi.mock('@/lib/demo', () => ({ demoGuard: () => undefined }))
vi.mock('@/lib/features', () => {
  class FeatureGatedError extends Error {
    feature: string
    limit?: number
    constructor(feature: string, message?: string) {
      super(message ?? feature)
      this.name = 'FeatureGatedError'
      this.feature = feature
    }
  }
  return { FeatureGatedError, getFeatures: vi.fn(async () => mocks.features) }
})
vi.mock('@/features/integrations/Lib/jobs', () => ({ enqueueJob: vi.fn(async () => 'job-1') }))
vi.mock('@/integrations/shopmonkey/load/outcome', () => ({
  mergeState: vi.fn(async () => undefined),
}))
vi.mock('@/integrations/shopmonkey/load/undo', () => ({
  undoLoad: vi.fn(async () => ({ removed: {}, kept: {} })),
}))
vi.mock('@/integrations/shopmonkey/reconcile/engine', () => ({
  reconcile: vi.fn(async () => ({ passed: true })),
}))
vi.mock('@/integrations/shopmonkey/load/people', () => ({
  referencedUsers: vi.fn(async () => new Set()),
}))
vi.mock('@/features/shopmonkey-import/Lib/startExtract.server', () => ({
  startShopmonkeyExtract: vi.fn(async () => ({ runId: 'run-1' })),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))

import { getShopmonkeyImport } from '@/features/shopmonkey-import/Actions/getShopmonkeyImport'
import { getShopmonkeyMapping } from '@/features/shopmonkey-import/Actions/getShopmonkeyMapping'
import { queueShopmonkeyCutover } from '@/features/shopmonkey-import/Actions/queueShopmonkeyCutover'
import { queueShopmonkeyLoad } from '@/features/shopmonkey-import/Actions/queueShopmonkeyLoad'
import { reconcileShopmonkeyImport } from '@/features/shopmonkey-import/Actions/reconcileShopmonkeyImport'
import { resumeShopmonkeyExtract } from '@/features/shopmonkey-import/Actions/resumeShopmonkeyExtract'
import { saveShopmonkeyMapping } from '@/features/shopmonkey-import/Actions/saveShopmonkeyMapping'
import { startShopmonkeyImportExtract } from '@/features/shopmonkey-import/Actions/startShopmonkeyImportExtract'
import { stopShopmonkeyExtract } from '@/features/shopmonkey-import/Actions/stopShopmonkeyExtract'
import { undoShopmonkeyLoad } from '@/features/shopmonkey-import/Actions/undoShopmonkeyLoad'

const READS: [string, () => Promise<{ success: boolean; forbidden?: boolean }>][] = [
  ['getShopmonkeyImport', () => getShopmonkeyImport()],
  ['getShopmonkeyMapping', () => getShopmonkeyMapping()],
]
const WRITES: [string, () => Promise<{ success: boolean; forbidden?: boolean }>][] = [
  ['saveShopmonkeyMapping', () => saveShopmonkeyMapping({ statusStageMap: {}, technicianMap: {} })],
  ['startShopmonkeyImportExtract', () => startShopmonkeyImportExtract()],
  ['stopShopmonkeyExtract', () => stopShopmonkeyExtract()],
  ['resumeShopmonkeyExtract', () => resumeShopmonkeyExtract()],
  ['queueShopmonkeyLoad', () => queueShopmonkeyLoad({ dryRun: true })],
  ['reconcileShopmonkeyImport', () => reconcileShopmonkeyImport()],
  ['queueShopmonkeyCutover', () => queueShopmonkeyCutover({ dryRun: true, shopStopped: true })],
  [
    'undoShopmonkeyLoad',
    () => undoShopmonkeyLoad({ runId: '7f9c2ba4-e88f-4c3e-9f2f-0d1e2a3b4c5d' }),
  ],
]

beforeEach(() => {
  mocks.options.length = 0
  mocks.features = { integrations: true }
  mocks.jobs.mockReset()
  mocks.jobs.mockResolvedValue([])
  mocks.technicians.mockReset()
  mocks.technicians.mockResolvedValue([])
  mocks.findUnique.mockReset()
  mocks.findUnique.mockResolvedValue({
    id: 'conn-1',
    status: 'active',
    state: {
      extract: {
        runId: 'run-1',
        finishedAt: null,
        startedAt: '2026-01-01T00:00:00Z',
        steps: {},
        step: 0,
        only: null,
        calls: 0,
      },
    },
    createdById: 'user-1',
  })
})

describe('the Shopmonkey import actions', () => {
  it.each([...READS, ...WRITES])('%s refuses a member with forbidden', async (_name, call) => {
    mocks.ctx.isAdmin = false
    const result = await call()
    expect(result).toMatchObject({ success: false, forbidden: true })
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })

  it.each(
    READS
  )('%s needs the settings read permission, and reads the caller’s own connection', async (_n, call) => {
    mocks.ctx.isAdmin = true
    expect((await call()).success).toBe(true)
    expect(mocks.options.at(-1)).toEqual({
      requiredPermissions: [{ action: 'read', subject: 'settings' }],
    })
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_connectorId: { organizationId: 'org-1', connectorId: 'shopmonkey' },
        },
      })
    )
  })

  it.each(
    WRITES
  )('%s needs the settings update permission, on the caller’s own connection', async (_n, call) => {
    mocks.ctx.isAdmin = true
    await call()
    expect(mocks.options.at(-1)).toEqual({
      requiredPermissions: [{ action: 'update', subject: 'settings' }],
    })
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_connectorId: { organizationId: 'org-1', connectorId: 'shopmonkey' },
        },
      })
    )
  })

  it('refuses a second load or cutover while one is queued or running, from any tab', async () => {
    mocks.ctx.isAdmin = true
    mocks.jobs.mockResolvedValue([{ kind: 'load.run' }])
    expect(await queueShopmonkeyLoad({ dryRun: true })).toMatchObject({
      success: false,
      error: expect.stringMatching(/already queued or running/),
    })
    expect(await queueShopmonkeyCutover({ dryRun: true, shopStopped: true })).toMatchObject({
      success: false,
    })
    expect(await startShopmonkeyImportExtract()).toMatchObject({ success: false })
  })

  it('refuses a load until an extract has finished, whatever the screen in another tab shows', async () => {
    mocks.ctx.isAdmin = true
    // The fixture's extract is still running.
    expect(await queueShopmonkeyLoad({ dryRun: false })).toMatchObject({
      success: false,
      error: expect.stringMatching(/extract has not finished/),
    })
    mocks.findUnique.mockResolvedValue({
      id: 'conn-1',
      status: 'active',
      state: {},
      createdById: 'user-1',
    })
    expect(await queueShopmonkeyLoad({ dryRun: true })).toMatchObject({
      success: false,
      error: expect.stringMatching(/Nothing has been extracted/),
    })
    mocks.findUnique.mockResolvedValue({
      id: 'conn-1',
      status: 'active',
      state: { extract: { runId: 'run-1', finishedAt: '2026-01-01T01:00:00Z' } },
      createdById: 'user-1',
    })
    expect(await queueShopmonkeyLoad({ dryRun: true })).toMatchObject({ success: true })
  })

  it('refuses an undo while a load or the cutover is queued or running', async () => {
    mocks.ctx.isAdmin = true
    const { undoLoad } = await import('@/integrations/shopmonkey/load/undo')
    vi.mocked(undoLoad).mockClear()
    for (const kind of ['load.run', 'cutover.run']) {
      mocks.jobs.mockResolvedValueOnce([{ kind }])
      expect(
        await undoShopmonkeyLoad({ runId: '7f9c2ba4-e88f-4c3e-9f2f-0d1e2a3b4c5d' })
      ).toMatchObject({ success: false, error: expect.stringMatching(/undo once it has finished/) })
    }
    expect(undoLoad).not.toHaveBeenCalled()
    expect(
      await undoShopmonkeyLoad({ runId: '7f9c2ba4-e88f-4c3e-9f2f-0d1e2a3b4c5d' })
    ).toMatchObject({ success: true })
    expect(undoLoad).toHaveBeenCalledTimes(1)
  })

  it.each(WRITES)('%s is refused as gated on a plan without integrations', async (_n, call) => {
    mocks.ctx.isAdmin = true
    mocks.features = { integrations: false }
    expect(await call()).toMatchObject({ success: false, gated: { feature: 'integrations' } })
  })

  it('still reads the import on a plan without integrations', async () => {
    mocks.ctx.isAdmin = true
    mocks.features = { integrations: false }
    expect((await getShopmonkeyImport()).success).toBe(true)
  })

  it('refuses a mapping naming another workshop’s technician', async () => {
    mocks.ctx.isAdmin = true
    // The lookup is scoped by the caller's workshop: another one's technician isn't found.
    mocks.technicians.mockResolvedValue([])
    const result = await saveShopmonkeyMapping({
      statusStageMap: {},
      technicianMap: { syn_usr_1: 'technician-of-another-workshop' },
    })
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/not one of this workshop/),
    })
    const where = (mocks.technicians.mock.calls.at(-1)?.[0] as { where: Record<string, unknown> })
      .where
    expect(where).toMatchObject({ organizationId: 'org-1' })
  })

  it('refuses a cutover without the operator’s word that the shop has stopped', async () => {
    mocks.ctx.isAdmin = true
    const result = await queueShopmonkeyCutover({ dryRun: false })
    expect(result.success).toBe(false)
  })
})
