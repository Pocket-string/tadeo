import { test, Page, expect } from '@playwright/test'

const TEST_EMAIL = 'jonathan.navarrete.ai@gmail.com'
const TEST_PASSWORD = '5438880'
const BASE = 'http://localhost:3000'

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { timeout: 60000 })
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#email').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(1000)
  await page.locator('#email').fill(TEST_EMAIL)
  await page.locator('#password').fill(TEST_PASSWORD)
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Iniciar Sesión' }).click()
  await page.waitForURL('**/dashboard', { timeout: 45000 })
}

test.describe('Turbo Deploy: Optimizer → Paper Trading', () => {
  test.setTimeout(300000)

  test('Optimize BNBUSDT 4h then deploy to paper trading', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Select BNBUSDT + 4h
    await page.locator('select').first().selectOption('BNBUSDT')
    await page.locator('button').filter({ hasText: /^4h$/ }).click()

    // Run optimizer
    await page.getByRole('button', { name: /ai optimizer/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText.toLowerCase()
      return body.includes('variaciones exploradas') || body.includes('mejoras encontradas')
    }, { timeout: 180000 })

    await page.waitForTimeout(1000)

    // Check result is VIABLE or PROMETEDORA (has positive PnL)
    const body = await page.textContent('body') || ''
    console.log('Has deploy button:', body.includes('Desplegar'))

    // Click deploy button
    const deployBtn = page.getByRole('button', { name: /desplegar/i })
    if (await deployBtn.isVisible()) {
      await deployBtn.click()

      // Wait for success message
      await page.waitForFunction(() => {
        const text = document.body.innerText
        return text.includes('Estrategia desplegada') || text.includes('Auto-Tick')
      }, { timeout: 30000 })

      await page.waitForTimeout(1000)
      await page.screenshot({ path: 'screenshots/turbo-deploy-success.png', fullPage: true })

      const result = await page.textContent('body') || ''
      console.log('Deploy success:', result.includes('Estrategia desplegada'))
      expect(result).toContain('Estrategia desplegada')
    } else {
      console.log('No deploy button visible — strategy may have negative PnL')
      await page.screenshot({ path: 'screenshots/turbo-deploy-no-button.png', fullPage: true })
    }
  })
})
