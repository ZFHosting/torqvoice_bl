/**
 * Deterministic anonymization of recorded Shopmonkey payloads (docs/fork/FORK.md, "Never commit real
 * shop data"). Pure: no I/O, so it is unit tested in src/__tests__/scripts/shopmonkey/anonymize.test.ts.
 * The CLI around it is anonymize-fixtures.ts.
 *
 * Rules:
 * - The same input (with the same salt) always gives the same fake, so a customer's email in the
 *   customer table and on an order stay equal, and references survive.
 * - Ids (`id`, `*Id`, `*Ids`) are kept: they are Shopmonkey's opaque ids, and the fixtures are useless
 *   without them.
 * - Names, emails, phones, VINs, plates, street addresses, postal codes, cities, URLs, card digits and
 *   free-text notes are replaced. Any string anywhere that looks like an email, a phone number or a VIN
 *   is replaced too, so a phone typed into a note or a custom field doesn't slip through.
 * - Every original value that was replaced is collected, so the caller can prove none of them is left
 *   anywhere in the output before writing it (`findLeaks`).
 *
 * The salt must be secret (ANONYMIZE_SALT, never committed): with a known salt, someone holding a guess
 * of a real phone number could check it against the fake.
 */
import { createHmac } from 'node:crypto'

/** Every fixture VIN starts with this, so a reviewer can tell a fake from a real one at a glance. */
export const FAKE_VIN_PREFIX = 'TVFX'
/** Fake phones are in the 555-0100–0199 range reserved for fiction. */
export const FAKE_PHONE_PATTERN = /^\+1202555 ?01\d\d$/
export const FAKE_EMAIL_DOMAIN = 'example.test'

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
  'secret',
])
/** VIN characters (no I, O or Q). */
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'

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
  | 'cardDigits'
  | 'secret'

/** Key name (lowercased) → what it holds. Context-free keys only; `name` is decided per table. */
const KEY_KINDS: Record<string, Kind> = {
  firstname: 'firstName',
  middlename: 'firstName',
  lastname: 'lastName',
  fullname: 'fullName',
  displayname: 'fullName',
  contactname: 'fullName',
  ownername: 'fullName',
  customername: 'fullName',
  technicianname: 'fullName',
  servicewritername: 'fullName',
  signername: 'fullName',
  signedby: 'fullName',
  companyname: 'companyName',
  email: 'email',
  emailaddress: 'email',
  phone: 'phone',
  phonenumber: 'phone',
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
  note: 'note',
  notes: 'note',
  internalnote: 'note',
  customernote: 'note',
  comment: 'note',
  comments: 'note',
  complaint: 'note',
  recommendation: 'note',
  deferredreason: 'note',
  declinedreason: 'note',
  message: 'note',
  body: 'note',
  text: 'note',
  signature: 'url',
  cardlast4: 'cardDigits',
  carddigits: 'cardDigits',
  last4: 'cardDigits',
  checknumber: 'cardDigits',
  token: 'secret',
  accesstoken: 'secret',
  password: 'secret',
  secret: 'secret',
  apikey: 'secret',
}

/** Tables whose `name` (and `coalescedName` / `generatedName`) is a person's or a business's name. */
const NAMED_TABLES = new Set([
  'customer',
  'user',
  'vendor',
  'location',
  'company',
  'fleet',
  'contact',
])
/** Order-like tables whose generated names are built from the customer and vehicle. */
const GENERATED_NAME_TABLES = new Set(['order'])

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// North American and international phone shapes with at least 10 digits.
const PHONE_RE = /(?<![\w-])\+?\d{0,3}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g

export interface Anonymizer {
  /** Anonymizes one record of `table`. Returns a new object; the input is untouched. */
  record(table: string, value: unknown): unknown
  /** Every original string that was replaced, for the leak check. */
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
  /** Only identifiers are collected: a replaced note like "Oil change" is no leak when a service has that name. */
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
        return `+1202555${String(100 + (h.readUInt16BE(0) % 100)).padStart(4, '0')}`
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
      case 'cardDigits':
        return String(h.readUInt16BE(0) % 10000).padStart(4, '0')
      case 'secret':
        return 'REDACTED'
    }
  }

  function replace(kind: Kind, value: unknown): unknown {
    if (
      typeof value === 'number' &&
      (kind === 'phone' || kind === 'cardDigits' || kind === 'postalCode')
    ) {
      return replace(kind, String(value))
    }
    if (typeof value !== 'string' || value.trim() === '') return value
    remember(kind, value)
    return fake(kind, value)
  }

  /** Free text that wasn't classified by key: scrub anything that looks like contact data or a VIN. */
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

  function kindFor(table: string, key: string, parentKey: string | null): Kind | null {
    const k = key.toLowerCase()
    if (k === 'name' || k === 'coalescedname' || k === 'generatedname') {
      if (NAMED_TABLES.has(table) && parentKey === null)
        return table === 'customer' || table === 'user' ? 'fullName' : 'companyName'
      if (GENERATED_NAME_TABLES.has(table) && parentKey === null && k !== 'name') return 'note'
      return null
    }
    // A `number` inside a phone list, an `address` inside an emails list.
    if (k === 'number' && parentKey && /phone/i.test(parentKey)) return 'phone'
    if (/url$/i.test(key) && !/^(base|api)url$/i.test(key)) return 'url'
    return KEY_KINDS[k] ?? null
  }

  function walk(table: string, value: unknown, parentKey: string | null): unknown {
    if (Array.isArray(value)) return value.map((v) => walk(table, v, parentKey))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (isIdKey(key)) {
          out[key] = child
          continue
        }
        const kind = kindFor(table, key, parentKey)
        if (kind && (typeof child === 'string' || typeof child === 'number'))
          out[key] = replace(kind, child)
        else if (kind && Array.isArray(child) && child.every((c) => typeof c === 'string')) {
          out[key] = child.map((c) => replace(kind, c))
        } else out[key] = walk(table, child, key)
      }
      return out
    }
    if (typeof value === 'string') return scrub(value)
    return value
  }

  return {
    record: (table, value) => walk(table.toLowerCase(), value, null),
    originals: () => replaced,
  }
}

function isIdKey(key: string): boolean {
  return key === 'id' || /Ids?$/.test(key) || key === '_id'
}

function extensionOf(url: string): string {
  const m = url.split('?')[0].match(/\.(jpe?g|png|gif|webp|heic|pdf)$/i)
  return m ? `.${m[1].toLowerCase()}` : ''
}

/**
 * Original values still present in the serialized output (whole words, case-insensitive), plus any
 * deny-listed string (the shop's name, a surname you know is in the data). Empty means safe to write.
 * `allowList` names originals that are known false positives (a customer whose surname is "Brake").
 */
export function findLeaks(
  serialized: string,
  originals: Iterable<string>,
  denyList: Iterable<string> = [],
  allowList: Iterable<string> = []
): string[] {
  const allowed = new Set([...allowList].map((v) => v.trim().toLowerCase()))
  const leaks: string[] = []
  for (const value of new Set([...originals, ...denyList])) {
    const needle = value.trim()
    if (needle.length < 4 || allowed.has(needle.toLowerCase())) continue
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, 'i').test(serialized))
      leaks.push(value)
  }
  return leaks
}
