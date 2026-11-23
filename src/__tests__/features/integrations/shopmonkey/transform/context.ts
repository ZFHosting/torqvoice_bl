/**
 * fork: what the transform tests share (M4): the synthetic fixtures by table and id, and a context whose
 * `resolve` answers every staged record with a predictable local id (`local:<table>:<remoteId>`), unless
 * a test says a record isn't loaded. SYNTHETIC fixtures (fixtures/shopmonkey/synthetic/README.md).
 */
import type { TransformContext } from '@/integrations/shopmonkey/transform/types'
import { loadFixtures } from '../mockServer'

export const fixtures = loadFixtures()

export function fixture(table: string, id: string): Record<string, unknown> {
  const found = fixtures[table]?.find((row) => row.id === id)
  if (!found) throw new Error(`No ${table} fixture ${id}`)
  return structuredClone(found)
}

export const local = (table: string, remoteId: string) => `local:${table}:${remoteId}`

export function context(
  overrides: Partial<TransformContext> & { notLoaded?: string[] } = {}
): TransformContext {
  const { notLoaded = [], ...rest } = overrides
  return {
    organizationId: 'org-1',
    runUserId: 'user-run',
    timeZone: 'America/Chicago',
    countryCode: 'US',
    resolve: (table, remoteId) =>
      notLoaded.includes(`${table}:${remoteId}`) ? null : local(table, remoteId),
    settings: { statusStageMap: {}, technicianMap: {} },
    ...rest,
  }
}
