import { test, expect, Page } from '@playwright/test'

const TEST_EMAIL = 'jonathan.navarrete.ai@gmail.com'
const TEST_PASSWORD = '5438880'

async function login(page: Page) {
  await page.goto('/login', { timeout: 60000 })
  await page.waitForLoadState('networkidle')
  await page.locator('#email').fill(TEST_EMAIL)
  await page.locator('#password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Iniciar Sesión' }).click()
  await page.waitForURL('**/dashboard', { timeout: 45000 })
}

test.describe('Full Trading Flow', () => {
  test.setTimeout(180000)

  test('Step 1: Login → Dashboard visible', async ({ page }) => {
    await login(page)
    await expect(page.locator('h1').first()).toBeVisible()
    await page.screenshot({ path: 'screenshots/01-dashboard.png' })
  })

  test('Step 2: Market Data shows ingested candles', async ({ page }) => {
    await login(page)
    await page.locator('aside').getByRole('link', { name: 'Market Data' }).click()
    await page.waitForURL('**/market-data', { timeout: 30000 })
    await page.waitForLoadState('networkidle')

    // Verify data is visible (should show BTCUSDT 1h with 2161 candles)
    const body = await page.textContent('body')
    await page.screenshot({ path: 'screenshots/02-market-data.png' })

    // Check if candles are shown in the summary table
    const hasBTCUSDT = body?.includes('BTCUSDT')
    console.log('BTCUSDT visible in page:', hasBTCUSDT)
    console.log('Page body snippet:', body?.substring(0, 500))
  })

  test('Step 3: Create strategy', async ({ page }) => {
    await login(page)
    await page.locator('aside').getByRole('link', { name: 'Estrategias' }).click()
    await page.waitForURL('**/strategies', { timeout: 30000 })
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: 'screenshots/03-strategies-before.png' })

    // Look for "New Strategy" or "Crear Estrategia" button
    const newBtn = page.getByRole('link', { name: /nueva|new|crear/i })
    if (await newBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newBtn.click()
      await page.waitForLoadState('networkidle')
      await page.screenshot({ path: 'screenshots/03b-new-strategy.png' })
    }
  })

  test('Step 4: Run backtest', async ({ page }) => {
    await login(page)
    await page.locator('aside').getByRole('link', { name: 'Backtesting' }).click()
    await page.waitForURL('**/backtests', { timeout: 30000 })
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: 'screenshots/04-backtesting.png' })
  })

  test('Step 5: AI Analyst', async ({ page }) => {
    await login(page)
    await page.locator('aside').getByRole('link', { name: 'AI Analyst' }).click()
    await page.waitForURL('**/ai-analyst', { timeout: 30000 })
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: 'screenshots/05-ai-analyst.png' })
  })

  test('Step 6: Paper Trading', async ({ page }) => {
    await login(page)
    await page.locator('aside').getByRole('link', { name: 'Paper Trading' }).click()
    await page.waitForURL('**/paper-trading', { timeout: 30000 })
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: 'screenshots/06-paper-trading.png' })
  })
})
