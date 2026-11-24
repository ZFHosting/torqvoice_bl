'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { History, Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { AppCard } from '@/components/app-card'
import { useConfirm } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { undoShopmonkeyLoad } from '../Actions/undoShopmonkeyLoad'
import type { ImportView } from './types'
import { useWorkshopTime } from './useWorkshopTime'

/**
 * fork (M8): the loads of this connection, newest first, each with an undo (M5: what that load created, and nothing
 * the workshop uses since). The sync's loads are listed too. No undo after cutover.
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
  if (view.runs.length === 0) return null
  const cutOver = !!view.cutover

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
      router.refresh()
    } else {
      toast.error(res.error || t('undoFailed'))
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
        {view.runs.map((run) => (
          <div key={run.runId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <div className="min-w-0 text-sm">
              <span className="font-medium">{when(run.at)}</span>
              <span className="ml-2 text-muted-foreground">
                {t('records', { count: run.records })}
              </span>
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
                disabled={busyId !== null}
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
