import { Page } from '@playwright/test'

/**
 * Dismiss any onboarding/tour overlay that might block interactions.
 * Call after page.goto() and waitForLoadState.
 */
export async function dismissOverlays(page: Page) {
  // Try to dismiss onboarding wizard ("Omitir tutorial" button)
  const omitirBtn = page.getByText('Omitir tutorial')
  if (await omitirBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await omitirBtn.click()
    await page.waitForTimeout(500)
  }

  // Try to dismiss tour ("Saltar tour" button)
  const saltarBtn = page.getByText('Saltar tour')
  if (await saltarBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await saltarBtn.click()
    await page.waitForTimeout(500)
  }
}
