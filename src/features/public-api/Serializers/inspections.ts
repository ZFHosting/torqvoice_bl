/** Inspections and their items, field by field (docs/fork/API.md §4). Never the share token. */
import { iso, isoAlways } from '../Lib/serializeFormat'
import type { InspectionItemOut, InspectionOut } from '../Schema/inspections'

const ITEM_SELECT = {
  id: true,
  section: true,
  name: true,
  description: true,
  code: true,
  sortOrder: true,
  condition: true,
  notes: true,
  inputType: true,
  unit: true,
  measuredValue: true,
  textValue: true,
  imageUrls: true,
} as const

interface ItemRow {
  id: string
  section: string
  name: string
  description: string | null
  code: string | null
  sortOrder: number
  condition: string
  notes: string | null
  inputType: string
  unit: string | null
  measuredValue: number | null
  textValue: string | null
  imageUrls: string[]
}

export function inspectionSelect(includes: ReadonlySet<string>) {
  return {
    id: true,
    status: true,
    vehicleId: true,
    templateId: true,
    technicianId: true,
    mileage: true,
    notes: true,
    startDateTime: true,
    endDateTime: true,
    completedAt: true,
    inspectorName: true,
    certificateNumber: true,
    nextTestDue: true,
    createdAt: true,
    updatedAt: true,
    ...(includes.has('items')
      ? { items: { select: ITEM_SELECT, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } }
      : {}),
  }
}

export interface InspectionRow {
  id: string
  status: string
  vehicleId: string
  templateId: string
  technicianId: string | null
  mileage: number | null
  notes: string | null
  startDateTime: Date | null
  endDateTime: Date | null
  completedAt: Date | null
  inspectorName: string | null
  certificateNumber: string | null
  nextTestDue: Date | null
  createdAt: Date
  updatedAt: Date
  items?: ItemRow[]
}

function serializeItem(row: ItemRow): InspectionItemOut {
  return {
    id: row.id,
    section: row.section,
    name: row.name,
    description: row.description,
    code: row.code,
    sortOrder: row.sortOrder,
    condition: row.condition,
    notes: row.notes,
    inputType: row.inputType,
    unit: row.unit,
    measuredValue: row.measuredValue,
    textValue: row.textValue,
    photoCount: row.imageUrls.length,
  }
}

export function serializeInspection(
  row: InspectionRow,
  includes: ReadonlySet<string>
): InspectionOut {
  return {
    id: row.id,
    status: row.status,
    vehicleId: row.vehicleId,
    templateId: row.templateId,
    technicianId: row.technicianId,
    mileage: row.mileage,
    notes: row.notes,
    startDateTime: iso(row.startDateTime),
    endDateTime: iso(row.endDateTime),
    completedAt: iso(row.completedAt),
    inspectorName: row.inspectorName,
    certificateNumber: row.certificateNumber,
    nextTestDue: iso(row.nextTestDue),
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
    ...(includes.has('items') ? { items: (row.items ?? []).map(serializeItem) } : {}),
  }
}
