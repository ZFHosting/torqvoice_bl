/** Vehicles and their notes, field by field (docs/fork/API.md §4). */
import { iso, isoAlways, moneyOrNull } from '../Lib/serializeFormat'
import type { VehicleNoteOut, VehicleOut } from '../Schema/vehicles'
import { customFieldsFrom } from './common'

const NOTE_SELECT = {
  id: true,
  title: true,
  content: true,
  isPinned: true,
  createdAt: true,
  updatedAt: true,
} as const

interface NoteRow {
  id: string
  title: string
  content: string
  isPinned: boolean
  createdAt: Date
  updatedAt: Date
}

export function vehicleSelect(includes: ReadonlySet<string>) {
  return {
    id: true,
    customerId: true,
    make: true,
    model: true,
    year: true,
    vin: true,
    licensePlate: true,
    color: true,
    mileage: true,
    fuelType: true,
    transmission: true,
    engineSize: true,
    engineCode: true,
    fleetNumber: true,
    bodyType: true,
    purchaseDate: true,
    purchasePrice: true,
    isArchived: true,
    archiveReason: true,
    createdAt: true,
    updatedAt: true,
    ...(includes.has('notes')
      ? {
          notes: {
            select: NOTE_SELECT,
            orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
          },
        }
      : {}),
  }
}

export interface VehicleRow {
  id: string
  customerId: string | null
  make: string
  model: string
  year: number
  vin: string | null
  licensePlate: string | null
  color: string | null
  mileage: number
  fuelType: string | null
  transmission: string | null
  engineSize: string | null
  engineCode: string | null
  fleetNumber: string | null
  bodyType: string | null
  purchaseDate: Date | null
  purchasePrice: number | null
  isArchived: boolean
  archiveReason: string | null
  createdAt: Date
  updatedAt: Date
  notes?: NoteRow[]
}

function serializeNote(n: NoteRow): VehicleNoteOut {
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    isPinned: n.isPinned,
    createdAt: isoAlways(n.createdAt),
    updatedAt: isoAlways(n.updatedAt),
  }
}

export function serializeVehicle(
  row: VehicleRow,
  includes: ReadonlySet<string>,
  extra: Record<string, unknown>
): VehicleOut {
  return {
    id: row.id,
    customerId: row.customerId,
    make: row.make,
    model: row.model,
    year: row.year,
    vin: row.vin,
    licensePlate: row.licensePlate,
    color: row.color,
    mileage: row.mileage,
    fuelType: row.fuelType,
    transmission: row.transmission,
    engineSize: row.engineSize,
    engineCode: row.engineCode,
    fleetNumber: row.fleetNumber,
    bodyType: row.bodyType,
    purchaseDate: iso(row.purchaseDate),
    purchasePrice: moneyOrNull(row.purchasePrice),
    isArchived: row.isArchived,
    archiveReason: row.archiveReason,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
    ...(includes.has('notes') ? { notes: (row.notes ?? []).map(serializeNote) } : {}),
    ...(includes.has('customFields') ? { customFields: customFieldsFrom(extra) } : {}),
  }
}
