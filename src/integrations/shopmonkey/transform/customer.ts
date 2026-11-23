/**
 * Customer (MAPPING §4): the customer row, its extra emails and phones (X4), and its custom field
 * values. A deleted Shopmonkey customer isn't imported (it stays in the archive).
 */
import {
  cleanText,
  joinName,
  normalizeEmail,
  normalizePhone,
} from '@/features/import/Lib/normalize'
import { date, entries, type FieldSpec, records, str, unmappedFields, warn } from './fields'
import type { Row, TransformContext, TransformResult, Warning } from './types'

export const CUSTOMER_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'firstName',
    'lastName',
    'companyName',
    'publicId',
    'emails',
    'phoneNumbers',
    'address1',
    'address2',
    'city',
    'state',
    'postalCode',
    'country',
    'note',
    'taxExempt',
    'gstExempt',
    'hstExempt',
    'pstExempt',
    'customerType',
    'customFields',
    'labels',
    'referralSourceId',
    'createdDate',
    'deleted',
  ],
  archive: [
    'companyId',
    'locationId',
    'locationIds',
    'updatedDate',
    'deletedDate',
    'deletedReason',
    'discountPercent',
    'externalId',
    'fleetId',
    'metadata',
    'preferredContactMethod',
    'preferredLanguage',
    'website',
  ],
}

export interface CustomerContactRow {
  remoteId: string
  kind: 'email' | 'phone'
  value: string
  label: string | null
  isPrimary: boolean
  marketingOptIn: boolean | null
  subscribed: boolean | null
}

export interface CustomFieldValueRow {
  entityType: 'customer' | 'vehicle' | 'service_record' | 'quote'
  /** The field's name; M5 creates the definition on first sight. */
  name: string
  value: string
}

export interface CustomerRows {
  customer: {
    name: string
    company: string | null
    email: string | null
    phone: string | null
    address: string | null
    notes: string | null
    taxExempt: boolean
    reminderOptOut: boolean
    createdAt: Date | undefined
    userId: string
    organizationId: string
  }
  /** `publicId` when it is all digits; M5 keeps it only if no other customer has it (MAPPING §4). */
  customerNumberCandidate: string | null
  contacts: CustomerContactRow[]
  customFields: CustomFieldValueRow[]
}

/** Primary first, then the oldest (MAPPING §3). */
function byPrimaryThenAge(a: Row, b: Row): number {
  if (a.primary === true && b.primary !== true) return -1
  if (b.primary === true && a.primary !== true) return 1
  return String(a.createdDate ?? '').localeCompare(String(b.createdDate ?? ''))
}

/** The lines an invoice prints, US order: street, second line, "City, ST 12345", country. */
export function composeAddress(record: Row): string | null {
  const city = str(record.city)
  const stateZip = cleanText([str(record.state), str(record.postalCode)].filter(Boolean).join(' '))
  const locality = cleanText([city, stateZip].filter(Boolean).join(', '))
  const lines = [str(record.address1), str(record.address2), locality, str(record.country)].filter(
    (line): line is string => !!line
  )
  return lines.length ? lines.join('\n') : null
}

export function transformCustomer(
  record: Row,
  ctx: TransformContext
): TransformResult<CustomerRows | null> {
  const remoteId = String(record.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(record, CUSTOMER_FIELDS)
  if (record.deleted === true) return { rows: null, warnings, unmapped }

  const person = joinName(str(record.firstName), str(record.lastName))
  const companyName = str(record.companyName)
  let name = person ?? companyName
  if (!name) {
    name = `Shopmonkey customer ${str(record.publicId) ?? remoteId}`
    warnings.push(
      warn('customer', remoteId, 'customer_missing_name', 'No name or company', 'firstName')
    )
  }

  const emails = records(record.emails).sort(byPrimaryThenAge)
  const phones = records(record.phoneNumbers).sort(byPrimaryThenAge)
  const contacts: CustomerContactRow[] = []
  for (const [i, e] of emails.entries()) {
    const { value, valid } = normalizeEmail(str(e.email))
    if (!value) continue
    if (!valid) {
      warnings.push(
        warn(
          'customer',
          remoteId,
          'customer_invalid_email',
          'An email that does not look like one',
          'emails'
        )
      )
    }
    contacts.push({
      remoteId: String(e.id ?? `${remoteId}:email:${i}`),
      kind: 'email',
      value,
      label: null,
      isPrimary: i === 0,
      marketingOptIn: typeof e.marketingOptIn === 'boolean' ? e.marketingOptIn : null,
      subscribed: typeof e.subscribed === 'boolean' ? e.subscribed : null,
    })
  }
  for (const [i, p] of phones.entries()) {
    const value = normalizePhone(str(p.number), ctx.countryCode)
    if (!value) continue
    const extension = str(p.extension)
    contacts.push({
      remoteId: String(p.id ?? `${remoteId}:phone:${i}`),
      kind: 'phone',
      value: extension ? `${value} ext. ${extension}` : value,
      label: str(p.userDefinedType) ?? str(p.type),
      isPrimary: i === 0,
      marketingOptIn: null,
      subscribed: null,
    })
  }
  const primaryEmail = contacts.find((c) => c.kind === 'email' && c.isPrimary)
  const primaryPhone = contacts.find((c) => c.kind === 'phone' && c.isPrimary)

  const customFields: CustomFieldValueRow[] = []
  if (str(record.customerType) === 'Fleet') {
    customFields.push({ entityType: 'customer', name: 'Customer type', value: 'Fleet' })
  }
  // PROVISIONAL(M0:S4): `customFields` and `labels` are `{ id: value }` objects; the field's name is its id
  // until the definitions are recorded.
  for (const [field, value] of entries(record.customFields)) {
    const text = value === null || value === undefined ? null : String(value).trim()
    if (text) customFields.push({ entityType: 'customer', name: field, value: text })
  }
  const labels = entries(record.labels)
    .map(([, label]) => str(label))
    .filter((label): label is string => !!label)
  if (labels.length)
    customFields.push({ entityType: 'customer', name: 'Labels', value: labels.join(', ') })
  const referral = str(record.referralSourceId)
  if (referral) {
    customFields.push({ entityType: 'customer', name: 'Referral source', value: referral })
  }

  const publicId = str(record.publicId)
  return {
    rows: {
      customer: {
        name,
        company: person && companyName ? companyName : null,
        email: primaryEmail?.value ?? null,
        phone: primaryPhone?.value ?? null,
        address: composeAddress(record),
        notes: cleanText(typeof record.note === 'string' ? record.note : null),
        taxExempt: [record.taxExempt, record.gstExempt, record.hstExempt, record.pstExempt].some(
          (flag) => flag === true
        ),
        // PROVISIONAL(M0:S4): only an explicit unsubscribe on the primary email opts out.
        reminderOptOut: emails[0]?.subscribed === false,
        createdAt: date(record.createdDate) ?? undefined,
        userId: ctx.runUserId,
        organizationId: ctx.organizationId,
      },
      customerNumberCandidate: publicId && /^\d+$/.test(publicId) ? publicId : null,
      contacts,
      customFields,
    },
    warnings,
    unmapped,
  }
}
