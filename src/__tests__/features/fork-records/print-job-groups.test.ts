/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 2): how a printed sheet divides its lines by job, and the
 * designer's choice for it. SYNTHETIC data.
 */
import { describe, expect, it } from 'vitest'
import {
  groupByFor,
  groupingOptions,
  groupingValue,
  offersGrouping,
} from '@/features/fork-records/Lib/designerJobGrouping'
import {
  groupingOf,
  jobGroupKey,
  jobGroupsFor,
  NO_JOB_GROUP,
  sampleJobs,
  uncountedLinesLeftOut,
} from '@/features/fork-records/Lib/printJobGroups'

const jobs = [
  { id: 'j2', name: 'Oil change', ordinal: 1 },
  { id: 'j1', name: 'Brakes', ordinal: 0 },
]
const money = (amount: number) => `$${amount.toFixed(2)}`
const shown = (amount: number) => amount

describe('jobGroupsFor', () => {
  it('makes one group per job in the jobs’ order, then Other, each with its subtotal', () => {
    const groups = jobGroupsFor({
      jobs,
      lines: [
        { jobId: 'j2', total: 70 },
        { jobId: 'j1', total: 250 },
        { jobId: 'j1', total: 96 },
        { jobId: null, total: 15 },
      ],
      labels: {},
      shown,
      money,
    })
    expect(groups).toEqual([
      { key: 'job:j1', title: 'Brakes', subtotalLabel: 'Brakes subtotal', subtotal: '$346.00' },
      {
        key: 'job:j2',
        title: 'Oil change',
        subtotalLabel: 'Oil change subtotal',
        subtotal: '$70.00',
      },
      { key: NO_JOB_GROUP, title: 'Other', subtotalLabel: 'Other subtotal', subtotal: '$15.00' },
    ])
  })

  it('leaves out a job with no lines, and a declined line from its job’s subtotal', () => {
    const groups = jobGroupsFor({
      jobs,
      lines: [
        { jobId: 'j1', total: 250 },
        { jobId: 'j1', total: 96, excluded: true },
      ],
      labels: { otherJobLines: 'Annet', groupSubtotal: 'Sum {group}' },
      shown,
      money,
    })
    expect(groups).toEqual([
      { key: 'job:j1', title: 'Brakes', subtotalLabel: 'Sum Brakes', subtotal: '$250.00' },
    ])
  })

  it('marks a declined or deferred job, and drops a subtotal only for lines left out of the totals', () => {
    const jobs3 = [
      { id: 'j1', name: 'Brakes', ordinal: 0, authorizationStatus: 'Declined' },
      { id: 'j2', name: 'Tyres', ordinal: 1, deferredDate: new Date('2026-10-01T00:00:00Z') },
      { id: 'j3', name: 'Oil', ordinal: 2, authorizationStatus: 'Authorized' },
    ]
    const read = (groups: ReturnType<typeof jobGroupsFor>) =>
      groups?.map((g) => [g.title, g.excluded ?? false])
    // Lines the totals count (a work order edited in the app): the subtotal stays.
    const invoice = jobGroupsFor({
      jobs: jobs3,
      lines: [
        { jobId: 'j1', total: 250 },
        { jobId: 'j2', total: 400 },
        { jobId: 'j3', total: 70 },
      ],
      labels: {},
      shown,
      money,
    })
    expect(read(invoice)).toEqual([
      ['Brakes (declined)', false],
      ['Tyres (deferred)', false],
      ['Oil', false],
    ])
    // Lines left out of the totals (a quote's struck lines, an imported invoice's): no subtotal.
    const quote = jobGroupsFor({
      jobs: jobs3,
      lines: [
        { jobId: 'j1', total: 250, excluded: true },
        { jobId: 'j2', total: 400, excluded: true },
        { jobId: 'j3', total: 70 },
      ],
      labels: {},
      shown,
      money,
    })
    expect(read(quote)).toEqual([
      ['Brakes (declined)', true],
      ['Tyres (deferred)', true],
      ['Oil', false],
    ])
    // The importer's rule exactly: only `Declined`.
    expect(
      jobGroupsFor({
        jobs: [{ id: 'j1', name: 'Brakes', ordinal: 0, authorizationStatus: 'declined' }],
        lines: [{ jobId: 'j1', total: 1 }],
        labels: {},
        shown,
        money,
      })?.[0].title
    ).toBe('Brakes')
  })

  it('reads from a work order’s stored subtotal whether it leaves a declined job’s lines out', () => {
    const jobs2 = [
      { id: 'j1', name: 'Brakes', ordinal: 0, authorizationStatus: 'Declined' },
      { id: 'j2', name: 'Oil', ordinal: 1 },
    ]
    const lines = [
      { jobId: 'j1', total: 250 },
      { jobId: 'j2', total: 70 },
      { jobId: null, total: 30 },
    ]
    // Imported: the subtotal is the other lines' sum.
    const imported = uncountedLinesLeftOut(jobs2, lines, 100)
    expect(lines.map(imported)).toEqual([true, false, false])
    // Edited in the app: every line counted.
    expect(lines.map(uncountedLinesLeftOut(jobs2, lines, 350))).toEqual([false, false, false])
    // No declined or deferred job, or no subtotal to read: nothing is left out.
    expect(lines.map(uncountedLinesLeftOut([jobs2[1]], lines, 100))).toEqual([false, false, false])
    expect(lines.map(uncountedLinesLeftOut(jobs2, lines, undefined))).toEqual([false, false, false])
  })

  it('reads cents and shop fee lines exactly, and gives any group whose every line is struck no subtotal', () => {
    const jobs2 = [
      { id: 'j1', name: 'Brakes', ordinal: 0 },
      { id: 'j2', name: 'Wipers', ordinal: 1, authorizationStatus: 'Declined' },
    ]
    const lines = [
      { jobId: 'j1', total: 0.1 },
      { jobId: 'j1', total: 0.2, pricingType: 'shopFee' },
      { jobId: 'j2', total: 0.3 },
    ]
    // 0.1 + 0.2 is 0.30000000000000004: still the counted lines' sum.
    expect(lines.map(uncountedLinesLeftOut(jobs2, lines, 0.3))).toEqual([false, false, true])
    expect(lines.map(uncountedLinesLeftOut(jobs2, lines, 0.6))).toEqual([false, false, false])
    const groups = jobGroupsFor({
      jobs: [{ id: 'j1', name: 'Brakes', ordinal: 0 }],
      lines: [
        { jobId: 'j1', total: 5, excluded: true },
        { jobId: null, total: 2, excluded: true },
        { jobId: null, total: 1 },
      ],
      labels: {},
      shown,
      money,
    })
    expect(groups?.map((g) => [g.title, g.excluded ?? false])).toEqual([
      ['Brakes', true],
      ['Other', false],
    ])
  })

  it('is nothing when no line has a job, so the sheet prints flat', () => {
    expect(
      jobGroupsFor({
        jobs,
        lines: [{ total: 1 }, { jobId: null, total: 2 }],
        labels: {},
        shown,
        money,
      })
    ).toBeUndefined()
  })

  it('never puts a line under a job the document doesn’t list', () => {
    expect(jobGroupKey(jobs, 'j-elsewhere')).toBe(NO_JOB_GROUP)
    expect(jobGroupKey(jobs, 'j1')).toBe('job:j1')
    expect(
      jobGroupsFor({ jobs, lines: [{ jobId: 'j-elsewhere', total: 5 }], labels: {}, shown, money })
    ).toBeUndefined()
  })
})

describe('groupingOf', () => {
  it('takes the section’s choice, and by job for a document with jobs when it made none', () => {
    expect(groupingOf('category', true)).toBe('category')
    expect(groupingOf('job', false)).toBe('job')
    expect(groupingOf('none', true)).toBeNull()
    expect(groupingOf(undefined, true)).toBe('job')
    expect(groupingOf(undefined, false)).toBeNull()
    expect(groupingOf(undefined, undefined)).toBeNull()
  })
})

describe('sampleJobs', () => {
  it('puts the designer’s sample under two jobs named by its categories', () => {
    const items = [
      { amount: 222.5 },
      { sku: 'BD', category: 'Brakes', amount: 149 },
      { sku: 'BP', category: 'Brakes', amount: 96.5 },
      { sku: 'OIL', category: 'Service', amount: 40 },
    ]
    const { keyOf, groups } = sampleJobs(items, {}, money)
    expect(items.map(keyOf)).toEqual([
      'job:sample-1',
      'job:sample-1',
      'job:sample-1',
      'job:sample-2',
    ])
    const read = (list: { title: string; subtotal: string }[] = []) =>
      list.map((g) => [g.title, g.subtotal])
    expect(read(groups.items)).toEqual([
      ['Brakes', '$468.00'],
      ['Service', '$40.00'],
    ])
    // Each table adds up its own lines: the parts table the parts, the labor table the labor.
    expect(read(groups.parts)).toEqual([
      ['Brakes', '$245.50'],
      ['Service', '$40.00'],
    ])
    expect(read(groups.labor)).toEqual([['Brakes', '$222.50']])
  })
})

describe('the designer’s Group lines choice', () => {
  const labels = { none: 'None', category: 'Category', job: 'By job' }

  it('is upstream’s, unchanged, for a workshop without jobs', () => {
    expect(offersGrouping('items_table', true, false)).toBe(true)
    expect(offersGrouping('labor_table', false, false)).toBe(false)
    expect(groupingOptions('items_table', false, labels).map((o) => o.value)).toEqual([
      'none',
      'category',
    ])
    expect(groupingValue(undefined, false)).toBe('none')
    expect(groupByFor('none', false)).toBeUndefined()
    expect(groupByFor('category', false)).toBe('category')
  })

  it('offers By job, on the labor table too, and shows unset as By job, for a workshop with jobs', () => {
    expect(offersGrouping('labor_table', false, true)).toBe(true)
    expect(groupingOptions('items_table', true, labels).map((o) => o.value)).toEqual([
      'none',
      'category',
      'job',
    ])
    expect(groupingOptions('labor_table', true, labels).map((o) => o.value)).toEqual([
      'none',
      'job',
    ])
    expect(groupingValue(undefined, true)).toBe('job')
    expect(groupByFor('none', true)).toBe('none')
    expect(groupByFor('job', true)).toBe('job')
  })
})
