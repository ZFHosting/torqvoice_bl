/**
 * fork (A5) on a real PostgreSQL (`npm run test:db`): what A5 added to the app's own paths, through those paths (the
 * real `withAuth` and audit log, signed in as the workshop's owner). The app's clock sends `time_entry.start` and
 * `time_entry.stop` (and the stop of a clock a start closed; nothing for a tap on the clock already running); an
 * invoice issued sends `work_order.issue`, a backfill doesn't; deleting an inspection, pulling a payment back from
 * the accounting system and turning an appointment into a work order leave tombstones (the last its delete event
 * too); the content wipe, removing the sample data and undoing a spreadsheet import leave a `reset` marker, the wipe
 * only when it removed something the API serves. Its own workshop, removed again. SYNTHETIC data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eventsOf, guardTestDatabase, newShop, removeCreated, type Shop } from './publicApiHarness'

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let shop: Shop

const session = vi.hoisted(() => ({ organizationId: '', userId: '', technicianId: '' }))
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
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }))
// The technician app's auth, as its token would give it: the owner, as the workshop's technician.
vi.mock('@/lib/with-api-auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/with-api-auth')>()
  return {
    ...real,
    withApiAuth: async (_request: Request, fn: (ctx: unknown) => Promise<Response>) =>
      fn({
        organizationId: session.organizationId,
        userId: session.userId,
        technicianIds: [session.technicianId],
        isAdmin: true,
        role: 'owner',
      }),
  }
})

const ids: Record<string, string> = {}

/** The audit rows of this workshop with this action, waited for (they're written after the action answers). */
async function audits(action: string, count: number) {
  let found = await eventsOf(shop.org, action)
  for (let i = 0; i < 20 && found.audits.length < count; i++)
    found = await eventsOf(shop.org, action)
  return found
}

/** The deliveries of an event to this workshop's webhook, waited for (they follow the audit row). */
async function deliveries(event: string, count: number) {
  let found = await eventsOf(shop.org, event)
  for (let i = 0; i < 20 && found.deliveries < count; i++) found = await eventsOf(shop.org, event)
  return found.deliveries
}

const tombstone = (entityType: string, entityId: string) =>
  db.deletedRecord.count({ where: { organizationId: shop.org, entityType, entityId } })
const markers = (reason: string) =>
  db.deletedRecord.count({
    where: { organizationId: shop.org, entityType: 'reset', entityId: reason },
  })

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  shop = await newShop('A5h')
  session.organizationId = shop.org
  session.userId = shop.owner
  const customer = await db.customer.create({
    data: { organizationId: shop.org, userId: shop.owner, name: 'Hook Customer' },
    select: { id: true },
  })
  ids.customer = customer.id
  ids.vehicle = (
    await db.vehicle.create({
      data: {
        organizationId: shop.org,
        userId: shop.owner,
        customerId: customer.id,
        make: 'Volvo',
        model: 'V70',
        year: 2010,
      },
      select: { id: true },
    })
  ).id
  for (const key of ['jobA', 'jobB', 'issued', 'backfilled']) {
    ids[key] = (
      await db.serviceRecord.create({
        data: {
          organizationId: shop.org,
          vehicleId: ids.vehicle,
          customerId: customer.id,
          title: `Hook ${key}`,
          totalAmount: 100,
          subtotal: 100,
          status: 'pending',
        },
        select: { id: true },
      })
    ).id
  }
  // The owner is a technician too, as a one-person shop is: the app's own clock is theirs.
  ids.technician = (
    await db.technician.create({
      data: { organizationId: shop.org, name: 'Owner Technician', userId: shop.owner },
      select: { id: true },
    })
  ).id
  session.technicianId = ids.technician
}, 120_000)

afterAll(async () => {
  await removeCreated()
})

describe('the app’s own clock', () => {
  it('sends time_entry.start and time_entry.stop, and nothing for a tap on the clock already running', async () => {
    const { startMyClock, stopMyClock } = await import(
      '@/features/time-tracking/Actions/timeClockActions'
    )
    expect((await startMyClock({ serviceRecordId: ids.jobA })).success).toBe(true)
    // The same job again: nothing started.
    expect((await startMyClock({ serviceRecordId: ids.jobA })).success).toBe(true)
    expect((await audits('time_entry.start', 1)).audits).toHaveLength(1)
    // Another job: the first clock stops, the second starts.
    expect((await startMyClock({ serviceRecordId: ids.jobB })).success).toBe(true)
    expect((await audits('time_entry.start', 2)).audits).toHaveLength(2)
    expect((await stopMyClock()).success).toBe(true)
    const stops = await audits('timeEntry.update', 2)
    expect(stops.audits).toHaveLength(2)
    // Under the API's names, with the API's resource.
    expect(await deliveries('time_entry.start', 2)).toBe(2)
    expect(await deliveries('time_entry.stop', 2)).toBe(2)
    const started = (
      await db.webhookDelivery.findMany({
        where: { webhook: { organizationId: shop.org }, event: 'time_entry.start' },
        select: { payload: true },
      })
    ).map((d) => JSON.parse(d.payload))
    // The start on job B names the clock it closed (job A's).
    const second = started.find((p) => p.data.workOrderId === ids.jobB)
    expect(second.entity).toBe('time_entry')
    const jobAEntry = await db.timeEntry.findFirstOrThrow({
      where: { serviceRecordId: ids.jobA, organizationId: shop.org },
      select: { id: true },
    })
    expect(second.data).toMatchObject({ workOrderId: ids.jobB, closedEntryId: jobAEntry.id })
    expect(started.find((p) => p.data.workOrderId === ids.jobA).data.closedEntryId).toBeUndefined()
  })
})

describe('the technician app finishing a job', () => {
  it('sends a time_entry.stop for each clock it stops', async () => {
    const before = (await eventsOf(shop.org, 'timeEntry.update')).audits.length
    const { startMyClock } = await import('@/features/time-tracking/Actions/timeClockActions')
    expect((await startMyClock({ serviceRecordId: ids.jobA })).success).toBe(true)
    const { PATCH } = await import('@/app/api/v1/tech/jobs/[id]/status/route')
    const res = await PATCH(
      new Request('http://localhost/api/v1/tech/jobs/x/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      }),
      { params: Promise.resolve({ id: ids.jobA }) }
    )
    expect(res.status).toBe(200)
    expect(await db.timeEntry.count({ where: { serviceRecordId: ids.jobA, endedAt: null } })).toBe(
      0
    )
    expect((await audits('timeEntry.update', before + 1)).audits).toHaveLength(before + 1)
  })
})

describe('an invoice issued', () => {
  it('sends work_order.issue; a backfill (an import, a freeze of older invoices) doesn’t', async () => {
    const { issueInvoice } = await import('@/features/invoices/Lib/issueInvoice')
    await db.serviceRecord.updateMany({
      where: { id: { in: [ids.issued, ids.backfilled] } },
      data: { status: 'completed' },
    })
    expect(await issueInvoice(ids.issued, shop.org, 'sent')).toBe(true)
    expect(await issueInvoice(ids.backfilled, shop.org, 'backfill')).toBe(true)
    const issued = await audits('work_order.issue', 1)
    expect(issued.audits.map((a) => a.entityId)).toEqual([ids.issued])
    expect(await deliveries('work_order.issue', 1)).toBe(1)
  })
})

describe('deletes A2 didn’t reach', () => {
  it('leave a tombstone for an inspection deleted on its own', async () => {
    const template = await db.inspectionTemplate.create({
      data: { organizationId: shop.org, name: 'Hook template' },
      select: { id: true },
    })
    const inspection = await db.inspection.create({
      data: { organizationId: shop.org, vehicleId: ids.vehicle, templateId: template.id },
      select: { id: true },
    })
    const { deleteInspection } = await import('@/features/inspections/Actions/inspectionActions')
    expect((await deleteInspection(inspection.id)).success).toBe(true)
    expect(await tombstone('inspection', inspection.id)).toBe(1)
  })

  it('leave a tombstone for a payment pulled back from the accounting system', async () => {
    const payment = await db.payment.create({
      data: { serviceRecordId: ids.jobA, amount: 50, provider: 'xero', externalId: 'syn-pay-1' },
      select: { id: true },
    })
    const { removePulledPayment } = await import('@/features/integrations/Lib/accounting-sync')
    expect(await removePulledPayment(shop.org, payment.id, 'xero')).toBe(true)
    expect(await tombstone('payment', payment.id)).toBe(1)
  })

  it('leave a tombstone and the delete event for an appointment that became a work order', async () => {
    const appointment = await db.appointment.create({
      data: {
        organizationId: shop.org,
        title: 'Hook appointment',
        startAt: new Date('2026-06-03T08:00:00.000Z'),
        endAt: new Date('2026-06-03T09:00:00.000Z'),
      },
      select: { id: true },
    })
    const { createBookingOnce } = await import('@/features/calendar/Actions/createBooking')
    const booked = await createBookingOnce({
      kind: 'workOrder',
      fromAppointmentId: appointment.id,
      token: 'a5-hooks-convert-token-01',
      title: 'Hook appointment',
      vehicleId: ids.vehicle,
      startDate: '2026-06-03',
      startTime: '08:00',
      endDate: '2026-06-03',
      endTime: '09:00',
      notifications: [],
    })
    expect(booked.success).toBe(true)
    expect(await db.appointment.count({ where: { id: appointment.id } })).toBe(0)
    expect(await tombstone('appointment', appointment.id)).toBe(1)
    const deleted = await audits('appointment.delete', 1)
    expect(deleted.audits.map((a) => a.entityId)).toEqual([appointment.id])
    expect(await deliveries('appointment.delete', 1)).toBe(1)
  })
})

describe('bulk deletes', () => {
  it('mark a spreadsheet import’s undo', async () => {
    const batch = await db.importBatch.create({
      data: {
        organizationId: shop.org,
        userId: shop.owner,
        source: 'csv',
        entity: 'customers',
        fileName: 'hooks.csv',
        status: 'completed',
      },
      select: { id: true },
    })
    const { undoImportBatch } = await import('@/features/import/Actions/importActions')
    expect((await undoImportBatch(batch.id)).success).toBe(true)
    expect(await markers('import_undo')).toBe(1)
  })

  it('mark removing the sample data', async () => {
    const sample = await db.customer.create({
      data: { organizationId: shop.org, userId: shop.owner, name: 'Sample Customer' },
      select: { id: true },
    })
    const { SAMPLE_DATA_IDS_KEY } = await import('@/features/onboarding/Lib/onboardingKeys')
    await db.appSetting.create({
      data: {
        organizationId: shop.org,
        userId: shop.owner,
        key: SAMPLE_DATA_IDS_KEY,
        value: JSON.stringify({ customers: [sample.id] }),
      },
    })
    const { removeSampleData } = await import('@/features/onboarding/Actions/checklistActions')
    expect(await removeSampleData()).toMatchObject({ success: true, data: { removed: true } })
    expect(await markers('sample_data')).toBe(1)
  })

  it('mark the content wipe only when it removed what the API serves', async () => {
    const { deleteContent } = await import('@/features/settings/Actions/deleteContent')
    expect((await deleteContent({ notifications: true })).success).toBe(true)
    expect(await markers('delete_content')).toBe(0)
    expect((await deleteContent({ inventory: true })).success).toBe(true)
    expect(await markers('delete_content')).toBe(1)
  })
})
