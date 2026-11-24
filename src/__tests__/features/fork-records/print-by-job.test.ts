/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 2): a printed invoice or quote with jobs prints each job
 * as its name, its lines and its subtotal, in the jobs' order, then the lines of no job under "Other"; the labor and
 * parts tables too. A layout that chose a grouping (or none) keeps it. SYNTHETIC data.
 */
import { describe, expect, it } from 'vitest'
import { buildInvoicePrintSpec } from '@/features/invoice-designer/Pdf/buildInvoicePrint'
import { buildQuotePrintSpec } from '@/features/invoice-designer/Pdf/buildQuotePrint'
import type { InvoiceLayoutConfig } from '@/features/settings/Schema/invoiceLayoutSchema'
import { buildLayoutFromPreset, layoutPresets } from '@/features/settings/Schema/layoutPresets'
import type { InvoiceData } from '@/features/vehicles/Components/invoice-pdf/types'

const workJobs = [
  { id: 'j-oil', name: 'Oil change', ordinal: 1 },
  { id: 'j-brakes', name: 'Front brakes', ordinal: 0 },
]

const invoiceData = {
  id: 'svc1',
  title: 'Service',
  description: null,
  type: 'repair',
  serviceDate: new Date('2026-09-26T09:00:00Z'),
  invoiceDate: new Date('2026-09-26T09:00:00Z'),
  shopName: 'Shop',
  techName: null,
  mileage: null,
  diagnosticNotes: null,
  invoiceNotes: null,
  subtotal: 581,
  taxRate: 0,
  taxAmount: 0,
  totalAmount: 581,
  cost: 581,
  invoiceNumber: 'INV-1',
  partItems: [
    {
      partNumber: 'BD-1',
      name: 'Brake disc',
      quantity: 2,
      unitPrice: 75,
      total: 150,
      jobId: 'j-brakes',
    },
    {
      partNumber: 'OF-3',
      name: 'Oil filter',
      quantity: 1,
      unitPrice: 15,
      total: 15,
      jobId: 'j-oil',
    },
    { partNumber: 'WB-9', name: 'Wiper blade', quantity: 1, unitPrice: 96, total: 96, jobId: null },
  ],
  laborItems: [
    { description: 'Oil change labour', hours: 1, rate: 70, total: 70, jobId: 'j-oil' },
    { description: 'Replace discs', hours: 2.5, rate: 100, total: 250, jobId: 'j-brakes' },
  ],
  workJobs,
  customer: { name: 'Alex Carter', email: null, phone: null, address: null, company: null },
  vehicle: null,
} as unknown as InvoiceData

type Table = { kind: 'table'; columns: { key: string }[]; rows: Record<string, string>[] }

/** Every table node in a spec. */
function tables(node: unknown, out: Table[] = []): Table[] {
  if (Array.isArray(node)) {
    for (const child of node) tables(child, out)
  } else if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>
    if (n.kind === 'table' && Array.isArray(n.rows)) out.push(n as unknown as Table)
    for (const value of Object.values(n)) tables(value, out)
  }
  return out
}

/** The table whose columns include `key`: `n` the items table, `ref` the parts table, `rate` the labor table. */
const tableWith = (spec: unknown, key: string) =>
  tables(spec).find((t) => t.columns.some((c) => c.key === key))

/** A table's rows as the reader sees them: a heading, a line, or a subtotal. */
const read = (table: Table | undefined) =>
  (table?.rows ?? []).map((row) =>
    row.groupTitle
      ? `# ${row.groupTitle}`
      : row.groupSubtotal
        ? `= ${row.desc} ${row.total}`
        : `- ${row.desc}`
  )

const preset = (id: string) => {
  const found = layoutPresets.find((p) => p.id === id)
  if (!found) throw new Error(`no preset ${id}`)
  return buildLayoutFromPreset(found)
}

function withGroupBy(layout: InvoiceLayoutConfig, groupBy: 'category' | 'job' | 'none') {
  return {
    ...layout,
    sections: layout.sections.map((s) =>
      ['items_table', 'parts_table', 'labor_table'].includes(s.id) ? { ...s, groupBy } : s
    ),
  }
}

const invoiceSpec = (layout: InvoiceLayoutConfig, data: InvoiceData = invoiceData) =>
  buildInvoicePrintSpec({ data, locale: 'en', template: { layoutConfig: layout } as never })

describe('an invoice with jobs', () => {
  it('prints the items table by job, in the jobs’ order, Other last, each with its subtotal', () => {
    const items = tableWith(invoiceSpec(preset('itemized')), 'n')
    expect(read(items)).toEqual([
      '# Front brakes',
      '- Replace discs',
      '- Brake disc',
      '= Front brakes subtotal $400.00',
      '# Oil change',
      '- Oil change labour',
      '- Oil filter',
      '= Oil change subtotal $85.00',
      '# Other',
      '- Wiper blade',
      '= Other subtotal $96.00',
    ])
    // Numbered in print order.
    expect(items?.rows.filter((r) => r.n).map((r) => r.n)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('prints the parts and the labor tables by job too', () => {
    const spec = invoiceSpec(preset('classic'))
    expect(read(tableWith(spec, 'ref'))).toEqual([
      '# Front brakes',
      '- Brake disc',
      '= Front brakes subtotal $150.00',
      '# Oil change',
      '- Oil filter',
      '= Oil change subtotal $15.00',
      '# Other',
      '- Wiper blade',
      '= Other subtotal $96.00',
    ])
    expect(read(tableWith(spec, 'rate'))).toEqual([
      '# Front brakes',
      '- Replace discs',
      '= Front brakes subtotal $250.00',
      '# Oil change',
      '- Oil change labour',
      '= Oil change subtotal $70.00',
    ])
  })

  it('keeps a layout’s own choice: none prints flat, category by category', () => {
    const flat = tableWith(invoiceSpec(withGroupBy(preset('itemized'), 'none')), 'n')
    expect(read(flat).every((line) => line.startsWith('- '))).toBe(true)
    const categories = tableWith(invoiceSpec(withGroupBy(preset('itemized'), 'category')), 'n')
    expect(read(categories)).not.toContain('# Front brakes')
  })

  it('prints flat without jobs, as upstream does', () => {
    const data = { ...invoiceData, workJobs: [] } as unknown as InvoiceData
    expect(
      read(tableWith(invoiceSpec(preset('itemized'), data), 'n')).every((l) => l.startsWith('- '))
    ).toBe(true)
  })
})

describe('an invoice with a declined job', () => {
  it('prints its lines under the job, marked, with no subtotal (the totals leave them out)', () => {
    const data = {
      ...invoiceData,
      workJobs: [
        { id: 'j-brakes', name: 'Front brakes', ordinal: 0, authorizationStatus: 'Declined' },
        { id: 'j-oil', name: 'Oil change', ordinal: 1 },
      ],
    } as unknown as InvoiceData
    const rows = read(tableWith(invoiceSpec(preset('itemized'), data), 'n'))
    expect(rows.slice(0, 3)).toEqual([
      '# Front brakes (declined)',
      '- Replace discs',
      '- Brake disc',
    ])
    expect(rows).not.toContain('= Front brakes subtotal $400.00')
    expect(rows).toContain('= Oil change subtotal $85.00')
  })
})

describe('a quote with jobs', () => {
  it('prints by job, a declined line struck and out of its job’s subtotal', () => {
    const quote = {
      ...(invoiceData as unknown as Record<string, unknown>),
      quoteNumber: 'Q-1',
      status: 'draft',
      createdAt: new Date('2026-09-26T09:00:00Z'),
      validUntil: null,
      notes: null,
      discountType: null,
      discountValue: 0,
      discountAmount: 0,
      laborItems: [
        {
          description: 'Oil change labour',
          hours: 1,
          rate: 70,
          total: 70,
          jobId: 'j-oil',
          excluded: true,
        },
        { description: 'Replace discs', hours: 2.5, rate: 100, total: 250, jobId: 'j-brakes' },
      ],
    }
    const spec = buildQuotePrintSpec({ data: quote, layoutConfig: preset('itemized') } as never)
    const items = tableWith(spec, 'n')
    expect(read(items)).toContain('= Oil change subtotal $15.00')
    expect(items?.rows.find((r) => r.desc === 'Oil change labour')?.struck).toBe('1')
  })
})
