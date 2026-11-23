/**
 * `/api/v1/technicians` and `/api/v1/work-order-statuses` (docs/fork/API.md §4): who does the work, and the
 * workshop's own work order statuses with the stage each is filed under.
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'

export const technicianSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    isActive: z.boolean(),
    sortOrder: z.number().int(),
    dailyCapacity: z.number().int().describe('Minutes a day the work board plans for'),
    skills: z.string().nullable(),
    userId: z.string().nullable().describe('The login the technician has, if any'),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Technician' })

export const workOrderStatusSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    stage: z.string().describe('pending, in-progress or completed'),
    color: z.string(),
    sortOrder: z.number().int(),
    notifyCustomer: z.boolean(),
    archivedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'WorkOrderStatus' })

export type TechnicianOut = z.infer<typeof technicianSchema>
export type WorkOrderStatusOut = z.infer<typeof workOrderStatusSchema>

export const techniciansSpec: ReadSpec<TechnicianOut> = {
  path: '/technicians',
  tag: 'Technicians',
  noun: { one: 'technician', many: 'technicians' },
  filters: z.object({
    active: z.enum(['true', 'false']).optional().describe('Only active (true) or inactive (false)'),
  }),
  response: technicianSchema,
}

export const workOrderStatusesSpec: ReadSpec<WorkOrderStatusOut> = {
  path: '/work-order-statuses',
  tag: 'Work order statuses',
  noun: { one: 'work order status', many: 'work order statuses' },
  response: workOrderStatusSchema,
}

export const staffEndpoints: EndpointSpec[] = [
  ...readEndpoints(techniciansSpec),
  ...readEndpoints(workOrderStatusesSpec),
]
