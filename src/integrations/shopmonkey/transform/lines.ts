/**
 * An order's services and their lines (MAPPING §6.2, §6.3): every service a `WorkJob`, every line a
 * `ServiceLabor` or `ServicePart` (or quote line) under it with its `lineKind`. Shopmonkey's lines carry
 * no total of their own, so each total is worked out under one formula (PROVISIONAL(M0:S5)) and checked,
 * per service, against Shopmonkey's computed `calculated*Cents`; a difference is a warning with both
 * numbers, never a correction.
 */
import { centsToAmount } from '../money'
import { type FieldSpec, num, records, str, warn } from './fields'
import type { Row, TransformContext, Warning } from './types'

export type LineKind = 'labor' | 'fee' | 'epa' | 'shopSupplies' | 'part' | 'tire' | 'subcontract'

export interface LaborLine {
  remoteId: string
  lineKind: 'labor' | 'fee' | 'epa' | 'shopSupplies'
  description: string
  hours: number
  rate: number
  total: number
  pricingType: 'hourly' | 'shopFee'
  taxable: boolean
  technicianId: string | null
  completed: boolean | null
  costHours: number | null
  costRate: number | null
  discountAmount: number | null
  sourceExtra: Row | null
  sortOrder: number
}

export interface PartLine {
  remoteId: string
  lineKind: 'part' | 'tire' | 'subcontract'
  name: string
  partNumber: string | null
  quantity: number
  unitPrice: number
  unitCost: number
  total: number
  category: string | null
  taxable: boolean
  inventoryPartId: string | null
  discountAmount: number | null
  note: string | null
  sourceExtra: Row | null
  sortOrder: number
}

export interface JobRows {
  remoteId: string
  job: {
    name: string
    note: string | null
    ordinal: number
    authorizationStatus: string | null
    recommended: boolean
    hidden: boolean
    lumpSum: boolean
    fixedPrice: number | null
    deferredDate: Date | null
    deferredReason: string | null
    totalAmount: number
    discountAmount: number
    taxAmount: number
  }
  /** Whether the job counts toward the document's totals (not Declined, not deferred). */
  counts: boolean
  labor: LaborLine[]
  parts: PartLine[]
  /** The line totals in cents, by kind, as worked out here. */
  cents: Record<LineKind, number>
  /** A deferred service: becomes a VehicleFinding (§6.4). */
  deferred: { description: string; notes: string } | null
  /** The deferred service this one revives (§6.4): its finding is resolved by this order. */
  revivesRemoteId: string | null
}

export const SERVICE_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'orderId',
    'name',
    'note',
    'ordinal',
    'authorizationStatus',
    'recommended',
    'hidden',
    'lumpSum',
    'fixedPriceCents',
    'deferredDate',
    'deferredReason',
    'revivedFromId',
    'labors',
    'parts',
    'tires',
    'subcontracts',
    'fees',
    'calculatedLaborCents',
    'calculatedPartsCents',
    'calculatedTiresCents',
    'calculatedSubcontractsCents',
    'calculatedFeeCents',
    'calculatedEpaCents',
    'calculatedShopSuppliesCents',
    'calculatedDiscountCents',
    'calculatedTaxCents',
    'totalCents',
  ],
  archive: [
    'calculatedDiscountPercent',
    'calculatedGSTCents',
    'calculatedHSTCents',
    'calculatedPSTCents',
    'categoryId',
    'companyId',
    'createdDate',
    'discountCents',
    'discountPercent',
    'discountValueType',
    'epaCents',
    'epaPercent',
    'epaValueType',
    'excludedFromDeferred',
    'gstCents',
    'gstPercent',
    'gstValueType',
    'hideLineItemPricing',
    'hstCents',
    'hstPercent',
    'hstValueType',
    'lineItemInventoryStatus',
    'lineItemOrder',
    'locationId',
    'metadata',
    'pricing',
    'pstCents',
    'pstPercent',
    'pstValueType',
    'revived',
    'shopSuppliesApplied',
    'shopSuppliesCents',
    'shopSuppliesPercent',
    'shopSuppliesValueType',
    'sourceServiceId',
    'taxCents',
    'taxPercent',
    'taxValueType',
    'updatedDate',
  ],
}

/** MAPPING §6.3. PROVISIONAL(M0:S5). */
export function countsTowardTotals(service: Row): boolean {
  return service.authorizationStatus !== 'Declined' && !service.deferredDate
}

/** A line's own taxable flag (CA: any of GST/PST/HST). MAPPING §6.2. */
function taxable(line: Row): boolean {
  return [line.taxable, line.taxableGST, line.taxablePST, line.taxableHST].some((f) => f === true)
}

const cents = (value: unknown) => Math.round(num(value) ?? 0)

/** gross − discount. PROVISIONAL(M0:S5): the fixtures' formula; checked per service. */
export function lineCents(kind: 'labor' | 'part' | 'tire' | 'subcontract', line: Row): number {
  const discount = cents(line.discountCents)
  if (kind === 'labor') {
    return (
      Math.round((num(line.hours) ?? 0) * cents(line.rateCents) * (num(line.multiplier) ?? 1)) -
      discount
    )
  }
  if (kind === 'subcontract') return cents(line.retailCostCents) - discount
  return Math.round((num(line.quantity) ?? 0) * cents(line.retailCostCents)) - discount
}

const EPA_LIKE = /\b(epa|environmental|shop\s*suppl)/i

function pick(line: Row, keys: string[]): Row | null {
  const out: Row = {}
  for (const key of keys) if (line[key] !== undefined && line[key] !== null) out[key] = line[key]
  return Object.keys(out).length ? out : null
}

export function transformService(
  service: Row,
  ctx: TransformContext,
  epaTaxable: boolean,
  shopSuppliesTaxable: boolean
): { rows: JobRows; warnings: Warning[] } {
  const remoteId = String(service.id)
  const warnings: Warning[] = []
  const technician = (userId: unknown) => {
    const id = str(userId)
    return id ? ctx.resolve('user', id) : null
  }
  const total: Record<LineKind, number> = {
    labor: 0,
    fee: 0,
    epa: 0,
    shopSupplies: 0,
    part: 0,
    tire: 0,
    subcontract: 0,
  }
  const labor: LaborLine[] = []
  const parts: PartLine[] = []
  let order = 0

  for (const l of records(service.labors)) {
    const c = lineCents('labor', l)
    total.labor += c
    const note = str(l.note)
    labor.push({
      remoteId: String(l.id),
      lineKind: 'labor',
      description: [str(l.name) ?? 'Labor', note].filter(Boolean).join('\n'),
      hours: num(l.hours) ?? 0,
      rate: centsToAmount(cents(l.rateCents)),
      total: centsToAmount(c),
      pricingType: 'hourly',
      taxable: taxable(l),
      technicianId: technician(l.technicianId),
      completed: typeof l.completed === 'boolean' ? l.completed : null,
      costHours: num(l.costHours),
      costRate: num(l.costRateCents) === null ? null : centsToAmount(cents(l.costRateCents)),
      discountAmount: cents(l.discountCents) ? centsToAmount(cents(l.discountCents)) : null,
      sourceExtra: pick(l, [
        'multiplier',
        'multiplierType',
        'rateId',
        'inventoryLaborId',
        'discountPercent',
        'discountValueType',
        'skillRequired',
      ]),
      sortOrder: order++,
    })
  }

  const partLine = (p: Row, kind: 'part' | 'tire' | 'subcontract', extra: string[]): PartLine => {
    const c = lineCents(kind, p)
    total[kind] += c
    const inventoryId = str(kind === 'tire' ? p.inventoryTireId : p.inventoryPartId)
    return {
      remoteId: String(p.id),
      lineKind: kind,
      name: str(kind === 'tire' ? (p.calculatedName ?? p.name) : p.name) ?? kind,
      partNumber: str(p.partNumber),
      quantity: kind === 'subcontract' ? 1 : (num(p.quantity) ?? 0),
      unitPrice: centsToAmount(cents(p.retailCostCents)),
      unitCost: centsToAmount(cents(kind === 'subcontract' ? p.costCents : p.wholesaleCostCents)),
      total: centsToAmount(c),
      category: kind === 'tire' ? 'Tires' : kind === 'subcontract' ? 'Sublet' : null,
      taxable: taxable(p),
      inventoryPartId: inventoryId
        ? ctx.resolve(kind === 'tire' ? 'inventory_tire' : 'inventory_part', inventoryId)
        : null,
      discountAmount: cents(p.discountCents) ? centsToAmount(cents(p.discountCents)) : null,
      note: str(p.note),
      sourceExtra: pick(p, extra),
      sortOrder: order++,
    }
  }
  for (const p of records(service.parts)) {
    parts.push(
      partLine(p, 'part', [
        'sku',
        'binLocation',
        'vendorId',
        'reserved',
        'inventoryStatus',
        'purchaseStatus',
      ])
    )
  }
  for (const t of records(service.tires)) {
    parts.push(
      partLine(t, 'tire', [
        'size',
        'sizeFormat',
        'sku',
        'tireIdentificationNumbers',
        'tireModelId',
        'federalExciseTaxCents',
        'wasteTireFee',
      ])
    )
  }
  for (const s of records(service.subcontracts))
    parts.push(partLine(s, 'subcontract', ['vendorId', 'costCents']))

  const lineBase = total.labor + total.part + total.tire + total.subcontract
  for (const f of records(service.fees)) {
    const c =
      f.feeType === 'FixedCents'
        ? cents(f.amountCents)
        : Math.round((lineBase * (num(f.percent) ?? 0)) / 100)
    total.fee += c
    const name = str(f.name) ?? 'Fee'
    if (EPA_LIKE.test(name)) {
      warnings.push(
        warn(
          'order_service',
          remoteId,
          'epa_also_fee',
          `A fee named like EPA or shop supplies: ${name}`,
          'fees'
        )
      )
    }
    labor.push({
      remoteId: String(f.id),
      lineKind: 'fee',
      description: name,
      hours: 1,
      rate: centsToAmount(c),
      total: centsToAmount(c),
      pricingType: 'shopFee',
      // PROVISIONAL(M0:S6): fees carry no taxable flag and aren't taxed.
      taxable: false,
      technicianId: null,
      completed: null,
      costHours: null,
      costRate: null,
      discountAmount: null,
      sourceExtra: pick(f, [
        'feeType',
        'percent',
        'amountCents',
        'lineItemEntity',
        'inventoryFeeId',
      ]),
      sortOrder: order++,
    })
  }
  for (const [kind, key, label, isTaxable] of [
    ['epa', 'calculatedEpaCents', 'EPA', epaTaxable],
    ['shopSupplies', 'calculatedShopSuppliesCents', 'Shop supplies', shopSuppliesTaxable],
  ] as const) {
    const c = cents(service[key])
    if (!c) continue
    total[kind] += c
    labor.push({
      remoteId: `${remoteId}:${kind}`,
      lineKind: kind,
      description: label,
      hours: 1,
      rate: centsToAmount(c),
      total: centsToAmount(c),
      pricingType: 'shopFee',
      taxable: isTaxable,
      technicianId: null,
      completed: null,
      costHours: null,
      costRate: null,
      discountAmount: null,
      sourceExtra: null,
      sortOrder: order++,
    })
  }

  // Lines by category against Shopmonkey's computed service totals.
  const checks: [string, number][] = [
    ['calculatedLaborCents', total.labor],
    ['calculatedPartsCents', total.part],
    ['calculatedTiresCents', total.tire],
    ['calculatedSubcontractsCents', total.subcontract],
    ['calculatedFeeCents', total.fee],
  ]
  for (const [key, ours] of checks) {
    if (service[key] === undefined || service[key] === null) continue
    const theirs = cents(service[key])
    if (theirs !== ours) {
      warnings.push(
        warn(
          'order_service',
          remoteId,
          'money_mismatch',
          `${key}: lines add up to ${ours}, Shopmonkey says ${theirs}`,
          key
        )
      )
    }
  }

  const deferredDate = str(service.deferredDate)
  const name = str(service.name) ?? 'Service'
  const note = str(service.note)
  const reason = str(service.deferredReason)
  return {
    rows: {
      remoteId,
      job: {
        name,
        note,
        ordinal: Math.trunc(num(service.ordinal) ?? 0),
        authorizationStatus: str(service.authorizationStatus),
        recommended: service.recommended === true,
        hidden: service.hidden === true,
        lumpSum: service.lumpSum === true,
        fixedPrice: service.lumpSum === true ? centsToAmount(cents(service.fixedPriceCents)) : null,
        deferredDate: deferredDate ? new Date(deferredDate) : null,
        deferredReason: reason,
        totalAmount: centsToAmount(cents(service.totalCents)),
        discountAmount: centsToAmount(cents(service.calculatedDiscountCents)),
        taxAmount: centsToAmount(cents(service.calculatedTaxCents)),
      },
      counts: countsTowardTotals(service),
      labor,
      parts,
      cents: total,
      deferred: deferredDate
        ? {
            description: name,
            notes: [note, `Deferred${reason ? ` (${reason})` : ''}`].filter(Boolean).join('\n'),
          }
        : null,
      revivesRemoteId: str(service.revivedFromId),
    },
    warnings,
  }
}

const TAX_FLAGS = ['taxable', 'taxableGST', 'taxablePST', 'taxableHST']
const LINE_ARCHIVE = [
  'cannedServiceId',
  'categoryId',
  'companyId',
  'createdDate',
  'labels',
  'locationId',
  'metadata',
  'orderId',
  'ordinal',
  'serviceId',
  'showNote',
  'updatedDate',
]

/** The fields of each kind of line nested in a service (and a canned service). */
export const LINE_FIELDS: Record<string, FieldSpec> = {
  labors: {
    mapped: [
      'id',
      'name',
      'note',
      'hours',
      'rateCents',
      'multiplier',
      'discountCents',
      'technicianId',
      'completed',
      'costHours',
      'costRateCents',
      ...TAX_FLAGS,
      'multiplierType',
      'rateId',
      'inventoryLaborId',
      'discountPercent',
      'discountValueType',
      'skillRequired',
    ],
    archive: [...LINE_ARCHIVE, 'completedDate', 'costTotalCents', 'showHours'],
  },
  parts: {
    mapped: [
      'id',
      'name',
      'note',
      'partNumber',
      'quantity',
      'retailCostCents',
      'wholesaleCostCents',
      'discountCents',
      'inventoryPartId',
      ...TAX_FLAGS,
      'sku',
      'binLocation',
      'vendorId',
      'reserved',
      'inventoryStatus',
      'purchaseStatus',
    ],
    archive: [
      ...LINE_ARCHIVE,
      'discountPercent',
      'discountValueType',
      'reduceInventoryCount',
      'showCostAndQuantity',
      'showPartNumber',
    ],
  },
  tires: {
    mapped: [
      'id',
      'name',
      'calculatedName',
      'note',
      'partNumber',
      'quantity',
      'retailCostCents',
      'wholesaleCostCents',
      'discountCents',
      'inventoryTireId',
      ...TAX_FLAGS,
      'size',
      'sizeFormat',
      'sku',
      'tireIdentificationNumbers',
      'tireModelId',
      'federalExciseTaxCents',
      'wasteTireFee',
    ],
    archive: [
      ...LINE_ARCHIVE,
      'binLocation',
      'discountPercent',
      'discountValueType',
      'generatedBrandName',
      'generatedModelName',
      'inventoryStatus',
      'purchaseStatus',
      'reduceInventoryCount',
      'reserved',
      'showPartNumber',
      'showPriceAndQuantity',
    ],
  },
  subcontracts: {
    mapped: [
      'id',
      'name',
      'note',
      'retailCostCents',
      'costCents',
      'discountCents',
      ...TAX_FLAGS,
      'vendorId',
    ],
    archive: [...LINE_ARCHIVE, 'discountPercent', 'discountValueType'],
  },
  fees: {
    mapped: ['id', 'name', 'feeType', 'amountCents', 'percent', 'lineItemEntity', 'inventoryFeeId'],
    archive: [...LINE_ARCHIVE, 'laborId', 'partId', 'subcontractId', 'subtotalCents', 'tireId'],
  },
}
