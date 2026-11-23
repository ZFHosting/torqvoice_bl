/**
 * Vehicle (MAPPING §5): the vehicle row, its note, its custom field values, and its owner from the
 * `vehicle_owner` rows (§3: the most recently created one is the current owner).
 */
import { normalizePlate } from '@/lib/license-plate'
import type { CustomFieldValueRow } from './customer'
import { date, entries, type FieldSpec, num, records, str, unmappedFields, warn } from './fields'
import type { Row, TransformContext, TransformResult, Warning } from './types'

export const VEHICLE_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'year',
    'make',
    'model',
    'submodel',
    'drivetrain',
    'licensePlateState',
    'coalescedVINorHIN',
    'vin',
    'licensePlate',
    'color',
    'engine',
    'transmission',
    'type',
    'unit',
    'mileage',
    'mileageUnit',
    'note',
    'customFields',
    'labels',
    'createdDate',
    'deleted',
  ],
  archive: [
    'companyId',
    'locationId',
    'locationIds',
    'updatedDate',
    'deletedDate',
    'hin',
    'licensePlateCountry',
    'metadata',
    'name',
  ],
}

export interface VehicleRows {
  vehicle: {
    year: number
    make: string
    model: string
    vin: string | null
    licensePlate: string | null
    color: string | null
    engineSize: string | null
    transmission: string | null
    fuelType: null
    bodyType: string | null
    fleetNumber: string | null
    mileage: number
    customerId: string | null
    createdAt: Date | undefined
    userId: string
    organizationId: string
  }
  /** `Note` titled "Shopmonkey note", when the vehicle has one. */
  note: { title: string; content: string } | null
  customFields: CustomFieldValueRow[]
  /** `Mile` or `Kilometer`: the first vehicle seen sets the workshop's unit (M5). */
  mileageUnit: string | null
  /** Shopmonkey's id of the current owner, resolved or not. */
  ownerRemoteId: string | null
}

/** §3 VehicleOwner: the newest row is the current owner. PROVISIONAL(M0:S4): no "current" flag exists. */
export function currentOwner(owners: Row[]): { customerId: string | null; count: number } {
  const sorted = records(owners)
    .filter((o) => o.deleted !== true)
    .sort((a, b) => String(b.createdDate ?? '').localeCompare(String(a.createdDate ?? '')))
  return { customerId: str(sorted[0]?.customerId), count: sorted.length }
}

function transmission(value: string | null): { column: string | null; exact: string | null } {
  if (!value) return { column: null, exact: null }
  if (value === 'Manual') return { column: 'manual', exact: null }
  if (value.startsWith('Automatic')) {
    return { column: 'automatic', exact: value === 'Automatic' ? null : value }
  }
  return { column: null, exact: value }
}

export function transformVehicle(
  record: Row,
  owners: Row[],
  ctx: TransformContext
): TransformResult<VehicleRows | null> {
  const remoteId = String(record.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(record, VEHICLE_FIELDS)
  if (record.deleted === true) return { rows: null, warnings, unmapped }

  let year = num(record.year)
  let make = str(record.make)
  let model = str(record.model)
  if (year === null || !make || !model) {
    warnings.push(
      warn('vehicle', remoteId, 'vehicle_missing_ymm', 'Year, make or model is missing', 'year')
    )
    year ??= 0
    make ??= 'Unknown'
    model ??= 'Unknown'
  }

  const owner = currentOwner(owners)
  if (owner.count > 1) {
    warnings.push(
      warn(
        'vehicle',
        remoteId,
        'vehicle_multiple_owners',
        `${owner.count} owners over time`,
        'owners'
      )
    )
  }
  const customerId = owner.customerId ? ctx.resolve('customer', owner.customerId) : null
  if (owner.customerId && !customerId) {
    warnings.push(
      warn('vehicle', remoteId, 'vehicle_owner_unresolved', 'The owner was not imported', 'owners')
    )
  }

  const gear = transmission(str(record.transmission))
  const customFields: CustomFieldValueRow[] = []
  const field = (name: string, value: string | null) => {
    if (value) customFields.push({ entityType: 'vehicle', name, value })
  }
  field('Submodel', str(record.submodel))
  field('Drivetrain', str(record.drivetrain))
  field('Plate state', str(record.licensePlateState))
  field('Transmission', gear.exact)
  for (const [name, value] of entries(record.customFields)) {
    field(name, value === null || value === undefined ? null : String(value).trim() || null)
  }
  const labels = entries(record.labels)
    .map(([, label]) => str(label))
    .filter((label): label is string => !!label)
  field('Labels', labels.length ? labels.join(', ') : null)

  const mileage = num(record.mileage)
  const noteText = str(record.note)
  return {
    rows: {
      vehicle: {
        year: Math.trunc(year),
        make,
        model,
        vin: str(record.coalescedVINorHIN) ?? str(record.vin),
        licensePlate: normalizePlate(str(record.licensePlate)),
        color: str(record.color)?.toLowerCase() ?? null,
        engineSize: str(record.engine),
        transmission: gear.column,
        // The column defaults to gasoline: null says Shopmonkey didn't say.
        fuelType: null,
        bodyType: str(record.type),
        fleetNumber: str(record.unit),
        mileage: mileage === null ? 0 : Math.round(mileage),
        customerId,
        createdAt: date(record.createdDate) ?? undefined,
        userId: ctx.runUserId,
        organizationId: ctx.organizationId,
      },
      note: noteText ? { title: 'Shopmonkey note', content: noteText } : null,
      customFields,
      mileageUnit: str(record.mileageUnit),
      ownerRemoteId: owner.customerId,
    },
    warnings,
    unmapped,
  }
}
