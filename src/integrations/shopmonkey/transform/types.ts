/**
 * The transform's contract (docs/fork/milestones/M4-transform.md): pure, deterministic functions from a
 * staged Shopmonkey payload to the Torqvoice rows MAPPING.md describes, with warnings for anything odd
 * and a list of the source fields they didn't map. Nothing here touches the database: ids of other
 * records come through `resolve`, and M5 writes the rows.
 */

import type { Stage } from '@/features/work-order-statuses/Lib/stages'

export type { Stage }

export interface TransformContext {
  organizationId: string
  /** The user who started the import run: `userId` on customers, vehicles, quotes, inventory. */
  runUserId: string
  /** The workshop's IANA zone, for dates a person typed (Shopmonkey's are UTC already). */
  timeZone: string
  /** ISO 3166-1 alpha-2, for phone numbers. */
  countryCode: string
  /** The local id of a staged Shopmonkey record (from IntegrationLink), or null when it isn't loaded. */
  resolve: (table: string, remoteId: string) => string | null
  settings: {
    /** Workflow status id → stage, from the M8 mapping panel; absent ids take the default (RESULTS S9). */
    statusStageMap: Record<string, Stage>
    /** Shopmonkey user id → local technician id, or 'create'. */
    technicianMap: Record<string, string | 'create'>
  }
}

export interface Warning {
  code: string
  table: string
  remoteId: string
  field?: string
  message: string
}

export interface TransformResult<T> {
  rows: T
  warnings: Warning[]
  /** Source fields present on the record that nothing maps (for the M6 report). */
  unmapped: string[]
}

export type Row = Record<string, unknown>
