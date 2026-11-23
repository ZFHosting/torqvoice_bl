/**
 * fork: editing an imported work order or quote in the app keeps each line's job, kind, technician, cost and source
 * fields (M5 task 12), on a real PostgreSQL (`npm run test:db`). The page sends its lines without ids or any of those
 * columns, reordered (shop fees last) and with a line added; the save runs the real service, as the server action
 * does. SYNTHETIC fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'
import { createWorkshop, extractInto, guardTestDatabase, NOW } from './shopmonkeyLoadHarness'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))

const url = guardTestDatabase()
let db: typeof import('@/lib/db')['db']
let workshop: Awaited<ReturnType<typeof createWorkshop>>

const FORK_PART = ['jobId', 'lineKind', 'discountAmount', 'note', 'sourceExtra'] as const
const FORK_LABOR = [
  'jobId',
  'lineKind',
  'technicianId',
  'completed',
  'costHours',
  'costRate',
  'discountAmount',
  'sourceExtra',
] as const

const pick = (row: Record<string, unknown>, columns: readonly string[]) =>
  Object.fromEntries(columns.map((c) => [c, row[c] ?? null]))

/** Lines by name, with the fork columns only: what a save must leave as it was. */
const byName = (rows: Record<string, unknown>[], name: string, columns: readonly string[]) =>
  Object.fromEntries(rows.map((r) => [String(r[name]), pick(r, columns)]))

/** What the work order page sends for a part (ServiceRecordPage.tsx): no id, none of the fork columns. */
const formPart = (p: Record<string, unknown>) => ({
  partNumber: (p.partNumber as string) || '',
  name: p.name as string,
  quantity: p.quantity as number,
  unit: (p.unit as string) ?? null,
  category: (p.category as string) ?? null,
  unitPrice: p.unitPrice as number,
  total: p.total as number,
  unitCost: (p.unitCost as number) ?? 0,
  markupPercent: (p.markupPercent as number) ?? 0,
  inventoryPartId: (p.inventoryPartId as string) ?? undefined,
  taxable: p.taxable as boolean,
})

const formLabor = (l: Record<string, unknown>) => ({
  description: l.description as string,
  hours: l.hours as number,
  rate: l.rate as number,
  total: l.total as number,
  pricingType: (l.pricingType as string) || 'hourly',
  taxable: l.taxable as boolean,
})

const added = {
  partNumber: 'NEW-1',
  name: 'Added in the app',
  quantity: 1,
  unit: null,
  category: null,
  unitPrice: 10,
  total: 10,
  unitCost: 0,
  markupPercent: 0,
  taxable: true,
}

beforeAll(async () => {
  if (!url) throw new Error('E2E_DATABASE_URL is not set')
  ;({ db } = await import('@/lib/db'))
  workshop = await createWorkshop('Edit')
  await extractInto(createMockShopmonkey(), workshop)
  const { runLoad } = await import('@/integrations/shopmonkey/load/run')
  const summary = await runLoad({
    organizationId: workshop.organizationId,
    connectionId: workshop.connectionId,
    runUserId: workshop.userId,
    now: NOW,
  })
  expect(summary.failures).toEqual([])
})

afterAll(async () => {
  if (workshop) await workshop.remove()
})

describe('editing an imported work order', () => {
  it('keeps every line’s job, kind, technician, cost and source fields through a save from the page', async () => {
    const record = await db.serviceRecord.findFirst({
      where: {
        organizationId: workshop.organizationId,
        issuedAt: null,
        laborItems: { some: { jobId: { not: null } } },
        partItems: { some: { jobId: { not: null } } },
      },
      include: { partItems: true, laborItems: true },
    })
    expect(record, 'an open imported work order with grouped lines').toBeTruthy()
    if (!record) return
    expect(record.laborItems.some((l) => l.technicianId)).toBe(true)
    const partsBefore = byName(record.partItems, 'name', FORK_PART)
    const laborBefore = byName(record.laborItems, 'description', FORK_LABOR)

    const { updateServiceRecordService } = await import(
      '@/features/vehicles/Lib/serviceRecordService.server'
    )
    await updateServiceRecordService(
      { organizationId: workshop.organizationId, userId: workshop.userId, actor: 'user' },
      {
        id: record.id,
        partItems: [...record.partItems.map(formPart).reverse(), added],
        laborItems: [...record.laborItems.map(formLabor).reverse()],
      }
    )

    const after = await db.serviceRecord.findFirstOrThrow({
      where: { id: record.id },
      include: { partItems: true, laborItems: true },
    })
    expect(after.partItems).toHaveLength(record.partItems.length + 1)
    const partsAfter = byName(after.partItems, 'name', FORK_PART)
    for (const [name, columns] of Object.entries(partsBefore))
      expect(partsAfter[name], name).toEqual(columns)
    expect(partsAfter[added.name]).toEqual(pick({}, FORK_PART))
    expect(byName(after.laborItems, 'description', FORK_LABOR)).toEqual(laborBefore)
  })
})

describe('editing an imported quote', () => {
  it('keeps every line’s job, kind and source fields through a save from the page', async () => {
    const quote = await db.quote.findFirst({
      where: {
        organizationId: workshop.organizationId,
        OR: [
          { partItems: { some: { jobId: { not: null } } } },
          { laborItems: { some: { jobId: { not: null } } } },
        ],
      },
      include: {
        partItems: { orderBy: { sortOrder: 'asc' } },
        laborItems: { orderBy: { sortOrder: 'asc' } },
      },
    })
    expect(quote, 'an imported quote with grouped lines').toBeTruthy()
    if (!quote) return
    const partsBefore = byName(quote.partItems, 'name', FORK_PART)
    const laborBefore = byName(quote.laborItems, 'description', FORK_LABOR)

    const { updateQuoteService } = await import('@/features/quotes/Lib/quoteService.server')
    await updateQuoteService(
      { organizationId: workshop.organizationId, userId: workshop.userId, actor: 'user' },
      {
        id: quote.id,
        partItems: [...quote.partItems.map(formPart).reverse(), added],
        laborItems: [...quote.laborItems.map(formLabor).reverse()],
      }
    )

    const after = await db.quote.findFirstOrThrow({
      where: { id: quote.id },
      include: { partItems: true, laborItems: true },
    })
    const partsAfter = byName(after.partItems, 'name', FORK_PART)
    for (const [name, columns] of Object.entries(partsBefore))
      expect(partsAfter[name], name).toEqual(columns)
    expect(partsAfter[added.name]).toEqual(pick({}, FORK_PART))
    expect(byName(after.laborItems, 'description', FORK_LABOR)).toEqual(laborBefore)
  })
})
