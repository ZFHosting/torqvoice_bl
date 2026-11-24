'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { CheckCircle2, ClipboardCheck, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { AppCard } from '@/components/app-card'
import { handleGated } from '@/components/upgrade-gate'
import { useFormatCurrency } from '@/components/currency-settings-context'
import { centsToAmount } from '@/integrations/shopmonkey/money'
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
import { reconcileShopmonkeyImport } from '../Actions/reconcileShopmonkeyImport'
import type { ImportView } from './types'
import { useWorkshopTime } from './useWorkshopTime'

const GATES = ['counts', 'money', 'receivables', 'failures'] as const
const BUCKETS = [
  'loaded',
  'skipped',
  'deleted',
  'archive',
  'folded',
  'settings',
  'failed',
  'missing',
] as const
const LISTED = 20

/**
 * fork (M8): the reconciliation (M6): the four gates cutover waits on, then where every staged record went, the
 * money differences, invoices to compare by hand, the warnings and the fields nothing reads.
 */
export function ImportReportCard({
  view,
  onChanged,
}: {
  view: ImportView
  onChanged: () => Promise<void> | void
}) {
  const t = useTranslations('shopmonkeyImport.report')
  const when = useWorkshopTime()
  const [running, setRunning] = useState(false)
  const report = view.report
  // In the workshop's currency (the import loads amounts as they are, in the workshop's own).
  const currency = useFormatCurrency()
  const money = (cents: number) => currency(centsToAmount(cents))

  const run = async () => {
    setRunning(true)
    const res = await reconcileShopmonkeyImport()
    setRunning(false)
    if (res.success && res.data) toast.success(res.data.passed ? t('passed') : t('notPassed'))
    else if (!handleGated(res)) toast.error(res.error || t('failed'))
    await onChanged()
  }

  const gateText = (code: string, values: Record<string, number | string>) => {
    const v = { ...values } as Record<string, number | string>
    for (const key of ['shopmonkeyCents', 'torqvoiceCents']) {
      if (typeof v[key] === 'number') v[key] = money(v[key] as number)
    }
    return t(`gates.${code}` as 'gates.no_failures', v)
  }

  return (
    <AppCard
      icon={ClipboardCheck}
      title={t('title')}
      description={t('description')}
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={run}
          disabled={running || !view.lastLoad}
          data-testid="shopmonkey-reconcile"
        >
          {running ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
          )}
          {t('run')}
        </Button>
      }
    >
      {!report ? (
        <p className="text-sm text-muted-foreground">
          {view.lastLoad ? t('notRun') : t('loadFirst')}
        </p>
      ) : (
        <div className="space-y-6 text-sm">
          <div className="space-y-2" data-testid="shopmonkey-gates">
            <p className="text-muted-foreground">
              {t('generated', {
                time: when(report.generatedAt),
              })}
            </p>
            {GATES.map((name) => {
              const gate = report.gates[name]
              return (
                <div
                  key={name}
                  className="flex items-start gap-2"
                  data-gate={name}
                  data-passed={gate.passed}
                >
                  {gate.passed ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  )}
                  <div>
                    <span className="font-medium">{t(`gateName.${name}`)}</span>
                    <Badge
                      variant={gate.passed ? 'secondary' : 'destructive'}
                      className="ml-2 text-xs"
                    >
                      {gate.passed ? t('pass') : t('fail')}
                    </Badge>
                    <p className="text-muted-foreground">{gateText(gate.code, gate.values)}</p>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('table')}</TableHead>
                  <TableHead className="text-right">{t('staged')}</TableHead>
                  {BUCKETS.map((b) => (
                    <TableHead key={b} className="text-right">
                      {t(`bucket.${b}`)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.counts.map((row) => (
                  <TableRow key={row.table}>
                    <TableCell className="font-mono text-xs">{row.table}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.staged}</TableCell>
                    {BUCKETS.map((b) => (
                      <TableCell key={b} className="text-right tabular-nums">
                        {row.buckets[b] ?? 0}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {report.money.differences.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium">
                {t('differences', { count: report.money.differenceTotal })}
              </h4>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('order')}</TableHead>
                      <TableHead>{t('field')}</TableHead>
                      <TableHead className="text-right">{t('shopmonkey')}</TableHead>
                      <TableHead className="text-right">{t('torqvoice')}</TableHead>
                      <TableHead>{t('explained')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.money.differences.slice(0, LISTED).map((d) => (
                      <TableRow key={`${d.orderId}:${d.field}`}>
                        <TableCell>{d.number ?? d.orderId}</TableCell>
                        <TableCell>{t(`moneyField.${d.field}`)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(d.shopmonkeyCents)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(d.torqvoiceCents)}
                        </TableCell>
                        <TableCell>
                          {d.explainedBy ? (
                            <span className="font-mono text-xs">{d.explainedBy}</span>
                          ) : (
                            <Badge variant="destructive" className="text-xs">
                              {t('unexplained')}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {report.spotChecks.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium">{t('spotChecks')}</h4>
              <ul className="grid gap-1 sm:grid-cols-2">
                {report.spotChecks.map((s) => (
                  <li key={s.orderId} className="flex justify-between gap-2">
                    <Link href={s.path} className="underline underline-offset-2">
                      {s.invoiceNumber ?? s.number ?? s.orderId}
                    </Link>
                    <span className="tabular-nums text-muted-foreground">
                      {money(s.shopmonkeyTotalCents)} / {money(s.torqvoiceTotalCents)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {Object.keys(report.warnings).length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium">{t('warnings')}</h4>
              <div className="flex flex-wrap gap-2">
                {Object.entries(report.warnings).map(([code, w]) => (
                  <Badge key={code} variant="outline" className="font-mono text-xs">
                    {code} × {w.count}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {report.unmapped.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium">{t('unmapped')}</h4>
              <p className="text-muted-foreground">{t('unmappedHelp')}</p>
              <ul className="font-mono text-xs">
                {report.unmapped.slice(0, LISTED).map((u) => (
                  <li key={`${u.where}.${u.field}`}>
                    {u.where}.{u.field} ({u.nonEmpty}/{u.seen})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </AppCard>
  )
}
