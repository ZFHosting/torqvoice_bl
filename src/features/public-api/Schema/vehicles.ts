/**
 * `/api/v1/vehicles` (docs/fork/API.md §4): `?customerId=`, `?vin=`, `?plate=`, with `include=notes` and
 * `include=customFields`.
 */
import { z } from 'zod'
import { createVehicleSchema, updateVehicleSchema } from '@/features/vehicles/Schema/vehicleSchema'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { patchBody, writeEndpoints } from '../Lib/writeSpec'
import { customFieldValueSchema, sourceSchema } from './common'

export const vehicleNoteSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    isPinned: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'VehicleNote' })

export const vehicleSchema = z
  .object({
    id: z.string(),
    customerId: z.string().nullable(),
    make: z.string(),
    model: z.string(),
    year: z.number().int(),
    vin: z.string().nullable(),
    licensePlate: z.string().nullable(),
    color: z.string().nullable(),
    mileage: z.number().int().describe('In the workshop’s unit system (see /settings)'),
    fuelType: z.string().nullable(),
    transmission: z.string().nullable(),
    engineSize: z.string().nullable(),
    engineCode: z.string().nullable(),
    fleetNumber: z.string().nullable(),
    bodyType: z.string().nullable(),
    purchaseDate: z.string().nullable(),
    purchasePrice: z.number().nullable(),
    isArchived: z.boolean(),
    archiveReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    notes: z.array(vehicleNoteSchema).optional(),
    customFields: z.array(customFieldValueSchema).optional(),
    // fork (A5): with `include=source`
    sourceRecord: sourceSchema.optional(),
  })
  .meta({ id: 'Vehicle' })

export type VehicleOut = z.infer<typeof vehicleSchema>
export type VehicleNoteOut = z.infer<typeof vehicleNoteSchema>

export const vehiclesSpec: ReadSpec<VehicleOut> = {
  path: '/vehicles',
  tag: 'Vehicles',
  noun: { one: 'vehicle', many: 'vehicles' },
  filters: z.object({
    customerId: z.string().min(1).optional(),
    vin: z.string().trim().min(1).max(32).optional(),
    plate: z.string().trim().min(1).max(32).optional(),
  }),
  includes: ['notes', 'customFields'],
  // fork (A5): `include=source`
  sourceModel: 'Vehicle',
  response: vehicleSchema,
}

export const vehicleEndpoints: EndpointSpec[] = [
  ...readEndpoints(vehiclesSpec),
  ...writeEndpoints({
    ...vehiclesSpec,
    create: createVehicleSchema,
    update: patchBody(updateVehicleSchema),
    remove: true,
  }),
]
