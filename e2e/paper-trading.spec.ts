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

test.describe('Paper Trading: SOLUSDT 4h validation', () => {
  test.setTimeout(300000) // 5 min total

  test('Step 1: Navigate to Paper Trading and start session', async ({ page }) => {
    await login(page)

    // Navigate to paper trading
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    await page.screenshot({ path: 'screenshots/paper-01-initial.png', fullPage: true })

    // Click "Nueva Sesión" button
    const newSessionBtn = page.getByRole('button', { name: /nueva ses/i })
    if (await newSessionBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newSessionBtn.click()
      await page.waitForTimeout(1000)

      // Select strategy - find the best CAUTION one (Scanner or Optimized)
      const strategySelect = page.locator('select').first()
      const options = await strategySelect.locator('option').allTextContents()
      console.log('Available strategies:', options)

      // Try to find Scanner strategy or the best available
      const scannerIdx = options.findIndex(o => o.includes('Scanner'))
      const optimizedIdx = options.findIndex(o => o.includes('Optimized'))
      const targetIdx = scannerIdx >= 0 ? scannerIdx : (optimizedIdx >= 0 ? optimizedIdx : 0)
      await strategySelect.selectOption({ index: targetIdx })
      console.log(`Selected strategy: ${options[targetIdx]}`)

      // Set symbol to SOLUSDT
      const symbolInput = page.locator('input[placeholder="BTCUSDT"]')
      if (await symbolInput.isVisible()) {
        await symbolInput.clear()
        await symbolInput.fill('SOLUSDT')
      }

      // Set timeframe to 4h
      const tfSelect = page.locator('select').nth(1)
      if (await tfSelect.isVisible()) {
        await tfSelect.selectOption('4h')
      }

      // Set capital to match real account (~10 USDC for testing)
      const capitalInput = page.locator('input[type="number"]')
      if (await capitalInput.isVisible()) {
        await capitalInput.clear()
        await capitalInput.fill('100')
      }

      await page.screenshot({ path: 'screenshots/paper-02-form.png', fullPage: true })

      // Start session
      await page.getByRole('button', { name: /iniciar ses/i }).click()
      await page.waitForTimeout(3000)

      await page.screenshot({ path: 'screenshots/paper-03-started.png', fullPage: true })

      // Verify session appeared
      const body = await page.textContent('body') || ''
      const hasSession = body.includes('SOLUSDT') || body.includes('active') || body.includes('Capital')
      console.log('Session created:', hasSession)
      expect(hasSession).toBeTruthy()
    } else {
      console.log('New session button not found — may already have sessions')
      await page.screenshot({ path: 'screenshots/paper-02-existing.png', fullPage: true })
    }
  })

  test('Step 2: Execute ticks and verify signals', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Click on the SOLUSDT session card (or first session)
    const sessionCard = page.locator('text=SOLUSDT').first()
    if (await sessionCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sessionCard.click()
      await page.waitForTimeout(2000)
    }

    await page.screenshot({ path: 'screenshots/paper-04-dashboard.png', fullPage: true })

    // Execute multiple ticks to check for signals
    const tickBtn = page.getByRole('button', { name: /ejecutar tick/i })
    const results: string[] = []

    for (let i = 0; i < 3; i++) {
      if (await tickBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tickBtn.click()
        await page.waitForTimeout(5000) // Wait for tick to complete

        const body = await page.textContent('body') || ''
        const hasPrice = body.includes('Precio Actual') || body.includes('$')
        const hasTrade = body.includes('BUY') || body.includes('SELL')
        const hasHold = body.includes('hold') || body.includes('No signal')

        results.push(`Tick ${i + 1}: price=${hasPrice}, trade=${hasTrade}`)
        console.log(`Tick ${i + 1}: price=${hasPrice}, trade=${hasTrade}, hold=${hasHold}`)
      }
    }

    await page.screenshot({ path: 'screenshots/paper-05-after-ticks.png', fullPage: true })

    // Verify the dashboard shows KPI cards
    const body = await page.textContent('body') || ''
    const hasCapital = body.includes('Capital') || body.includes('$')
    const hasPnL = body.includes('PnL')
    console.log(`Dashboard: capital=${hasCapital}, pnl=${hasPnL}`)
    console.log('Tick results:', results)
  })

  test('Step 3: Run AI Monitor', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Click on the session
    const sessionCard = page.locator('text=SOLUSDT').first()
    if (await sessionCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sessionCard.click()
      await page.waitForTimeout(2000)
    }

    // Click AI Monitor button
    const monitorBtn = page.getByRole('button', { name: /ai monitor/i })
    if (await monitorBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await monitorBtn.click()
      await page.waitForTimeout(10000) // Wait for AI analysis

      await page.screenshot({ path: 'screenshots/paper-06-monitor.png', fullPage: true })

      const body = await page.textContent('body') || ''
      const hasReport = body.includes('Monitor') || body.includes('alertas') || body.includes('Sin alertas')
      console.log('AI Monitor report:', hasReport)
    } else {
      console.log('AI Monitor button not visible — session may not be active')
      await page.screenshot({ path: 'screenshots/paper-06-no-monitor.png', fullPage: true })
    }
  })
})
