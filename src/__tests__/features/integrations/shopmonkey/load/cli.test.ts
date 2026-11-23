/**
 * fork: the load CLI's arguments and the summary it prints (M5 tasks 9 and 11). SYNTHETIC values.
 */
import { describe, expect, it } from 'vitest'
import { formatLoadSummary, parseLoadArgs } from '@/integrations/shopmonkey/load/cli'
import { unitSystemOf } from '@/integrations/shopmonkey/load/proposals'
import type { LoadSummary } from '@/integrations/shopmonkey/load/run'

describe('load arguments', () => {
  it('reads the connection and the flags', () => {
    expect(parseLoadArgs(['load', '--connection', 'c1'])).toEqual({
      connection: 'c1',
      dryRun: false,
      applyNumbering: false,
      applySettings: false,
      user: null,
    })
    expect(
      parseLoadArgs([
        'load',
        '--connection',
        'c1',
        '--apply-numbering',
        '--apply-settings',
        '--user',
        'u1',
      ])
    ).toMatchObject({ applyNumbering: true, applySettings: true, user: 'u1' })
    expect(parseLoadArgs(['load', '--connection', 'c1', '--dry-run']).dryRun).toBe(true)
  })

  it('refuses what it can’t do', () => {
    expect(() => parseLoadArgs(['load'])).toThrow('--connection is required')
    expect(() => parseLoadArgs(['load', '--connection'])).toThrow('needs a value')
    expect(() => parseLoadArgs(['load', '--connection', 'c1', '--force'])).toThrow(
      'Unknown option --force'
    )
    expect(() => parseLoadArgs(['extract', '--connection', 'c1'])).toThrow('Usage: run.ts load')
    expect(() =>
      parseLoadArgs(['load', '--connection', 'c1', '--dry-run', '--apply-numbering'])
    ).toThrow('A dry run applies nothing')
  })
})

const counts = (created: number, updated = 0, unchanged = 0) => ({
  created,
  updated,
  unchanged,
  skipped: 0,
  failed: 0,
})

const summary = (extra: Partial<LoadSummary> = {}): LoadSummary => ({
  runId: 'run-1',
  dryRun: false,
  counts: { customer: counts(3), vehicle: counts(0, 1, 2), quote: counts(0) },
  warnings: { vehicle_multiple_owners: 2 },
  failures: [{ table: 'order', remoteId: 'syn_ord_9', error: 'PrismaClientKnownRequestError' }],
  batches: {},
  issued: 2,
  mileageUnit: 'Mile',
  proposals: {
    numbering: {
      highest: '1004',
      changes: [{ key: 'workshop.invoicePrefix', current: '{year}-', proposed: '' }],
    },
    settings: [{ key: 'workshop.defaultTaxRate', current: null, proposed: '8.25' }],
    workshopName: null,
  },
  applied: [],
  ...extra,
})

describe('the summary', () => {
  it('lists what changed per table, warnings, failures and how to apply the proposals', () => {
    const lines = formatLoadSummary(summary())
    expect(lines).toEqual([
      'Load run-1:',
      '  customer: 3 new, 0 updated, 0 unchanged',
      '  vehicle: 0 new, 1 updated, 2 unchanged',
      '  invoices issued: 2',
      'Warnings:',
      '  vehicle_multiple_owners: 2',
      'Failed records (the rest loaded):',
      '  order syn_ord_9: PrismaClientKnownRequestError',
      'Highest imported number: 1004',
      'Numbering (apply with --apply-numbering):',
      '  workshop.invoicePrefix: "{year}-" → ""',
      'Settings (apply with --apply-settings):',
      '  workshop.defaultTaxRate: null → "8.25"',
    ])
  })

  it('says a dry run kept nothing, and marks what a run applied', () => {
    expect(formatLoadSummary(summary({ dryRun: true }))[0]).toBe(
      'Dry run run-1: nothing was kept. A real run would change:'
    )
    expect(formatLoadSummary(summary({ dryRun: true }))).not.toContain('  invoices issued: 2')
    expect(formatLoadSummary(summary({ applied: ['workshop.invoicePrefix'] }))).toContain(
      'Numbering (applied):'
    )
  })
})

describe('the unit system Shopmonkey’s vehicles imply', () => {
  it('reads miles and kilometers, and nothing else', () => {
    expect(unitSystemOf('Mile')).toBe('imperial')
    expect(unitSystemOf('Kilometer')).toBe('metric')
    expect(unitSystemOf('Hours')).toBeNull()
    expect(unitSystemOf(null)).toBeNull()
  })
})
