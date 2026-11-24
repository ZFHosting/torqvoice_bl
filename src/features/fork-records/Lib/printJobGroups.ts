/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 2): the job groups a printed sheet divides its lines into.
 *
 * A Shopmonkey order is a list of services (`WorkJob`), each with its own lines; printed, each job reads as its name,
 * its lines and its subtotal. Computed once by each print builder from the real lines, as the category groups are
 * (`lineGroups.ts`), and handed to the spec as worded strings; a line's `job` names its entry here.
 */

import type { LineGroup } from '@/features/invoice-designer/Spec/buildSpec'

/** The group of the lines that belong to no job. */
export const NO_JOB_GROUP = 'job:none'

/** A job as the print builders read it. */
export interface PrintJob {
  id: string
  name: string
  ordinal: number
}

/**
 * What a print reads of a document's jobs, as the `workJobs` of its work order or quote query (an include, so the
 * document and its jobs come in one read).
 */
export const PRINT_JOBS = {
  orderBy: [{ ordinal: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }],
  select: { id: true, name: true, ordinal: true },
}

/**
 * A sheet's job groups, one set per table: the items table holds every line, the parts and labor tables only their
 * own, so each subtotal adds up the lines printed above it.
 */
export interface JobGroups {
  items?: LineGroup[]
  parts?: LineGroup[]
  labor?: LineGroup[]
}

/** The set a table section prints with. */
export function jobGroupsOfTable(
  groups: JobGroups | undefined,
  sectionId: string
): LineGroup[] | undefined {
  if (sectionId === 'parts_table') return groups?.parts
  if (sectionId === 'labor_table') return groups?.labor
  return groups?.items
}

/** How a table of lines is divided: the section's choice, or the workshop's default when it made none. */
export type LineGrouping = 'category' | 'job' | null

/**
 * The key of a line's job group: its job's, or the catch-all when it has no job or a job the document doesn't list
 * (a line never prints under another record's heading).
 */
export function jobGroupKey(jobs: readonly PrintJob[], jobId: string | null | undefined): string {
  return jobId && jobs.some((job) => job.id === jobId) ? `job:${jobId}` : NO_JOB_GROUP
}

/**
 * The grouping a table prints with. `groupBy` set on the section wins (`none` is the choice to print flat). Unset, a
 * document with jobs groups by job, as a Shopmonkey order printed there (`groupByJobByDefault`, which the builders set
 * from the document's jobs), and every other document prints flat, as upstream's do. An issued invoice too: its jobs
 * are locked with it, and none was issued with jobs before job grouping existed (jobs come from the fork's import and
 * API).
 */
export function groupingOf(
  groupBy: 'category' | 'job' | 'none' | undefined,
  groupByJobByDefault: boolean | undefined
): LineGrouping {
  if (groupBy === 'category' || groupBy === 'job') return groupBy
  if (groupBy === 'none') return null
  return groupByJobByDefault ? 'job' : null
}

/** The group a line's `job` key names on a sheet that groups by job (`jobGroupKey`), for the builders. */
export const jobKeyer =
  (jobs: readonly PrintJob[] | undefined) => (jobId: string | null | undefined) =>
    jobGroupKey(jobs ?? [], jobId)

interface JobGroupInput {
  jobs: readonly PrintJob[]
  lines: { jobId?: string | null; total: number; excluded?: boolean; taxable?: boolean | null }[]
  labels: Record<string, string>
  /** A line total as the sheet shows it (before or after tax), as `lineGroupsFor` takes it. */
  shown: (amount: number, taxable?: boolean) => number
  money: (amount: number) => string
}

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((str, [key, val]) => str.replace(`{${key}}`, val), template)
}

/**
 * One group per job that has lines, in the jobs' order, then the lines of no job under "Other". Nothing at all
 * when no line has a job: a sheet asked to group by job then prints flat, as one with no categories does.
 */
export function jobGroupsFor(input: JobGroupInput): LineGroup[] | undefined {
  const { jobs, labels, shown, money } = input
  const L = (key: string, fallback: string) => labels[key] || fallback
  const keyed = input.lines.map((line) => ({ line, key: jobGroupKey(jobs, line.jobId) }))
  if (!keyed.some((entry) => entry.key !== NO_JOB_GROUP)) return undefined

  const subtotalOf = (lines: JobGroupInput['lines']) =>
    money(
      lines.reduce(
        (sum, line) => (line.excluded ? sum : sum + shown(line.total, line.taxable !== false)),
        0
      )
    )
  const group = (key: string, title: string): LineGroup | null => {
    const lines = keyed.filter((entry) => entry.key === key).map((entry) => entry.line)
    if (!lines.length) return null
    return {
      key,
      title,
      subtotalLabel: fill(L('groupSubtotal', '{group} subtotal'), { group: title }),
      subtotal: subtotalOf(lines),
    }
  }

  const ordered = [...jobs].sort((a, b) => a.ordinal - b.ordinal)
  const groups = ordered.map((job) => group(`job:${job.id}`, job.name))
  groups.push(group(NO_JOB_GROUP, L('otherJobLines', 'Other')))
  return groups.filter((g): g is LineGroup => g !== null)
}

/**
 * The designer's sample under two jobs, so "By job" previews as it prints: the labor and the first category's parts
 * as the first job, everything else as the second, each named by its category in the sample's language.
 */
export function sampleJobs<I extends { sku?: string; category?: string; amount: number }>(
  items: readonly I[],
  labels: Record<string, string>,
  money: (amount: number) => string
): { keyOf: (item: I) => string; groups: JobGroups } {
  const L = (key: string, fallback: string) => labels[key] || fallback
  const categories = [
    ...new Set(items.flatMap((item) => (item.sku && item.category ? [item.category] : []))),
  ]
  const inFirst = (item: I) => !item.sku || item.category === categories[0]
  const keyOf = (item: I) => (inFirst(item) ? 'job:sample-1' : 'job:sample-2')
  const titles: Record<string, string> = {
    'job:sample-1': categories[0] ?? L('labor', 'Labor'),
    'job:sample-2': categories[1] ?? L('otherJobLines', 'Other'),
  }
  const groupsOf = (lines: readonly I[]): LineGroup[] =>
    ['job:sample-1', 'job:sample-2'].flatMap((key) => {
      const members = lines.filter((item) => keyOf(item) === key)
      if (!members.length) return []
      return [
        {
          key,
          title: titles[key],
          subtotalLabel: fill(L('groupSubtotal', '{group} subtotal'), { group: titles[key] }),
          subtotal: money(members.reduce((sum, item) => sum + item.amount, 0)),
        },
      ]
    })
  return {
    keyOf,
    groups: {
      items: groupsOf(items),
      parts: groupsOf(items.filter((item) => item.sku)),
      labor: groupsOf(items.filter((item) => !item.sku)),
    },
  }
}
