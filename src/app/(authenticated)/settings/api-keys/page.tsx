import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getApiKeys } from '@/features/public-api/Actions/apiKeyActions'
import { ApiKeysSettings } from '@/features/public-api/Components/ApiKeysSettings'
import { getFeatures, isCloudMode } from '@/lib/features'
import { getLayoutData } from '@/lib/get-layout-data'
import { settingsPageTitle } from '@/lib/page-title'
import { FeatureLocked } from '../feature-locked-message'

export function generateMetadata() {
  return settingsPageTitle('apiKeys')
}

/** fork: Settings → API keys (docs/fork/API.md §2), gated by the `api` plan feature like webhooks. */
export default async function ApiKeysPage() {
  const data = await getLayoutData()
  if (data.status === 'unauthenticated') redirect('/auth/sign-in')
  if (data.status === 'no-organization') redirect('/onboarding')

  const t = await getTranslations('apiKeys')
  const result = await getApiKeys()
  if (!result.success || !result.data) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('ownerOnly')}</p>
      </div>
    )
  }

  const features = await getFeatures(data.organizationId)
  const content = <ApiKeysSettings keys={result.data.keys} roles={result.data.roles} />
  return features.api ? (
    content
  ) : (
    <FeatureLocked feature={t('title')} description={t('description')} isCloud={isCloudMode()}>
      {content}
    </FeatureLocked>
  )
}
