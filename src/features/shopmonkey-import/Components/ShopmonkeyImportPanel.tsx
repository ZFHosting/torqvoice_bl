'use client'

import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
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

/** Every few seconds while the queue has something of the import's; now and then otherwise, to show the sync. */
const BUSY_MS = 3_000
const IDLE_MS = 30_000

class ImportReadError extends Error {
  constructor(
    message: string,
    readonly forbidden: boolean
  ) {
    super(message)
  }
}

/** Which extract the mapping was read for: the operator's run as it finished, or the sync's runs, all one. */
const mappingKey = (view: ImportView) =>
  view.extract?.sync ? 'sync' : (view.extract?.finishedAt ?? 'none')

/**
 * fork (M8): the Shopmonkey import, on the connector's page under its connection settings. Panels in the order the
 * import goes: mapping, extract and load, the reconciliation report, the sync window and cutover, and the loads that
 * can still be undone. Read through TanStack Query, polled while a job of the import is queued or running.
 */
export function ShopmonkeyImportPanel() {
  const t = useTranslations('shopmonkeyImport')
  const query = useQuery<ImportView, ImportReadError>({
    queryKey: ['shopmonkey-import'],
    queryFn: async () => {
      const res = await getShopmonkeyImport()
      if (!res.success || !res.data) {
        throw new ImportReadError(res.error ?? t('loadFailed'), res.forbidden === true)
      }
      return res.data
    },
    refetchInterval: (q) => {
      const live = q.state.data?.live
      return live && (live.extract || live.load || live.cutover) ? BUSY_MS : IDLE_MS
    },
    retry: (count, error) => !error.forbidden && count < 2,
  })
  const { refetch } = query
  const refresh = useCallback(async () => {
    await refetch()
  }, [refetch])

  if (query.error?.forbidden) {
    return (
      <AppCard icon={ShieldAlert} title={t('title')}>
        <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
      </AppCard>
    )
  }
  const view = query.data
  if (!view) {
    return (
      <AppCard title={t('title')}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {query.error ? (
            query.error.message
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
  return (
    <div className="space-y-4" data-testid="shopmonkey-import">
      {/* Read again once the operator's extract finishes: the statuses and users come from it. The ten-minute sync's
          runs replace the extract in the state; they don't read the mapping again (or lose unsaved choices). */}
      {!view.cutover && (
        <ImportMappingCard key={mappingKey(view)} runKey={mappingKey(view)} onSaved={refresh} />
      )}
      <ImportRunCard view={view} onChanged={refresh} />
      <ImportReportCard view={view} onChanged={refresh} />
      <ImportSyncCard view={view} onChanged={refresh} />
      <ImportHistoryRuns view={view} onChanged={refresh} />
    </div>
  )
}
