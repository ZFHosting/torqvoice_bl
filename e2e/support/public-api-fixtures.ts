/**
 * fork (A6): what the public API spec needs in the suite's workshop and can't make through a screen in a few clicks:
 * a role with every permission for its key (the workshop's default roles can't write work orders), and a webhook that
 * takes every event (inserted as the A4 tests do: its URL, on a reserved domain, would be refused when saved, and a
 * delivery to it fails without anything leaving the machine). `setup` prints their ids as JSON; `cleanup` removes
 * them, and the spec's keys and their service users. Run by `support/public-api.ts`:
 *
 *   node node_modules/tsx/dist/cli.mjs --import ./scripts/shopmonkey/register.mjs e2e/support/public-api-fixtures.ts setup
 */
import { db } from '@/lib/db'
import { permissionGroups } from '@/lib/permissions'
import { endProcess } from '../../scripts/shopmonkey/exit'

export const ROLE_NAME = 'E2E API full access'
export const WEBHOOK_NAME = 'E2E API events'
export const KEY_NAME = 'E2E public API'

async function workshop() {
  const email = process.env.E2E_USER_EMAIL ?? 'demo@torqvoice.com'
  const user = await db.user.findFirstOrThrow({ where: { email }, select: { id: true } })
  const member = await db.organizationMember.findFirstOrThrow({
    where: { userId: user.id, role: 'owner' },
    orderBy: { id: 'asc' },
    select: { organizationId: true },
  })
  return { organizationId: member.organizationId, userId: user.id }
}

async function setup() {
  const { organizationId, userId } = await workshop()
  await cleanup()
  const role = await db.role.create({
    data: {
      organizationId,
      name: ROLE_NAME,
      permissions: {
        create: permissionGroups.flatMap((g) =>
          g.permissions.map((p) => ({ action: p.action as string, subject: g.subject as string }))
        ),
      },
    },
    select: { id: true },
  })
  const webhook = await db.webhook.create({
    data: {
      organizationId,
      createdById: userId,
      name: WEBHOOK_NAME,
      url: 'https://hooks.example.test/e2e-public-api',
      secret: 'e'.repeat(32),
      events: JSON.stringify(['*']),
      isActive: true,
    },
    select: { id: true },
  })
  console.log(JSON.stringify({ organizationId, roleId: role.id, webhookId: webhook.id }))
}

async function cleanup() {
  const { organizationId } = await workshop()
  const keys = await db.apiKey.findMany({
    where: { organizationId, name: KEY_NAME },
    select: { id: true, serviceUserId: true },
  })
  await db.apiKey.deleteMany({ where: { id: { in: keys.map((k) => k.id) } } })
  await db.user.deleteMany({ where: { id: { in: keys.map((k) => k.serviceUserId) } } })
  await db.webhook.deleteMany({ where: { organizationId, name: WEBHOOK_NAME } })
  await db.role.deleteMany({ where: { organizationId, name: ROLE_NAME } })
}

const step = process.argv[2]
;(step === 'setup'
  ? setup()
  : step === 'cleanup'
    ? cleanup()
    : Promise.reject(new Error(`no step ${step}`))
)
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => endProcess(() => db.$disconnect()))
