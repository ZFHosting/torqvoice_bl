import { expect, type Page } from '@playwright/test'
import { settle } from './hydration'
import { clearMailbox, linkIn, waitForMail } from './mail'

/**
 * fork (M8): the customer portal for a spec that needs to see what a customer sees: the workshop's portal switch,
 * and a customer signed in the way the portal signs one in (a link mailed to them, read from the mail sink), as
 * `specs/email/sending.spec.ts` does.
 */

/** Turns the portal on or off on its settings page; returns whether it was on, to put it back. */
export async function setPortal(page: Page, open: boolean): Promise<boolean> {
  await page.goto('/settings/customer-portal')
  await settle(page)
  const toggle = page.locator('#portal-enabled')
  await expect(toggle).toBeVisible()
  const was = (await toggle.getAttribute('aria-checked')) === 'true'
  if (was === open) return was
  await expect(async () => {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', String(open), { timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Everything is saved')).toBeVisible({ timeout: 30_000 })
  return was
}

/**
 * A new page, with no workshop session, signed into the portal as the customer with this email. Returns the page and
 * the portal's base address (`http://…/portal/<workshop>`), as the sign-in landed on it.
 */
export async function portalAs(
  page: Page,
  organizationId: string,
  email: string
): Promise<{ portal: Page; base: string }> {
  await clearMailbox()
  const asked = await page.request.post(`/api/public/portal/${organizationId}/auth/request`, {
    data: { email },
  })
  expect(asked.ok(), 'the workshop accepted the portal sign-in request').toBe(true)
  const mail = await waitForMail(email, { timeout: 30_000 })
  const link = linkIn(mail, /https?:\/\/[^"'\s]*\/auth\/verify\?token=[^"'\s&]+/)
  const portal = await page
    .context()
    .browser()
    ?.newPage({ storageState: { cookies: [], origins: [] } })
  if (!portal) throw new Error('no browser to open the portal with')
  try {
    return await signIn(portal, link)
  } catch (err) {
    await portal.close()
    throw err
  }
}

async function signIn(portal: Page, link: string): Promise<{ portal: Page; base: string }> {
  // The link only checks itself and leads to a page with a button (a mail scanner opening it signs nobody in); the
  // button signs the customer in.
  await portal.goto(link)
  await expect(portal, 'the link leads to the sign-in button').toHaveURL(/\/auth\/confirm/, {
    timeout: 30_000,
  })
  await portal.getByRole('button', { name: 'Continue to sign in' }).click()
  await expect(portal, 'the button signs the customer in').toHaveURL(/\/portal\/(?!.*\/auth\/)/, {
    timeout: 30_000,
  })
  const landed = new URL(portal.url())
  const base = landed.pathname.match(/^\/portal\/[^/]+/)?.[0]
  if (!base) throw new Error(`the portal landed on ${landed.pathname}`)
  return { portal, base: `${landed.origin}${base}` }
}
