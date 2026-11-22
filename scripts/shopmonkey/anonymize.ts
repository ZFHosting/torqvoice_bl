/**
 * Deterministic anonymization of recorded Shopmonkey payloads (docs/fork/FORK.md, "Never commit real
 * shop data"). Pure: no I/O, so it is unit tested in src/__tests__/scripts/shopmonkey/anonymize.test.ts.
 * The CLI around it is anonymize-fixtures.ts.
 *
 * **Replace by default.** Every string is replaced unless its key says it can't hold personal data:
 * - an id (`id`, `*Id`, `*Ids`): Shopmonkey's opaque ids, which the fixtures need to stay linked;
 * - a documented enum (ENUM_KEYS, from docs/fork/spikes/SHOPMONKEY-SCHEMAS.md): `status`, `paymentType`...;
 * - a short list of catalog and vehicle facts (SAFE_KEYS): part numbers, sizes, make and model...;
 * - `name` on things rather than people (a service, a part, a workflow status: THING_TABLES).
 * ISO dates, numbers and booleans are kept, except coordinates, which are zeroed. A field Shopmonkey
 * adds later is therefore replaced until someone decides it's safe, rather than leaking until someone
 * notices. Kept strings are still scrubbed: anything in them that looks like an email, a phone number
 * or a VIN is replaced.
 *
 * The same input (with the same salt) always gives the same fake, so a customer's email on the
 * customer and on an order stay equal. Every replaced identifier is collected, so the caller can prove
 * none is left anywhere in the output before writing it (`findLeaks`).
 *
 * The salt must be secret (ANONYMIZE_SALT, never committed): with a known salt, someone holding a guess
 * of a real phone number could check it against the fake.
 */
import { createHmac } from 'node:crypto'

/** Every fixture VIN starts with this, so a reviewer can tell a fake from a real one at a glance. */
export const FAKE_VIN_PREFIX = 'TVFX'
/** Fake phones are in the 555-0100–0199 range reserved for fiction, across a few area codes. */
export const FAKE_PHONE_PATTERN = /^\+1(202|303|404|505|606|707|808|909)555 ?01\d\d$/
export const FAKE_EMAIL_DOMAIN = 'example.test'
const AREA_CODES = ['202', '303', '404', '505', '606', '707', '808', '909']

const FIRST_NAMES = [
  'Avery',
  'Blake',
  'Casey',
  'Dana',
  'Elliot',
  'Finley',
  'Gray',
  'Harper',
  'Indy',
  'Jules',
  'Kai',
  'Logan',
  'Morgan',
  'Noel',
  'Oakley',
  'Parker',
  'Quinn',
  'Reese',
  'Sage',
  'Taylor',
  'Umber',
  'Vale',
  'Wren',
  'Xen',
  'Yael',
  'Zion',
]
const LAST_NAMES = [
  'Ashford',
  'Brightwater',
  'Coldridge',
  'Dunmore',
  'Elmsworth',
  'Fairbank',
  'Glenhollow',
  'Hartwell',
  'Ironwood',
  'Juniper',
  'Kestrel',
  'Larkspur',
  'Millbrook',
  'Northcote',
  'Oakhurst',
  'Pemberton',
  'Quarry',
  'Redfern',
  'Stonebridge',
  'Thistlewood',
  'Underhill',
  'Vantage',
  'Westbrook',
  'Yarrow',
  'Zephyr',
]
const COMPANY_WORDS = ['Fleet', 'Logistics', 'Haulage', 'Services', 'Rentals', 'Delivery', 'Works']
const STREETS = ['Maple', 'Cedar', 'Birch', 'Willow', 'Aspen', 'Spruce', 'Alder', 'Hazel', 'Rowan']
const STREET_KINDS = ['St', 'Ave', 'Rd', 'Ln', 'Way', 'Ct']
const CITIES = ['Springfield', 'Riverton', 'Lakeside', 'Fairview', 'Hillcrest', 'Brookfield']
const NOTES = [
  'Customer reports a noise when braking.',
  'Check again at next service.',
  'Waiting on parts.',
  'Called customer with the estimate.',
  'Vehicle dropped off after hours.',
  'Customer declined additional work for now.',
  'Recommend replacing within 3 months.',
  'Leave keys at the front desk.',
]
/** VIN characters (no I, O or Q). */
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'

/**
 * Keys documented as enums in Shopmonkey's schemas (docs/fork/spikes/SHOPMONKEY-SCHEMAS.md): their
 * values are drawn from a fixed list, so they can't hold personal data and the importer needs them.
 */
export const ENUM_KEYS: ReadonlySet<string> = new Set([
  'activity',
  'appliedDiscountValueType',
  'appointmentEvent',
  'attributionSource',
  'authorType',
  'authorizationStatus',
  'checklistStage',
  'clockInPlatform',
  'clockOutPlatform',
  'color',
  'configurationStatus',
  'confirmationStatus',
  'consumptionType',
  'contentType',
  'country',
  'creditMethod',
  'customerType',
  'defaultTemplateIdentifier',
  'deferredReason',
  'discountValueType',
  'disputedStatus',
  'disputedType',
  'drivetrain',
  'drivingCondition',
  'emailStatus',
  'entity',
  'epaValueType',
  'feePricingModel',
  'feeType',
  'fixedPriceLimitType',
  'gstValueType',
  'hstValueType',
  'inspectionReviewStatus',
  'inspectionStatus',
  'inventoryStatus',
  'invoiceLockState',
  'language',
  'lengthUnit',
  'licensePlateCountry',
  'lineItemEntity',
  'lineItemInventoryStatus',
  'lineItemOrder',
  'marketingOptInMethod',
  'marketingOptInStatus',
  'method',
  'mileageUnit',
  'multiplierType',
  'optInStatus',
  'orderShareType',
  'origin',
  'outerDiameterUnit',
  'partReturnPartType',
  'paymentMode',
  'paymentType',
  'preferredContactMethod',
  'preferredLaborGuide',
  'preferredLanguage',
  'pricing',
  'provider',
  'pstValueType',
  'purchaseStatus',
  'refundReason',
  'region',
  'returnType',
  'reviewStatus',
  'seasonality',
  'sectionWidthUnit',
  'sendReviewTrigger',
  'shopSuppliesConfig',
  'shopSuppliesServiceType',
  'shopSuppliesValueType',
  'size',
  'sizeFormat',
  'skillRequired',
  'smsStatus',
  'sourceType',
  'starterTemplateIdentifier',
  'status',
  'suggestedReplyState',
  'taxSystem',
  'taxValueType',
  'transactionType',
  'transmission',
  'treadDepthUnit',
  'type',
  'wheelDiameterUnit',
])

/** String keys that hold catalog, vehicle or document facts, never a person. Kept, then scrubbed. */
export const SAFE_KEYS: ReadonlySet<string> = new Set([
  'binLocation',
  'bodyStyle',
  'bedLength',
  'calculatedName',
  'cardType',
  'categoryType',
  'computedSortableName',
  'computed_ymm',
  'construction',
  'creditInvoiceNumber',
  'drivetype',
  'engine',
  'externalNumber',
  'fileType',
  'frontTireSize',
  'generatedBrandName',
  'generatedModelName',
  'hash',
  'idempotencyKey',
  'inventoryNumber',
  'invoiceNumber',
  'label',
  'loadRange',
  'make',
  'mobileCountryCode',
  'mobileNetworkCode',
  'model',
  'normalizedPartNumber',
  'normalizedSKU',
  'number',
  'parentName',
  'partNumber',
  'productionDate',
  'quickbooksRef',
  'readMethod',
  'rearTireSize',
  'serviceType',
  'size',
  'sku',
  'speedRating',
  'state',
  'submodel',
  'temperature_UTQG',
  'timezone',
  'traction_UTQG',
  'transmissionMfrCode',
  'transmissionSpeed',
  'unit',
  'vendorInvoiceNumber',
  'extension',
  'licensePlateState',
  'confirmationTemplateIdentifier',
  'reminderTemplateIdentifier',
])

/** Tables whose `name` names a thing (a service, a part, a status), not a person or a business. */
const THING_TABLES = new Set([
  'service',
  'order_service',
  'labor',
  'part',
  'tire',
  'fee',
  'subcontract',
  'canned_service',
  'canned_service_labor',
  'canned_service_part',
  'canned_service_tire',
  'canned_service_fee',
  'canned_service_subcontract',
  'inventory_part',
  'inventory_tire',
  'inventory_labor',
  'inventory_fee',
  'inventory_category',
  'inspection',
  'inspection_item',
  'inspection_item_status_detail',
  'inspection_template',
  'inspection_template_item',
  'workflow_status',
  'label',
  'tax_config',
  'payment_term',
  'tire_model',
  'brand',
  'payment_type_config',
  'labor_matrix',
  'pricing_matrix',
  'core_charge',
])
/** Tables whose `name` is a person. Any other non-thing table's `name` is free text. */
const PERSON_TABLES = new Set(['customer', 'user', 'contact'])
/** Tables whose `name` is a business. */
const BUSINESS_TABLES = new Set(['vendor', 'location', 'company', 'fleet'])

/** The table a nested object belongs to, by the key it sits under. */
const CHILD_TABLE: Record<string, string> = {
  customer: 'customer',
  customers: 'customer',
  vehicle: 'vehicle',
  vehicles: 'vehicle',
  user: 'user',
  users: 'user',
  technician: 'user',
  technicians: 'user',
  serviceWriter: 'user',
  vendor: 'vendor',
  location: 'location',
  locations: 'location',
  companyLocations: 'location',
  company: 'company',
  services: 'service',
  labors: 'labor',
  parts: 'part',
  tires: 'tire',
  fees: 'fee',
  subcontracts: 'subcontract',
  emails: 'email',
  phoneNumbers: 'phone_number',
  files: 'file',
  statusDetails: 'inspection_item_status_detail',
  owners: 'vehicle_owner',
  contactPhone: 'phone_number',
  workflowStatus: 'workflow_status',
  paymentTerm: 'payment_term',
  appointments: 'appointment',
  inspections: 'inspection',
  authorizations: 'authorization',
}

export type Kind =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'companyName'
  | 'email'
  | 'phone'
  | 'vin'
  | 'plate'
  | 'street'
  | 'city'
  | 'postalCode'
  | 'note'
  | 'url'
  | 'fileName'
  | 'digits'
  | 'token'
  | 'word'
  | 'secret'

/** Key name (lowercased) → what it holds, where a specific fake reads better than generic text. */
const KEY_KINDS: Record<string, Kind> = {
  firstname: 'firstName',
  middlename: 'firstName',
  contactfirstname: 'firstName',
  normalizedfirstname: 'firstName',
  lastname: 'lastName',
  contactlastname: 'lastName',
  normalizedlastname: 'lastName',
  fullname: 'fullName',
  displayname: 'fullName',
  contactname: 'fullName',
  ownername: 'fullName',
  customername: 'fullName',
  generatedcustomername: 'fullName',
  normalizedname: 'fullName',
  coalescedfirstnameorcompanyname: 'fullName',
  cardname: 'fullName',
  reviewername: 'fullName',
  technicianname: 'fullName',
  servicewritername: 'fullName',
  signername: 'fullName',
  signedby: 'fullName',
  scannedby: 'fullName',
  companyname: 'companyName',
  email: 'email',
  emailaddress: 'email',
  contactemail: 'email',
  phone: 'phone',
  phonenumber: 'phone',
  contactphone: 'phone',
  mobile: 'phone',
  mobilephone: 'phone',
  homephone: 'phone',
  workphone: 'phone',
  fax: 'phone',
  vin: 'vin',
  hin: 'vin',
  coalescedvinorhin: 'vin',
  licenseplate: 'plate',
  plate: 'plate',
  address: 'street',
  address1: 'street',
  address2: 'street',
  addressline1: 'street',
  addressline2: 'street',
  street: 'street',
  street1: 'street',
  street2: 'street',
  line1: 'street',
  line2: 'street',
  city: 'city',
  postalcode: 'postalCode',
  zip: 'postalCode',
  zipcode: 'postalCode',
  website: 'url',
  url: 'url',
  pdfurl: 'url',
  thumbnailurl: 'url',
  customphotourl: 'url',
  googlephotourl: 'url',
  reviewerphotourl: 'url',
  signature: 'url',
  filename: 'fileName',
  carddigits: 'digits',
  cardlast4: 'digits',
  last4: 'digits',
  checknumber: 'digits',
  accountnumber: 'digits',
  cardconfirmation: 'digits',
  dotnumber: 'digits',
  serial: 'token',
  taxid: 'token',
  externalid: 'token',
  token: 'secret',
  bstoken: 'secret',
  accesstoken: 'secret',
  password: 'secret',
  secret: 'secret',
  apikey: 'secret',
}

/** Kinds whose originals the leak check looks for in the output. */
const LEAK_CHECKED: ReadonlySet<Kind> = new Set<Kind>([
  'firstName',
  'lastName',
  'fullName',
  'companyName',
  'email',
  'phone',
  'vin',
  'plate',
  'street',
  'token',
  'secret',
])

/** Id keys that hold a person's identifier rather than Shopmonkey's: replaced like any value. */
const PII_ID_KEYS = new Set(['taxId', 'externalId'])

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// North American and international phone shapes with at least 10 digits.
const PHONE_RE = /(?<![\w-])\+?\d{0,3}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

export interface Anonymizer {
  /** Anonymizes one record of `table`. Returns a new object; the input is untouched. */
  record(table: string, value: unknown): unknown
  /** Every original identifier that was replaced, for the leak check. */
  originals(): ReadonlySet<string>
}

export function createAnonymizer(salt: string): Anonymizer {
  if (!salt || salt.length < 16)
    throw new Error('The anonymization salt must be at least 16 characters.')
  const replaced = new Set<string>()

  const digest = (kind: string, value: string) =>
    createHmac('sha256', salt).update(`${kind}\u0000${value.trim().toLowerCase()}`).digest()
  const pick = <T>(list: readonly T[], bytes: Buffer, offset = 0) =>
    list[bytes.readUInt16BE(offset) % list.length]
  const remember = (kind: Kind, original: string) => {
    if (LEAK_CHECKED.has(kind) && original.trim().length >= 4) replaced.add(original.trim())
  }

  function fake(kind: Kind, original: string): string {
    const h = digest(kind, original)
    switch (kind) {
      case 'firstName':
        return pick(FIRST_NAMES, h)
      case 'lastName':
        return pick(LAST_NAMES, h)
      case 'fullName':
        return `${pick(FIRST_NAMES, h)} ${pick(LAST_NAMES, h, 2)}`
      case 'companyName':
        return `${pick(LAST_NAMES, h)} ${pick(COMPANY_WORDS, h, 2)}`
      case 'email':
        return `user-${h.toString('hex').slice(0, 10)}@${FAKE_EMAIL_DOMAIN}`
      case 'phone':
        return `+1${pick(AREA_CODES, h, 2)}555${String(100 + (h.readUInt16BE(0) % 100)).padStart(4, '0')}`
      case 'vin': {
        let vin = FAKE_VIN_PREFIX
        for (let i = 0; vin.length < 17; i++) vin += VIN_CHARS[h[i % h.length] % VIN_CHARS.length]
        return vin
      }
      case 'plate':
        return `FX${String(h.readUInt16BE(0) % 10000).padStart(4, '0')}`
      case 'street':
        return `${1 + (h.readUInt16BE(0) % 9899)} ${pick(STREETS, h, 2)} ${pick(STREET_KINDS, h, 4)}`
      case 'city':
        return pick(CITIES, h)
      case 'postalCode':
        return `9${String(h.readUInt16BE(0) % 10000).padStart(4, '0')}`
      case 'note':
        return pick(NOTES, h)
      case 'url':
        return `https://files.${FAKE_EMAIL_DOMAIN}/${h.toString('hex').slice(0, 16)}${extensionOf(original)}`
      case 'fileName':
        return `file-${h.toString('hex').slice(0, 10)}${extensionOf(original)}`
      case 'digits':
        return String(h.readUInt16BE(0) % 10000).padStart(4, '0')
      case 'word':
      case 'token':
        return `x${h.toString('hex').slice(0, 12)}`
      case 'secret':
        return 'REDACTED'
    }
  }

  function replace(kind: Kind, value: string): string {
    if (value.trim() === '') return value
    remember(kind, value)
    return fake(kind, value)
  }

  /** Text kept as is (an id, an enum, a catalog fact): replace anything in it that looks like contact data. */
  function scrub(value: string): string {
    return value
      .replace(EMAIL_RE, (m) => (remember('email', m), fake('email', m)))
      .replace(VIN_RE, (m) =>
        m.startsWith(FAKE_VIN_PREFIX) ? m : (remember('vin', m), fake('vin', m))
      )
      .replace(PHONE_RE, (m) => {
        if (FAKE_PHONE_PATTERN.test(m.replace(/[\s()-]/g, ''))) return m
        if (m.replace(/\D/g, '').length < 10) return m
        remember('phone', m)
        return fake('phone', m)
      })
  }

  /** What to do with a string under `key` in `table`: keep (then scrub) or replace as a kind. */
  function decide(table: string, key: string): 'keep' | Kind {
    const lower = key.toLowerCase()
    if (key === 'number' && (table === 'phone_number' || table === 'phone')) return 'phone'
    if (KEY_KINDS[lower]) return KEY_KINDS[lower]
    if (key === 'name') {
      if (THING_TABLES.has(table)) return 'keep'
      if (PERSON_TABLES.has(table)) return 'fullName'
      if (BUSINESS_TABLES.has(table)) return 'companyName'
      return 'note'
    }
    if (isIdKey(key) || ENUM_KEYS.has(key) || SAFE_KEYS.has(key)) return 'keep'
    if (/url$/i.test(key)) return 'url'
    if (/name$/i.test(key)) return 'fullName'
    return 'note'
  }

  function walkString(table: string, key: string | null, value: string): string {
    if (ISO_DATE.test(value)) return value
    const decision = key === null ? 'note' : decide(table, key)
    if (decision === 'keep') return scrub(value)
    // A single word that isn't a name becomes a token rather than a sentence.
    // A single word of free text becomes a token. It isn't leak-checked: a word like "Cash" or "Fleet"
    // is just as likely to be an enum value or a part name elsewhere, and the identifiers that matter
    // (names, contacts, VINs, plates, serials, tax ids) have kinds of their own that are checked.
    if (decision === 'note' && !/\s/.test(value.trim())) return replace('word', value)
    return replace(decision, value)
  }

  function walk(table: string, value: unknown, key: string | null): unknown {
    if (Array.isArray(value)) return value.map((v) => walk(table, v, key))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        if (child !== null && typeof child === 'object') {
          out[childKey] = walk(CHILD_TABLE[childKey] ?? table, child, childKey)
        } else out[childKey] = walk(table, child, childKey)
      }
      return out
    }
    if (typeof value === 'string') return walkString(table, key, value)
    if (typeof value === 'number' && key !== null) {
      if (/(latitude|longitude)$/i.test(key)) return 0
      const kind = decide(table, key)
      if (kind === 'phone' || kind === 'digits' || kind === 'postalCode')
        return replace(kind, String(value))
    }
    return value
  }

  return {
    record: (table, value) => walk(table.toLowerCase(), value, null),
    originals: () => replaced,
  }
}

function isIdKey(key: string): boolean {
  if (PII_ID_KEYS.has(key)) return false
  return key === 'id' || key === '_id' || /Ids?$/.test(key)
}

function extensionOf(url: string): string {
  const m = url.split('?')[0].match(/\.(jpe?g|png|gif|webp|heic|pdf|docx?|xlsx?|csv|txt)$/i)
  return m ? `.${m[1].toLowerCase()}` : ''
}

/** Lowercase words, with apostrophes dropped inside them, so "O'Rourke" and "orourke" compare equal. */
function words(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9@.+]+/g, ' ')
      // A dot only joins words (an email, a domain); at the end of a sentence it's punctuation.
      .replace(/(^|\s)\.+|\.+(?=\s|$)/g, ' ')
      .trim()
  )
}

/**
 * Original values still present in the serialized output, plus any deny-listed string (the shop's
 * name, a surname you know is in the data). Empty means safe to write. A value counts as present when
 * its words appear as whole words, ignoring case and apostrophes; a deny-listed value also counts when
 * it appears squashed into one word (`Joes Garage` in `joesgarage.example`). `allowList` names
 * originals that are known false positives (a customer whose surname is "Brake").
 */
export function findLeaks(
  serialized: string,
  originals: Iterable<string>,
  denyList: Iterable<string> = [],
  allowList: Iterable<string> = []
): string[] {
  const allowed = new Set([...allowList].map((v) => words(v)))
  const haystack = ` ${words(serialized)} `
  const squashed = haystack.replace(/[^a-z0-9]/g, '')
  const deny = new Set([...denyList].map((v) => v.trim()).filter(Boolean))
  const leaks: string[] = []
  for (const value of new Set([...originals, ...deny])) {
    const needle = words(value)
    if (needle.length < 4 || allowed.has(needle)) continue
    const compact = needle.replace(/[^a-z0-9]/g, '')
    const found =
      haystack.includes(` ${needle} `) ||
      (deny.has(value.trim()) && compact.length >= 6 && squashed.includes(compact))
    if (found) leaks.push(value)
  }
  return leaks
}
