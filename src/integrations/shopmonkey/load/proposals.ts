/**
 * What a load proposes to the workshop's settings (M5 task 9), and applies only when the operator asks
 * (`--apply-numbering`, `--apply-settings`; the M8 screen later). Nothing here changes the workshop by itself.
 *
 * - Numbering (MAPPING §9): Shopmonkey's numbers are kept as they are, so the next job must carry on after the
 *   highest of them. Plain numbers take the format `''` and "Next invoice number" the highest + 1: left at
 *   `{year}-`, the next job would be numbered from the newest job's digits instead (RESULTS T1).
 * - Settings: the tax (rate, split, what is taxed), the default labor rate, the unit system from the oldest
 *   vehicle, and the time zone, from Shopmonkey's tax config, labor rates, vehicles and location.
 * - The workshop's name is only reported: renaming the workshop is the operator's, in Settings.
 * Each proposal lists only keys whose value would change.
 */
import { SETTING_KEYS } from '@/features/settings/Schema/settingsSchema'
import { db } from '@/lib/db'
import { serializeTaxComponentDefinitions } from '@/lib/tax-components'
import { SOURCE } from '../extract/stage'
import { transformTaxConfig } from '../transform/catalog'
import { defaultLaborRate, transformWorkshop } from '../transform/reference'
import type { Row } from '../transform/types'
import type { Tx } from './context'

export interface SettingChange {
  key: string
  /** What the workshop has now (null: never set). */
  current: string | null
  proposed: string
}

export interface Proposals {
  numbering: { highest: string | null; changes: SettingChange[] }
  settings: SettingChange[]
  /** Shopmonkey's name for the location, when it differs from the workshop's. Reported, never applied. */
  workshopName: { current: string; proposed: string } | null
}

/** The run's client: the dry run's transaction, or the database. */
type Client = Tx

async function payloads(client: Client, organizationId: string, table: string): Promise<Row[]> {
  const rows = await client.sourceRecord.findMany({
    where: { organizationId, source: SOURCE, table, remoteDeletedAt: null },
    orderBy: { id: 'asc' },
    select: { payload: true },
  })
  return rows.map((r) => r.payload as Row)
}

async function currentSettings(client: Client, organizationId: string, keys: string[]) {
  const rows = await client.appSetting.findMany({
    where: { organizationId, key: { in: keys } },
    select: { key: true, value: true },
  })
  return new Map(rows.map((r) => [r.key, r.value]))
}

function changes(proposed: [string, string][], current: Map<string, string>): SettingChange[] {
  return proposed
    .filter(([key, value]) => (current.get(key) ?? null) !== value)
    .map(([key, value]) => ({ key, current: current.get(key) ?? null, proposed: value }))
}

/** The highest plain number on the workshop's jobs (imported or not), as text: it can be any length. */
export async function highestPlainNumber(
  client: Client,
  organizationId: string
): Promise<bigint | null> {
  const rows = await client.$queryRaw<{ highest: string | null }[]>`
    SELECT MAX(CAST("invoiceNumber" AS NUMERIC))::text AS highest
    FROM "public"."service_records"
    WHERE "organizationId" = ${organizationId} AND "invoiceNumber" ~ '^[0-9]+$'
  `
  const highest = rows[0]?.highest
  return highest ? BigInt(highest) : null
}

export async function proposeNumbering(
  client: Client,
  organizationId: string
): Promise<Proposals['numbering']> {
  const highest = await highestPlainNumber(client, organizationId)
  if (highest === null) return { highest: null, changes: [] }
  const current = await currentSettings(client, organizationId, [
    SETTING_KEYS.INVOICE_PREFIX,
    SETTING_KEYS.INVOICE_START_NUMBER,
  ])
  const formatChange = changes([[SETTING_KEYS.INVOICE_PREFIX, '']], current)
  // Already numbering in plain numbers after the highest: "Next invoice number" adds nothing.
  const start = String(highest + BigInt(1))
  const startSet = current.get(SETTING_KEYS.INVOICE_START_NUMBER)
  const startNeeded =
    formatChange.length > 0 || (startSet !== undefined && startSet !== '' && startSet !== start)
  return {
    highest: String(highest),
    changes: [
      ...formatChange,
      ...(startNeeded ? changes([[SETTING_KEYS.INVOICE_START_NUMBER, start]], current) : []),
    ],
  }
}

/** `metric` or `imperial` from Shopmonkey's `mileageUnit` (`Mile`, `Kilometer`), or null. */
export function unitSystemOf(mileageUnit: string | null): string | null {
  if (!mileageUnit) return null
  if (/^k/i.test(mileageUnit)) return 'metric'
  if (/^mi/i.test(mileageUnit)) return 'imperial'
  return null
}

function validTimeZone(zone: string | null): zone is string {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The tax as the workshop's settings hold it (src/features/settings/Lib/workshopTax.ts). */
function taxSettings(config: Row): [string, string][] {
  const tax = transformTaxConfig(config)
  const out: [string, string][] = [
    [SETTING_KEYS.TAX_ENABLED, tax.rate > 0 ? 'true' : 'false'],
    [SETTING_KEYS.DEFAULT_TAX_RATE, String(tax.rate)],
    [SETTING_KEYS.TAX_MODE, tax.components ? 'split' : 'single'],
  ]
  if (tax.components) {
    out.push([SETTING_KEYS.TAX_COMPONENTS, serializeTaxComponentDefinitions(tax.components)])
  }
  const selective = !(tax.partsTaxable && tax.laborTaxable && tax.shopSuppliesTaxable)
  out.push([SETTING_KEYS.TAX_SELECTIVE, selective ? 'true' : 'false'])
  if (selective) {
    out.push(
      [SETTING_KEYS.TAX_APPLIES_TO_PARTS, String(tax.partsTaxable)],
      [SETTING_KEYS.TAX_APPLIES_TO_LABOR, String(tax.laborTaxable)],
      // PROVISIONAL(M0:S6): Torqvoice's shop fee lines are Shopmonkey's shop supplies (and EPA) charges.
      [SETTING_KEYS.TAX_APPLIES_TO_SHOP_FEE, String(tax.shopSuppliesTaxable)]
    )
  }
  return out
}

export async function proposeSettings(
  client: Client,
  organizationId: string,
  input: { mileageUnit: string | null }
): Promise<Pick<Proposals, 'settings' | 'workshopName'>> {
  const [taxConfigs, rates, companies, locations] = await Promise.all([
    payloads(client, organizationId, 'tax_config'),
    payloads(client, organizationId, 'labor_rate'),
    payloads(client, organizationId, 'company'),
    payloads(client, organizationId, 'location'),
  ])
  const taxConfig = taxConfigs[0] ?? null
  const proposed: [string, string][] = taxConfig ? taxSettings(taxConfig) : []
  const rate = defaultLaborRate(rates, taxConfig)
  if (rate !== null) proposed.push([SETTING_KEYS.DEFAULT_LABOR_RATE, String(rate)])
  const units = unitSystemOf(input.mileageUnit)
  if (units) proposed.push([SETTING_KEYS.UNIT_SYSTEM, units])
  const workshop = transformWorkshop(companies[0] ?? null, locations[0] ?? null)
  if (validTimeZone(workshop.timeZone)) proposed.push([SETTING_KEYS.TIMEZONE, workshop.timeZone])

  const current = await currentSettings(
    client,
    organizationId,
    proposed.map(([key]) => key)
  )
  const org = await client.organization.findFirst({
    where: { id: organizationId },
    select: { name: true },
  })
  return {
    settings: changes(proposed, current),
    workshopName:
      workshop.name && org && workshop.name !== org.name
        ? { current: org.name, proposed: workshop.name }
        : null,
  }
}

/** Writes the given changes to the workshop's settings as `userId`, all or none. Returns the keys written. */
export async function applySettingChanges(
  organizationId: string,
  userId: string,
  list: SettingChange[]
): Promise<string[]> {
  if (!list.length) return []
  await db.$transaction(
    list.map((c) =>
      db.appSetting.upsert({
        where: { organizationId_key: { organizationId, key: c.key } },
        create: { organizationId, userId, key: c.key, value: c.proposed },
        update: { value: c.proposed },
      })
    )
  )
  return list.map((c) => c.key)
}
