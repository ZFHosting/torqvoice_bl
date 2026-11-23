/**
 * Catalog and settings (MAPPING §3, §7): inventory parts and tires become `InventoryPart`s (with the
 * starting count as an "import" `StockMovement`), canned services and catalog labor and fees become
 * `LaborPreset`s, the tax config becomes the workshop's tax settings, and the default labor rate its
 * default rate.
 */
import { centsToAmount } from '../money'
import { joinName } from '@/features/import/Lib/normalize'
import { type FieldSpec, num, records, str, unmappedFields, warn } from './fields'
import { feeCents, lineCents } from './lines'
import type { Row, TransformContext, TransformResult, Warning } from './types'

const cents = (value: unknown) => Math.round(num(value) ?? 0)

export const INVENTORY_PART_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'name',
    'number',
    'partNumber',
    'note',
    'sku',
    'quantity',
    'minCriticalQuantity',
    'reorderQuantity',
    'wholesaleCostCents',
    'retailCostCents',
    'binLocation',
    'categoryId',
    'vendorId',
    'deleted',
    'size',
  ],
  archive: [
    'availableQuantity',
    'companyId',
    'createdDate',
    'discountCents',
    'federalExciseTaxCents',
    'locationId',
    'maxCriticalQuantity',
    'metadata',
    'reservedQuantity',
    'sizeFormat',
    'taxable',
    'tireModelId',
    'updatedDate',
    'wasteTireFeeCents',
  ],
}

export interface InventoryRows {
  part: {
    name: string
    partNumber: string | null
    description: string | null
    /** The sku: M5 keeps it as `barcode` only if no other part has it, else adds `sku:<value>` to tags. */
    barcodeCandidate: string | null
    category: string | null
    quantity: number
    minQuantity: number
    unitCost: number
    sellPrice: number
    supplier: string | null
    supplierPhone: string | null
    supplierEmail: string | null
    supplierUrl: string | null
    location: string | null
    userId: string
    organizationId: string
  }
  /** The starting count, so the stock history explains it. */
  movement: { delta: number; quantityAfter: number; reason: 'import'; note: string } | null
}

export function transformInventoryItem(
  item: Row,
  kind: 'part' | 'tire',
  lookups: { categories: Record<string, Row>; vendors: Record<string, Row> },
  ctx: TransformContext
): TransformResult<InventoryRows | null> {
  const remoteId = String(item.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(item, INVENTORY_PART_FIELDS)
  if (item.deleted === true) return { rows: null, warnings, unmapped }
  const vendor = str(item.vendorId) ? lookups.vendors[String(item.vendorId)] : undefined
  const category = str(item.categoryId) ? lookups.categories[String(item.categoryId)] : undefined
  const quantity = num(item.quantity) ?? 0
  const size = str(item.size)
  const contactPhone = vendor?.contactPhone
  return {
    rows: {
      part: {
        name: str(item.name) ?? (kind === 'tire' ? 'Tire' : 'Part'),
        partNumber: str(item.number) ?? str(item.partNumber),
        // §3: a tire's size goes in its description.
        description:
          [kind === 'tire' && size ? `Size ${size}` : null, str(item.note)]
            .filter(Boolean)
            .join('\n') || null,
        barcodeCandidate: str(item.sku),
        category: kind === 'tire' ? 'Tires' : (str(category?.name) ?? null),
        quantity,
        minQuantity: num(item.minCriticalQuantity) ?? num(item.reorderQuantity) ?? 0,
        unitCost: centsToAmount(cents(item.wholesaleCostCents)),
        sellPrice: centsToAmount(cents(item.retailCostCents)),
        supplier: str(vendor?.name) ?? null,
        // PROVISIONAL(M0:S10): the vendor's `contactPhone` may be an object with a number.
        supplierPhone:
          typeof contactPhone === 'string'
            ? contactPhone
            : (str((contactPhone as Row | undefined)?.number) ?? null),
        supplierEmail: str(vendor?.contactEmail) ?? null,
        supplierUrl: str(vendor?.url) ?? null,
        location: str(item.binLocation),
        userId: ctx.runUserId,
        organizationId: ctx.organizationId,
      },
      movement: quantity
        ? {
            delta: quantity,
            quantityAfter: quantity,
            reason: 'import',
            note: 'Imported from Shopmonkey',
          }
        : null,
    },
    warnings,
    unmapped,
  }
}

export interface PresetRows {
  preset: { name: string; description: string | null; userId: string; organizationId: string }
  items: {
    description: string
    hours: number
    rate: number
    pricingType: 'hourly' | 'shopFee'
    sortOrder: number
  }[]
  parts: {
    name: string
    partNumber: string | null
    quantity: number
    unitPrice: number
    category: string | null
    inventoryPartId: string | null
    sortOrder: number
  }[]
}

export const CANNED_SERVICE_FIELDS: FieldSpec = {
  mapped: ['id', 'name', 'note', 'labors', 'parts', 'tires', 'subcontracts', 'fees', 'deleted'],
  archive: [
    'bookable',
    'companyId',
    'createdDate',
    'locationId',
    'lumpSum',
    'metadata',
    'pricing',
    'publicId',
    'recommended',
    'updatedDate',
  ],
}

/** A canned service (§3): its labor and fees as preset items (fees priced `shopFee`), its parts as preset parts. */
export function transformCannedService(
  service: Row,
  ctx: TransformContext
): TransformResult<PresetRows | null> {
  const remoteId = String(service.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(service, CANNED_SERVICE_FIELDS)
  if (service.deleted === true) return { rows: null, warnings, unmapped }
  let order = 0
  const items: PresetRows['items'] = []
  const parts: PresetRows['parts'] = []
  for (const l of records(service.labors)) {
    items.push({
      description: str(l.name) ?? 'Labor',
      hours: num(l.hours) ?? 0,
      rate: centsToAmount(cents(l.rateCents)),
      pricingType: 'hourly',
      sortOrder: order++,
    })
  }
  // The base a percent fee applies to, as on an order (lines.ts): every line of the service.
  const lineBase =
    records(service.labors).reduce((a, l) => a + lineCents('labor', l), 0) +
    records(service.parts).reduce((a, p) => a + lineCents('part', p), 0) +
    records(service.tires).reduce((a, p) => a + lineCents('tire', p), 0) +
    records(service.subcontracts).reduce((a, p) => a + lineCents('subcontract', p), 0)
  for (const f of records(service.fees)) {
    const amount = feeCents(f, lineBase)
    if (f.feeType !== 'FixedCents' && typeof f.amountCents !== 'number') {
      warnings.push(
        warn(
          'canned_service',
          remoteId,
          'preset_percent_fee',
          `A ${num(f.percent) ?? 0}% fee: the preset carries today's amount`,
          'fees'
        )
      )
    }
    items.push({
      description: str(f.name) ?? 'Fee',
      hours: 1,
      rate: centsToAmount(amount),
      pricingType: 'shopFee',
      sortOrder: order++,
    })
  }
  const partOf = (p: Row, category: string | null, table: 'inventory_part' | 'inventory_tire') => {
    const inventory = str(table === 'inventory_tire' ? p.inventoryTireId : p.inventoryPartId)
    parts.push({
      name: str(p.name) ?? 'Part',
      partNumber: str(p.partNumber),
      quantity: num(p.quantity) ?? 1,
      unitPrice: centsToAmount(cents(p.retailCostCents)),
      category,
      inventoryPartId: inventory ? ctx.resolve(table, inventory) : null,
      sortOrder: order++,
    })
  }
  for (const p of records(service.parts)) partOf(p, null, 'inventory_part')
  for (const t of records(service.tires)) partOf(t, 'Tires', 'inventory_tire')
  for (const s of records(service.subcontracts))
    partOf({ ...s, quantity: 1 }, 'Sublet', 'inventory_part')
  return {
    rows: {
      preset: {
        name: str(service.name) ?? remoteId,
        description: str(service.note),
        userId: ctx.runUserId,
        organizationId: ctx.organizationId,
      },
      items,
      parts,
    },
    warnings,
    unmapped,
  }
}

/** The lines nested in a canned service: only what `transformCannedService` reads is mapped. */
export const CANNED_LINE_FIELDS: Record<string, FieldSpec> = {
  labors: {
    mapped: ['id', 'name', 'hours', 'rateCents', 'multiplier', 'discountCents'],
    archive: ['cannedServiceId', 'note', 'ordinal', 'taxable'],
  },
  parts: {
    mapped: [
      'id',
      'name',
      'partNumber',
      'quantity',
      'retailCostCents',
      'discountCents',
      'inventoryPartId',
    ],
    archive: ['cannedServiceId', 'note', 'ordinal', 'taxable', 'wholesaleCostCents'],
  },
  tires: {
    mapped: [
      'id',
      'name',
      'partNumber',
      'quantity',
      'retailCostCents',
      'discountCents',
      'inventoryTireId',
    ],
    archive: ['cannedServiceId', 'note', 'ordinal', 'taxable', 'wholesaleCostCents'],
  },
  subcontracts: {
    mapped: ['id', 'name', 'retailCostCents', 'discountCents'],
    archive: ['cannedServiceId', 'costCents', 'note', 'ordinal', 'taxable', 'vendorId'],
  },
  fees: {
    mapped: ['id', 'name', 'feeType', 'amountCents', 'percent', 'subtotalCents'],
    archive: ['cannedServiceId', 'ordinal'],
  },
}

export const CATALOG_LINE_FIELDS: FieldSpec = {
  mapped: [
    'id',
    'name',
    'note',
    'hours',
    'rateCents',
    'feeType',
    'amountCents',
    'percent',
    'deleted',
  ],
  archive: [
    'categoryId',
    'companyId',
    'costHours',
    'costRateCents',
    'createdDate',
    'discountCents',
    'discountPercent',
    'discountValueType',
    'locationId',
    'metadata',
    'multiplier',
    'multiplierType',
    'rateId',
    'taxable',
    'taxableGST',
    'taxableHST',
    'taxablePST',
    'updatedDate',
  ],
}

/** A catalog labor or fee item (§3): a one-line preset. A percent fee has no amount of its own: rate 0, warned. */
export function transformCatalogLine(
  item: Row,
  kind: 'labor' | 'fee',
  ctx: TransformContext
): TransformResult<PresetRows | null> {
  const remoteId = String(item.id)
  const warnings: Warning[] = []
  const unmapped = unmappedFields(item, CATALOG_LINE_FIELDS)
  if (item.deleted === true) return { rows: null, warnings, unmapped }
  const percent = kind === 'fee' && item.feeType !== 'FixedCents'
  if (percent) {
    warnings.push(
      warn(
        kind === 'fee' ? 'inventory_fee' : 'inventory_labor',
        remoteId,
        'preset_percent_fee',
        `A ${num(item.percent) ?? 0}% fee: the preset carries no amount`,
        'percent'
      )
    )
  }
  return {
    rows: {
      preset: {
        name: str(item.name) ?? remoteId,
        description: str(item.note),
        userId: ctx.runUserId,
        organizationId: ctx.organizationId,
      },
      items: [
        kind === 'labor'
          ? {
              description: str(item.name) ?? 'Labor',
              hours: num(item.hours) ?? 0,
              rate: centsToAmount(cents(item.rateCents)),
              pricingType: 'hourly',
              sortOrder: 0,
            }
          : {
              description: str(item.name) ?? 'Fee',
              hours: 1,
              rate: percent ? 0 : centsToAmount(cents(item.amountCents)),
              pricingType: 'shopFee',
              sortOrder: 0,
            },
      ],
      parts: [],
    },
    warnings,
    unmapped,
  }
}

export interface TaxSettingsRows {
  /** The default rate (US `taxPercent`); Canadian components when more than one of GST/PST/HST is set. */
  rate: number
  components: { name: string; rate: number }[] | null
  laborTaxable: boolean
  partsTaxable: boolean
  epaTaxable: boolean
  shopSuppliesTaxable: boolean
  system: string | null
}

/** The tax config (§3, RESULTS S6). */
export function transformTaxConfig(config: Row): TaxSettingsRows {
  const components = (
    [
      ['GST', config.gstPercent],
      ['PST', config.pstPercent],
      ['HST', config.hstPercent],
    ] as const
  )
    .map(([name, rate]) => ({ name, rate: num(rate) ?? 0 }))
    .filter((c) => c.rate !== 0)
  const any = (...keys: string[]) => keys.some((key) => config[key] === true)
  return {
    rate: num(config.taxPercent) ?? components.reduce((a, c) => a + c.rate, 0),
    components: components.length > 1 ? components : null,
    laborTaxable: any('laborTaxable', 'laborTaxableGST', 'laborTaxablePST', 'laborTaxableHST'),
    partsTaxable: any('partTaxable', 'partTaxableGST', 'partTaxablePST', 'partTaxableHST'),
    epaTaxable: config.epaTaxable === true,
    shopSuppliesTaxable: config.shopSuppliesTaxable === true,
    system: str(config.taxSystem),
  }
}

/** A vendor's contact name, for the supplier fields' notes. */
export const vendorContact = (vendor: Row) =>
  joinName(str(vendor.contactFirstName), str(vendor.contactLastName))
