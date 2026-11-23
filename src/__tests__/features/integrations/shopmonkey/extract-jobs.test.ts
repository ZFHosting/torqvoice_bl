/**
 * @vitest-environment node
 *
 * fork: running an extract (M3): the `extract.step` job works for a time budget and reschedules
 * itself, stops when another start replaced its run, waits out a long rate limit, and records one
 * audit event when the run finishes; starting a run is scoped to the workshop; the CLI parses its
 * arguments, resumes an unfinished run and prints progress. Against the mock Shopmonkey (SYNTHETIC).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from './memoryStore'
import { createMockShopmonkey } from './mockServer'

const memory = vi.hoisted(() => ({
  current: null as null | ReturnType<typeof import('./memoryStore').createMemoryStore>,
}))
const audit = vi.hoisted(() => ({ logAudit: vi.fn(async () => undefined) }))
const queue = vi.hoisted(() => ({ enqueueJob: vi.fn(async (_input: unknown) => 'job-1') }))
const dbMock = vi.hoisted(() => ({
  integrationConnection: {
    findFirst: vi.fn(async (_args: unknown) => null as unknown),
    update: vi.fn(async (_args: unknown) => ({})),
  },
}))

vi.mock('@/lib/db', () => ({ db: dbMock }))
vi.mock('@/lib/audit', () => ({
  logAudit: audit.logAudit,
  auditDetails: (key: string, params?: Record<string, unknown>) => ({ key, params }),
}))
vi.mock('@/features/integrations/Lib/jobs', () => ({ enqueueJob: queue.enqueueJob }))
vi.mock('@/integrations/shopmonkey/extract/stage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/shopmonkey/extract/stage')>()),
  prismaSourceStore: () => memory.current?.store,
}))
vi.mock('@/integrations/shopmonkey/extract/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/shopmonkey/extract/files')>()),
  createFileStager: () => ({
    fetchUrl: async () => ({ skipped: 'not_found' }),
    write: async () => ({ skipped: 'too_large' }),
  }),
}))

import type { ConnectorContext } from '@/features/integrations/Lib/types'
import { startShopmonkeyExtract } from '@/features/shopmonkey-import/Lib/startExtract.server'
import { createShopmonkeyClient } from '@/integrations/shopmonkey/client'
import {
  driveExtract,
  formatProgress,
  parseExtractArgs,
  runToDrive,
} from '@/integrations/shopmonkey/extract/cli'
import {
  type ExtractDeps,
  extractFor,
  extractSettings,
} from '@/integrations/shopmonkey/extract/engine'
import { type ExtractState, startState } from '@/integrations/shopmonkey/extract/plan'
import { connector } from '@/integrations/shopmonkey/server'

const NOW = new Date('2025-06-01T00:00:00.000Z')

function ctxFor(mock: ReturnType<typeof createMockShopmonkey>, extract: ExtractState | undefined) {
  const ctx = {
    connection: {
      id: 'conn-1',
      organizationId: 'org-1',
      connectorId: 'shopmonkey',
      settings: { locationId: 'syn_loc_1' },
      state: { extract } as Record<string, unknown>,
      externalAccountId: 'syn_com_1',
    },
    credentials: { apiKey: 'sm-test-key' },
    http: { fetch: mock.fetch, json: vi.fn() },
    log: vi.fn(async () => undefined),
    saveState: vi.fn(async (patch: Record<string, unknown>) => {
      ctx.connection.state = { ...ctx.connection.state, ...patch }
    }),
  }
  return ctx as typeof ctx & ConnectorContext
}

const step = connector.jobs['extract.step']

beforeEach(() => {
  memory.current = createMemoryStore()
  audit.logAudit.mockClear()
  queue.enqueueJob.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the extract.step job', () => {
  it('runs the extract to the end within its budget and records one audit event', async () => {
    const mock = createMockShopmonkey()
    const ctx = ctxFor(mock, startState(null, { runId: 'run-1', now: NOW }))
    const outcome = await step(ctx, { runId: 'run-1' })
    expect(outcome).toMatchObject({ summary: expect.stringContaining('done') })
    expect(outcome).not.toHaveProperty('rescheduleInSeconds')
    const saved = ctx.connection.state.extract as ExtractState
    expect(saved.finishedAt).not.toBeNull()
    expect(memory.current?.count('order')).toBe(5)
    expect(audit.logAudit).toHaveBeenCalledTimes(1)
    expect(audit.logAudit).toHaveBeenCalledWith(
      { userId: '', organizationId: 'org-1' },
      expect.objectContaining({
        action: 'shopmonkey.extract',
        entityId: 'conn-1',
        details: {
          key: 'shopmonkey_extract',
          params: { records: expect.any(Number), count: saved.calls },
        },
      })
    )
  })

  it('hands back to the queue when its time is up, with the checkpoint saved', async () => {
    const mock = createMockShopmonkey()
    const ctx = ctxFor(mock, startState(null, { runId: 'run-1', now: NOW }))
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 60_000
      return clock
    })
    const outcome = await step(ctx, { runId: 'run-1' })
    expect(outcome).toMatchObject({ rescheduleInSeconds: 1 })
    const saved = ctx.connection.state.extract as ExtractState
    expect(saved.finishedAt).toBeNull()
    expect(Object.keys(saved.steps).length).toBeGreaterThan(0)
    expect(audit.logAudit).not.toHaveBeenCalled()
  })

  it('stops quietly when another start replaced its run', async () => {
    const mock = createMockShopmonkey()
    const ctx = ctxFor(mock, startState(null, { runId: 'run-2', now: NOW }))
    expect(await step(ctx, { runId: 'run-1' })).toEqual({ summary: 'No extract to continue' })
    expect(mock.calls).toEqual([])
  })

  it('comes back when Shopmonkey says, on a rate limit longer than the client waits', async () => {
    const mock = createMockShopmonkey()
    const ctx = ctxFor(mock, startState(null, { runId: 'run-1', now: NOW }))
    ctx.http.fetch = async () =>
      new Response(JSON.stringify({ success: false }), {
        status: 429,
        headers: { 'retry-after': '900' },
      })
    expect(await step(ctx, { runId: 'run-1' })).toEqual({
      summary: 'Rate limited by Shopmonkey',
      rescheduleInSeconds: 901,
    })
  })
})

describe('starting an extract', () => {
  it('saves a fresh run on the workshop’s own connection and queues its first step', async () => {
    dbMock.integrationConnection.findFirst.mockResolvedValueOnce({
      id: 'conn-1',
      state: {
        extract: { childSignatures: { order: 'abc' }, watermarks: { customer: 'w' } },
        other: 1,
      },
    })
    const { runId } = await startShopmonkeyExtract({
      organizationId: 'org-1',
      connectionId: 'conn-1',
      only: ['order'],
    })
    expect(dbMock.integrationConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-1', organizationId: 'org-1', connectorId: 'shopmonkey' },
      })
    )
    const saved = (
      dbMock.integrationConnection.update.mock.calls.at(-1)?.[0] as {
        data: { state: { extract: ExtractState; other: number } }
      }
    ).data.state
    expect(saved.other).toBe(1)
    expect(saved.extract).toMatchObject({
      runId,
      only: ['order'],
      step: 0,
      childSignatures: { order: 'abc' },
      watermarks: { customer: 'w' },
    })
    expect(queue.enqueueJob).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      organizationId: 'org-1',
      kind: 'extract.step',
      payload: { runId },
      idempotencyKey: `extract:${runId}`,
    })
  })

  it('refuses another workshop’s connection', async () => {
    dbMock.integrationConnection.findFirst.mockResolvedValueOnce(null)
    await expect(
      startShopmonkeyExtract({ organizationId: 'org-2', connectionId: 'conn-1' })
    ).rejects.toThrow('not found')
    expect(queue.enqueueJob).not.toHaveBeenCalled()
  })
})

describe('the CLI', () => {
  it('parses its arguments and refuses what it doesn’t know', () => {
    expect(
      parseExtractArgs([
        'extract',
        '--connection',
        'c1',
        '--tables',
        'customer, order',
        '--since',
        '2026-01-01',
      ])
    ).toEqual({
      connection: 'c1',
      tables: ['customer', 'order'],
      since: '2026-01-01',
      restart: false,
    })
    expect(parseExtractArgs(['extract', '--connection', 'c1', '--restart']).restart).toBe(true)
    expect(() => parseExtractArgs(['load', '--connection', 'c1'])).toThrow('Usage')
    expect(() => parseExtractArgs(['extract'])).toThrow('--connection is required')
    expect(() => parseExtractArgs(['extract', '--connection'])).toThrow('needs a value')
    expect(() => parseExtractArgs(['extract', '--connection', 'c1', '--since', 'soon'])).toThrow(
      'ISO'
    )
    expect(() => parseExtractArgs(['extract', '--connection', 'c1', '--force'])).toThrow(
      'Unknown option'
    )
  })

  it('carries on an unfinished run under a new id, unless asked to start over', () => {
    const args = parseExtractArgs(['extract', '--connection', 'c1'])
    const unfinished = { ...startState(null, { runId: 'old', now: NOW }), step: 7 }
    expect(runToDrive(unfinished, args, 'new', NOW)).toMatchObject({
      resumed: true,
      state: { runId: 'new', step: 7 },
    })
    expect(runToDrive(unfinished, { ...args, restart: true }, 'new', NOW)).toMatchObject({
      resumed: false,
      state: { runId: 'new', step: 0 },
    })
    const finished = { ...unfinished, finishedAt: NOW.toISOString() }
    expect(runToDrive(finished, args, 'new', NOW).resumed).toBe(false)
  })

  it('prints the table, how far through its list, the pace and the time left', () => {
    const state = startState(null, { runId: 'r', only: ['customer'], now: NOW })
    state.steps.customer = {
      phase: 'backfill',
      stage: 'list',
      skip: 200,
      highWatermark: null,
      total: 1234,
      lastPage: null,
      cursor: null,
      counts: { created: 200, updated: 0, unchanged: 0, skipped: 0 },
      children: {
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        parents: 0,
        gone: 0,
        missing: 0,
      },
    }
    expect(formatProgress(state, 5)).toBe(
      '[1/2] customer  list 200/1,234 · 5 calls/min · ~3 min left'
    )
    state.steps.customer.stage = 'children'
    state.steps.customer.children.parents = 42
    expect(formatProgress(state, 5)).toBe('[1/2] customer  children of 42 fetched · 5 calls/min')
  })

  it('drives the same steps as the job to the end, printing as it goes', async () => {
    const mock = createMockShopmonkey()
    const deps: ExtractDeps = {
      client: createShopmonkeyClient({
        fetch: mock.fetch,
        log: () => undefined,
        sleep: async () => undefined,
      }),
      store: memory.current?.store as ExtractDeps['store'],
      files: {
        fetchUrl: async () => ({ skipped: 'not_found' }),
        write: async () => ({ skipped: 'too_large' }),
      },
      settings: extractSettings({ locationId: 'syn_loc_1' }),
      companyId: 'syn_com_1',
      log: () => undefined,
      now: () => NOW,
    }
    const lines: string[] = []
    const saves: ExtractState[] = []
    const done = await driveExtract({
      deps,
      state: startState(null, { runId: 'cli', now: NOW }),
      save: async (s) => {
        saves.push(s)
      },
      print: (line) => lines.push(line),
      everyMs: 0,
    })
    expect(done.finishedAt).not.toBeNull()
    expect(saves.length).toBeGreaterThan(10)
    expect(lines.at(-1)).toMatch(/^done · \d+ calls$/)
    expect(lines.some((l) => l.includes('customer'))).toBe(true)
  })

  it('keeps extracting until the budget is spent, saving after every unit', async () => {
    const mock = createMockShopmonkey()
    const deps: ExtractDeps = {
      client: createShopmonkeyClient({
        fetch: mock.fetch,
        log: () => undefined,
        sleep: async () => undefined,
      }),
      store: createMemoryStore().store,
      files: {
        fetchUrl: async () => ({ skipped: 'not_found' }),
        write: async () => ({ skipped: 'too_large' }),
      },
      settings: extractSettings({}),
      companyId: null,
      log: () => undefined,
    }
    let time = 0
    const saves: ExtractState[] = []
    const result = await extractFor(deps, startState(null, { runId: 'b', now: NOW }), {
      budgetMs: 3,
      clock: () => time++,
      save: async (s) => {
        saves.push(s)
      },
    })
    expect(result.done).toBe(false)
    expect(result.units).toBe(saves.length)
    expect(saves.length).toBeGreaterThanOrEqual(2)
  })
})
