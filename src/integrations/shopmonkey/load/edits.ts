/**
 * Torqvoice edits to imported rows (M7, the conflict and delete policies): a row is edited in Torqvoice when its
 * `updatedAt` is later than its link's `lastSyncedAt`. A load syncs the links of exactly the rows it wrote, at the end
 * of the unit that wrote them (`stampWritten` in `links.ts`), the rows it touched in passing included (an appointment
 * setting its work order's start), and the invoices it issued after their unit; so only a change made outside a load
 * counts, and an edit made while a load runs to a row it didn't write still does.
 */
import type { LocalModel } from './links'
import type { Tx } from './context'

/** The table of each linked model that records when its row last changed (an attachment doesn't). */
const UPDATED_TABLES: Partial<Record<LocalModel, string>> = {
  Customer: 'customers',
  Vehicle: 'vehicles',
  Technician: 'technicians',
  WorkOrderStatus: 'work_order_statuses',
  ServiceRecord: 'service_records',
  Quote: 'quotes',
  InventoryPart: 'inventory_parts',
  LaborPreset: 'labor_presets',
  Appointment: 'appointments',
  InspectionTemplate: 'inspection_templates',
  Inspection: 'inspections',
  TimeEntry: 'time_entries',
  TechnicianShift: 'technician_shifts',
  VehicleFinding: 'vehicle_findings',
  Note: 'notes',
  CustomFieldDefinition: 'custom_field_definitions',
}

/** When this workshop's row last changed, or null (no such row, or a model without the column). */
export async function rowUpdatedAt(
  tx: Tx,
  model: LocalModel,
  id: string,
  organizationId: string
): Promise<Date | null> {
  const table = UPDATED_TABLES[model]
  if (!table) return null
  // Findings and notes have no workshop column: their vehicle says whose they are.
  const scoped =
    model === 'VehicleFinding' || model === 'Note'
      ? `EXISTS (SELECT 1 FROM "public"."vehicles" AS v WHERE v."id" = r."vehicleId" AND v."organizationId" = $2)`
      : `r."organizationId" = $2`
  const rows = await tx.$queryRawUnsafe<{ updatedAt: Date }[]>(
    `SELECT r."updatedAt" FROM "public"."${table}" AS r WHERE r."id" = $1 AND ${scoped}`,
    id,
    organizationId
  )
  return rows[0]?.updatedAt ?? null
}

/** Whether the row changed in Torqvoice after its link's last sync. */
export async function editedSince(
  tx: Tx,
  model: LocalModel,
  id: string,
  organizationId: string,
  syncedAt: Date
): Promise<boolean> {
  const updatedAt = await rowUpdatedAt(tx, model, id, organizationId)
  return !!updatedAt && updatedAt.getTime() > syncedAt.getTime()
}
