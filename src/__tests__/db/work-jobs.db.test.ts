/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 1) on a real PostgreSQL (`npm run test:db`): the jobs of
 * a work order or a quote, changed from their pages, and the job each saved line is under. Every change is logged as
 * the API logs it (`job.*`, so webhooks fire as from the API); another workshop's documents and jobs are "not found";
 * a save keeps a line under a job of its own document and nothing else, from the form or an API body. SYNTHETIC data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  call,
  eventsOf,
  guardTestDatabase,
  newShop,
  removeCreated,
  route,
  type Shop,
} from './publicApiHarness'

const url = guardTestDatabase()

const session = vi.hoisted(() => ({ organizationId: '', userId: '' }))
vi.mock('@/lib/cached-session', () => ({
  getCachedSession: async () => ({ user: { id: session.userId, name: 'Owner', email: null } }),
  getCachedMembership: async () => ({
    organizationId: session.organizationId,
    role: 'owner',
    customRole: null,
  }),
  getCachedSessionScope: async () => null,
  resolveMembership: async () => ({
    organizationId: session.organizationId,
    role: 'owner',
    customRole: null,
  }),
  assertAccountSession: async () => undefined,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}))

let db: typeof import('@/lib/db')['db']
let A: Shop
let B: Shop
const ids = { aOrder: '', aOther: '', aQuote: '', bOrder: '', bJob: '' }

async function orderOf(shop: Shop, title: string) {
  const vehicle = await db.vehicle.create({
    data: {
      organizationId: shop.org,
      userId: shop.owner,
      make: 'Volvo',
      model: 'XC60',
      year: 2021,
    },
  })
  return (
    await db.serviceRecord.create({
      data: { organizationId: shop.org, vehicleId: vehicle.id, title, status: 'pending' },
    })
  ).id
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  A = await newShop('M9jobsA')
  B = await newShop('M9jobsB')
  session.organizationId = A.org
  session.userId = A.owner
  ids.aOrder = await orderOf(A, 'Brake service')
  ids.aOther = await orderOf(A, 'Another order')
  ids.aQuote = (
    await db.quote.create({ data: { organizationId: A.org, userId: A.owner, title: 'Quote' } })
  ).id
  ids.bOrder = await orderOf(B, 'Theirs')
  ids.bJob = (
    await db.workJob.create({
      data: { organizationId: B.org, serviceRecordId: ids.bOrder, name: 'Their job' },
    })
  ).id
}, 120_000)

afterAll(async () => {
  if (db) await removeCreated()
})

const actions = async () => ({
  ...(await import('@/features/fork-records/Actions/createWorkJob')),
  ...(await import('@/features/fork-records/Actions/updateWorkJob')),
  ...(await import('@/features/fork-records/Actions/deleteWorkJob')),
  ...(await import('@/features/fork-records/Actions/reorderWorkJobs')),
  ...(await import('@/features/fork-records/Actions/getWorkJobs')),
})

describe('a work order’s jobs, from its page', () => {
  it('are added, renamed, reordered and deleted, each logged as the API logs it', async () => {
    const a = await actions()
    const parent = { kind: 'workOrder', id: ids.aOrder } as const
    const brakes = await a.createWorkJob({
      parent,
      name: 'Front brakes',
      note: 'Approved by phone',
    })
    const oil = await a.createWorkJob({ parent, name: 'Oil change' })
    expect(brakes.success && oil.success).toBe(true)
    const brakesId = (brakes.data as { id: string }).id
    const oilId = (oil.data as { id: string }).id

    expect(
      (await a.updateWorkJob({ parent, jobId: brakesId, name: 'Brakes', note: null })).success
    ).toBe(true)
    expect((await a.reorderWorkJobs({ parent, jobIds: [oilId, brakesId] })).success).toBe(true)

    const listed = await a.getWorkJobs({ parent })
    expect(listed.success).toBe(true)
    expect(listed.data).toEqual({
      usesJobs: true,
      jobs: [
        { id: oilId, name: 'Oil change', note: null, authorizationStatus: null },
        { id: brakesId, name: 'Brakes', note: null, authorizationStatus: null },
      ],
    })

    expect((await a.deleteWorkJob({ parent, jobId: oilId })).success).toBe(true)
    expect(await db.workJob.count({ where: { id: oilId } })).toBe(0)
    expect(
      await db.deletedRecord.count({
        where: { organizationId: A.org, entityType: 'work_job', entityId: oilId },
      })
    ).toBe(1)

    const created = await eventsOf(A.org, 'job.create')
    expect(created.audits.map((e) => e.entityId).sort()).toEqual([brakesId, oilId].sort())
    // The rename, and both jobs the reorder moved.
    expect((await eventsOf(A.org, 'job.update')).audits).toHaveLength(3)
    expect((await eventsOf(A.org, 'job.delete')).audits.map((e) => e.entityId)).toEqual([oilId])
  })

  it('refuses a reorder that doesn’t name every job of the work order once', async () => {
    const a = await actions()
    const parent = { kind: 'workOrder', id: ids.aOrder } as const
    const jobs = await db.workJob.findMany({
      where: { serviceRecordId: ids.aOrder },
      select: { id: true },
    })
    const result = await a.reorderWorkJobs({ parent, jobIds: [...jobs.map((j) => j.id), ids.bJob] })
    expect(result.success).toBe(false)
  })
})

describe('a quote’s jobs, from its page', () => {
  it('are kept on the quote', async () => {
    const a = await actions()
    const parent = { kind: 'quote', id: ids.aQuote } as const
    const made = await a.createWorkJob({ parent, name: 'Timing belt' })
    expect(made.success).toBe(true)
    const row = await db.workJob.findUniqueOrThrow({
      where: { id: (made.data as { id: string }).id },
    })
    expect(row).toMatchObject({ quoteId: ids.aQuote, serviceRecordId: null, organizationId: A.org })
    expect((await a.getWorkJobs({ parent })).data?.jobs.map((j) => j.name)).toEqual(['Timing belt'])
  })

  it('are locked with the quote', async () => {
    const a = await actions()
    const { SETTING_KEYS } = await import('@/features/settings/Schema/settingsSchema')
    const locked = (
      await db.quote.create({
        data: { organizationId: A.org, userId: A.owner, title: 'Accepted', status: 'accepted' },
      })
    ).id
    await db.appSetting.create({
      data: {
        organizationId: A.org,
        userId: A.owner,
        key: SETTING_KEYS.QUOTE_LOCK_ENABLED,
        value: 'true',
      },
    })
    try {
      const result = await a.createWorkJob({ parent: { kind: 'quote', id: locked }, name: 'Late' })
      expect(result.success).toBe(false)
      expect(await db.workJob.count({ where: { quoteId: locked } })).toBe(0)
    } finally {
      await db.appSetting.deleteMany({
        where: { organizationId: A.org, key: SETTING_KEYS.QUOTE_LOCK_ENABLED },
      })
    }
  })
})

describe('another workshop’s documents and jobs', () => {
  it('are not found, and nothing of theirs changes', async () => {
    const a = await actions()
    const theirs = { kind: 'workOrder', id: ids.bOrder } as const
    const mine = { kind: 'workOrder', id: ids.aOrder } as const
    const made = await a.createWorkJob({ parent: theirs, name: 'Sneaky' })
    expect(made).toMatchObject({ success: false, error: 'Work order not found' })
    const renamed = await a.updateWorkJob({
      parent: mine,
      jobId: ids.bJob,
      name: 'Mine now',
      note: null,
    })
    expect(renamed).toMatchObject({ success: false, error: 'Job not found' })
    const removed = await a.deleteWorkJob({ parent: mine, jobId: ids.bJob })
    expect(removed).toMatchObject({ success: false, error: 'Job not found' })
    expect((await a.getWorkJobs({ parent: theirs })).data?.jobs).toEqual([])
    const theirQuote = (
      await db.quote.create({
        data: { organizationId: B.org, userId: B.owner, title: 'Their quote' },
      })
    ).id
    expect(
      await a.createWorkJob({ parent: { kind: 'quote', id: theirQuote }, name: 'Sneaky' })
    ).toMatchObject({
      success: false,
      error: 'Quote not found',
    })
    expect(await db.workJob.count({ where: { quoteId: theirQuote } })).toBe(0)
    expect(await db.workJob.findUniqueOrThrow({ where: { id: ids.bJob } })).toMatchObject({
      name: 'Their job',
      serviceRecordId: ids.bOrder,
    })
  })
})

describe('saving a work order’s lines', () => {
  it('keeps a line under a job of its own work order, and under nothing else', async () => {
    const own = await db.workJob.create({
      data: { organizationId: A.org, serviceRecordId: ids.aOrder, name: 'Own' },
    })
    const elsewhere = await db.workJob.create({
      data: { organizationId: A.org, serviceRecordId: ids.aOther, name: 'Another order’s' },
    })
    // A line the form doesn't send a job for keeps the one it has (an old tab's save).
    await db.serviceLabor.create({
      data: {
        serviceRecordId: ids.aOrder,
        description: 'Kept',
        hours: 1,
        rate: 1,
        total: 1,
        jobId: own.id,
      },
    })
    const { updateServiceRecordService } = await import(
      '@/features/vehicles/Lib/serviceRecordService.server'
    )
    const line = (description: string, jobId?: string | null) => ({
      description,
      hours: 1,
      rate: 10,
      total: 10,
      ...(jobId !== undefined ? { jobId } : {}),
    })
    await updateServiceRecordService(
      { organizationId: A.org, userId: A.owner, actor: 'user' },
      {
        id: ids.aOrder,
        laborItems: [
          line('Own job', own.id),
          line('Another order’s job', elsewhere.id),
          line('Another workshop’s job', ids.bJob),
          line('Emptied', ''),
          line('Cleared', null),
          line('Kept'),
        ],
        partItems: [{ name: 'Disc', quantity: 1, unitPrice: 5, total: 5, jobId: own.id }],
      }
    )
    const saved = await db.serviceLabor.findMany({
      where: { serviceRecordId: ids.aOrder },
      select: { description: true, jobId: true },
    })
    expect(Object.fromEntries(saved.map((l) => [l.description, l.jobId]))).toEqual({
      'Own job': own.id,
      'Another order’s job': null,
      'Another workshop’s job': null,
      Emptied: null,
      Cleared: null,
      Kept: own.id,
    })
    expect(
      (await db.servicePart.findFirstOrThrow({ where: { serviceRecordId: ids.aOrder } })).jobId
    ).toBe(own.id)
  })

  it('puts no line of a new work order under a job', async () => {
    const own = await db.workJob.findFirstOrThrow({ where: { serviceRecordId: ids.aOrder } })
    const { createServiceRecordService } = await import(
      '@/features/vehicles/Lib/serviceRecordService.server'
    )
    const vehicle = await db.vehicle.findFirstOrThrow({ where: { organizationId: A.org } })
    const made = await createServiceRecordService(
      { organizationId: A.org, userId: A.owner, actor: 'user' },
      {
        vehicleId: vehicle.id,
        title: 'New',
        laborItems: [{ description: 'Copied', hours: 1, rate: 1, total: 1, jobId: own.id }],
      }
    )
    const madeId = (made as { id: string }).id
    expect(
      (await db.serviceLabor.findFirstOrThrow({ where: { serviceRecordId: madeId } })).jobId
    ).toBeNull()
  })

  it('keeps a quote’s line under one of its jobs, and under nothing else', async () => {
    const quoteJob = await db.workJob.findFirstOrThrow({ where: { quoteId: ids.aQuote } })
    const orderJob = await db.workJob.findFirstOrThrow({ where: { serviceRecordId: ids.aOrder } })
    const { updateQuoteService } = await import('@/features/quotes/Lib/quoteService.server')
    await updateQuoteService(
      { organizationId: A.org, userId: A.owner, actor: 'user' },
      {
        id: ids.aQuote,
        partItems: [
          { name: 'Belt', quantity: 1, unitPrice: 50, total: 50, jobId: quoteJob.id },
          { name: 'Pump', quantity: 1, unitPrice: 80, total: 80, jobId: orderJob.id },
        ],
      }
    )
    const saved = await db.quotePart.findMany({
      where: { quoteId: ids.aQuote },
      select: { name: true, jobId: true },
    })
    expect(Object.fromEntries(saved.map((p) => [p.name, p.jobId]))).toEqual({
      Belt: quoteJob.id,
      Pump: null,
    })
  })

  it('refuses, through the API, a job that isn’t the work order’s (404), and takes "" as no job', async () => {
    const { resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit')
    resetKeyBudgets()
    const own = await db.workJob.findFirstOrThrow({ where: { serviceRecordId: ids.aOrder } })
    const before = await db.serviceLabor.findMany({
      where: { serviceRecordId: ids.aOrder },
      select: { id: true, jobId: true },
    })
    const { PATCH } = await route('work-orders/[id]')
    const patch = (jobId: string) =>
      call(PATCH, A.key, 'PATCH', `/work-orders/${ids.aOrder}`, {
        params: { id: ids.aOrder },
        body: { laborItems: [{ description: 'From the API', hours: 1, rate: 1, total: 1, jobId }] },
      })
    expect((await patch(ids.bJob)).status).toBe(404)
    // Nothing of the work order changed.
    expect(
      await db.serviceLabor.findMany({
        where: { serviceRecordId: ids.aOrder },
        select: { id: true, jobId: true },
      })
    ).toEqual(before)
    expect((await patch(own.id)).status).toBe(200)
    expect(
      (await db.serviceLabor.findFirstOrThrow({ where: { serviceRecordId: ids.aOrder } })).jobId
    ).toBe(own.id)
    expect((await patch('')).status).toBe(200)
    expect(
      (await db.serviceLabor.findFirstOrThrow({ where: { serviceRecordId: ids.aOrder } })).jobId
    ).toBeNull()
  })

  it('keeps a line’s job when the page holds a job id the sync has since recreated', async () => {
    const was = await db.workJob.create({
      data: { organizationId: A.org, serviceRecordId: ids.aOther, name: 'Synced' },
    })
    await db.serviceLabor.create({
      data: {
        serviceRecordId: ids.aOther,
        description: 'Synced line',
        hours: 1,
        rate: 1,
        total: 1,
        jobId: was.id,
      },
    })
    // The Shopmonkey sync replaces the job (a new id) and points the line at it, while the page is open.
    const now = await db.workJob.create({
      data: { organizationId: A.org, serviceRecordId: ids.aOther, name: 'Synced' },
    })
    await db.serviceLabor.updateMany({
      where: { serviceRecordId: ids.aOther },
      data: { jobId: now.id },
    })
    await db.workJob.delete({ where: { id: was.id } })
    const { updateServiceRecordService } = await import(
      '@/features/vehicles/Lib/serviceRecordService.server'
    )
    await updateServiceRecordService(
      { organizationId: A.org, userId: A.owner, actor: 'user' },
      {
        id: ids.aOther,
        laborItems: [{ description: 'Synced line', hours: 1, rate: 1, total: 1, jobId: was.id }],
      }
    )
    expect(
      (await db.serviceLabor.findFirstOrThrow({ where: { serviceRecordId: ids.aOther } })).jobId
    ).toBe(now.id)
  })

  it('refuses, through the API, a job on a new work order, or one that isn’t the quote’s (404)', async () => {
    const { resetKeyBudgets } = await import('@/features/public-api/Lib/rateLimit')
    resetKeyBudgets()
    const own = await db.workJob.findFirstOrThrow({ where: { serviceRecordId: ids.aOrder } })
    const vehicle = await db.vehicle.findFirstOrThrow({ where: { organizationId: A.org } })
    const before = await db.serviceRecord.count({ where: { organizationId: A.org } })
    const { POST } = await route('work-orders')
    const created = await call(POST, A.key, 'POST', '/work-orders', {
      body: {
        vehicleId: vehicle.id,
        title: 'New with a job',
        type: 'repair',
        laborItems: [{ description: 'L', hours: 1, rate: 1, total: 1, jobId: own.id }],
      },
    })
    expect(created.status).toBe(404)
    expect(await db.serviceRecord.count({ where: { organizationId: A.org } })).toBe(before)

    const { PATCH } = await route('quotes/[id]')
    const patched = await call(PATCH, A.key, 'PATCH', `/quotes/${ids.aQuote}`, {
      params: { id: ids.aQuote },
      body: { partItems: [{ name: 'Belt', quantity: 1, unitPrice: 50, total: 50, jobId: own.id }] },
    })
    expect(patched.status).toBe(404)
    expect(
      (await db.quotePart.findMany({ where: { quoteId: ids.aQuote }, select: { name: true } }))
        .map((p) => p.name)
        .sort()
    ).toEqual(['Belt', 'Pump'])
  })
})
