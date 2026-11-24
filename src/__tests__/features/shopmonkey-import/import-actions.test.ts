/**
 * @vitest-environment node
 *
 * fork (M8 acceptance): every action of the Shopmonkey import screen is the owner's or an admin's. A member gets
 * `forbidden`, whatever their role's permissions; reads need the settings read permission and everything else the
 * settings update permission; the connection is always the caller's own workshop's.
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
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: async (fn: (ctx: unknown) => Promise<unknown>, options: unknown) => {
    mocks.options.push(options)
    try {
      return { success: true, data: await fn(mocks.ctx) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}))
vi.mock('@/lib/db', () => ({
  db: {
    integrationConnection: { findUnique: mocks.findUnique },
    auditLog: { findMany: vi.fn(async () => []) },
    sourceRecord: { findMany: vi.fn(async () => []) },
    technician: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('@/lib/demo', () => ({ demoGuard: () => undefined }))
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

  it('refuses a cutover without the operator’s word that the shop has stopped', async () => {
    mocks.ctx.isAdmin = true
    const result = await queueShopmonkeyCutover({ dryRun: false })
    expect(result.success).toBe(false)
  })
})
