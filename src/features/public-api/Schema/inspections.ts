/**
 * `/api/v1/inspections` (docs/fork/API.md §4, read only): `?vehicleId=`, `?status=`; `include=items` for what
 * was checked and what was found. Photos are counted, not served (the attachment download is work orders' only).
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'

export const inspectionItemSchema = z
  .object({
    id: z.string(),
    section: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    code: z.string().nullable(),
    sortOrder: z.number().int(),
    condition: z.string().describe('pass, attention, fail, not checked or not applicable'),
    notes: z.string().nullable(),
    inputType: z.string(),
    unit: z.string().nullable(),
    measuredValue: z.number().nullable(),
    textValue: z.string().nullable(),
    photoCount: z.number().int(),
  })
  .meta({ id: 'InspectionItem' })

export const inspectionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    vehicleId: z.string(),
    templateId: z.string(),
    technicianId: z.string().nullable(),
    mileage: z.number().int().nullable(),
    notes: z.string().nullable(),
    startDateTime: z.string().nullable(),
    endDateTime: z.string().nullable(),
    completedAt: z.string().nullable(),
    inspectorName: z.string().nullable(),
    certificateNumber: z.string().nullable(),
    nextTestDue: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    items: z.array(inspectionItemSchema).optional(),
  })
  .meta({ id: 'Inspection' })

export type InspectionOut = z.infer<typeof inspectionSchema>
export type InspectionItemOut = z.infer<typeof inspectionItemSchema>

export const inspectionsSpec: ReadSpec<InspectionOut> = {
  path: '/inspections',
  tag: 'Inspections',
  noun: { one: 'inspection', many: 'inspections' },
  filters: z.object({
    vehicleId: z.string().min(1).optional(),
    status: z.string().trim().min(1).max(50).optional(),
  }),
  includes: ['items'],
  // fork (A5): `include=source`
  sourceModel: 'Inspection',
  response: inspectionSchema,
}

export const inspectionEndpoints: EndpointSpec[] = readEndpoints(inspectionsSpec)
