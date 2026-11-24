'use client'

import { useCallback } from 'react'
import { useFormatter } from 'next-intl'
import { useDateSettings } from '@/components/date-settings-context'

/**
 * fork (M8): a date and time as the import screen shows one, on the workshop's clock (AGENTS.md, "Whose clock"): the
 * formatter alone would use the server's zone.
 */
export function useWorkshopTime() {
  const format = useFormatter()
  const { timezone } = useDateSettings()
  return useCallback(
    (iso: string) =>
      format.dateTime(new Date(iso), {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone || undefined,
      }),
    [format, timezone]
  )
}
