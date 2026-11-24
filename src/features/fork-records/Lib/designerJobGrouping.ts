/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 2): the invoice designer's "Group lines" choice for a
 * workshop that has jobs. It adds "By job" to the items and parts tables and offers it on the labor table (labor has no
 * category), and shows what an unset choice prints: by job, for a document with jobs (printJobGroups.ts). A workshop
 * without jobs keeps upstream's choice exactly, unset included.
 */

type GroupBy = 'category' | 'job' | 'none' | undefined

/** Whether the section offers a grouping at all. */
export function offersGrouping(sectionId: string, upstream: boolean, usesJobs: boolean): boolean {
  return upstream || (usesJobs && sectionId === 'labor_table')
}

/** The value the choice shows. */
export function groupingValue(groupBy: GroupBy, usesJobs: boolean): 'category' | 'job' | 'none' {
  return groupBy ?? (usesJobs ? 'job' : 'none')
}

/** The options, upstream's first, each with its label. */
export function groupingOptions(
  sectionId: string,
  usesJobs: boolean,
  labels: { none: string; category: string; job: string }
): { value: string; label: string }[] {
  return [
    { value: 'none', label: labels.none },
    ...(sectionId === 'labor_table' ? [] : [{ value: 'category', label: labels.category }]),
    ...(usesJobs ? [{ value: 'job', label: labels.job }] : []),
  ]
}

/** What the section stores for a choice: upstream's unset for "none" where unset prints flat, said out loud otherwise. */
export function groupByFor(choice: string, usesJobs: boolean): GroupBy {
  if (choice === 'category') return 'category'
  if (choice === 'job') return 'job'
  return usesJobs ? 'none' : undefined
}
