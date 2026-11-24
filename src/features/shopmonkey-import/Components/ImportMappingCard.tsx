'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { Loader2, Save, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { AppCard } from '@/components/app-card'
import { handleGated } from '@/components/upgrade-gate'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { STAGES, type Stage } from '@/features/work-order-statuses/Lib/stages'
import { getShopmonkeyMapping } from '../Actions/getShopmonkeyMapping'
import { saveShopmonkeyMapping } from '../Actions/saveShopmonkeyMapping'
import type { MappingView } from './types'

/** A Select can't hold an empty value: the load's own choice for a user is this. */
const AUTO = 'auto'

/**
 * fork (M8): what each Shopmonkey workflow status becomes (a stage) and who each Shopmonkey user becomes (an existing
 * technician, a new one, or the load's own choice: a new technician for a user the history names, none otherwise).
 * Saved on the connection for every load, the sync's included. Read once per operator extract (`runKey`): the
 * statuses and users come from the archive, and reading them scans it, so the screen's polling doesn't.
 */
export function ImportMappingCard({
  runKey,
  onSaved,
}: {
  runKey: string
  onSaved: () => Promise<void> | void
}) {
  const t = useTranslations('shopmonkeyImport.mapping')
  const ts = useTranslations('shopmonkeyImport.stages')
  const query = useQuery<MappingView, Error>({
    queryKey: ['shopmonkey-mapping', runKey],
    queryFn: async () => {
      const res = await getShopmonkeyMapping()
      if (!res.success || !res.data) throw new Error(res.error ?? t('loadFailed'))
      return res.data
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  })
  const mapping = query.data ?? null
  const error = query.error?.message ?? null
  // The operator's choices over what was saved.
  const [stageEdits, setStages] = useState<Record<string, Stage>>({})
  const [userEdits, setUsers] = useState<Record<string, string>>({})
  const stages = useMemo<Record<string, Stage>>(
    () => ({
      ...Object.fromEntries((mapping?.statuses ?? []).map((s) => [s.id, s.stage])),
      ...stageEdits,
    }),
    [mapping, stageEdits]
  )
  const users = useMemo<Record<string, string>>(
    () => ({
      ...Object.fromEntries((mapping?.users ?? []).map((u) => [u.id, u.choice || AUTO])),
      ...userEdits,
    }),
    [mapping, userEdits]
  )
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    const technicianMap = Object.fromEntries(Object.entries(users).filter(([, v]) => v !== AUTO))
    const res = await saveShopmonkeyMapping({ statusStageMap: stages, technicianMap })
    setSaving(false)
    if (res.success) {
      toast.success(t('saved'))
      await onSaved()
    } else {
      if (!handleGated(res)) toast.error(res.error || t('saveFailed'))
    }
  }

  return (
    <AppCard
      icon={Workflow}
      title={t('title')}
      description={t('description')}
      action={
        <Button
          size="sm"
          onClick={save}
          disabled={!mapping || saving}
          data-testid="shopmonkey-mapping-save"
        >
          {saving ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1 h-3.5 w-3.5" />
          )}
          {t('save')}
        </Button>
      }
    >
      {!mapping ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {error ?? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('loading')}
            </>
          )}
        </div>
      ) : mapping.statuses.length === 0 && mapping.users.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="space-y-6">
          {mapping.statuses.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('status')}</TableHead>
                    <TableHead className="w-56">{t('stage')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mapping.statuses.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{s.name}</TableCell>
                      <TableCell>
                        <Select
                          value={stages[s.id]}
                          onValueChange={(v) => setStages((m) => ({ ...m, [s.id]: v as Stage }))}
                        >
                          <SelectTrigger
                            className="h-8 w-full"
                            aria-label={t('stageOf', { name: s.name })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STAGES.map((stage) => (
                              <SelectItem key={stage} value={stage}>
                                {ts(stage)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {mapping.users.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('user')}</TableHead>
                    <TableHead className="w-64">{t('technician')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mapping.users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <span>{u.name}</span>
                        {!u.referenced && (
                          <Badge variant="outline" className="ml-2 text-xs">
                            {t('notInHistory')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={users[u.id] ?? AUTO}
                          onValueChange={(v) => setUsers((m) => ({ ...m, [u.id]: v }))}
                        >
                          <SelectTrigger
                            className="h-8 w-full"
                            aria-label={t('technicianOf', { name: u.name })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={AUTO}>
                              {u.referenced ? t('autoCreate') : t('autoSkip')}
                            </SelectItem>
                            <SelectItem value="create">{t('create')}</SelectItem>
                            {mapping.technicians.map((tech) => (
                              <SelectItem key={tech.id} value={tech.id}>
                                {tech.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </AppCard>
  )
}
