'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, ShieldAlert } from 'lucide-react'
import { AppCard } from '@/components/app-card'
import { getShopmonkeyImport } from '../Actions/getShopmonkeyImport'
import { ImportHistoryRuns } from './ImportHistoryRuns'
import { ImportMappingCard } from './ImportMappingCard'
import { ImportReportCard } from './ImportReportCard'
import { ImportRunCard } from './ImportRunCard'
import { ImportSyncCard } from './ImportSyncCard'
import type { ImportView } from './types'

/** Every few seconds while something runs; now and then otherwise, to show the sync. */
const BUSY_MS = 3_000
const IDLE_MS = 30_000

function busy(view: ImportView | null): boolean {
  if (!view) return false
  const running = (s?: { status: string } | null) => s?.status === 'queued' || s?.status === 'running'
  return (
    (!!view.extract && !view.extract.finishedAt && !view.extract.stopped) ||
    running(view.loadRun) ||
    running(view.cutoverRun)
  )
}

/**
 * fork (M8): the Shopmonkey import, on the connector's page under its connection settings. Panels in the order the
 * import goes: mapping, extract and load, the reconciliation report, the sync window and cutover, and the loads that
 * can still be undone.
 */
export function ShopmonkeyImportPanel() {
  const t = useTranslations('shopmonkeyImport')
  const [view, setView] = useState<ImportView | null>(null)
  const [error, setError] = useState<{ message: string; forbidden: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const res = await getShopmonkeyImport()
    if (res.success && res.data) {
      setView(res.data)
      setError(null)
      return res.data
    }
    setError({ message: res.error ?? t('loadFailed'), forbidden: res.forbidden === true })
    return null
  }, [t])

  useEffect(() => {
    let stopped = false
    const tick = async () => {
      const next = await load()
      if (stopped) return
      timer.current = setTimeout(tick, busy(next) ? BUSY_MS : IDLE_MS)
    }
    tick()
    return () => {
      stopped = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load])

  // After a button: read again at once, and keep reading while it runs.
  const refresh = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    const next = await load()
    const again = async () => {
      const latest = await load()
      timer.current = setTimeout(again, busy(latest) ? BUSY_MS : IDLE_MS)
    }
    timer.current = setTimeout(again, busy(next) ? BUSY_MS : IDLE_MS)
  }, [load])

  if (error?.forbidden) {
    return (
      <AppCard icon={ShieldAlert} title={t('title')}>
        <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
      </AppCard>
    )
  }
  if (!view) {
    return (
      <AppCard title={t('title')}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {error ? (
            error.message
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('loading')}
            </>
          )}
        </div>
      </AppCard>
    )
  }
  const cutOver = !!view.cutover
  return (
    <div className="space-y-4" data-testid="shopmonkey-import">
      {!cutOver && <ImportMappingCard onSaved={refresh} />}
      <ImportRunCard view={view} onChanged={refresh} />
      <ImportReportCard view={view} onChanged={refresh} />
      <ImportSyncCard view={view} onChanged={refresh} />
      <ImportHistoryRuns view={view} onChanged={refresh} />
    </div>
  )
}
