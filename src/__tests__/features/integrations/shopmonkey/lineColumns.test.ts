/**
 * fork: an edit in the app keeps an imported line's job, kind, technician, cost and source fields (M5 task 12),
 * although the form sends none of them and no line ids.
 */
import { describe, expect, it } from 'vitest'
import {
  carryLineColumns,
  forkColumnsOf,
  LABOR_LINE_COLUMNS,
  LABOR_MATCH,
  matchLines,
  PART_LINE_COLUMNS,
  PART_MATCH,
} from '@/integrations/shopmonkey/schema/lineColumns'

const part = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  partNumber: `PN-${name}`,
  jobId: `job-${name}`,
  lineKind: 'part',
  discountAmount: null,
  note: `note ${name}`,
  sourceExtra: { bin: name },
  ...extra,
})

const sent = (name: string, partNumber = `PN-${name}`) => ({ name, partNumber, quantity: 1 })

describe('carrying the fork columns of the lines a save replaces', () => {
  it('keeps them on lines moved to another place in the list', () => {
    const previous = [part('a'), part('b'), part('c')]
    const out = carryLineColumns(
      previous,
      [sent('c'), sent('a'), sent('b')],
      PART_MATCH,
      PART_LINE_COLUMNS
    )
    expect(out.map((l) => (l as Record<string, unknown>).jobId)).toEqual([
      'job-c',
      'job-a',
      'job-b',
    ])
    expect(out[0]).toMatchObject({ lineKind: 'part', note: 'note c', sourceExtra: { bin: 'c' } })
  })

  it('gives a line added in the same save none, and keeps the rest when one is removed', () => {
    const out = carryLineColumns(
      [part('a'), part('b')],
      [sent('b'), sent('new')],
      PART_MATCH,
      PART_LINE_COLUMNS
    )
    expect(out[0]).toMatchObject({ jobId: 'job-b' })
    expect(out[1]).toEqual(sent('new'))
  })

  it('keeps them on a renamed part that kept its part number', () => {
    const out = carryLineColumns(
      [part('a'), part('b')],
      [sent('a'), sent('b renamed', 'PN-b'), sent('new')],
      PART_MATCH,
      PART_LINE_COLUMNS
    )
    expect(out[1]).toMatchObject({ name: 'b renamed', jobId: 'job-b', note: 'note b' })
    expect(out[2]).toEqual(sent('new'))
  })

  it('does not guess for a part renamed and renumbered, or a renamed labor line', () => {
    const parts = carryLineColumns(
      [part('a'), part('b')],
      [sent('a'), sent('b renamed', 'PN-other')],
      PART_MATCH,
      PART_LINE_COLUMNS
    )
    expect(parts[1]).toEqual(sent('b renamed', 'PN-other'))
    const labor = carryLineColumns(
      [{ description: 'Brakes', pricingType: 'hourly', technicianId: 'tech-1' }],
      [{ description: 'Brakes, front', pricingType: 'hourly' }],
      LABOR_MATCH,
      LABOR_LINE_COLUMNS
    )
    expect(labor[0]).toEqual({ description: 'Brakes, front', pricingType: 'hourly' })
  })

  it('pairs lines with the same name in order, each taken once', () => {
    const previous = [part('a', { jobId: 'job-1' }), part('a', { jobId: 'job-2' })]
    expect(matchLines(previous, [sent('a'), sent('a')], PART_MATCH).map((p) => p?.jobId)).toEqual([
      'job-1',
      'job-2',
    ])
  })

  it('leaves a column the incoming line sets itself, and carries no nulls', () => {
    const out = carryLineColumns(
      [part('a', { note: null })],
      [{ ...sent('a'), jobId: 'mine' }],
      PART_MATCH,
      PART_LINE_COLUMNS
    )
    expect(out[0]).toMatchObject({ jobId: 'mine', lineKind: 'part' })
    expect(out[0]).not.toHaveProperty('note')
  })

  it('matches labor by description and pricing, carrying technician and cost', () => {
    const previous = [
      {
        description: 'Brake job',
        pricingType: 'hourly',
        jobId: 'job-1',
        lineKind: 'labor',
        technicianId: 'tech-1',
        completed: true,
        costHours: 1.5,
        costRate: 30,
        discountAmount: null,
        sourceExtra: null,
      },
      {
        description: 'Shop supplies',
        pricingType: 'shopFee',
        jobId: null,
        lineKind: 'shopSupplies',
        technicianId: null,
        completed: null,
        costHours: null,
        costRate: null,
        discountAmount: null,
        sourceExtra: null,
      },
    ]
    const out = carryLineColumns(
      previous,
      [
        { description: 'Shop supplies', pricingType: 'shopFee', hours: 1 },
        { description: 'Brake job', pricingType: 'hourly', hours: 2 },
      ],
      LABOR_MATCH,
      LABOR_LINE_COLUMNS
    )
    expect(out[0]).toEqual({
      description: 'Shop supplies',
      pricingType: 'shopFee',
      hours: 1,
      lineKind: 'shopSupplies',
    })
    expect(out[1]).toMatchObject({
      hours: 2,
      jobId: 'job-1',
      technicianId: 'tech-1',
      completed: true,
      costHours: 1.5,
      costRate: 30,
    })
  })

  it('picks only the columns asked for, for a create that lists its fields', () => {
    expect(
      forkColumnsOf({ ...part('a'), technicianId: 'tech-1', name: 'a' }, PART_LINE_COLUMNS)
    ).toEqual({ jobId: 'job-a', lineKind: 'part', note: 'note a', sourceExtra: { bin: 'a' } })
  })
})
