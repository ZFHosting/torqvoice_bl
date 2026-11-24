/**
 * @vitest-environment node
 *
 * fork: the cutover command's arguments and closing lines (M7, `scripts/shopmonkey/run.ts cutover`).
 */
import { describe, expect, it } from 'vitest'
import {
  CUTOVER_USAGE,
  formatCutoverResult,
  parseCutoverArgs,
} from '@/integrations/shopmonkey/sync/cli'
import type { CutoverResult } from '@/integrations/shopmonkey/sync/cutover'

describe('parseCutoverArgs', () => {
  it('reads the connection, the operator’s word, a dry run and the member', () => {
    expect(
      parseCutoverArgs([
        'cutover',
        '--connection',
        'conn_1',
        '--shop-stopped',
        '--dry-run',
        '--user',
        'user_1',
      ])
    ).toEqual({ connection: 'conn_1', shopStopped: true, dryRun: true, user: 'user_1' })
    expect(parseCutoverArgs(['cutover', '--connection', 'conn_1'])).toEqual({
      connection: 'conn_1',
      shopStopped: false,
      dryRun: false,
      user: null,
    })
  })

  it('refuses a missing connection, a flag without its value and an unknown flag', () => {
    expect(() => parseCutoverArgs(['cutover', '--shop-stopped'])).toThrow(
      /--connection is required/
    )
    expect(() => parseCutoverArgs(['cutover', '--connection'])).toThrow(/needs a value/)
    expect(() => parseCutoverArgs(['cutover', '--connection', 'c', '--force'])).toThrow(
      /Unknown option --force/
    )
    expect(() => parseCutoverArgs(['load', '--connection', 'c'])).toThrow(CUTOVER_USAGE)
  })
})

describe('formatCutoverResult', () => {
  const result = (over: Partial<CutoverResult>): CutoverResult => ({
    dryRun: false,
    completed: true,
    stoppedAt: null,
    steps: [],
    reconciliation: null,
    ...over,
  })

  it('says what happened, and where it stopped', () => {
    expect(formatCutoverResult(result({}))).toEqual([
      'Cut over. Torqvoice no longer follows Shopmonkey.',
    ])
    expect(formatCutoverResult(result({ dryRun: true }))).toEqual([
      'Dry run: every step would go ahead. Nothing in the workshop was changed.',
    ])
    expect(formatCutoverResult(result({ completed: false, stoppedAt: 3 }))).toEqual([
      'Stopped at step 3. Nothing after it was done.',
    ])
    expect(formatCutoverResult(result({ dryRun: true, completed: false, stoppedAt: 1 }))).toEqual([
      'Stopped at step 1 (dry run). Nothing after it was tried.',
    ])
  })
})
