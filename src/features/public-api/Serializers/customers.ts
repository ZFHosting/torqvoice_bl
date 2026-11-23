/** Customers and their contacts, field by field (docs/fork/API.md §4). */
import type { CustomerContactOut, CustomerOut } from '../Schema/customers'
import { isoAlways } from '../Lib/serializeFormat'
import { customFieldsFrom } from './common'

export const CONTACT_SELECT = {
  id: true,
  kind: true,
  value: true,
  label: true,
  isPrimary: true,
  marketingOptIn: true,
  subscribed: true,
  createdAt: true,
  updatedAt: true,
} as const

export const CONTACT_ORDER = [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] as const

export interface ContactRow {
  id: string
  kind: string
  value: string
  label: string | null
  isPrimary: boolean
  marketingOptIn: boolean | null
  subscribed: boolean | null
  createdAt: Date
  updatedAt: Date
}

export function customerSelect(includes: ReadonlySet<string>) {
  return {
    id: true,
    customerNumber: true,
    name: true,
    company: true,
    email: true,
    phone: true,
    address: true,
    taxId: true,
    taxExempt: true,
    reminderOptOut: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
    ...(includes.has('contacts')
      ? { contacts: { select: CONTACT_SELECT, orderBy: [...CONTACT_ORDER] } }
      : {}),
  }
}

export interface CustomerRow {
  id: string
  customerNumber: string | null
  name: string
  company: string | null
  email: string | null
  phone: string | null
  address: string | null
  taxId: string | null
  taxExempt: boolean
  reminderOptOut: boolean
  notes: string | null
  createdAt: Date
  updatedAt: Date
  contacts?: ContactRow[]
}

export function serializeContact(c: ContactRow): CustomerContactOut {
  return {
    id: c.id,
    kind: c.kind,
    value: c.value,
    label: c.label,
    isPrimary: c.isPrimary,
    marketingOptIn: c.marketingOptIn,
    subscribed: c.subscribed,
    createdAt: isoAlways(c.createdAt),
    updatedAt: isoAlways(c.updatedAt),
  }
}

export function serializeCustomer(
  row: CustomerRow,
  includes: ReadonlySet<string>,
  extra: Record<string, unknown>
): CustomerOut {
  return {
    id: row.id,
    customerNumber: row.customerNumber,
    name: row.name,
    company: row.company,
    email: row.email,
    phone: row.phone,
    address: row.address,
    taxId: row.taxId,
    taxExempt: row.taxExempt,
    reminderOptOut: row.reminderOptOut,
    notes: row.notes,
    createdAt: isoAlways(row.createdAt),
    updatedAt: isoAlways(row.updatedAt),
    ...(includes.has('contacts') ? { contacts: (row.contacts ?? []).map(serializeContact) } : {}),
    ...(includes.has('customFields') ? { customFields: customFieldsFrom(extra) } : {}),
  }
}
