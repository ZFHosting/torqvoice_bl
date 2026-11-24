import { expect, test } from '@playwright/test'
import { settle } from '../../support/hydration'
import { pdfContent } from '../../support/pdf'
import { addJobs, removeWorkOrder, workshopHasJobs } from '../../support/work-jobs'
import {
  addLabor,
  jobIdOf,
  newWorkOrder,
  saveWorkOrder,
  seededVehicleUrl,
} from '../../support/work-order'

/**
 * fork (M9, docs/fork/milestones/M9-job-grouping-ui.md): a work order's lines under its jobs (Shopmonkey's
 * services). A workshop without jobs sees its work order and invoice as before; once the work order has jobs (as the
 * import or the API make them), the page shows the lines under them, a line moved to another job and saved stays
 * there, and the invoice prints each job with its lines and subtotal.
 */

test.describe.configure({ mode: 'serial' })

const BRAKES = 'E2E Front brakes'
const OIL = 'E2E Oil change'
const DISCS = 'E2E replace discs'
const OIL_LABOR = 'E2E oil change labour'

let jobUrl = ''

test.afterAll(async () => {
  if (jobUrl) await removeWorkOrder(jobIdOf(jobUrl))
})

async function invoiceText(page: import('@playwright/test').Page): Promise<string> {
  const response = await page.request.get(`/api/protected/services/${jobIdOf(jobUrl)}/pdf`)
  expect(response.status()).toBe(200)
  return (await pdfContent(await response.body())).flat
}

test('a workshop without jobs sees its work order and invoice as before', async ({ page }) => {
  test.setTimeout(120_000)
  jobUrl = await newWorkOrder(page, await seededVehicleUrl(page), 'E2E jobs brake service')
  expect(await workshopHasJobs(jobIdOf(jobUrl)), 'the suite’s workshop starts without jobs').toBe(
    false
  )
  await addLabor(page, { description: DISCS, hours: 2, rate: 100 })
  await addLabor(page, { description: OIL_LABOR, hours: 1, rate: 70 })
  await saveWorkOrder(page)
  await page.reload()
  await settle(page)
  await expect(page.getByRole('button', { name: 'Add job' })).toHaveCount(0)
  const text = await invoiceText(page)
  expect(text).toContain(DISCS)
  // No group headings or group subtotals: the lines print as one flat list.
  expect(text).not.toMatch(/\w subtotal/)
})

test('with jobs, the lines show under them, a moved line stays moved, and the invoice prints by job', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await addJobs(jobIdOf(jobUrl), { withLine: BRAKES, empty: OIL }, DISCS)
  await page.goto(jobUrl)
  await settle(page)
  const brakes = page.getByRole('region', { name: BRAKES })
  await expect(brakes.getByText(DISCS)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Other' }).getByText(OIL_LABOR)).toBeVisible()

  await page.getByRole('combobox', { name: `Job for ${OIL_LABOR}` }).click()
  await page.getByRole('option', { name: OIL }).click()
  await expect(page.getByRole('region', { name: OIL }).getByText(OIL_LABOR)).toBeVisible()
  await saveWorkOrder(page)

  await page.reload()
  await settle(page)
  await expect(page.getByRole('region', { name: OIL }).getByText(OIL_LABOR)).toBeVisible()
  await expect(page.getByRole('region', { name: BRAKES }).getByText(DISCS)).toBeVisible()

  const text = await invoiceText(page)
  expect(text).toMatch(
    new RegExp(`${BRAKES}.*${DISCS}.*${BRAKES} subtotal.*${OIL}.*${OIL_LABOR}.*${OIL} subtotal`)
  )
})
