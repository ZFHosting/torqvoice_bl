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
  /**
   * The local id a staged Shopmonkey record was loaded as, by Shopmonkey table and id (M5 keeps the link), or
   * null when it isn't loaded. `order` resolves to a work order (`ServiceRecord`) only: an estimate loads as a
   * quote and resolves under `quote`, so a payment or timesheet on an estimate finds no work order. `user`
   * resolves to a technician, `workflow_status` to a `WorkOrderStatus`, `inventory_part` and `inventory_tire`
   * to an `InventoryPart`, `inspection_template` to an `InspectionTemplate`.
   */
  resolve: (table: string, remoteId: string) => string | null
  settings: {
    /**
     * Every workflow status id → its stage: the operator's choices (M8) over `defaultStages` (RESULTS S9). M5
     * builds it complete; an order whose status is missing warns `order_status_unmapped`.
     */
    statusStageMap: Record<string, Stage>
    /**
     * Shopmonkey user id → local technician id, or 'create' (M8's staff panel). The transforms resolve
     * technicians through `resolve('user', …)`; M5 uses this map to decide which to create or reuse.
     */
    technicianMap: Record<string, string | 'create'>
  }
  /**
   * Words the transforms write for people (MAPPING §6.6), in the workshop's language: `english` is the text with
   * `{name}` placeholders, as written here. M5 passes the workshop's translator; without one, English.
   */
  label?: (english: string, values?: Record<string, string>) => string
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
