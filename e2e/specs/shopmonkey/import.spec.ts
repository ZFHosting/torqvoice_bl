import { expect, type Page, test } from '@playwright/test'
import {
  connectionStatus,
  customerOfVehicle,
  forgetConnections,
  ownerOrganizationId,
} from '../../support/db'
import { settle } from '../../support/hydration'
import { portalAs, setPortal } from '../../support/portal'
import { cleanUpShopmonkey, loadedRow, runQueuedJobs } from '../../support/shopmonkey'

/**
 * fork (M8, docs/fork/milestones/M8-import-ui.md): the Shopmonkey import from its connector page, against the stand-in
 * Shopmonkey (`e2e/shopmonkey-standin.ts`, the synthetic fixtures). Connect, extract, map, dry run, load, the report
 * with every gate passing, what an imported vehicle and job look like (on the work order and in the vehicle's current
 * owner's portal), then undo, which leaves the shared workshop as it was. The server's timers are off, so the spec runs the queued jobs itself (`support/shopmonkey.ts`).
 */

test.describe.configure({ mode: 'serial' })

/** The toast saying this: the panel's status line can show the same words (e2e/support/email-designer.ts does the same). */
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text }).first()

/** Whether the workshop's portal was on before the spec turned it on (undefined until then). */
let portalWasOpen: boolean | undefined

test.afterAll(async ({ browser }) => {
  // The portal's switch (up to a minute) and the clean-up script (up to three) take longer than a hook's default.
  test.setTimeout(300_000)
  try {
    // The portal as it was found, from a page of its own: the test's may be gone after a timeout.
    if (portalWasOpen !== undefined) {
      const owner = await browser.newPage({ storageState: 'e2e/.auth/owner.json' })
      await setPortal(owner, portalWasOpen).finally(() => owner.close())
    }
  } finally {
    // Whether or not the test got to its own undo, or the portal could be put back: the loads undone, the archive
    // gone, then the connection, even when the clean-up fails.
    try {
      cleanUpShopmonkey()
    } finally {
      await forgetConnections(['shopmonkey'])
    }
  }
})

test.describe('the Shopmonkey import', () => {
  test('connects, extracts, maps, dry-runs, loads, reconciles and undoes', async ({ page }) => {
    test.setTimeout(360_000)
    await page.goto('/settings/integrations/shopmonkey')
    await settle(page)
    await page.locator('input[name="shopmonkey-apiKey"]').fill('sm-e2e-key')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect
      .poll(() => connectionStatus('shopmonkey'), {
        timeout: 30_000,
        message: 'Shopmonkey is active',
      })
      .toBe('active')

    await page.reload()
    await settle(page)
    const panel = page.getByTestId('shopmonkey-import')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('Nothing has been read from Shopmonkey yet.')).toBeVisible()

    // Extract.
    await panel.getByRole('button', { name: 'Extract', exact: true }).click()
    await expect(toast(page, 'The extract has started.')).toBeVisible()
    runQueuedJobs()
    await page.reload()
    await settle(page)
    await expect(panel.getByText(/^Extracted /)).toBeVisible()
    await expect(panel.getByTestId('shopmonkey-progress')).toContainText('order')

    // The mapping: what each workflow status and user becomes.
    await expect(panel.getByRole('combobox', { name: /^Stage for / }).first()).toBeVisible()
    await expect(panel.getByRole('combobox', { name: /^Technician for / }).first()).toBeVisible()
    await panel.getByTestId('shopmonkey-mapping-save').click()
    await expect(toast(page, 'Saved. The next load uses it.')).toBeVisible()

    // A dry run, then the load.
    await panel.getByRole('button', { name: 'Dry run', exact: true }).click()
    await expect(toast(page, 'Dry run queued.')).toBeVisible()
    runQueuedJobs()
    await page.reload()
    await settle(page)
    await expect(panel.getByTestId('shopmonkey-load-status')).toHaveText(/^Dry run done/)
    await expect(panel.getByText(/^Last dry run /)).toBeVisible()

    await panel.getByRole('button', { name: 'Load', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Load', exact: true }).click()
    await expect(toast(page, 'Load queued.')).toBeVisible()
    runQueuedJobs()
    await page.reload()
    await settle(page)
    await expect(panel.getByTestId('shopmonkey-load-status')).toHaveText(/^Load done/)

    // The report: every gate passes.
    await panel.getByTestId('shopmonkey-reconcile').click()
    await expect(toast(page, 'Every check passes.')).toBeVisible()
    await expect(panel.locator('[data-gate][data-passed="true"]')).toHaveCount(4)

    // A vehicle Shopmonkey has no year, make or model for (M0 spike T4): no stray "0", and it says it's synced.
    const vehicle = await loadedRow('Vehicle', 'vehicle', 'syn_veh_3')
    expect(vehicle).not.toBeNull()
    await page.goto(`/vehicles/${vehicle}`)
    await settle(page)
    await expect(page.getByText('Unknown Unknown').first()).toBeVisible()
    await expect(page.getByText(/(^|\s)0 Unknown/)).toHaveCount(0)
    await expect(page.getByTestId('shopmonkey-sync-banner')).toBeVisible()

    // A job billed to the vehicle's previous owner (T3, blocker B10): the work order names who it was billed to.
    const job = await loadedRow('ServiceRecord', 'order', 'syn_ord_1004')
    expect(job).not.toBeNull()
    await page.goto(`/vehicles/${vehicle}/service/${job}`)
    await settle(page)
    await expect(page.getByText(/Dana Dunmore/).first()).toBeVisible()
    await expect(page.getByTestId('shopmonkey-sync-banner')).toBeVisible()

    // The same job in the vehicle's current owner's portal (B10's default: listed there, spike T3). The portal is put
    // back as it was found.
    portalWasOpen = await setPortal(page, true)
    const owner = await customerOfVehicle(vehicle as string)
    const { portal, base } = await portalAs(page, await ownerOrganizationId(), owner.email)
    try {
      await portal.goto(`${base}/vehicles/${vehicle}`)
      await expect(portal.locator(`a[href$="/invoices/${job}"]`).first()).toBeVisible()
    } finally {
      await portal.close()
    }
    await setPortal(page, portalWasOpen)
    portalWasOpen = undefined

    // Undo the load: the workshop is as it was.
    await page.goto('/settings/integrations/shopmonkey')
    await settle(page)
    const runs = page.getByTestId('shopmonkey-runs')
    await runs.getByRole('button', { name: 'Undo', exact: true }).first().click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(toast(page, /Undone: /)).toBeVisible()
    expect(await loadedRow('ServiceRecord', 'order', 'syn_ord_1004')).toBeNull()
  })

  test.describe('in dark mode and another language', () => {
    test.use({ colorScheme: 'dark' })

    test('shows the import, in English where the language has no words for it yet', async ({
      page,
      baseURL,
    }) => {
      await page
        .context()
        .addCookies([{ name: 'locale', value: 'nb', url: baseURL ?? 'http://localhost:3100' }])
      await page.goto('/settings/integrations/shopmonkey')
      await settle(page)
      const panel = page.getByTestId('shopmonkey-import')
      await expect(panel).toBeVisible()
      await expect(panel.getByText('Extract and load')).toBeVisible()
      // The page itself is in Norwegian (the import's own words fall back to English until translated).
      await expect(page.getByRole('button', { name: 'Koble fra' })).toBeVisible()
      await expect(page.locator('html')).toHaveClass(/dark/)
    })
  })
})
