/**
 * Builds the SYNTHETIC Shopmonkey fixtures in
 * src/__tests__/features/integrations/fixtures/shopmonkey/synthetic/.
 *
 *   npx tsx scripts/shopmonkey/build-synthetic-fixtures.ts
 *
 * Synthetic means invented, not recorded: no Shopmonkey API key was available in M0 (blocker B1 in
 * docs/fork/PROGRESS.md). Field names and enums follow Shopmonkey's published schemas
 * (https://shopmonkey.dev/schema/<Table>); every value is made up. Replace these with recorded,
 * anonymized fixtures (scripts/shopmonkey/spike.ts → anonymize-fixtures.ts) as soon as a key exists.
 *
 * Money is generated, not typed, so every total agrees with its lines under ONE stated formula
 * (`lineTotal`, `rollUpService`, `rollUpOrder` below). PROVISIONAL(M0:S5): the formula is our reading of
 * the schema (lines carry hours, rate, multiplier, quantity and discount but no total; services carry
 * calculated*Cents; orders carry per-category cents and totalCostCents). Confirm it against recorded
 * orders before trusting the importer's money assertions.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const OUT = 'src/__tests__/features/integrations/fixtures/shopmonkey/synthetic'
const COMPANY = 'syn_com_1'
const LOCATION = 'syn_loc_1'
const TAX_PERCENT = 8.25

type Rec = Record<string, unknown>

const base = (id: string, createdDate: string, extra: Rec = {}): Rec => ({
  id,
  companyId: COMPANY,
  locationId: LOCATION,
  createdDate,
  updatedDate: createdDate,
  metadata: null,
  ...extra,
})

// ─── Money (PROVISIONAL(M0:S5)) ────────────────────────────────────────────────────────────────────

interface LaborIn {
  id: string
  name: string
  hours: number
  rateCents: number
  multiplier?: number
  discountCents?: number
  technicianId?: string | null
  completed?: boolean
  taxable?: boolean
  note?: string
  costHours?: number | null
  costRateCents?: number | null
  rateId?: string | null
}
interface PartIn {
  id: string
  name: string
  quantity: number
  retailCostCents: number
  wholesaleCostCents?: number | null
  discountCents?: number
  partNumber?: string | null
  sku?: string | null
  inventoryPartId?: string | null
  vendorId?: string | null
  binLocation?: string
  taxable?: boolean
  note?: string
}
interface TireIn extends PartIn {
  size: string
  inventoryTireId?: string | null
  tireIdentificationNumbers?: string[]
}
interface SubcontractIn {
  id: string
  name: string
  costCents: number
  retailCostCents: number
  discountCents?: number
  vendorId?: string | null
  taxable?: boolean
  note?: string | null
}
interface FeeIn {
  id: string
  name: string
  feeType: 'FixedCents' | 'PercentService' | 'PercentLineItem'
  amountCents?: number
  percent?: number
}
interface ServiceIn {
  id: string
  name: string
  ordinal: number
  authorizationStatus: 'NotAuthorized' | 'Authorized' | 'Declined'
  recommended?: boolean
  hidden?: boolean
  deferredDate?: string | null
  deferredReason?: 'Archived' | 'Declined' | 'InvoicedNotAuthorized' | null
  revivedFromId?: string | null
  note?: string
  epaCents?: number
  shopSuppliesCents?: number
  labors?: LaborIn[]
  parts?: PartIn[]
  tires?: TireIn[]
  subcontracts?: SubcontractIn[]
  fees?: FeeIn[]
}

/** A line's total in cents: gross minus its discount. PROVISIONAL(M0:S5). */
function lineTotal(
  kind: 'labor' | 'part' | 'tire' | 'subcontract',
  line: LaborIn | PartIn | SubcontractIn
): number {
  const discount = (line as { discountCents?: number }).discountCents ?? 0
  if (kind === 'labor') {
    const l = line as LaborIn
    return Math.round(l.hours * l.rateCents * (l.multiplier ?? 1)) - discount
  }
  if (kind === 'subcontract') return (line as SubcontractIn).retailCostCents - discount
  const p = line as PartIn
  return Math.round(p.quantity * p.retailCostCents) - discount
}

function rollUpService(orderId: string, s: ServiceIn, createdDate: string): Rec {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const labors = (s.labors ?? []).map((l) => ({ l, total: lineTotal('labor', l) }))
  const parts = (s.parts ?? []).map((p) => ({ p, total: lineTotal('part', p) }))
  const tires = (s.tires ?? []).map((t) => ({ t, total: lineTotal('tire', t) }))
  const subs = (s.subcontracts ?? []).map((c) => ({ c, total: lineTotal('subcontract', c) }))
  const laborCents = sum(labors.map((x) => x.total))
  const partsCents = sum(parts.map((x) => x.total))
  const tiresCents = sum(tires.map((x) => x.total))
  const subcontractsCents = sum(subs.map((x) => x.total))
  const lineBase = laborCents + partsCents + tiresCents + subcontractsCents
  const fees = (s.fees ?? []).map((f) => ({
    f,
    total:
      f.feeType === 'FixedCents'
        ? (f.amountCents ?? 0)
        : Math.round((lineBase * (f.percent ?? 0)) / 100),
  }))
  const feeCents = sum(fees.map((x) => x.total))
  const epaCents = s.epaCents ?? 0
  const shopSuppliesCents = s.shopSuppliesCents ?? 0
  const taxableBase = sum([
    ...labors.filter((x) => x.l.taxable !== false).map((x) => x.total),
    ...parts.filter((x) => x.p.taxable !== false).map((x) => x.total),
    ...tires.filter((x) => x.t.taxable !== false).map((x) => x.total),
    ...subs.filter((x) => x.c.taxable === true).map((x) => x.total),
  ])
  const taxCents = Math.round((taxableBase * TAX_PERCENT) / 100)
  const totalCents = lineBase + feeCents + epaCents + shopSuppliesCents + taxCents
  const taxFlags = (taxable: boolean) => ({
    taxable,
    taxableGST: false,
    taxableHST: false,
    taxablePST: false,
  })

  return base(s.id, createdDate, {
    orderId,
    name: s.name,
    note: s.note ?? '',
    ordinal: s.ordinal,
    authorizationStatus: s.authorizationStatus,
    recommended: s.recommended ?? false,
    hidden: s.hidden ?? false,
    lumpSum: false,
    pricing: 'LineItem',
    fixedPriceCents: 0,
    deferredDate: s.deferredDate ?? null,
    deferredReason: s.deferredReason ?? null,
    excludedFromDeferred: false,
    revived: Boolean(s.revivedFromId),
    revivedFromId: s.revivedFromId ?? null,
    sourceServiceId: null,
    categoryId: null,
    hideLineItemPricing: false,
    lineItemOrder: 'Labor',
    lineItemInventoryStatus: 'None',
    discountCents: 0,
    discountPercent: 0,
    discountValueType: 'FixedCents',
    epaCents,
    epaPercent: 0,
    epaValueType: 'FixedCents',
    shopSuppliesApplied: shopSuppliesCents > 0,
    shopSuppliesCents,
    shopSuppliesPercent: 0,
    shopSuppliesValueType: 'FixedCents',
    taxCents: 0,
    taxPercent: TAX_PERCENT,
    taxValueType: 'Percent',
    gstCents: 0,
    gstPercent: 0,
    gstValueType: 'Percent',
    pstCents: 0,
    pstPercent: 0,
    pstValueType: 'Percent',
    hstCents: 0,
    hstPercent: 0,
    hstValueType: 'Percent',
    calculatedLaborCents: laborCents,
    calculatedPartsCents: partsCents,
    calculatedTiresCents: tiresCents,
    calculatedSubcontractsCents: subcontractsCents,
    calculatedFeeCents: feeCents,
    calculatedEpaCents: epaCents,
    calculatedShopSuppliesCents: shopSuppliesCents,
    calculatedDiscountCents: 0,
    calculatedDiscountPercent: 0,
    calculatedTaxCents: taxCents,
    calculatedGSTCents: 0,
    calculatedPSTCents: 0,
    calculatedHSTCents: 0,
    totalCents,
    labors: labors.map(({ l }, ordinal) =>
      base(l.id, createdDate, {
        orderId,
        serviceId: s.id,
        ordinal,
        name: l.name,
        note: l.note ?? '',
        hours: l.hours,
        rateCents: l.rateCents,
        rateId: l.rateId ?? 'syn_rate_1',
        multiplier: l.multiplier ?? 1,
        multiplierType: 'Hours',
        discountCents: l.discountCents ?? 0,
        discountPercent: 0,
        discountValueType: 'FixedCents',
        technicianId: l.technicianId ?? null,
        completed: l.completed ?? false,
        completedDate: l.completed ? createdDate : null,
        costHours: l.costHours ?? null,
        costRateCents: l.costRateCents ?? null,
        costTotalCents:
          l.costHours != null && l.costRateCents != null
            ? Math.round(l.costHours * l.costRateCents)
            : null,
        showHours: true,
        showNote: true,
        skillRequired: null,
        categoryId: null,
        inventoryLaborId: null,
        labels: {},
        ...taxFlags(l.taxable !== false),
      })
    ),
    parts: parts.map(({ p }, ordinal) =>
      base(p.id, createdDate, {
        orderId,
        serviceId: s.id,
        ordinal,
        name: p.name,
        note: p.note ?? '',
        partNumber: p.partNumber ?? null,
        sku: p.sku ?? null,
        quantity: p.quantity,
        retailCostCents: p.retailCostCents,
        wholesaleCostCents: p.wholesaleCostCents ?? null,
        discountCents: p.discountCents ?? 0,
        discountPercent: 0,
        discountValueType: 'FixedCents',
        inventoryPartId: p.inventoryPartId ?? null,
        vendorId: p.vendorId ?? null,
        binLocation: p.binLocation ?? '',
        reserved: false,
        inventoryStatus: p.inventoryPartId ? 'InventoryReduced' : 'None',
        purchaseStatus: null,
        reduceInventoryCount: Boolean(p.inventoryPartId),
        showCostAndQuantity: true,
        showNote: true,
        showPartNumber: true,
        categoryId: null,
        labels: {},
        ...taxFlags(p.taxable !== false),
      })
    ),
    tires: tires.map(({ t }, ordinal) =>
      base(t.id, createdDate, {
        orderId,
        serviceId: s.id,
        ordinal,
        name: t.name,
        calculatedName: t.name,
        generatedBrandName: 'Synthetic',
        generatedModelName: 'All Season',
        note: t.note ?? null,
        size: t.size,
        sizeFormat: 'Conventional',
        partNumber: t.partNumber ?? null,
        sku: t.sku ?? null,
        quantity: t.quantity,
        retailCostCents: t.retailCostCents,
        wholesaleCostCents: t.wholesaleCostCents ?? null,
        discountCents: t.discountCents ?? 0,
        discountPercent: 0,
        discountValueType: 'FixedCents',
        federalExciseTaxCents: 0,
        wasteTireFee: 0,
        tireIdentificationNumbers: t.tireIdentificationNumbers ?? [],
        inventoryTireId: t.inventoryTireId ?? null,
        tireModelId: 'syn_tmod_1',
        binLocation: null,
        reserved: false,
        inventoryStatus: 'None',
        purchaseStatus: null,
        reduceInventoryCount: false,
        showNote: true,
        showPartNumber: true,
        showPriceAndQuantity: true,
        labels: {},
        ...taxFlags(t.taxable !== false),
      })
    ),
    subcontracts: subs.map(({ c }, ordinal) =>
      base(c.id, createdDate, {
        orderId,
        serviceId: s.id,
        ordinal,
        name: c.name,
        note: c.note ?? null,
        costCents: c.costCents,
        retailCostCents: c.retailCostCents,
        discountCents: c.discountCents ?? 0,
        discountPercent: 0,
        discountValueType: 'FixedCents',
        vendorId: c.vendorId ?? null,
        showNote: true,
        categoryId: null,
        labels: {},
        ...taxFlags(c.taxable === true),
      })
    ),
    fees: fees.map(({ f, total }, ordinal) =>
      base(f.id, createdDate, {
        orderId,
        serviceId: s.id,
        ordinal,
        name: f.name,
        feeType: f.feeType,
        amountCents: f.feeType === 'FixedCents' ? (f.amountCents ?? 0) : total,
        percent: f.percent ?? 0,
        subtotalCents: f.feeType === 'FixedCents' ? null : lineBase,
        lineItemEntity: null,
        laborId: null,
        partId: null,
        tireId: null,
        subcontractId: null,
        inventoryFeeId: null,
        categoryId: null,
        labels: {},
      })
    ),
  })
}

/** Whether a service counts toward its order's totals. PROVISIONAL(M0:S5), MAPPING §6.3. */
function countsTowardTotals(service: {
  authorizationStatus: string
  deferredDate?: unknown
}): boolean {
  return service.authorizationStatus !== 'Declined' && !service.deferredDate
}

interface PaymentIn {
  id: string
  amountCents: number
  transactionType: 'Charge' | 'Refund'
  paymentType: string
  status: 'Succeeded' | 'Failed' | 'Pending'
  recordedDate: string
  deposit?: boolean
  note?: string
  checkNumber?: string | null
  cardDigits?: string | null
  refundReason?: string | null
  chargeId?: string | null
  /** On a charge that was later refunded: Shopmonkey's own refund summary (MAPPING §6.5). */
  refundedAmountCents?: number | null
}

function rollUpOrder(
  order: Rec,
  services: Rec[],
  payments: PaymentIn[],
  orderDiscountCents = 0
): Rec {
  const counted = services.filter((s) =>
    countsTowardTotals(s as { authorizationStatus: string; deferredDate?: unknown })
  )
  const sum = (key: string) => counted.reduce((a, s) => a + (s[key] as number), 0)
  const laborCents = sum('calculatedLaborCents')
  const partsCents = sum('calculatedPartsCents')
  const tiresCents = sum('calculatedTiresCents')
  const subcontractsCents = sum('calculatedSubcontractsCents')
  const feesCents = sum('calculatedFeeCents')
  const epaCents = sum('calculatedEpaCents')
  const shopSuppliesCents = sum('calculatedShopSuppliesCents')
  const taxCents = sum('calculatedTaxCents')
  const subtotal =
    laborCents +
    partsCents +
    tiresCents +
    subcontractsCents +
    feesCents +
    epaCents +
    shopSuppliesCents
  // PROVISIONAL(M0:S5): the order-level discount comes off after tax here.
  const totalCostCents = subtotal - orderDiscountCents + taxCents
  // PROVISIONAL(M0:S5): refunds carry a negative amountCents (error PAYM-101beb: "Refunded amount must
  // be a negative value"), so the amount paid is the plain signed sum of succeeded transactions.
  const paidCostCents = payments
    .filter((p) => p.status === 'Succeeded')
    .reduce((a, p) => a + p.amountCents, 0)
  const remainingCostCents = totalCostCents - paidCostCents
  return {
    ...order,
    laborCents,
    partsCents,
    tiresCents,
    subcontractsCents,
    feesCents,
    epaCents,
    shopSuppliesCents,
    taxCents,
    gstCents: 0,
    pstCents: 0,
    hstCents: 0,
    discountCents: orderDiscountCents,
    totalCostCents,
    paidCostCents,
    remainingCostCents,
    hasPayments: payments.length > 0,
    paid: order.status === 'Invoice' && remainingCostCents <= 0,
  }
}

// ─── Records ───────────────────────────────────────────────────────────────────────────────────────

const location = [
  base(LOCATION, '2019-01-02T15:00:00.000Z', {
    name: 'Synthetic Auto Works',
    address1: '100 Example Way',
    address2: null,
    city: 'Springfield',
    state: 'TX',
    postalCode: '90001',
    country: 'US',
    timezone: 'America/Chicago',
    phone: '+12025550100',
    email: 'shop@example.test',
    website: null,
    archived: false,
    deleted: false,
    latitude: 0,
    longitude: 0,
  }),
]
const company = [
  { id: COMPANY, name: 'Synthetic Auto Works', createdDate: '2019-01-02T15:00:00.000Z' },
]

const taxConfig = [
  base('syn_tax_1', '2019-01-02T15:00:00.000Z', {
    taxSystem: 'US',
    taxPercent: TAX_PERCENT,
    gstPercent: 0,
    pstPercent: 0,
    hstPercent: 0,
    laborTaxable: true,
    partTaxable: true,
    subcontractTaxable: false,
    epaTaxable: false,
    shopSuppliesTaxable: false,
    laborTaxableGST: false,
    laborTaxableHST: false,
    laborTaxablePST: false,
    partTaxableGST: false,
    partTaxableHST: false,
    partTaxablePST: false,
    epaPercent: 0,
    includeEpaOnLabor: false,
    includeEpaOnParts: false,
    laborShopSupplies: false,
    partShopSupplies: false,
    shopSuppliesConfig: 'NoCap',
    shopSuppliesMaxCapCents: 0,
    applyServiceDiscountToTaxableItemsFirst: false,
    priceCalculatorVersion: 2,
    rateId: null,
    hash: 'syn',
    version: 1,
  }),
]

const laborRate = [
  base('syn_rate_1', '2019-01-02T15:00:00.000Z', {
    name: 'Standard',
    valueCents: 14000,
    flatRate: false,
    isEmployeeRate: false,
    deleted: false,
  }),
  base('syn_rate_2', '2019-01-02T15:00:00.000Z', {
    name: 'Diagnostic',
    valueCents: 16000,
    flatRate: false,
    isEmployeeRate: false,
    deleted: false,
  }),
]

const wf = (id: string, name: string, position: number, ro: boolean) =>
  base(id, '2019-01-02T15:00:00.000Z', {
    name,
    position,
    repairOrderWorkflow: ro,
    invoiceWorkflow: !ro,
    archiveWhenInactive: false,
    archiveWhenPaid: !ro,
    daysToArchive: 0,
    inactiveOrderWarningThreshold: null,
  })
const workflowStatus = [
  wf('syn_wfs_1', 'Waiting for approval', 0, true),
  wf('syn_wfs_2', 'In progress', 1, true),
  wf('syn_wfs_3', 'Waiting on parts', 2, true),
  wf('syn_wfs_4', 'Ready for pickup', 3, true),
  wf('syn_wfs_5', 'Invoiced', 0, false),
  wf('syn_wfs_6', 'Paid', 1, false),
]

const user = (id: string, firstName: string, lastName: string, tech: boolean, writer: boolean) => ({
  id,
  companyIds: [COMPANY],
  locationIds: [LOCATION],
  createdDate: '2019-01-02T15:00:00.000Z',
  updatedDate: '2019-01-02T15:00:00.000Z',
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@example.test`,
  phone: null,
  active: true,
  assignedTechnician: tech,
  assignedServiceWriter: writer,
  canTrackTime: tech,
  color: 'blue',
  roleIds: [],
  laborRateId: null,
  customFields: null,
})
const users = [
  user('syn_usr_1', 'Avery', 'Ashford', true, false),
  user('syn_usr_2', 'Blake', 'Brightwater', true, false),
  user('syn_usr_3', 'Casey', 'Coldridge', false, true),
]

const referralSource = [
  base('syn_ref_1', '2019-01-02T15:00:00.000Z', {
    name: 'Search engine',
    editable: true,
    reserved: false,
  }),
]

const customer = (id: string, created: string, extra: Rec) =>
  base(id, created, {
    locationIds: [LOCATION],
    firstName: null,
    lastName: null,
    companyName: null,
    address1: null,
    address2: null,
    city: null,
    state: null,
    postalCode: null,
    country: 'US',
    note: '',
    customerType: 'Customer',
    taxExempt: false,
    gstExempt: false,
    pstExempt: false,
    hstExempt: false,
    preferredContactMethod: null,
    preferredLanguage: 'en',
    labels: {},
    customFields: null,
    referralSourceId: null,
    deleted: false,
    deletedDate: null,
    deletedReason: null,
    discountPercent: 0,
    externalId: null,
    fleetId: null,
    website: null,
    ...extra,
  })
const customersBare = [
  customer('syn_cus_1', '2020-05-04T16:30:00.000Z', {
    publicId: '1001',
    firstName: 'Dana',
    lastName: 'Dunmore',
    address1: '12 Maple St',
    address2: 'Apt 4',
    city: 'Riverton',
    state: 'TX',
    postalCode: '90012',
    note: 'Prefers text messages.',
    preferredContactMethod: 'SMS',
    referralSourceId: 'syn_ref_1',
    labels: { syn_lbl_1: 'VIP' },
    customFields: { syn_cf_1: 'Blue sedan owner club' },
  }),
  customer('syn_cus_2', '2021-02-11T14:00:00.000Z', {
    publicId: '1002',
    firstName: 'Elliot',
    lastName: 'Elmsworth',
    companyName: 'Fairbank Logistics',
    customerType: 'Fleet',
    address1: '400 Cedar Ave',
    city: 'Lakeside',
    state: 'TX',
    postalCode: '90020',
    preferredContactMethod: 'Email',
  }),
  customer('syn_cus_3', '2021-06-01T10:00:00.000Z', {
    publicId: '1003',
    firstName: 'Finley',
    lastName: 'Fairbank',
    deleted: true,
    deletedDate: '2023-01-05T10:00:00.000Z',
    deletedReason: 'Duplicate',
  }),
  customer('syn_cus_4', '2022-08-19T18:45:00.000Z', {
    publicId: 'C-17',
    companyName: 'Glenhollow Rentals',
    taxExempt: true,
    address1: '9 Birch Rd',
    city: 'Fairview',
    state: 'TX',
    postalCode: '90044',
  }),
]

// Every customer read embeds its contacts as emails[] and phoneNumbers[] (shopmonkey.dev, Customer).
const email = (
  id: string,
  customerId: string,
  addr: string,
  primary: boolean,
  marketingOptIn: boolean,
  created: string
) =>
  base(id, created, {
    customerId,
    email: addr,
    primary,
    marketingOptIn,
    subscribed: marketingOptIn,
  })
const customerEmail = [
  email(
    'syn_eml_1',
    'syn_cus_1',
    'dana.dunmore@example.test',
    true,
    true,
    '2020-05-04T16:30:00.000Z'
  ),
  email(
    'syn_eml_2',
    'syn_cus_1',
    'dana.work@example.test',
    false,
    false,
    '2022-01-10T09:00:00.000Z'
  ),
  email('syn_eml_3', 'syn_cus_2', 'fleet@example.test', true, false, '2021-02-11T14:00:00.000Z'),
  email('syn_eml_4', 'syn_cus_4', 'office@example.test', true, false, '2022-08-19T18:45:00.000Z'),
]
const phone = (
  id: string,
  customerId: string,
  number: string,
  type: string,
  primary: boolean,
  created: string
) =>
  base(id, created, {
    customerId,
    number,
    type,
    primary,
    extension: null,
    country: 'US',
    userDefinedType: null,
  })
const customerPhone = [
  phone('syn_phn_1', 'syn_cus_1', '+12025550101', 'Mobile', true, '2020-05-04T16:30:00.000Z'),
  phone('syn_phn_2', 'syn_cus_1', '+12025550102', 'Landline', false, '2021-03-03T12:00:00.000Z'),
  phone('syn_phn_3', 'syn_cus_2', '+12025550103', 'Mobile', true, '2021-02-11T14:00:00.000Z'),
]

const customers = customersBare.map((c) => ({
  ...c,
  emails: customerEmail.filter((e) => e.customerId === c.id),
  phoneNumbers: customerPhone.filter((p) => p.customerId === c.id),
}))

const vehicle = (id: string, created: string, extra: Rec) =>
  base(id, created, {
    locationIds: [LOCATION],
    year: null,
    make: null,
    model: null,
    submodel: null,
    vin: null,
    hin: null,
    coalescedVINorHIN: null,
    licensePlate: null,
    licensePlateState: null,
    licensePlateCountry: 'US',
    color: null,
    engine: null,
    transmission: null,
    drivetrain: null,
    type: null,
    unit: null,
    mileage: null,
    mileageUnit: 'Mile',
    note: '',
    labels: {},
    customFields: null,
    deleted: false,
    deletedDate: null,
    name: null,
    ...extra,
  })
const vehicles = [
  vehicle('syn_veh_1', '2020-05-04T16:40:00.000Z', {
    year: 2018,
    make: 'Honda',
    model: 'Civic',
    submodel: 'EX',
    vin: 'TVFX0SYN000000001',
    coalescedVINorHIN: 'TVFX0SYN000000001',
    licensePlate: 'fx-1001',
    licensePlateState: 'TX',
    color: 'Blue',
    engine: '2.0L I4',
    transmission: 'AutomaticCVT',
    drivetrain: 'FWD',
    type: 'Car',
    mileage: 84250,
    note: 'Customer prefers synthetic oil.',
  }),
  vehicle('syn_veh_2', '2021-02-11T14:10:00.000Z', {
    year: 2021,
    make: 'Ford',
    model: 'Transit 250',
    vin: 'TVFX0SYN000000002',
    coalescedVINorHIN: 'TVFX0SYN000000002',
    licensePlate: 'FX2002',
    licensePlateState: 'TX',
    color: 'White',
    transmission: 'Automatic',
    drivetrain: 'RWD',
    type: 'Van',
    unit: 'T-12',
    mileage: 41230,
  }),
  vehicle('syn_veh_3', '2020-09-09T09:00:00.000Z', { licensePlate: 'FX3003', mileage: 120001 }),
]
const vehicleOwner = [
  {
    id: 'syn_vow_1',
    companyId: COMPANY,
    vehicleId: 'syn_veh_1',
    customerId: 'syn_cus_1',
    createdDate: '2020-05-04T16:40:00.000Z',
    updatedDate: null,
    metadata: null,
  },
  {
    id: 'syn_vow_2',
    companyId: COMPANY,
    vehicleId: 'syn_veh_2',
    customerId: 'syn_cus_2',
    createdDate: '2021-02-11T14:10:00.000Z',
    updatedDate: null,
    metadata: null,
  },
  // PROVISIONAL(M0:S4): a vehicle with an earlier and a later owner. The importer takes the most
  // recently created owner as current until a recorded fixture shows how ownership changes look.
  {
    id: 'syn_vow_3',
    companyId: COMPANY,
    vehicleId: 'syn_veh_3',
    customerId: 'syn_cus_1',
    createdDate: '2020-09-09T09:00:00.000Z',
    updatedDate: null,
    metadata: null,
  },
  {
    id: 'syn_vow_4',
    companyId: COMPANY,
    vehicleId: 'syn_veh_3',
    customerId: 'syn_cus_4',
    createdDate: '2024-04-01T09:00:00.000Z',
    updatedDate: null,
    metadata: null,
  },
]

const inventoryCategory = [
  base('syn_cat_1', '2019-01-02T15:00:00.000Z', {
    name: 'Brakes',
    parentId: null,
    parentName: '',
    deleted: false,
  }),
  base('syn_cat_2', '2019-01-02T15:00:00.000Z', {
    name: 'Filters',
    parentId: null,
    parentName: '',
    deleted: false,
  }),
]
const vendor = [
  base('syn_ven_1', '2019-01-02T15:00:00.000Z', {
    name: 'Westbrook Parts Supply',
    accountNumber: 'ACCT-9',
    contactFirstName: 'Gray',
    contactLastName: 'Glenhollow',
    contactEmail: 'orders@example.test',
    contactPhone: { number: '+12025550104' },
    address1: '1 Industrial Ct',
    city: 'Brookfield',
    state: 'TX',
    postalCode: '90055',
    country: 'US',
    url: 'https://vendor.example.test',
    deleted: false,
  }),
]
const inventoryPart = [
  base('syn_inv_1', '2019-03-01T12:00:00.000Z', {
    name: 'Ceramic brake pads (front)',
    number: 'BP-1234',
    sku: 'BP1234',
    note: null,
    quantity: 6,
    availableQuantity: 6,
    reservedQuantity: 0,
    minCriticalQuantity: 2,
    maxCriticalQuantity: null,
    reorderQuantity: 4,
    retailCostCents: 8999,
    wholesaleCostCents: 4200,
    binLocation: 'A3',
    categoryId: 'syn_cat_1',
    vendorId: 'syn_ven_1',
    taxable: true,
    deleted: false,
  }),
  base('syn_inv_2', '2019-03-01T12:00:00.000Z', {
    name: 'Oil filter',
    number: 'OF-77',
    sku: 'OF77',
    note: null,
    quantity: 24,
    availableQuantity: 24,
    reservedQuantity: 0,
    minCriticalQuantity: 6,
    maxCriticalQuantity: null,
    reorderQuantity: 12,
    retailCostCents: 1299,
    wholesaleCostCents: 450,
    binLocation: 'B1',
    categoryId: 'syn_cat_2',
    vendorId: 'syn_ven_1',
    taxable: true,
    deleted: false,
  }),
]
const inventoryTire = [
  base('syn_itr_1', '2019-03-01T12:00:00.000Z', {
    name: 'All-season 225/45R17',
    size: '225/45R17',
    sizeFormat: 'Conventional',
    partNumber: 'AS-2254517',
    sku: 'AS2254517',
    tireModelId: 'syn_tmod_1',
    quantity: 8,
    availableQuantity: 8,
    reservedQuantity: 0,
    minCriticalQuantity: 4,
    reorderQuantity: 4,
    retailCostCents: 13500,
    wholesaleCostCents: 9000,
    federalExciseTaxCents: 0,
    wasteTireFeeCents: 300,
    discountCents: 0,
    taxable: true,
    deleted: false,
  }),
]

const cannedLabor = {
  id: 'syn_cnl_1',
  name: 'Replace front brake pads',
  hours: 1.5,
  rateCents: 14000,
}
const cannedService = [
  base('syn_can_1', '2019-04-01T12:00:00.000Z', {
    name: 'Front brake service',
    note: 'Pads, cleaner and a road test.',
    publicId: '1',
    lumpSum: false,
    pricing: 'LineItem',
    recommended: false,
    bookable: true,
    deleted: false,
    labors: [
      {
        ...cannedLabor,
        cannedServiceId: 'syn_can_1',
        multiplier: 1,
        discountCents: 0,
        taxable: true,
        ordinal: 0,
        note: '',
      },
    ],
    parts: [
      {
        id: 'syn_cnp_1',
        cannedServiceId: 'syn_can_1',
        name: 'Ceramic brake pads (front)',
        inventoryPartId: 'syn_inv_1',
        quantity: 1,
        retailCostCents: 8999,
        wholesaleCostCents: 4200,
        discountCents: 0,
        taxable: true,
        ordinal: 0,
        note: '',
      },
    ],
    fees: [
      {
        id: 'syn_cnf_1',
        cannedServiceId: 'syn_can_1',
        name: 'Brake cleaner',
        feeType: 'FixedCents',
        amountCents: 500,
        percent: 0,
        ordinal: 0,
      },
    ],
    tires: [],
    subcontracts: [],
  }),
]

// Orders. Every number is generated from the lines by rollUpService / rollUpOrder.
const order = (id: string, created: string, extra: Rec): Rec =>
  base(id, created, {
    orderCreatedDate: created,
    repairOrderDate: null,
    name: null,
    coalescedName: null,
    generatedName: null,
    complaint: null,
    recommendation: null,
    status: 'Estimate',
    workflowStatusId: null,
    workflowStatusDate: created,
    workflowStatusPosition: null,
    authorized: false,
    authorizedDate: null,
    completedDate: null,
    invoiced: false,
    invoicedDate: null,
    messagedDate: null,
    dueDate: null,
    paymentDueDate: null,
    fullyPaidDate: null,
    mileageIn: null,
    mileageOut: null,
    assignedTechnicianIds: [],
    serviceWriterId: null,
    purchaseOrderNumber: null,
    labels: {},
    customFields: null,
    archived: false,
    deleted: false,
    deletedDate: null,
    taxConfigId: 'syn_tax_1',
    appliedDiscountCents: 0,
    appliedDiscountPercent: 0,
    appliedDiscountValueType: 'FixedCents',
    discountPercent: 0,
    invoiceLockState: 'Unlocked',
    ...extra,
  })

const orders: Rec[] = []
const services: Rec[] = []
const payments: Rec[] = []
function addOrder(o: Rec, svcIn: ServiceIn[], pays: PaymentIn[] = [], orderDiscountCents = 0) {
  const svcs = svcIn.map((s) => rollUpService(o.id as string, s, o.createdDate as string))
  orders.push(rollUpOrder(o, svcs, pays, orderDiscountCents))
  services.push(...svcs)
  for (const p of pays) {
    payments.push(
      base(p.id, p.recordedDate, {
        orderId: o.id,
        amountCents: p.amountCents,
        transactionType: p.transactionType,
        paymentType: p.paymentType,
        paymentMode: 'Manual',
        provider: 'Manual',
        status: p.status,
        recordedDate: p.recordedDate,
        deposit: p.deposit ?? false,
        note: p.note ?? '',
        checkNumber: p.checkNumber ?? null,
        cardDigits: p.cardDigits ?? null,
        refundReason: p.refundReason ?? null,
        chargeId: p.chargeId ?? null,
        refunded: p.refundedAmountCents ? true : null,
        refundedAmountCents: p.refundedAmountCents ?? null,
        receiptNumber: payments.length + 1,
        statementId: null,
        bulkPaymentId: null,
      })
    )
  }
}

// O1: an estimate that was sent, not yet authorized → Quote, status "sent".
addOrder(
  order('syn_ord_1001', '2025-01-08T15:00:00.000Z', {
    number: '1001',
    publicId: 'syn-1001',
    customerId: 'syn_cus_1',
    vehicleId: 'syn_veh_1',
    generatedName: 'Front brake service',
    complaint: 'Squealing from the front when braking.',
    recommendation: 'Replace front pads.',
    messagedDate: '2025-01-08T16:00:00.000Z',
  }),
  [
    {
      id: 'syn_svc_1001_1',
      name: 'Front brake service',
      ordinal: 0,
      authorizationStatus: 'NotAuthorized',
      labors: [
        { id: 'syn_lab_1001_1', name: 'Replace front brake pads', hours: 1.5, rateCents: 14000 },
      ],
      parts: [
        {
          id: 'syn_prt_1001_1',
          name: 'Ceramic brake pads (front)',
          quantity: 1,
          retailCostCents: 8999,
          wholesaleCostCents: 4200,
          inventoryPartId: 'syn_inv_1',
          partNumber: 'BP-1234',
        },
      ],
    },
  ]
)

// O2: a repair order in progress, two technicians, a service writer, EPA, a pending recommendation.
addOrder(
  order('syn_ord_1002', '2025-02-03T14:00:00.000Z', {
    number: '1002',
    publicId: 'syn-1002',
    status: 'RepairOrder',
    repairOrderDate: '2025-02-03T14:30:00.000Z',
    customerId: 'syn_cus_2',
    vehicleId: 'syn_veh_2',
    name: 'Fleet service T-12',
    workflowStatusId: 'syn_wfs_3',
    workflowStatusDate: '2025-02-04T09:00:00.000Z',
    workflowStatusPosition: 2,
    authorized: true,
    authorizedDate: '2025-02-03T15:00:00.000Z',
    assignedTechnicianIds: ['syn_usr_2', 'syn_usr_1'],
    serviceWriterId: 'syn_usr_3',
    purchaseOrderNumber: 'PO-7781',
    mileageIn: 41230,
    labels: { syn_lbl_2: 'Fleet' },
  }),
  [
    {
      id: 'syn_svc_1002_1',
      name: 'Oil change',
      ordinal: 0,
      authorizationStatus: 'Authorized',
      epaCents: 300,
      labors: [
        {
          id: 'syn_lab_1002_1',
          name: 'Oil and filter change',
          hours: 0.5,
          rateCents: 14000,
          technicianId: 'syn_usr_2',
          completed: true,
          costHours: 0.5,
          costRateCents: 3500,
        },
      ],
      parts: [
        {
          id: 'syn_prt_1002_1',
          name: 'Oil filter',
          quantity: 1,
          retailCostCents: 1299,
          wholesaleCostCents: 450,
          inventoryPartId: 'syn_inv_2',
          partNumber: 'OF-77',
          binLocation: 'B1',
        },
        {
          id: 'syn_prt_1002_2',
          name: 'Synthetic oil 5W-30 (qt)',
          quantity: 7,
          retailCostCents: 899,
          wholesaleCostCents: 380,
        },
      ],
    },
    {
      id: 'syn_svc_1002_2',
      name: 'Cabin air filter',
      ordinal: 1,
      authorizationStatus: 'NotAuthorized',
      recommended: true,
      parts: [
        {
          id: 'syn_prt_1002_3',
          name: 'Cabin air filter',
          quantity: 1,
          retailCostCents: 3499,
          wholesaleCostCents: 1500,
        },
      ],
      labors: [
        { id: 'syn_lab_1002_2', name: 'Replace cabin filter', hours: 0.3, rateCents: 14000 },
      ],
    },
  ]
)

// O3: the complex invoice. Four services (one declined and deferred), a line discount, a fixed and a
// percent fee, shop supplies, tires, a sublet, a deposit, a partial payment, a refund and a failed
// charge, an inspection and timesheets against it.
addOrder(
  order('syn_ord_1003', '2025-03-10T15:00:00.000Z', {
    number: '1003',
    publicId: 'syn-1003',
    status: 'Invoice',
    repairOrderDate: '2025-03-10T15:30:00.000Z',
    customerId: 'syn_cus_1',
    vehicleId: 'syn_veh_1',
    coalescedName: 'Brakes, tires and alignment',
    complaint: 'Grinding noise and the car pulls to the right.',
    recommendation: 'Coolant is due; customer declined for now.',
    workflowStatusId: 'syn_wfs_5',
    workflowStatusDate: '2025-03-14T17:00:00.000Z',
    workflowStatusPosition: 0,
    authorized: true,
    authorizedDate: '2025-03-10T16:00:00.000Z',
    completedDate: '2025-03-14T16:30:00.000Z',
    invoiced: true,
    invoicedDate: '2025-03-14T17:05:00.000Z',
    messagedDate: '2025-03-14T17:06:00.000Z',
    paymentDueDate: '2025-04-13T05:00:00.000Z',
    mileageIn: 84250,
    mileageOut: 84262,
    assignedTechnicianIds: ['syn_usr_1', 'syn_usr_2'],
    serviceWriterId: 'syn_usr_3',
    customFields: { syn_cf_2: 'Loaner car given' },
    // Find Order embeds the order's files. PROVISIONAL(M0:S4): how `url` is downloaded.
    files: [
      {
        id: 'syn_ofl_1',
        fileName: 'alignment-printout.pdf',
        fileSize: 120455,
        fileType: 'application/pdf',
        thumbnailUrl: null,
        url: 'https://files.example.test/synthetic/alignment-printout.pdf',
      },
    ],
  }),
  [
    {
      id: 'syn_svc_1003_1',
      name: 'Front brake service',
      ordinal: 0,
      authorizationStatus: 'Authorized',
      shopSuppliesCents: 450,
      labors: [
        {
          id: 'syn_lab_1003_1',
          name: 'Replace front brake pads',
          note: 'Rotors within spec.',
          hours: 1.5,
          rateCents: 14000,
          discountCents: 1000,
          technicianId: 'syn_usr_1',
          completed: true,
          costHours: 1.2,
          costRateCents: 3500,
        },
      ],
      parts: [
        {
          id: 'syn_prt_1003_1',
          name: 'Ceramic brake pads (front)',
          quantity: 1,
          retailCostCents: 8999,
          wholesaleCostCents: 4200,
          inventoryPartId: 'syn_inv_1',
          partNumber: 'BP-1234',
          sku: 'BP1234',
          vendorId: 'syn_ven_1',
          binLocation: 'A3',
        },
      ],
      fees: [
        { id: 'syn_fee_1003_1', name: 'Brake cleaner', feeType: 'FixedCents', amountCents: 500 },
      ],
    },
    {
      id: 'syn_svc_1003_2',
      name: 'Tires: mount and balance',
      ordinal: 1,
      authorizationStatus: 'Authorized',
      tires: [
        {
          id: 'syn_tir_1003_1',
          name: 'All-season 225/45R17',
          size: '225/45R17',
          quantity: 4,
          retailCostCents: 13500,
          wholesaleCostCents: 9000,
          inventoryTireId: 'syn_itr_1',
          partNumber: 'AS-2254517',
          tireIdentificationNumbers: ['SYNTIN0001', 'SYNTIN0002', 'SYNTIN0003', 'SYNTIN0004'],
        },
      ],
      labors: [
        {
          id: 'syn_lab_1003_2',
          name: 'Mount and balance (4)',
          hours: 1,
          rateCents: 14000,
          technicianId: 'syn_usr_2',
          completed: true,
        },
      ],
      fees: [
        { id: 'syn_fee_1003_2', name: 'Tire disposal', feeType: 'PercentService', percent: 2 },
      ],
    },
    {
      id: 'syn_svc_1003_3',
      name: 'Four-wheel alignment (sublet)',
      ordinal: 2,
      authorizationStatus: 'Authorized',
      subcontracts: [
        {
          id: 'syn_sub_1003_1',
          name: 'Alignment at partner shop',
          costCents: 6000,
          retailCostCents: 9500,
          vendorId: 'syn_ven_1',
          note: 'Invoice #A-55 from partner.',
        },
      ],
    },
    {
      id: 'syn_svc_1003_4',
      name: 'Coolant flush',
      ordinal: 3,
      authorizationStatus: 'Declined',
      deferredDate: '2025-03-10T16:00:00.000Z',
      deferredReason: 'Declined',
      labors: [{ id: 'syn_lab_1003_4', name: 'Coolant flush', hours: 1, rateCents: 14000 }],
      parts: [
        {
          id: 'syn_prt_1003_4',
          name: 'Coolant (gal)',
          quantity: 2,
          retailCostCents: 1899,
          wholesaleCostCents: 800,
        },
      ],
    },
  ],
  [
    {
      id: 'syn_pay_1003_1',
      amountCents: 10000,
      transactionType: 'Charge',
      paymentType: 'Cash',
      status: 'Succeeded',
      recordedDate: '2025-03-10T16:05:00.000Z',
      deposit: true,
      note: 'Deposit at drop-off',
    },
    {
      id: 'syn_pay_1003_2',
      amountCents: 50000,
      transactionType: 'Charge',
      paymentType: 'Card',
      status: 'Succeeded',
      recordedDate: '2025-03-14T17:30:00.000Z',
      cardDigits: '4242',
      refundedAmountCents: 5000,
    },
    {
      id: 'syn_pay_1003_3',
      amountCents: -5000,
      chargeId: 'syn_pay_1003_2',
      transactionType: 'Refund',
      paymentType: 'Card',
      status: 'Succeeded',
      recordedDate: '2025-03-20T15:00:00.000Z',
      cardDigits: '4242',
      refundReason: 'RequestedByCustomer',
      note: 'Goodwill for the wait',
    },
    {
      id: 'syn_pay_1003_4',
      amountCents: 20000,
      transactionType: 'Charge',
      paymentType: 'Card',
      status: 'Failed',
      recordedDate: '2025-03-21T15:00:00.000Z',
      cardDigits: '0002',
    },
  ]
)

// O4: an invoice billed to the vehicle's previous owner, with an order-level percent discount,
// paid by check and refunded in full (net paid 0 → refund_net_nonpositive). The vehicle has no
// year, make or model.
addOrder(
  order('syn_ord_1004', '2023-11-02T15:00:00.000Z', {
    number: '1004',
    publicId: 'syn-1004',
    status: 'Invoice',
    customerId: 'syn_cus_1',
    vehicleId: 'syn_veh_3',
    complaint: 'Check engine light.',
    workflowStatusId: 'syn_wfs_6',
    workflowStatusPosition: 1,
    authorized: true,
    authorizedDate: '2023-11-02T15:10:00.000Z',
    completedDate: '2023-11-02T18:00:00.000Z',
    invoiced: true,
    invoicedDate: '2023-11-02T18:05:00.000Z',
    dueDate: '2023-12-02T06:00:00.000Z',
    mileageIn: 120001,
    appliedDiscountValueType: 'Percent',
    appliedDiscountPercent: 10,
    discountPercent: 10,
  }),
  [
    {
      id: 'syn_svc_1004_1',
      name: 'Diagnostic',
      ordinal: 0,
      authorizationStatus: 'Authorized',
      labors: [
        {
          id: 'syn_lab_1004_1',
          name: 'Diagnose check engine light',
          hours: 1,
          rateCents: 16000,
          technicianId: 'syn_usr_1',
          completed: true,
          rateId: 'syn_rate_2',
          taxable: false,
        },
      ],
    },
  ],
  [
    {
      id: 'syn_pay_1004_1',
      amountCents: 14400,
      transactionType: 'Charge',
      paymentType: 'Check',
      status: 'Succeeded',
      recordedDate: '2023-11-02T18:10:00.000Z',
      checkNumber: '5521',
      refundedAmountCents: 14400,
    },
    {
      id: 'syn_pay_1004_2',
      amountCents: -14400,
      chargeId: 'syn_pay_1004_1',
      transactionType: 'Refund',
      paymentType: 'Check',
      status: 'Succeeded',
      recordedDate: '2023-11-20T15:00:00.000Z',
      refundReason: 'RequestedByCustomer',
      note: 'Warranty claim',
    },
  ],
  1600
)

// O5: a deleted order: archived in SourceRecord, never loaded.
addOrder(
  order('syn_ord_1005', '2024-06-01T15:00:00.000Z', {
    number: '1005',
    publicId: 'syn-1005',
    customerId: 'syn_cus_2',
    vehicleId: 'syn_veh_2',
    deleted: true,
    deletedDate: '2024-06-02T15:00:00.000Z',
    deletedReason: 'Created by mistake',
  }),
  [
    {
      id: 'syn_svc_1005_1',
      name: 'Wipers',
      ordinal: 0,
      authorizationStatus: 'NotAuthorized',
      parts: [{ id: 'syn_prt_1005_1', name: 'Wiper blades', quantity: 2, retailCostCents: 1999 }],
    },
  ]
)

// The customer's authorization of order 1003: how and when, and per service. PROVISIONAL(M0:S4): we
// assume GET /v3/order/:id/authorization nests the authorization_service rows as `services`.
const authorization = [
  base('syn_aut_1', '2025-03-10T16:00:00.000Z', {
    orderId: 'syn_ord_1003',
    customerId: 'syn_cus_1',
    serviceWriterId: 'syn_usr_3',
    date: '2025-03-10T16:00:00.000Z',
    method: 'Phone',
    note: 'Approved brakes, tires and alignment; declined coolant.',
    authorizedCostCents: 116811,
    serviceAuthorizationReset: false,
    services: [
      ['syn_svc_1003_1', 'Front brake service', 'Authorized'],
      ['syn_svc_1003_2', 'Tires: mount and balance', 'Authorized'],
      ['syn_svc_1003_3', 'Four-wheel alignment (sublet)', 'Authorized'],
      ['syn_svc_1003_4', 'Coolant flush', 'Declined'],
    ].map(([serviceId, name, authorizationStatus], i) =>
      base(`syn_aus_${i + 1}`, '2025-03-10T16:00:00.000Z', {
        authorizationId: 'syn_aut_1',
        serviceId,
        name,
        authorizationStatus,
        authorizedCostCents: 0,
      })
    ),
  }),
]

const inventoryLabor = [
  base('syn_inl_1', '2019-04-01T12:00:00.000Z', {
    name: 'Brake inspection',
    note: '',
    hours: 0.5,
    rateCents: 14000,
    rateId: 'syn_rate_1',
    multiplier: 1,
    multiplierType: 'Hours',
    discountCents: 0,
    discountPercent: 0,
    discountValueType: 'FixedCents',
    costHours: null,
    costRateCents: null,
    categoryId: 'syn_cat_1',
    taxable: true,
    taxableGST: false,
    taxableHST: false,
    taxablePST: false,
    deleted: false,
  }),
]
const inventoryFee = [
  base('syn_inf_1', '2019-04-01T12:00:00.000Z', {
    name: 'Shop disposal fee',
    feeType: 'FixedCents',
    amountCents: 350,
    percent: 0,
    categoryId: null,
    deleted: false,
  }),
]
const label = [
  base('syn_lbl_1', '2019-04-01T12:00:00.000Z', {
    name: 'VIP',
    color: 'purple',
    entity: 'Customer',
    saved: true,
  }),
  base('syn_lbl_2', '2019-04-01T12:00:00.000Z', {
    name: 'Fleet',
    color: 'blue',
    entity: 'Order',
    saved: true,
  }),
]

const appointment = [
  base('syn_apt_1', '2025-01-30T12:00:00.000Z', {
    name: 'Fleet oil change',
    note: 'Drop off before 8.',
    customerId: 'syn_cus_2',
    vehicleId: 'syn_veh_2',
    orderId: 'syn_ord_1002',
    startDate: '2025-02-03T14:00:00.000Z',
    endDate: '2025-02-03T15:00:00.000Z',
    allDay: false,
    color: 'blue',
    confirmationStatus: 'Confirmed',
    origin: 'Shop',
    publicId: 'syn-apt-1',
    recurring: false,
    sendConfirmation: false,
    sendReminder: false,
    useEmail: false,
    useSMS: false,
  }),
]

const templateItems = ['Brakes', 'Tires', 'Wiper blades', 'Battery'].map((name, ordinal) => ({
  id: `syn_iti_${ordinal + 1}`,
  inspectionTemplateId: 'syn_itp_1',
  name,
  message: '',
  ordinal,
  status: null,
  recommendedCannedServiceIds: [],
  createdDate: '2019-05-01T12:00:00.000Z',
}))
const inspectionTemplate = [
  base('syn_itp_1', '2019-05-01T12:00:00.000Z', {
    name: 'Multi-point inspection',
    note: null,
    deleted: false,
    items: templateItems,
  }),
]
const inspectionItem = (
  n: number,
  name: string,
  status: string | null,
  message: string,
  files: Rec[] = []
) => ({
  id: `syn_iit_${n}`,
  inspectionId: 'syn_ins_1',
  name,
  message,
  ordinal: n - 1,
  status,
  publicId: `syn-iit-${n}`,
  inspectorUserId: 'syn_usr_1',
  inspectionDate: '2025-03-10T17:00:00.000Z',
  recommendedCannedServiceIds: status === 'Red' ? ['syn_can_1'] : [],
  reviewStatus: null,
  // Photos are embedded as files[] ({ fileName, fileSize, fileType, id, thumbnailUrl, url }) per the
  // docs. PROVISIONAL(M0:S7): whether `url` downloads without the API key, and how long it lives.
  files,
  createdDate: '2025-03-10T17:00:00.000Z',
})
const inspection = [
  base('syn_ins_1', '2025-03-10T17:00:00.000Z', {
    orderId: 'syn_ord_1003',
    templateId: 'syn_itp_1',
    name: 'Multi-point inspection',
    note: 'Front pads worn; tires near the wear bars.',
    completed: true,
    completedById: 'syn_usr_1',
    completedDate: '2025-03-10T17:30:00.000Z',
    createdById: 'syn_usr_1',
    checklistStage: 'RepairOrder',
    ordinal: 0,
    recommended: false,
    items: [
      inspectionItem(1, 'Brakes', 'Red', 'Front pads at 2 mm.', [
        {
          id: 'syn_ifl_1',
          fileName: 'brakes.jpg',
          fileSize: 48213,
          fileType: 'image/jpeg',
          thumbnailUrl: 'https://files.example.test/synthetic/brakes-thumb.jpg',
          url: 'https://files.example.test/synthetic/brakes.jpg',
        },
      ]),
      inspectionItem(2, 'Tires', 'Yellow', 'Tread at 3/32".'),
      inspectionItem(3, 'Wiper blades', 'Green', ''),
      inspectionItem(4, 'Battery', 'NotApplicable', ''),
    ],
  }),
]

const timesheet = [
  // PROVISIONAL(M0:S8): `duration` has no documented unit. The timesheet list's meta reports
  // totals in milliseconds, so the fixtures use milliseconds; the importer derives minutes from clockIn
  // and clockOut and keeps `duration` only in SourceRecord.
  base('syn_tsh_1', '2025-03-10T18:00:00.000Z', {
    technicianId: 'syn_usr_1',
    activity: 'Labor',
    orderId: 'syn_ord_1003',
    serviceId: 'syn_svc_1003_1',
    laborId: 'syn_lab_1003_1',
    clockIn: '2025-03-10T18:00:00.000Z',
    clockOut: '2025-03-10T19:30:00.000Z',
    duration: 5_400_000,
    inProgress: false,
    note: '',
    number: '1',
    type: 'Timeclock',
    flatRate: false,
    rateCents: null,
  }),
  base('syn_tsh_2', '2025-03-10T13:00:00.000Z', {
    technicianId: 'syn_usr_2',
    activity: 'General',
    orderId: null,
    serviceId: null,
    laborId: null,
    clockIn: '2025-03-10T13:00:00.000Z',
    clockOut: '2025-03-10T21:30:00.000Z',
    duration: 30_600_000,
    inProgress: false,
    note: 'Opening shift',
    number: '2',
    type: 'Timeclock',
    flatRate: false,
    rateCents: null,
  }),
  base('syn_tsh_3', '2025-03-11T13:00:00.000Z', {
    technicianId: 'syn_usr_1',
    activity: 'General',
    orderId: null,
    serviceId: null,
    laborId: null,
    clockIn: '2025-03-11T13:00:00.000Z',
    clockOut: null,
    duration: null,
    inProgress: true,
    note: '',
    number: '3',
    type: 'Timeclock',
    flatRate: false,
    rateCents: null,
  }),
]

// ─── Output ────────────────────────────────────────────────────────────────────────────────────────

const TABLES: [table: string, endpoint: string, records: unknown[]][] = [
  ['company', '/v3/company/:id', company],
  ['location', '/v3/location', location],
  ['tax_config', '/v3/tax_config', taxConfig],
  ['labor_rate', '/v3/labor_rate', laborRate],
  ['workflow_status', '/v3/workflow_status', workflowStatus],
  ['user', '/v3/user', users],
  ['referral_source', '/v3/referral_source', referralSource],
  ['customer', 'POST /v3/customer/search', customers],
  ['vehicle', '/v3/customer/:id/vehicle', vehicles],
  ['vehicle_owner', '/v3/vehicle/:id/owners', vehicleOwner],
  ['inventory_category', '/v3/inventory_category', inventoryCategory],
  ['vendor', '/v3/vendor', vendor],
  ['inventory_part', 'POST /v3/inventory_part/search', inventoryPart],
  ['inventory_tire', 'POST /v3/inventory_tire/search', inventoryTire],
  ['canned_service', '/v3/canned_service', cannedService],
  ['order', '/v3/order', orders],
  ['order_service', '/v3/order/:id/service', services],
  ['payment', 'POST /v3/integration/payment/search', payments],
  ['appointment', '/v3/appointment', appointment],
  ['authorization', '/v3/order/:id/authorization', authorization],
  ['inventory_labor', 'POST /v3/inventory_labor/search', inventoryLabor],
  ['inventory_fee', 'POST /v3/inventory_fee/search', inventoryFee],
  ['label', '/v3/label', label],
  ['inspection_template', '/v3/inspection_template', inspectionTemplate],
  ['inspection', '/v3/inspection', inspection],
  ['timesheet', '/v3/timesheet', timesheet],
]

function main() {
  mkdirSync(OUT, { recursive: true })
  for (const [table, endpoint, records] of TABLES) {
    const fixture = {
      table,
      source: 'synthetic',
      synthetic: true,
      note: 'SYNTHETIC: invented from Shopmonkey published schemas, not recorded. See README.md.',
      endpoint,
      total: records.length,
      records,
    }
    writeFileSync(path.join(OUT, `${table}.json`), `${JSON.stringify(fixture, null, 2)}\n`)
  }
  // Written the way the repository formats JSON, so `npm run check` is quiet.
  execFileSync('npx', ['biome', 'format', '--write', OUT], { stdio: 'inherit', shell: true })
  console.log(`Wrote ${TABLES.length} synthetic fixture files to ${OUT}`)
}

main()
