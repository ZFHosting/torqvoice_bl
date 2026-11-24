'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { DatabaseZap, Download, FlaskConical, Loader2, Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { AppCard } from '@/components/app-card'
import { handleGated } from '@/components/upgrade-gate'
import { useConfirm } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { queueShopmonkeyLoad } from '../Actions/queueShopmonkeyLoad'
import { resumeShopmonkeyExtract } from '../Actions/resumeShopmonkeyExtract'
import { startShopmonkeyImportExtract } from '../Actions/startShopmonkeyImportExtract'
import { stopShopmonkeyExtract } from '../Actions/stopShopmonkeyExtract'
import type { ImportView } from './types'
import { useWorkshopTime } from './useWorkshopTime'

type Counts = Record<string, { created: number; updated: number; failed: number }>

const written = (counts: Counts | undefined) =>
  Object.values(counts ?? {}).reduce((a, c) => a + (c?.created ?? 0) + (c?.updated ?? 0), 0)

/** fork (M8): the extract's progress per table, and the buttons that extract, stop, dry-run and load. */
export function ImportRunCard({
  view,
  onChanged,
}: {
  view: ImportView
  onChanged: () => Promise<void> | void
}) {
  const t = useTranslations('shopmonkeyImport.run')
  const confirm = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const extract = view.extract
  const cutOver = !!view.cutover
  // What the job queue has, not what the state last said: a job that died leaves no button stuck.
  const extracting = view.live.extract
  const loading = view.live.load
  // The sync's own runs are its to carry on; an operator's run its job stopped (or lost) can carry on.
  const resumable = !!extract && !extract.finishedAt && !extract.sync && !extracting
  const when = useWorkshopTime()

  const act = async (
    name: string,
    call: () => Promise<{ success: boolean; error?: string }>,
    done: string
  ) => {
    setBusy(name)
    const res = await call()
    setBusy(null)
    if (res.success) toast.success(done)
    else if (!handleGated(res)) toast.error(res.error || t('failed'))
    await onChanged()
  }

  const load = async (dryRun: boolean) => {
    if (!dryRun) {
      const ok = await confirm({
        title: t('confirmLoadTitle'),
        description: t('confirmLoadDescription'),
        confirmLabel: t('load'),
        cancelLabel: t('cancel'),
        icon: DatabaseZap,
      })
      if (!ok) return
    }
    await act(
      dryRun ? 'dry' : 'load',
      () => queueShopmonkeyLoad({ dryRun }),
      t('loadQueued', { kind: dryRun ? t('kindDryRun') : t('kindLoad') })
    )
  }

  const kind = view.loadRun?.dryRun ? t('kindDryRun') : t('kindLoad')
  const loadLine = (() => {
    const run = view.loadRun
    if (!run) return null
    if (run.status === 'queued') return t('loadQueued', { kind })
    if (run.status === 'running') return t('loadRunning', { kind })
    if (run.status === 'done') return t('loadDone', { kind, time: when(run.at) })
    if (run.status === 'refused') return t('loadRefused', { kind, message: run.message ?? '' })
    if (run.status === 'interrupted') return t('loadInterrupted', { kind })
    return t('loadFailed', { kind })
  })()

  return (
    <AppCard
      icon={Download}
      title={t('title')}
      description={t('description')}
      action={
        <div className="flex flex-wrap gap-2">
          {extracting && !extract?.sync ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => act('stop', stopShopmonkeyExtract, t('stopAsked'))}
            >
              {busy === 'stop' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Pause className="mr-1 h-3.5 w-3.5" />
              )}
              {t('stop')}
            </Button>
          ) : resumable ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || cutOver}
              onClick={() => act('resume', resumeShopmonkeyExtract, t('resumed'))}
            >
              {busy === 'resume' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1 h-3.5 w-3.5" />
              )}
              {t('resume')}
            </Button>
          ) : null}
          {!extracting && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || cutOver || loading || view.live.cutover}
              onClick={() => act('extract', startShopmonkeyImportExtract, t('extractQueued'))}
            >
              {busy === 'extract' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1 h-3.5 w-3.5" />
              )}
              {extract ? t('extractAgain') : t('extract')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || cutOver || extracting || loading || !extract?.finishedAt}
            onClick={() => load(true)}
          >
            {busy === 'dry' ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConical className="mr-1 h-3.5 w-3.5" />
            )}
            {t('dryRun')}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null || cutOver || extracting || loading || !extract?.finishedAt}
            onClick={() => load(false)}
          >
            {busy === 'load' ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <DatabaseZap className="mr-1 h-3.5 w-3.5" />
            )}
            {t('load')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        {!extract ? (
          <p className="text-muted-foreground">{t('notStarted')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              <span>
                {extract.finishedAt
                  ? t('finished', { time: when(extract.finishedAt) })
                  : extract.stopped
                    ? t('stopped')
                    : t('running', { time: when(extract.startedAt) })}
              </span>
              {extract.sync && <Badge variant="secondary">{t('syncRun')}</Badge>}
              {extracting && extract.perMinute !== null && (
                <span>{t('rate', { perMinute: Math.round(extract.perMinute) })}</span>
              )}
              {extracting && extract.minutesLeft !== null && (
                <span>{t('eta', { minutes: Math.max(1, Math.round(extract.minutesLeft)) })}</span>
              )}
              <span>{t('calls', { count: extract.calls })}</span>
            </div>
            <div className="overflow-x-auto">
              <Table data-testid="shopmonkey-progress">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('table')}</TableHead>
                    <TableHead>{t('stageHead')}</TableHead>
                    <TableHead className="text-right">{t('progress')}</TableHead>
                    <TableHead className="text-right">{t('written')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {extract.tables.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="font-mono text-xs">{row.key}</TableCell>
                      <TableCell>
                        {row.skippedReason ? t('skipped') : t(`stage.${row.stage}` as 'stage.done')}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.total !== null ? `${row.read} / ${row.total}` : row.read}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.written}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        {loadLine && <p data-testid="shopmonkey-load-status">{loadLine}</p>}
        {view.lastDryRun && (
          <p className="text-muted-foreground">
            {t('lastDryRun', {
              time: when(view.lastDryRun.at),
              records: written(view.lastDryRun.counts),
              failures: view.lastDryRun.failureCount,
            })}
          </p>
        )}
        {view.lastLoad && (
          <p className="text-muted-foreground">
            {t('lastLoad', {
              time: when(view.lastLoad.finishedAt),
              records: written(view.lastLoad.counts),
              failures: view.lastLoad.failureCount,
              issued: view.lastLoad.issued,
            })}
          </p>
        )}
      </div>
    </AppCard>
  )
}
