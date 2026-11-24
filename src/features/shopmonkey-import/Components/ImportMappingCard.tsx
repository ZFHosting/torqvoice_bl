'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Save, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { AppCard } from '@/components/app-card'
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
 * Saved on the connection for every load, the sync's included.
 */
export function ImportMappingCard({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const t = useTranslations('shopmonkeyImport.mapping')
  const ts = useTranslations('shopmonkeyImport.stages')
  const [mapping, setMapping] = useState<MappingView | null>(null)
  const [stages, setStages] = useState<Record<string, Stage>>({})
  const [users, setUsers] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await getShopmonkeyMapping()
    if (!res.success || !res.data) {
      setError(res.error ?? t('loadFailed'))
      return
    }
    setMapping(res.data)
    setStages(Object.fromEntries(res.data.statuses.map((s) => [s.id, s.stage])))
    setUsers(Object.fromEntries(res.data.users.map((u) => [u.id, u.choice || AUTO])))
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    setSaving(true)
    const technicianMap = Object.fromEntries(Object.entries(users).filter(([, v]) => v !== AUTO))
    const res = await saveShopmonkeyMapping({ statusStageMap: stages, technicianMap })
    setSaving(false)
    if (res.success) {
      toast.success(t('saved'))
      await onSaved()
    } else {
      toast.error(res.error || t('saveFailed'))
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
