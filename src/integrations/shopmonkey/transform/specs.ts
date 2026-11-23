/**
 * Every field spec the transforms have, in one place: by Shopmonkey table, and for the records nested in one
 * (a customer's emails, a service's lines, an inspection's items). The unmapped-field test and MAPPING §11 read
 * them from here.
 */
import {
  CANNED_LINE_FIELDS,
  CANNED_SERVICE_FIELDS,
  CATALOG_LINE_FIELDS,
  INVENTORY_PART_FIELDS,
} from './catalog'
import { CUSTOMER_FIELDS, EMAIL_FIELDS, PHONE_FIELDS } from './customer'
import type { FieldSpec } from './fields'
import {
  FILE_FIELDS,
  INSPECTION_FIELDS,
  INSPECTION_ITEM_FIELDS,
  INSPECTION_TEMPLATE_FIELDS,
  TEMPLATE_ITEM_FIELDS,
} from './inspection'
import { LINE_FIELDS, SERVICE_FIELDS } from './lines'
import { ORDER_FIELDS } from './order'
import { PAYMENT_FIELDS } from './payment'
import { REFERENCE_FIELDS } from './reference'
import { USER_FIELDS, WORKFLOW_STATUS_FIELDS } from './staff'
import { APPOINTMENT_FIELDS, TIMESHEET_FIELDS } from './time'
import { VEHICLE_FIELDS } from './vehicle'

/** By Shopmonkey table (the staged table names). */
export const TABLE_SPECS: Record<string, FieldSpec> = {
  customer: CUSTOMER_FIELDS,
  vehicle: VEHICLE_FIELDS,
  user: USER_FIELDS,
  workflow_status: WORKFLOW_STATUS_FIELDS,
  order: ORDER_FIELDS,
  order_service: SERVICE_FIELDS,
  payment: PAYMENT_FIELDS,
  timesheet: TIMESHEET_FIELDS,
  appointment: APPOINTMENT_FIELDS,
  inventory_part: INVENTORY_PART_FIELDS,
  inventory_tire: INVENTORY_PART_FIELDS,
  inventory_labor: CATALOG_LINE_FIELDS,
  inventory_fee: CATALOG_LINE_FIELDS,
  canned_service: CANNED_SERVICE_FIELDS,
  inspection_template: INSPECTION_TEMPLATE_FIELDS,
  inspection: INSPECTION_FIELDS,
  ...REFERENCE_FIELDS,
}

/** Records nested in another, by `<table>.<key>[]` (files by `files[]`, wherever they sit). */
export const NESTED_SPECS: Record<string, FieldSpec> = {
  'customer.emails[]': EMAIL_FIELDS,
  'customer.phoneNumbers[]': PHONE_FIELDS,
  ...Object.fromEntries(
    Object.entries(LINE_FIELDS).map(([kind, spec]) => [`order_service.${kind}[]`, spec])
  ),
  ...Object.fromEntries(
    Object.entries(CANNED_LINE_FIELDS).map(([kind, spec]) => [`canned_service.${kind}[]`, spec])
  ),
  'inspection_template.items[]': TEMPLATE_ITEM_FIELDS,
  'inspection.items[]': INSPECTION_ITEM_FIELDS,
  'files[]': FILE_FIELDS,
}
