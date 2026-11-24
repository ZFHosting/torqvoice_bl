'use client'

import { useTranslations } from 'next-intl'
import { useWorkshopTime } from './useWorkshopTime'
import { RefreshCcw } from 'lucide-react'

/**
 * fork (M7 task 4, built in M8): on a record loaded from Shopmonkey while the workshop is still in the sync window.
 * Changes made in Shopmonkey come over and overwrite edits made here, until cutover.
 */
export function ShopmonkeySyncBanner({ lastSyncAt }: { lastSyncAt: string | null }) {
  const t = useTranslations('shopmonkeyImport.banner')
  const when = useWorkshopTime()
  return (
    <div
      className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
      data-testid="shopmonkey-sync-banner"
      role="status"
    >
      <RefreshCcw className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div>
        <p className="font-medium">{t('synced')}</p>
        <p className="text-muted-foreground">
          {lastSyncAt
            ? t('syncedDetail', {
                time: when(lastSyncAt),
              })
            : t('syncedNever')}
        </p>
      </div>
    </div>
  )
}
