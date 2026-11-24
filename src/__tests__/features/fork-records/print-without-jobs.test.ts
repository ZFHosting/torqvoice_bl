/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md acceptance 2): a workshop with no jobs sees no change. An
 * invoice and a quote without jobs, in every layout preset, flat and grouped by category, print exactly as they did
 * before job grouping existed: the snapshot (each spec's SHA-256, so a change names the preset and document without
 * committing every sheet) was taken on `fork/integration` before M9 changed any print code, and M9 must leave it as it
 * is. SYNTHETIC data.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildInvoicePrintSpec } from '@/features/invoice-designer/Pdf/buildInvoicePrint'
import { buildQuotePrintSpec } from '@/features/invoice-designer/Pdf/buildQuotePrint'
import { buildLayoutFromPreset, layoutPresets } from '@/features/settings/Schema/layoutPresets'
import type { InvoiceLayoutConfig } from '@/features/settings/Schema/invoiceLayoutSchema'
import type { InvoiceData } from '@/features/vehicles/Components/invoice-pdf/types'

const invoiceData = {
  id: 'svc1',
  title: 'Brake service',
  description: null,
  type: 'repair',
  serviceDate: new Date('2026-09-26T09:00:00Z'),
  invoiceDate: new Date('2026-09-26T09:00:00Z'),
  invoiceDueDate: new Date('2026-10-10T09:00:00Z'),
  shopName: 'Shop',
  techName: 'Sam',
  mileage: 52000,
  diagnosticNotes: null,
  invoiceNotes: '<p>Thanks for your business.</p>',
  subtotal: 581,
  taxRate: 25,
  taxAmount: 145.25,
  totalAmount: 726.25,
  cost: 581,
  invoiceNumber: 'INV-1001',
  partItems: [
    {
      partNumber: 'BD-1',
      name: 'Brake disc',
      quantity: 2,
      unit: 'pcs',
      category: 'Brakes',
      unitPrice: 75,
      total: 150,
    },
    {
      partNumber: 'BP-2',
      name: 'Brake pads',
      quantity: 1,
      unit: 'set',
      category: 'Brakes',
      unitPrice: 96,
      total: 96,
    },
    {
      partNumber: 'OF-3',
      name: 'Oil filter',
      quantity: 1,
      unit: 'pcs',
      category: null,
      unitPrice: 15,
      total: 15,
    },
  ],
  laborItems: [
    { description: 'Replace discs and pads', hours: 2.5, rate: 100, total: 250 },
    { description: 'Oil change', hours: 1, rate: 70, total: 70, pricingType: 'service' },
  ],
  customer: {
    name: 'Alex Carter',
    email: 'alex@example.com',
    phone: null,
    address: '1 Test Street',
    company: null,
  },
  vehicle: {
    make: 'Volvo',
    model: 'XC60',
    year: 2021,
    vin: null,
    licensePlate: 'AB 12345',
    mileage: 52000,
    customer: null,
  },
} as unknown as InvoiceData

const quoteData = {
  ...(invoiceData as unknown as Record<string, unknown>),
  quoteNumber: 'Q-1001',
  status: 'draft',
  createdAt: new Date('2026-09-26T09:00:00Z'),
  validUntil: new Date('2026-10-26T09:00:00Z'),
  notes: null,
  discountType: null,
  discountValue: 0,
  discountAmount: 0,
} as never

/** The preset with its items and parts tables grouped by category, as a workshop can set it. */
function byCategory(layout: InvoiceLayoutConfig): InvoiceLayoutConfig {
  return {
    ...layout,
    sections: layout.sections.map((section) =>
      section.id === 'items_table' || section.id === 'parts_table'
        ? { ...section, groupBy: 'category' as const }
        : section
    ),
  }
}

const hashOf = (spec: unknown) => createHash('sha256').update(JSON.stringify(spec)).digest('hex')

function specs() {
  const out: Record<string, unknown> = {}
  for (const preset of layoutPresets) {
    for (const [variant, layout] of [
      ['flat', buildLayoutFromPreset(preset)],
      ['category', byCategory(buildLayoutFromPreset(preset))],
    ] as const) {
      out[`${preset.id} ${variant} invoice`] = hashOf(
        buildInvoicePrintSpec({
          data: invoiceData,
          locale: 'en',
          template: { layoutConfig: layout } as never,
        })
      )
      out[`${preset.id} ${variant} quote`] = hashOf(
        buildQuotePrintSpec({ data: quoteData, layoutConfig: layout } as never)
      )
    }
  }
  return out
}

describe('a document without jobs', () => {
  it('prints as it did before job grouping, in every preset, flat and by category', () => {
    expect(specs()).toMatchSnapshot()
  })
})
