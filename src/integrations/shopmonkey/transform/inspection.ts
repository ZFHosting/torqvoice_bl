/**
 * Inspections (MAPPING §8): Shopmonkey's templates become Torqvoice templates on the `basic` scale (one
 * section, its items in order), and each inspection becomes an `Inspection` against its template, with
 * the item grades mapped to conditions. Photos are staged files (M3, `inspection_file`): M5 moves them
 * into uploads and fills `imageUrls`.
 */
import type { Condition } from '@/features/inspections/Lib/conditions'
import { date, type FieldSpec, num, records, str, unmappedFields, warn } from './fields'
import type { Row, TransformContext, TransformResult, Warning } from './types'

/** §8, both enums [docs]. */
export function condition(status: unknown): Condition {
  switch (status) {
    case 'Green':
      return 'pass'
    case 'Yellow':
      return 'attention'
    case 'Red':
      return 'fail'
    case 'NotApplicable':
      return 'not_applicable'
    default:
      return 'not_inspected'
  }
}

export const INSPECTION_TEMPLATE_FIELDS: FieldSpec = {
  mapped: ['id', 'name', 'note', 'items', 'deleted', 'createdDate'],
  archive: ['companyId', 'locationId', 'metadata', 'updatedDate'],
}

export interface TemplateRows {
  template: {
    name: string
    description: string | null
    standard: 'custom'
    country: null
    severityScale: 'basic'
    organizationId: string
    createdAt: Date | undefined
  }
  section: { name: string; sortOrder: number }
  items: {
    remoteId: string
    name: string
    description: string | null
    sortOrder: number
    allowNotApplicable: true
  }[]
}

export function transformInspectionTemplate(
  template: Row,
  ctx: TransformContext
): TransformResult<TemplateRows | null> {
  const unmapped = unmappedFields(template, INSPECTION_TEMPLATE_FIELDS)
  if (template.deleted === true) return { rows: null, warnings: [], unmapped }
  const name = str(template.name) ?? String(template.id)
  return {
    rows: {
      template: {
        name,
        description: str(template.note),
        standard: 'custom',
        country: null,
        severityScale: 'basic',
        organizationId: ctx.organizationId,
        createdAt: date(template.createdDate) ?? undefined,
      },
      section: { name, sortOrder: 0 },
      items: records(template.items)
        .sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0))
        .map((item, i) => ({
          remoteId: String(item.id),
          name: str(item.name) ?? `Item ${i + 1}`,
          description: str(item.message),
          sortOrder: i,
          allowNotApplicable: true as const,
        })),
    },
    warnings: [],
    unmapped,
  }
}

/** An item nested in a template, and one in an inspection, and a photo on an item (MAPPING §8). */
export const TEMPLATE_ITEM_FIELDS: FieldSpec = {
  mapped: ['id', 'name', 'message', 'ordinal'],
  archive: ['createdDate', 'inspectionTemplateId', 'recommendedCannedServiceIds', 'status'],
}
export const INSPECTION_ITEM_FIELDS: FieldSpec = {
  mapped: ['id', 'name', 'message', 'ordinal', 'status', 'statusDetails', 'files'],
  archive: [
    'createdDate',
    'inspectionDate',
    'inspectionId',
    'inspectorUserId',
    'publicId',
    'recommendedCannedServiceIds',
    'reviewStatus',
  ],
}
/** A file entry (an order's `files[]`, an item's): staged as its own record (M3), loaded by M5. */
export const FILE_FIELDS: FieldSpec = {
  mapped: ['id', 'fileName', 'fileSize', 'fileType', 'url'],
  archive: ['thumbnailUrl'],
}

export const INSPECTION_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'orderId',
    'templateId',
    'name',
    'note',
    'completed',
    'completedDate',
    'completedById',
    'items',
    'createdDate',
  ],
  archive: [
    'checklistStage',
    'companyId',
    'createdById',
    'locationId',
    'metadata',
    'ordinal',
    'recommended',
    'updatedDate',
  ],
}

export interface InspectionRows {
  inspection: {
    status: 'completed' | 'in_progress'
    notes: string | null
    completedAt: Date | null
    vehicleId: string
    templateId: string
    technicianId: string | null
    mileage: number | null
    severityScale: 'basic'
    organizationId: string
    createdAt: Date | undefined
  }
  items: {
    remoteId: string
    name: string
    section: string
    sortOrder: number
    condition: Condition
    notes: string | null
    /** Staged photo ids (`inspection_file`), filled into `imageUrls` by M5. */
    photoRemoteIds: string[]
  }[]
  /** The work order it belongs to (every Shopmonkey inspection has one), linked by M5. */
  orderRemoteId: string | null
}

/**
 * An inspection: its order gives the vehicle (and mileage). Not imported when the order's vehicle or the
 * template didn't load: Torqvoice needs both.
 */
export function transformInspection(
  inspection: Row,
  order: Row | null,
  ctx: TransformContext
): TransformResult<InspectionRows | null> {
  const remoteId = String(inspection.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(inspection, INSPECTION_FIELDS)
  const vehicleRemote = str(order?.vehicleId)
  const vehicleId = vehicleRemote ? ctx.resolve('vehicle', vehicleRemote) : null
  const templateRemote = str(inspection.templateId)
  const templateId = templateRemote ? ctx.resolve('inspection_template', templateRemote) : null
  if (!vehicleId || !templateId) {
    warnings.push(
      warn(
        'inspection',
        remoteId,
        vehicleId ? 'inspection_template_unresolved' : 'inspection_vehicle_unresolved',
        vehicleId ? 'Its template was not imported' : "Its order's vehicle was not imported",
        vehicleId ? 'templateId' : 'orderId'
      )
    )
    return { rows: null, warnings, unmapped }
  }
  const section = str(inspection.name) ?? 'Inspection'
  const completedBy = str(inspection.completedById)
  const mileage = num(order?.mileageIn)
  return {
    rows: {
      inspection: {
        status: inspection.completed === true ? 'completed' : 'in_progress',
        notes: str(inspection.note),
        completedAt: date(inspection.completedDate),
        vehicleId,
        templateId,
        technicianId: completedBy ? ctx.resolve('user', completedBy) : null,
        mileage: mileage === null ? null : Math.round(mileage),
        severityScale: 'basic',
        organizationId: ctx.organizationId,
        createdAt: date(inspection.createdDate) ?? undefined,
      },
      items: records(inspection.items)
        .sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0))
        .map((item, i) => {
          // §8: the selected status detail labels are appended to the item's notes.
          const details = records(item.statusDetails)
            .filter((d) => d.selected !== false)
            .map((d) => str(d.label) ?? str(d.name))
            .filter((label): label is string => !!label)
          return {
            remoteId: String(item.id),
            name: str(item.name) ?? `Item ${i + 1}`,
            section,
            sortOrder: i,
            condition: condition(item.status),
            notes: [str(item.message), ...details].filter(Boolean).join('\n') || null,
            photoRemoteIds: records(item.files).map((f) => String(f.id)),
          }
        }),
      orderRemoteId: str(inspection.orderId),
    },
    warnings,
    unmapped,
  }
}
