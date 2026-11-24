'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Layers, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { AppCard } from '@/components/app-card'
import { useConfirm } from '@/components/confirm-dialog'
import { useFormatCurrency } from '@/components/currency-settings-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { createWorkJob } from '../Actions/createWorkJob'
import { deleteWorkJob } from '../Actions/deleteWorkJob'
import { getWorkJobs } from '../Actions/getWorkJobs'
import { reorderWorkJobs } from '../Actions/reorderWorkJobs'
import { updateWorkJob } from '../Actions/updateWorkJob'
import type { JobParent } from '../Schema/workJobActionSchemas'

/** A Select can't hold an empty value: "no job" is this. */
const NO_JOB = 'none'

const jobsViewSchema = z.object({
  usesJobs: z.boolean(),
  jobs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      note: z.string().nullable(),
      authorizationStatus: z.string().nullable(),
    })
  ),
})
type JobsView = z.infer<typeof jobsViewSchema>
type Job = JobsView['jobs'][number]

/** A line of the form, as the card reads it: labor has a description, a part a name. */
type FormLine = {
  description?: string
  name?: string
  total: number
  jobId?: string | null
  excluded?: boolean
}

interface Line {
  kind: 'labor' | 'part'
  index: number
  label: string
  total: number
  jobId: string | null
  excluded: boolean
}

/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md task 1): the lines of a work order or a quote under their jobs
 * (a Shopmonkey order's services), with the lines of no job under "Other". Jobs are added, edited, reordered and
 * deleted at once; a line moves between jobs in the form, saved with the rest of it. Mounted only for a workshop that
 * has jobs (an import or the API made them), with the jobs its page read on the server (`pageJobs.server.ts`): every
 * other workshop's page is as upstream draws it, and asks nothing more.
 */
export function WorkJobsCard({
  parent,
  initialJobs,
  laborItems,
  partItems,
  onMoveLine,
  locked,
}: {
  parent: JobParent
  /** The document's jobs as the page read them on the server. */
  initialJobs: Job[]
  laborItems: FormLine[]
  partItems: FormLine[]
  onMoveLine: (kind: 'labor' | 'part', index: number, jobId: string | null) => void
  locked: boolean
}) {
  const t = useTranslations('workJobs')
  const format = useFormatCurrency()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const queryKey = ['work-jobs', parent.kind, parent.id]
  const [mountedAt] = useState(() => Date.now())
  const query = useQuery<JobsView, Error>({
    queryKey,
    queryFn: async () => {
      const res = await getWorkJobs({ parent })
      if (!res.success) throw new Error(res.error ?? t('loadFailed'))
      return jobsViewSchema.parse(res.data)
    },
    // What the page read on the server, fresh for a minute: no second read on arrival.
    initialData: { usesJobs: true, jobs: initialJobs },
    initialDataUpdatedAt: mountedAt,
    staleTime: 60_000,
  })
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ job: Job | null } | null>(null)
  // A save refreshes the page, which reads the jobs again (the sync may have recreated them): the card takes those.
  const serverJobs = JSON.stringify(initialJobs)
  useEffect(() => {
    queryClient.setQueryData(['work-jobs', parent.kind, parent.id], {
      usesJobs: true,
      jobs: JSON.parse(serverJobs) as Job[],
    })
  }, [queryClient, parent.kind, parent.id, serverJobs])

  const jobs = query.data?.jobs ?? []
  const lines = useMemo<Line[]>(() => {
    const known = new Set(jobs.map((job) => job.id))
    const own = (jobId: string | null | undefined) => (jobId && known.has(jobId) ? jobId : null)
    return [
      ...laborItems.map((l, index) => ({
        kind: 'labor' as const,
        index,
        label: l.description ?? '',
        total: l.total,
        jobId: own(l.jobId),
        excluded: Boolean(l.excluded),
      })),
      ...partItems.map((p, index) => ({
        kind: 'part' as const,
        index,
        label: p.name ?? '',
        total: p.total,
        jobId: own(p.jobId),
        excluded: Boolean(p.excluded),
      })),
    ]
  }, [jobs, laborItems, partItems])

  const refresh = () => queryClient.invalidateQueries({ queryKey })
  const run = async (write: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(true)
    try {
      const res = await write()
      if (!res.success) {
        toast.error(res.error ?? t('saveFailed'))
        return false
      }
      await refresh()
      return true
    } finally {
      setBusy(false)
    }
  }

  const move = (from: number, to: number) => {
    const ids = jobs.map((job) => job.id)
    const [id] = ids.splice(from, 1)
    ids.splice(to, 0, id)
    void run(() => reorderWorkJobs({ parent, jobIds: ids }))
  }

  const remove = async (job: Job) => {
    const ok = await confirm({
      title: t('deleteTitle', { name: job.name }),
      description: t('deleteDescription'),
      confirmLabel: t('delete'),
      destructive: true,
    })
    if (!ok) return
    const done = await run(() => deleteWorkJob({ parent, jobId: job.id }))
    // Its lines stay, ungrouped: the form says so too, so a save doesn't name the job that's gone.
    if (done) {
      for (const line of lines) if (line.jobId === job.id) onMoveLine(line.kind, line.index, null)
    }
  }

  const subtotal = (members: Line[]) =>
    members.reduce((sum, line) => (line.excluded ? sum : sum + line.total), 0)
  const other = lines.filter((line) => line.jobId === null)
  const disabled = locked || busy

  const lineRows = (members: Line[]) =>
    members.length === 0 ? (
      <p className="px-3 py-2 text-sm text-muted-foreground">{t('noLines')}</p>
    ) : (
      <ul className="divide-y">
        {members.map((line) => (
          <li
            key={`${line.kind}-${line.index}`}
            className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm"
          >
            <Badge variant="outline" className="shrink-0">
              {line.kind === 'labor' ? t('labor') : t('part')}
            </Badge>
            <span
              className={
                line.excluded
                  ? 'min-w-0 flex-1 truncate text-muted-foreground line-through'
                  : 'min-w-0 flex-1 truncate'
              }
            >
              {line.label || t('untitled')}
            </span>
            <span className="tabular-nums">{format(line.total)}</span>
            <Select
              value={line.jobId ?? NO_JOB}
              disabled={disabled}
              onValueChange={(value) =>
                onMoveLine(line.kind, line.index, value === NO_JOB ? null : value)
              }
            >
              <SelectTrigger
                className="h-8 w-44"
                aria-label={t('moveLine', { line: line.label || t('untitled') })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {jobs.map((job) => (
                  <SelectItem key={job.id} value={job.id}>
                    {job.name}
                  </SelectItem>
                ))}
                <SelectItem value={NO_JOB}>{t('other')}</SelectItem>
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
    )

  return (
    <AppCard
      icon={Layers}
      title={t('title')}
      badge={jobs.length || undefined}
      description={t('description')}
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setEditing({ job: null })}
        >
          <Plus className="h-4 w-4" />
          {t('addJob')}
        </Button>
      }
    >
      <div className="space-y-3">
        {jobs.map((job, i) => {
          const members = lines.filter((line) => line.jobId === job.id)
          return (
            <section key={job.id} aria-label={job.name} className="rounded-md border">
              <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
                <h3 className="font-medium">{job.name}</h3>
                {job.authorizationStatus && (
                  <Badge variant="secondary">{statusLabel(t, job.authorizationStatus)}</Badge>
                )}
                <span className="ml-auto text-sm tabular-nums">{format(subtotal(members))}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={disabled || i === 0}
                  aria-label={t('moveUp', { name: job.name })}
                  onClick={() => move(i, i - 1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={disabled || i === jobs.length - 1}
                  aria-label={t('moveDown', { name: job.name })}
                  onClick={() => move(i, i + 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={disabled}
                  aria-label={t('edit', { name: job.name })}
                  onClick={() => setEditing({ job })}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive"
                  disabled={disabled}
                  aria-label={t('deleteJob', { name: job.name })}
                  onClick={() => void remove(job)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </header>
              {job.note && (
                <p className="whitespace-pre-line px-3 pt-2 text-sm text-muted-foreground">
                  {job.note}
                </p>
              )}
              {lineRows(members)}
            </section>
          )
        })}
        {other.length > 0 && (
          <section aria-label={t('other')} className="rounded-md border">
            <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
              <h3 className="font-medium">{t('other')}</h3>
              <span className="ml-auto text-sm tabular-nums">{format(subtotal(other))}</span>
            </header>
            {lineRows(other)}
          </section>
        )}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <p className="text-xs text-muted-foreground">{t('saveHint')}</p>
      </div>
      {editing && (
        <JobDialog
          job={editing.job}
          onClose={() => setEditing(null)}
          onSave={async (fields) => {
            const done = await run(() =>
              editing.job
                ? updateWorkJob({ parent, jobId: editing.job.id, ...fields })
                : createWorkJob({ parent, ...fields })
            )
            if (done) setEditing(null)
          }}
        />
      )}
    </AppCard>
  )
}

/** Shopmonkey's statuses in the reader's language; anything else as the source wrote it. */
function statusLabel(t: ReturnType<typeof useTranslations>, status: string): string {
  const key = `status.${status.toLowerCase()}`
  return t.has(key) ? t(key) : status
}

function JobDialog({
  job,
  onClose,
  onSave,
}: {
  job: Job | null
  onClose: () => void
  onSave: (fields: { name: string; note: string | null }) => Promise<void>
}) {
  const t = useTranslations('workJobs')
  const [name, setName] = useState(job?.name ?? '')
  const [note, setNote] = useState(job?.note ?? '')
  const [saving, setSaving] = useState(false)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{job ? t('editTitle') : t('addTitle')}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          // The page's own form is its React parent: typing a job's name doesn't make the work order unsaved.
          onInput={(event) => event.stopPropagation()}
          onSubmit={async (event) => {
            // Nor does saving the job submit it: a job is saved on its own.
            event.preventDefault()
            event.stopPropagation()
            if (!name.trim()) return
            setSaving(true)
            try {
              await onSave({ name: name.trim(), note: note.trim() || null })
            } finally {
              setSaving(false)
            }
          }}
        >
          <DialogBody className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="work-job-name">{t('name')}</Label>
              <Input
                id="work-job-name"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="work-job-note">{t('note')}</Label>
              <Textarea
                id="work-job-note"
                value={note}
                maxLength={2000}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
