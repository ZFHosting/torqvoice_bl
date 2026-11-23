/**
 * The transforms' `resolve(table, remoteId)` (transform/types.ts): which local row a Shopmonkey record was loaded
 * as, answered from memory so the transforms stay synchronous and pure. Filled from the connection's links and the
 * archive's backed-up mappings when a load starts, and kept up to date as the load creates rows.
 */
import { db } from '@/lib/db'
import { SOURCE } from '../extract/stage'
import type { LocalModel } from './links'

/** The model each table's records load as (transform/types.ts). An `order` resolves to a work order only. */
export const TABLE_MODEL: Record<string, LocalModel> = {
  customer: 'Customer',
  vehicle: 'Vehicle',
  user: 'Technician',
  workflow_status: 'WorkOrderStatus',
  order: 'ServiceRecord',
  quote: 'Quote',
  inventory_part: 'InventoryPart',
  inventory_tire: 'InventoryPart',
  canned_service: 'LaborPreset',
  inventory_labor: 'LaborPreset',
  inventory_fee: 'LaborPreset',
  appointment: 'Appointment',
  inspection_template: 'InspectionTemplate',
  inspection: 'Inspection',
}

/** A quote is an `order` record loaded as a `Quote`. */
const sourceTable = (table: string) => (table === 'quote' ? 'order' : table)

export interface Resolver {
  resolve(table: string, remoteId: string): string | null
  set(table: string, remoteId: string, localId: string): void
}

export function createResolver(entries: Iterable<[string, string]> = []): Resolver {
  const map = new Map<string, string>(entries)
  const key = (table: string, remoteId: string) =>
    `${TABLE_MODEL[table] ?? table}|${sourceTable(table)}:${remoteId}`
  return {
    resolve: (table, remoteId) => map.get(key(table, remoteId)) ?? null,
    set: (table, remoteId, localId) => {
      map.set(key(table, remoteId), localId)
    },
  }
}

/** Every record of this workshop already loaded: its links first, then the backed-up mappings (after a restore). */
export async function loadResolver(
  scope: { organizationId: string; connectionId: string },
  client: Pick<typeof db, 'integrationLink' | 'sourceRecord'> = db
): Promise<Resolver> {
  const entries = new Map<string, string>()
  const mappings = await client.sourceRecord.findMany({
    where: { organizationId: scope.organizationId, source: SOURCE, localId: { not: null } },
    select: { table: true, remoteId: true, localEntity: true, localId: true },
  })
  for (const m of mappings) {
    if (m.localEntity && m.localId)
      entries.set(`${m.localEntity}|${m.table}:${m.remoteId}`, m.localId)
  }
  const links = await client.integrationLink.findMany({
    where: { connectionId: scope.connectionId },
    select: { entityType: true, entityId: true, remoteId: true },
  })
  for (const link of links) entries.set(`${link.entityType}|${link.remoteId}`, link.entityId)
  return createResolver(entries)
}
