'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { History, Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { AppCard } from '@/components/app-card'
import { handleGated } from '@/components/upgrade-gate'
import { useConfirm } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getShopmonkeyLoadHistory } from '../Actions/getShopmonkeyLoadHistory'
import { undoShopmonkeyLoad } from '../Actions/undoShopmonkeyLoad'
import type { ImportView, LoadRunView } from './types'
import { useWorkshopTime } from './useWorkshopTime'

/**
 * fork (M8): the loads of this connection, newest first, each with an undo (M5: what that load created, and nothing
 * the workshop uses since). The operator's loads, and the sync's newest few marked as the sync's (listed apart, so
 * the sync never pushes the first load out). No undo after cutover, nor while a load or the cutover runs.
 */
export function ImportHistoryRuns({
  view,
  onChanged,
}: {
  view: ImportView
  onChanged: () => Promise<void> | void
}) {
  const t = useTranslations('shopmonkeyImport.history')
  const when = useWorkshopTime()
  const confirm = useConfirm()
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  // Read apart from the polled view: when the screen opens, and when a load, a sync's load or an undo ends.
  const history = useQuery<LoadRunView[], Error>({
    queryKey: [
      'shopmonkey-history',
      view.lastLoad?.runId ?? '',
      view.loadRun ? `${view.loadRun.status}:${view.loadRun.at}` : '',
      view.lastSync?.at ?? '',
      !!view.cutover,
    ],
    queryFn: async () => {
      const res = await getShopmonkeyLoadHistory()
      if (!res.success || !res.data) throw new Error(res.error ?? '')
      return res.data
    },
    refetchOnWindowFocus: false,
  })
  const runs = history.data ?? []
  if (runs.length === 0) return null
  const cutOver = !!view.cutover
  // Not under a load or the cutover (the action refuses too).
  const busy = view.live.load || view.live.cutover

  const undo = async (runId: string, at: string, records: number) => {
    const ok = await confirm({
      title: t('confirmTitle'),
      description: t('confirmDescription'),
      subject: [
        {
          label: when(at),
          detail: t('records', { count: records }),
          icon: History,
        },
      ],
      confirmLabel: t('undo'),
      cancelLabel: t('cancel'),
      icon: Undo2,
      destructive: true,
    })
    if (!ok) return
    setBusyId(runId)
    const res = await undoShopmonkeyLoad({ runId })
    setBusyId(null)
    if (res.success && res.data) {
      const removed = Object.values(res.data.removed).reduce((a, n) => a + n, 0)
      const kept = Object.values(res.data.kept).reduce((a, n) => a + n, 0)
      toast.success(t('undone', { removed, kept }))
      await history.refetch()
      router.refresh()
    } else {
      if (!handleGated(res)) toast.error(res.error || t('undoFailed'))
    }
    await onChanged()
  }

  return (
    <AppCard
      icon={History}
      title={t('title')}
      description={cutOver ? t('cutOver') : t('description')}
    >
      <div className="divide-y" data-testid="shopmonkey-runs">
        {runs.map((run) => (
          <div key={run.runId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <div className="min-w-0 text-sm">
              <span className="font-medium">{when(run.at)}</span>
              <span className="ml-2 text-muted-foreground">
                {t('records', { count: run.records })}
              </span>
              {run.sync && (
                <Badge variant="outline" className="ml-2 text-xs">
                  {t('syncBadge')}
                </Badge>
              )}
              {run.undone && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {t('undoneBadge')}
                </Badge>
              )}
            </div>
            {!run.undone && !cutOver && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={busyId !== null || busy}
                onClick={() => undo(run.runId, run.at, run.records)}
              >
                {busyId === run.runId ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Undo2 className="mr-1 h-3.5 w-3.5" />
                )}
                {t('undo')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </AppCard>
  )
}
