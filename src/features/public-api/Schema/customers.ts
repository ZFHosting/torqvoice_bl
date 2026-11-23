/**
 * `/api/v1/customers` (docs/fork/API.md §4): `?q=` over name, email, phone and number, with
 * `include=contacts` (X4: their other emails and phones) and `include=customFields`; and
 * `/customers/{id}/contacts`.
 */
import { z } from 'zod'
import type { EndpointSpec } from '../Lib/openapi'
import { type ReadSpec, readEndpoints } from '../Lib/readSpec'
import { customFieldValueSchema } from './common'

export const customerContactSchema = z
  .object({
    id: z.string(),
    kind: z.string().describe('email or phone'),
    value: z.string(),
    label: z.string().nullable(),
    isPrimary: z.boolean(),
    marketingOptIn: z.boolean().nullable(),
    subscribed: z.boolean().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'CustomerContact' })

export const customerSchema = z
  .object({
    id: z.string(),
    customerNumber: z.string().nullable(),
    name: z.string(),
    company: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
    taxId: z.string().nullable(),
    taxExempt: z.boolean(),
    reminderOptOut: z.boolean(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    contacts: z.array(customerContactSchema).optional(),
    customFields: z.array(customFieldValueSchema).optional(),
  })
  .meta({ id: 'Customer' })

export type CustomerOut = z.infer<typeof customerSchema>
export type CustomerContactOut = z.infer<typeof customerContactSchema>

export const customersSpec: ReadSpec<CustomerOut> = {
  path: '/customers',
  tag: 'Customers',
  noun: { one: 'customer', many: 'customers' },
  filters: z.object({
    q: z.string().trim().min(1).max(100).optional().describe('Name, email, phone or number'),
  }),
  includes: ['contacts', 'customFields'],
  response: customerSchema,
}

export const customerEndpoints: EndpointSpec[] = [
  ...readEndpoints(customersSpec),
  {
    method: 'get',
    path: '/customers/{id}/contacts',
    summary: 'A customer’s emails and phones beyond the primary ones',
    tag: 'Customers',
    response: z.array(customerContactSchema),
  },
]
