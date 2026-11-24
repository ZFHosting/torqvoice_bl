/**
 * fork: what the Shopmonkey load tests on PostgreSQL share (M5): a workshop of their own with a Shopmonkey
 * connection, a full extract against the mock Shopmonkey into its archive, and counts of every table a load writes.
 * SYNTHETIC fixtures.
 */
import { randomUUID } from 'node:crypto'
import { createMockShopmonkey } from '../features/integrations/shopmonkey/mockServer'

export const NOW = new Date('2025-06-01T00:00:00.000Z')

export function guardTestDatabase() {
  const url = process.env.E2E_DATABASE_URL ?? ''
  const name = url.split('/').pop()?.split('?')[0]?.toLowerCase() ?? ''
  if (url && !/test|e2e/.test(name)) {
    throw new Error(
      `Refusing to use database "${name}": its name must say test or e2e, like the rest of this suite.`
    )
  }
  process.env.DATABASE_URL = url
  return url
}

export async function createWorkshop(label: string) {
  const { db } = await import('@/lib/db')
  const stamp = randomUUID().slice(0, 8)
  const organizationId = (await db.organization.create({ data: { name: `${label} ${stamp}` } })).id
  const userId = (
    await db.user.create({
      data: { email: `${label.toLowerCase()}-${stamp}@example.com`, name: 'Owner' },
    })
  ).id
  await db.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
  const connectionId = (
    await db.integrationConnection.create({
      data: { organizationId, connectorId: 'shopmonkey', createdById: userId, status: 'active' },
    })
  ).id
  const remove = async () => {
    await db.organization.deleteMany({ where: { id: organizationId } })
    await db.user.deleteMany({ where: { id: userId } })
  }
  return { organizationId, userId, connectionId, remove }
}

/** Stages the mock's records into the workshop's archive, as a real extract would. */
export async function extractInto(
  mock: ReturnType<typeof createMockShopmonkey>,
  scope: { organizationId: string; connectionId: string },
  /** How files are staged: by default, nothing is (every link "not found"). */
  stager?: import('@/integrations/shopmonkey/extract/files').FileStager
) {
  const { createShopmonkeyClient } = await import('@/integrations/shopmonkey/client')
  const engine = await import('@/integrations/shopmonkey/extract/engine')
  const plan = await import('@/integrations/shopmonkey/extract/plan')
  const stage = await import('@/integrations/shopmonkey/extract/stage')
  const deps = {
    client: createShopmonkeyClient({
      fetch: mock.fetch,
      log: () => undefined,
      sleep: async () => undefined,
    }),
    store: stage.prismaSourceStore(scope),
    files: stager ?? {
      fetchUrl: async () => ({ skipped: 'not_found' as const }),
      write: async () => ({ skipped: 'too_large' as const }),
    },
    settings: engine.extractSettings({ locationId: 'syn_loc_1' }),
    companyId: 'syn_com_1',
    log: () => undefined,
    now: () => NOW,
  }
  let state = plan.startState(null, { runId: randomUUID(), now: NOW })
  for (let i = 0; i < 2_000; i++) {
    const result = await engine.extractStep(deps, state)
    state = result.state
    if (result.done) {
      // fork (M6): kept on the connection as the CLI and the job keep it: the reconciliation reads its totals.
      const { db } = await import('@/lib/db')
      const connection = await db.integrationConnection.findUniqueOrThrow({
        where: { id: scope.connectionId },
        select: { state: true },
      })
      await db.integrationConnection.update({
        where: { id: scope.connectionId },
        data: {
          state: { ...((connection.state as object) ?? {}), extract: state } as object,
        },
      })
      return
    }
  }
  throw new Error('The extract did not finish')
}

const TABLES = [
  'customer',
  'customerContact',
  'vehicle',
  'note',
  'technician',
  'workOrderStatus',
  'serviceRecord',
  'quote',
  'workJob',
  'serviceLabor',
  'servicePart',
  'quoteLabor',
  'quotePart',
  'payment',
  'vehicleFinding',
  'serviceRecordMeta',
  'serviceAttachment',
  'inventoryPart',
  'stockMovement',
  'laborPreset',
  'appointment',
  'inspectionTemplate',
  'inspection',
  'inspectionItem',
  'timeEntry',
  'technicianShift',
  'customFieldDefinition',
  'customFieldValue',
] as const

/** Rows of every table a load writes, in this workshop. */
export async function countRows(organizationId: string): Promise<Record<string, number>> {
  const { db } = await import('@/lib/db')
  const where = { organizationId }
  const scoped: Record<string, unknown> = {
    serviceLabor: { serviceRecord: where },
    servicePart: { serviceRecord: where },
    payment: { serviceRecord: where },
    serviceAttachment: { serviceRecord: where },
    quoteLabor: { quote: where },
    quotePart: { quote: where },
    vehicleFinding: { vehicle: where },
    note: { vehicle: where },
    inspectionItem: { inspection: where },
    customFieldValue: { field: where },
  }
  const d = db as unknown as Record<string, { count: (args: unknown) => Promise<number> }>
  const out: Record<string, number> = {}
  for (const t of TABLES) out[t] = await d[t].count({ where: scoped[t] ?? where })
  return out
}
