import { expect, test } from '@playwright/test'
import { settle } from '../../support/hydration'
import { cleanUpPublicApi, deliveredEvents, setUpPublicApi } from '../../support/public-api'

/**
 * fork (A6, docs/fork/milestones/A6-hardening.md task 1): the public API end to end. The owner makes a key in
 * Settings → API keys; over HTTP it creates a customer, their vehicle, a work order, a labour line and a payment; the
 * work order's page shows the line and the payment; the webhook's delivery log has every event; the key is revoked
 * on the screen and stops working at once. (In `specs/public-api/`: the suite keeps one folder per area.)
 */

test.describe.configure({ mode: 'serial' })

let fixtures: ReturnType<typeof setUpPublicApi>

test.beforeAll(() => {
  fixtures = setUpPublicApi()
})

test.afterAll(() => {
  cleanUpPublicApi()
})

test('a key made in Settings writes a work order the app shows, with its webhook events', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)

  // The key, made on the screen: shown once.
  await page.goto('/settings/api-keys')
  await settle(page)
  await page.getByRole('button', { name: 'Create key' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('E2E public API')
  await dialog.locator('#api-key-role').click()
  await page.getByRole('option', { name: 'E2E API full access' }).click()
  await dialog.getByRole('button', { name: 'Create key' }).click()
  const shown = page.getByRole('dialog').filter({ hasText: 'Your new API key' })
  await expect(shown).toBeVisible()
  const key = (await shown.locator('code').innerText()).trim()
  expect(key).toMatch(/^tvk_/)
  await shown.getByRole('button', { name: 'Done' }).click()

  // Over HTTP, as an integration would.
  const api = async (method: 'POST' | 'GET' | 'DELETE', path: string, data?: unknown) => {
    const response = await request.fetch(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(data !== undefined ? { data } : {}),
    })
    return { status: response.status(), body: await response.json().catch(() => null) }
  }
  const customer = await api('POST', '/customers', { name: 'E2E API Customer' })
  expect(customer.status).toBe(201)
  const vehicle = await api('POST', '/vehicles', {
    customerId: customer.body.data.id,
    make: 'Volvo',
    model: 'XC60',
    year: 2021,
  })
  expect(vehicle.status).toBe(201)
  const workOrder = await api('POST', '/work-orders', {
    vehicleId: vehicle.body.data.id,
    title: 'E2E API brake service',
    type: 'repair',
  })
  expect(workOrder.status).toBe(201)
  const workOrderId = workOrder.body.data.id as string
  const line = await api('POST', `/work-orders/${workOrderId}/lines`, {
    kind: 'labor',
    description: 'E2E API labour line',
    hours: 2,
    rate: 100,
  })
  expect(line.status).toBe(201)
  const payment = await api('POST', `/work-orders/${workOrderId}/payments`, {
    amount: 123.45,
    method: 'cash',
    note: 'E2E API payment',
  })
  expect(payment.status).toBe(201)

  // The app shows what the API wrote.
  await page.goto(`/vehicles/${vehicle.body.data.id}/service/${workOrderId}`)
  await settle(page)
  await expect(page.getByText('E2E API brake service').first()).toBeVisible()
  await expect(page.getByText('E2E API labour line').first()).toBeVisible()
  // The page draws some figures twice, one copy hidden for another layout.
  await expect(
    page
      .getByText(/123[.,]45/)
      .filter({ visible: true })
      .first()
  ).toBeVisible()

  // Every write's event reached the webhook's delivery log.
  await expect
    .poll(() => deliveredEvents(fixtures.webhookId), { timeout: 20_000 })
    .toEqual(
      expect.arrayContaining([
        'customer.create',
        'vehicle.create',
        'service.create',
        'service.update',
        'payment.create',
      ])
    )
  await page.goto('/settings/webhooks')
  await settle(page)
  // The smallest block that holds both the webhook's name and its Deliveries button: its card.
  const card = page
    .locator('div')
    .filter({ hasText: 'E2E API events' })
    .filter({ has: page.getByRole('button', { name: 'Deliveries' }) })
    .last()
  await card.getByRole('button', { name: 'Deliveries' }).click()
  await expect(page.getByRole('dialog').getByText('payment.create').first()).toBeVisible()
  await page.keyboard.press('Escape')

  // Cleaned up through the API, then the key revoked on the screen: it stops working at once.
  expect((await api('DELETE', `/work-orders/${workOrderId}`)).status).toBe(200)
  expect((await api('DELETE', `/vehicles/${vehicle.body.data.id}`)).status).toBe(200)
  expect((await api('DELETE', `/customers/${customer.body.data.id}`)).status).toBe(200)
  await page.goto('/settings/api-keys')
  await settle(page)
  // The smallest block that holds both the key's name and its Revoke button: its row.
  const row = page
    .locator('div')
    .filter({ hasText: 'E2E public API' })
    .filter({ has: page.getByRole('button', { name: 'Revoke' }) })
    .last()
  await row.getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
  await expect.poll(async () => (await api('GET', '/customers?limit=1')).status).toBe(401)
})
