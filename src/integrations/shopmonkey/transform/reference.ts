/**
 * Tables other transforms read from rather than turn into rows of their own (MAPPING §3): the company and
 * location, the tax config and labor rates (workshop settings), vendors and categories (on inventory
 * parts), labels and referral sources (custom field values), authorizations (`authorizedAt`) and vehicle
 * owners (`Vehicle.customerId`). What they don't feed stays in the archive.
 */
import { centsToAmount } from '../money'
import { type FieldSpec, num, str } from './fields'
import type { Row } from './types'

const TAX_RATES = ['taxPercent', 'gstPercent', 'pstPercent', 'hstPercent']
const TAXABLE = ['labor', 'part'].flatMap((k) => [
  `${k}Taxable`,
  `${k}TaxableGST`,
  `${k}TaxablePST`,
  `${k}TaxableHST`,
])

export const REFERENCE_FIELDS: Record<string, FieldSpec> = {
  company: { mapped: ['id', 'name'], archive: ['createdDate'] },
  location: {
    mapped: ['id', 'name', 'timezone'],
    archive: [
      'address1',
      'address2',
      'archived',
      'city',
      'companyId',
      'country',
      'createdDate',
      'deleted',
      'email',
      'latitude',
      'locationId',
      'longitude',
      'metadata',
      'phone',
      'postalCode',
      'state',
      'updatedDate',
      'website',
    ],
  },
  tax_config: {
    mapped: [
      'id',
      ...TAX_RATES,
      ...TAXABLE,
      'epaTaxable',
      'shopSuppliesTaxable',
      'taxSystem',
      'rateId',
    ],
    archive: [
      'applyServiceDiscountToTaxableItemsFirst',
      'companyId',
      'createdDate',
      'epaPercent',
      'hash',
      'includeEpaOnLabor',
      'includeEpaOnParts',
      'laborShopSupplies',
      'locationId',
      'metadata',
      'partShopSupplies',
      'priceCalculatorVersion',
      'shopSuppliesConfig',
      'shopSuppliesMaxCapCents',
      'subcontractTaxable',
      'updatedDate',
      'version',
    ],
  },
  labor_rate: {
    mapped: ['id', 'name', 'valueCents', 'isEmployeeRate', 'deleted', 'createdDate'],
    archive: ['companyId', 'flatRate', 'locationId', 'metadata', 'updatedDate'],
  },
  vendor: {
    mapped: ['id', 'name', 'contactEmail', 'contactPhone', 'url'],
    archive: [
      'accountNumber',
      'address1',
      'city',
      'companyId',
      'contactFirstName',
      'contactLastName',
      'country',
      'createdDate',
      'deleted',
      'locationId',
      'metadata',
      'postalCode',
      'state',
      'updatedDate',
    ],
  },
  inventory_category: {
    mapped: ['id', 'name'],
    archive: [
      'companyId',
      'createdDate',
      'deleted',
      'locationId',
      'metadata',
      'parentId',
      'parentName',
      'updatedDate',
    ],
  },
  label: {
    mapped: ['id', 'name'],
    archive: [
      'color',
      'companyId',
      'createdDate',
      'entity',
      'locationId',
      'metadata',
      'saved',
      'updatedDate',
    ],
  },
  referral_source: {
    mapped: ['id', 'name'],
    archive: [
      'companyId',
      'createdDate',
      'editable',
      'locationId',
      'metadata',
      'reserved',
      'updatedDate',
    ],
  },
  authorization: {
    mapped: ['id', 'orderId', 'date', 'createdDate'],
    archive: [
      'authorizedCostCents',
      'companyId',
      'customerId',
      'locationId',
      'metadata',
      'method',
      'note',
      'serviceAuthorizationReset',
      'serviceWriterId',
      'services',
      'updatedDate',
    ],
  },
  vehicle_owner: {
    mapped: ['id', 'customerId', 'vehicleId', 'createdDate'],
    archive: ['companyId', 'metadata', 'updatedDate'],
  },
}

/**
 * The workshop's default labor rate (§3): the tax config's `rateId` when it names one, else the oldest
 * rate that isn't an employee's. PROVISIONAL(M0:S6): what `rateId` on the tax config means is a reading
 * of the schema. Others are archive only.
 */
export function defaultLaborRate(rates: Row[], taxConfig: Row | null): number | null {
  const live = rates.filter((r) => r.deleted !== true)
  const named = str(taxConfig?.rateId) ? live.find((r) => r.id === taxConfig?.rateId) : undefined
  const fallback = live
    .filter((r) => r.isEmployeeRate !== true)
    .sort((a, b) => String(a.createdDate ?? '').localeCompare(String(b.createdDate ?? '')))[0]
  const chosen = named ?? fallback
  const cents = num(chosen?.valueCents)
  return cents === null ? null : centsToAmount(Math.round(cents))
}
