'use client'
/**
 * Settings → API keys (docs/fork/API.md §2): the workshop's keys, a dialog to create one (shown in
 * full once, with a copy button), and revoke. Owners and admins only; the page checks first.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, Copy, KeyRound, Loader2, Plus } from 'lucide-react'
import { useConfirm } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { createApiKey, revokeApiKey } from '../Actions/apiKeyActions'

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  role: { id: string; name: string } | null
}

export function ApiKeysSettings({
  keys,
  roles,
}: {
  keys: ApiKeyRow[]
  roles: { id: string; name: string }[]
}) {
  const t = useTranslations('apiKeys')
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '')
  const [ips, setIps] = useState('')
  const [shownKey, setShownKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // An action that can't reach the server throws instead of answering; caught here, so the page
  // stays and says so rather than falling to the error page.
  const create = () =>
    startTransition(async () => {
      const result = await createApiKey({
        name,
        roleId,
        ipAllowlist: ips
          .split(/[\s,]+/)
          .map((ip) => ip.trim())
          .filter(Boolean),
      }).catch(() => null)
      if (!result?.success || !result.data) {
        toast.error(result?.error ?? t('createFailed'))
        return
      }
      setCreateOpen(false)
      setName('')
      setIps('')
      setShownKey(result.data.key)
      router.refresh()
    })

  const revoke = async (key: ApiKeyRow) => {
    const ok = await confirm({
      title: t('revokeTitle', { name: key.name }),
      description: t('revokeDescription'),
      confirmLabel: t('revoke'),
      cancelLabel: t('cancel'),
      destructive: true,
    })
    if (!ok) return
    startTransition(async () => {
      const result = await revokeApiKey(key.id).catch(() => null)
      if (!result?.success) toast.error(result?.error ?? t('revokeFailed'))
      else toast.success(t('revoked'))
      router.refresh()
    })
  }

  const copy = async () => {
    if (!shownKey) return
    await navigator.clipboard.writeText(shownKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // An instant, read by whoever is signed in: their own clock, as on the webhooks page.
  const when = (date: Date | null) => (date ? new Date(date).toLocaleString() : t('never'))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={roles.length === 0}>
          <Plus className="mr-2 h-4 w-4" />
          {t('create')}
        </Button>
      </div>
      {roles.length === 0 && <p className="text-sm text-muted-foreground">{t('needRole')}</p>}

      <Card>
        <CardContent className="divide-y p-0">
          {keys.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
              <KeyRound className="h-8 w-8" />
              <p>{t('empty')}</p>
            </div>
          ) : (
            keys.map((key) => (
              <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{key.name}</span>
                    {key.revokedAt ? (
                      <Badge variant="secondary">{t('statusRevoked')}</Badge>
                    ) : key.expiresAt && new Date(key.expiresAt) <= new Date() ? (
                      <Badge variant="secondary">{t('statusExpired')}</Badge>
                    ) : (
                      <Badge variant="outline">{key.role?.name ?? t('noRole')}</Badge>
                    )}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">tvk_{key.prefix}_…</p>
                  <p className="text-xs text-muted-foreground">
                    {t('created', { when: when(key.createdAt) })} ·{' '}
                    {t('lastUsed', { when: when(key.lastUsedAt) })}
                  </p>
                </div>
                {!key.revokedAt && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => revoke(key)}
                  >
                    {t('revoke')}
                  </Button>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('createTitle')}</DialogTitle>
            <DialogDescription>{t('createDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api-key-name">{t('name')}</Label>
              <Input
                id="api-key-name"
                value={name}
                maxLength={80}
                placeholder={t('namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-key-role">{t('role')}</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id="api-key-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('roleHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-key-ips">{t('ipAllowlist')}</Label>
              <Textarea
                id="api-key-ips"
                value={ips}
                rows={2}
                onChange={(e) => setIps(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('ipAllowlistHint')}</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={create} disabled={pending || !name.trim() || !roleId}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={shownKey !== null} onOpenChange={(open) => !open && setShownKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('shownTitle')}</DialogTitle>
            <DialogDescription>{t('shownDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex items-center gap-2 rounded-md border bg-muted p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{shownKey}</code>
              <Button
                variant="ghost"
                size="icon"
                onClick={copy}
                aria-label={copied ? t('copied') : t('copy')}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setShownKey(null)}>{t('done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
