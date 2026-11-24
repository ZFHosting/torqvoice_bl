/**
 * fork (A6, docs/fork/milestones/A6-hardening.md task 4): a workshop for the API's load check, in a local database
 * made for it: 5,000 customers, 10,000 vehicles, 50,000 work orders over three years, 20,000 payments, and twelve
 * full-access API keys (20 requests a second over 120 a minute each). SYNTHETIC data. Refuses any database but a local
 * one named for testing (`guard.ts`).
 *
 *   DATABASE_URL=postgresql://…/torqvoice_fork_load LOAD_KEYS_FILE=<path outside the repo> \
 *     npx tsx --import ./scripts/shopmonkey/register.mjs scripts/load-check/seed.ts
 */
import { writeFileSync } from 'node:fs'
import { createApiKey } from '@/features/public-api/Lib/keys.server'
import { db } from '@/lib/db'
import { permissionGroups } from '@/lib/permissions'
import { endProcess } from '../shopmonkey/exit'
import { loadDatabaseRefusal } from './guard'

const CUSTOMERS = 5_000
const VEHICLES = 10_000
const WORK_ORDERS = 50_000
const PAYMENTS = 20_000
const KEYS = 12
const CHUNK = 5_000

function guard() {
  const refusal = loadDatabaseRefusal(process.env.DATABASE_URL)
  if (refusal) throw new Error(refusal)
  if (!process.env.LOAD_KEYS_FILE) throw new Error('LOAD_KEYS_FILE says where the keys go (outside the repo).')
}

const DAY = 24 * 60 * 60 * 1000
const START = Date.parse('2023-11-01T00:00:00Z')
const at = (i: number, n: number) => new Date(START + Math.floor((i / n) * 3 * 365) * DAY + (i % 600) * 60_000)

async function inChunks<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK))
}

async function main() {
  guard()
  const owner = await db.user.create({
    data: { email: `load-owner-${Date.now()}@example.test`, name: 'Load Owner' },
    select: { id: true },
  })
  const org = await db.organization.create({ data: { name: 'Load Check Workshop' }, select: { id: true } })
  await db.organizationMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'owner' } })
  const role = await db.role.create({
    data: {
      organizationId: org.id,
      name: 'Load check',
      permissions: {
        create: permissionGroups.flatMap((g) =>
          g.permissions.map((p) => ({ action: p.action as string, subject: g.subject as string }))
        ),
      },
    },
  })
  const keys: string[] = []
  for (let i = 0; i < KEYS; i++) {
    const made = await createApiKey({
      organizationId: org.id,
      name: `load ${i + 1}`,
      roleId: role.id,
      createdById: owner.id,
    })
    keys.push(made.key)
  }

  const customerIds = Array.from({ length: CUSTOMERS }, (_, i) => `load-cus-${i}`)
  await inChunks(
    customerIds.map((id, i) => ({
      id,
      organizationId: org.id,
      userId: owner.id,
      name: `Load Customer ${i}`,
      email: `customer${i}@example.test`,
      createdAt: at(i, CUSTOMERS),
      updatedAt: at(i, CUSTOMERS),
    })),
    (data) => db.customer.createMany({ data })
  )
  const vehicleIds = Array.from({ length: VEHICLES }, (_, i) => `load-veh-${i}`)
  await inChunks(
    vehicleIds.map((id, i) => ({
      id,
      organizationId: org.id,
      userId: owner.id,
      customerId: customerIds[i % CUSTOMERS],
      make: ['Volvo', 'Toyota', 'Ford', 'Tesla'][i % 4],
      model: 'Model',
      year: 2005 + (i % 20),
      createdAt: at(i, VEHICLES),
      updatedAt: at(i, VEHICLES),
    })),
    (data) => db.vehicle.createMany({ data })
  )
  const statuses = ['pending', 'in-progress', 'waiting-parts', 'completed', 'completed', 'completed']
  const workOrderIds = Array.from({ length: WORK_ORDERS }, (_, i) => `load-wo-${i}`)
  await inChunks(
    workOrderIds.map((id, i) => {
      const when = at(i, WORK_ORDERS)
      return {
        id,
        organizationId: org.id,
        vehicleId: vehicleIds[i % VEHICLES],
        customerId: customerIds[i % CUSTOMERS],
        title: `Load job ${i}`,
        status: statuses[i % statuses.length],
        serviceDate: when,
        startDateTime: when,
        totalAmount: 100 + (i % 900),
        subtotal: 100 + (i % 900),
        invoiceNumber: String(10_000 + i),
        createdAt: when,
        updatedAt: when,
      }
    }),
    (data) => db.serviceRecord.createMany({ data })
  )
  await inChunks(
    Array.from({ length: PAYMENTS }, (_, i) => ({
      serviceRecordId: workOrderIds[(i * 7) % WORK_ORDERS],
      amount: 50 + (i % 400),
      method: 'card',
      date: at(i, PAYMENTS),
      createdAt: at(i, PAYMENTS),
      updatedAt: at(i, PAYMENTS),
    })),
    (data) => db.payment.createMany({ data })
  )
  writeFileSync(process.env.LOAD_KEYS_FILE as string, `${JSON.stringify({ organizationId: org.id, keys })}\n`)
  console.log(
    `Seeded ${CUSTOMERS} customers, ${VEHICLES} vehicles, ${WORK_ORDERS} work orders, ${PAYMENTS} payments, ${KEYS} keys.`
  )
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => endProcess(() => db.$disconnect()))
