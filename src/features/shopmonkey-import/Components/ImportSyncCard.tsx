'use client'

import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { FlaskConical, Flag, Loader2, RefreshCcw } from 'lucide-react'
import { toast } from 'sonner'
import { AppCard } from '@/components/app-card'
import { useConfirm } from '@/components/confirm-dialog'
import { CopyValue } from '@/components/copy-value'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { queueShopmonkeyCutover } from '../Actions/queueShopmonkeyCutover'
import type { ImportView } from './types'

const STEPS = [
  'stopped',
  'delta',
  'reconcile',
  'numbering',
  'recorded',
  'syncOff',
  'reminder',
] as const

/**
 * fork (M8): the sync window (M7) and the cutover. Where Shopmonkey's webhook goes, when the sync last loaded, the
 * deletes it kept for someone to decide on, and the cutover itself: a dry run first, then the real one, each after a
 * confirmation that lists the steps.
 */
export function ImportSyncCard({
  view,
  onChanged,
}: {
  view: ImportView
  onChanged: () => Promise<void> | void
}) {
  const t = useTranslations('shopmonkeyImport.sync')
  const format = useFormatter()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<'dry' | 'real' | null>(null)
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const run = view.cutoverRun
  const running = run?.status === 'queued' || run?.status === 'running'
  const passed = view.report?.passed === true

  const cutover = async (dryRun: boolean) => {
    const ok = await confirm({
      title: dryRun ? t('confirmDryTitle') : t('confirmTitle'),
      description: dryRun ? t('confirmDryDescription') : t('confirmDescription'),
      consequences: STEPS.map((s) => t(`step.${s}`)),
      confirmLabel: dryRun ? t('dryRun') : t('cutover'),
      cancelLabel: t('cancel'),
      icon: dryRun ? FlaskConical : Flag,
      destructive: !dryRun,
      irreversible: !dryRun,
      ...(dryRun ? {} : { requireText: 'Shopmonkey' }),
    })
    if (!ok) return
    setBusy(dryRun ? 'dry' : 'real')
    const res = await queueShopmonkeyCutover({ dryRun, shopStopped: true })
    setBusy(null)
    if (res.success) toast.success(dryRun ? t('dryQueued') : t('queued'))
    else toast.error(res.error || t('failed'))
    await onChanged()
  }

  return (
    <AppCard icon={RefreshCcw} title={t('title')} description={t('description')}>
      <div className="space-y-4 text-sm">
        {view.cutover ? (
          <p data-testid="shopmonkey-cutover-done">
            {t('cutOver', { time: when(view.cutover.at) })}
          </p>
        ) : (
          <>
            <div className="space-y-1">
              <p className="font-medium">{t('webhook')}</p>
              <p className="text-muted-foreground">{t('webhookHelp')}</p>
              <div className="flex items-center gap-2">
                <code className="break-all rounded bg-muted px-2 py-1 text-xs">
                  {view.webhookUrl}
                </code>
                <CopyValue value={view.webhookUrl} label={t('webhook')} />
              </div>
            </div>
            <p className="text-muted-foreground">
              {view.lastSync
                ? t('lastSync', {
                    time: when(view.lastSync.at),
                    records: view.lastSync.records,
                    deleted: view.lastSync.deleted,
                  })
                : t('noSync')}
            </p>
          </>
        )}

        {view.lastSync && view.lastSync.keptDeleteCount > 0 && (
          <div className="space-y-1" data-testid="shopmonkey-kept-deletes">
            <p className="font-medium">{t('kept', { count: view.lastSync.keptDeleteCount })}</p>
            <p className="text-muted-foreground">{t('keptHelp')}</p>
            <ul className="space-y-0.5">
              {view.lastSync.keptDeletes.map((k) => (
                <li key={`${k.table}:${k.remoteId}`} className="flex flex-wrap gap-2">
                  <span className="font-mono text-xs">
                    {k.table} {k.remoteId}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {t(`keptReason.${k.reason}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        {run && (
          <div className="space-y-1" data-testid="shopmonkey-cutover-run">
            <p className="font-medium">
              {run.status === 'queued' || run.status === 'running'
                ? t(run.dryRun ? 'dryRunning' : 'running')
                : run.status === 'done'
                  ? run.completed
                    ? t(run.dryRun ? 'dryCompleted' : 'completed', { time: when(run.at) })
                    : t('stoppedAt', { step: run.stoppedAt ?? 0 })
                  : run.status === 'refused'
                    ? t('refused', { message: run.message ?? '' })
                    : t('failed')}
            </p>
            {run.steps && (
              <ol className="list-decimal space-y-0.5 pl-5">
                {run.steps.map((s) => (
                  <li key={s.step} data-status={s.status}>
                    <span className="font-medium">{t(`step.${STEPS[s.step - 1]}`)}</span>{' '}
                    <Badge
                      variant={s.status === 'failed' ? 'destructive' : 'secondary'}
                      className="text-xs"
                    >
                      {t(`stepStatus.${s.status}` as 'stepStatus.done')}
                    </Badge>
                    {/* The importer's own sentence: counts, gate summaries, the reminder. English, as on the CLI. */}
                    <p className="text-xs text-muted-foreground">{s.detail}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {!view.cutover && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || running || !view.lastLoad}
              onClick={() => cutover(true)}
              data-testid="shopmonkey-cutover-dry"
            >
              {busy === 'dry' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="mr-1 h-3.5 w-3.5" />
              )}
              {t('dryRun')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy !== null || running || !view.lastLoad || !passed}
              onClick={() => cutover(false)}
              title={passed ? undefined : t('passFirst')}
            >
              {busy === 'real' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Flag className="mr-1 h-3.5 w-3.5" />
              )}
              {t('cutover')}
            </Button>
          </div>
        )}
      </div>
    </AppCard>
  )
}
