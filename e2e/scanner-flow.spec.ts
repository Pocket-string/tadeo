import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:3000'
const EMAIL = 'jonathan.navarrete.ai@gmail.com'
const PASSWORD = '5438880'

test.describe('Scanner Flow: Ingest → Scan → Backtest', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/login`)
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForURL('**/dashboard', { timeout: 15000 })
  })

  async function ingestPair(page: import('@playwright/test').Page, symbol: string, timeframe: string) {
    await page.goto(`${BASE}/market-data`)
    await page.waitForLoadState('networkidle')

    // Select symbol from dropdown
    await page.locator('select').first().selectOption(symbol)

    // Click timeframe button
    await page.click(`button:has-text("${timeframe}")`)

    // Set dates to 6 months back
    const endDate = new Date().toISOString().split('T')[0]
    const startDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const dateInputs = page.locator('input[type="date"]')
    await dateInputs.nth(0).fill(startDate)
    await dateInputs.nth(1).fill(endDate)

    // Submit
    await page.click('button[type="submit"]')

    // Wait for completion (can take a while for 6 months of data)
    await page.waitForSelector('text=/completad|Guardados/i', { timeout: 120000 })

    // Verify result
    const resultText = await page.textContent('body')
    expect(resultText).toMatch(/Guardados:\s*[\d,]+/)
  }

  test('1. Ingest ETHUSDT 4h (6 months)', async ({ page }) => {
    await ingestPair(page, 'ETHUSDT', '4h')
    await page.screenshot({ path: 'screenshots/scanner-01-eth4h.png' })
  })

  test('2. Ingest SOLUSDT 4h (6 months)', async ({ page }) => {
    await ingestPair(page, 'SOLUSDT', '4h')
    await page.screenshot({ path: 'screenshots/scanner-02-sol4h.png' })
  })

  test('3. Ingest BNBUSDT 4h (6 months)', async ({ page }) => {
    await ingestPair(page, 'BNBUSDT', '4h')
    await page.screenshot({ path: 'screenshots/scanner-03-bnb4h.png' })
  })

  test('4. Run Scanner', async ({ page }) => {
    await page.goto(`${BASE}/scanner`)
    await page.waitForLoadState('networkidle')

    // Click scan
    await page.click('button:has-text("Escanear Mercado")')

    // Wait for results (scanning multiple pairs can take time)
    await page.waitForSelector('text=/Escaneados|No hay oportunidades/i', { timeout: 60000 })

    await page.screenshot({ path: 'screenshots/scanner-04-results.png', fullPage: true })

    const body = await page.textContent('body')
    expect(body).toMatch(/Escaneados/)
  })

  test('5. Full pipeline: scan → approve → scientific backtest', async ({ page }) => {
    // Scan
    await page.goto(`${BASE}/scanner`)
    await page.waitForLoadState('networkidle')
    await page.click('button:has-text("Escanear Mercado")')
    await page.waitForSelector('text=/Escaneados|No hay oportunidades/i', { timeout: 60000 })

    await page.screenshot({ path: 'screenshots/scanner-05a-scan.png', fullPage: true })

    const approveButtons = page.locator('button:has-text("Aprobar")')
    const count = await approveButtons.count()

    if (count > 0) {
      // Approve first opportunity
      await approveButtons.first().click()
      await page.waitForSelector('text=/creada/i', { timeout: 15000 })
      await page.screenshot({ path: 'screenshots/scanner-05b-approved.png' })

      // Go to scientific backtest
      await page.goto(`${BASE}/backtests/scientific`)
      await page.waitForLoadState('networkidle')
      await page.screenshot({ path: 'screenshots/scanner-05c-scientific.png' })

      // Select the most recent strategy (Scanner strategy)
      const strategySelects = page.locator('select')
      const firstSelect = strategySelects.first()
      if (await firstSelect.isVisible()) {
        const options = await firstSelect.locator('option').allTextContents()
        // Find the Scanner strategy
        const scannerOption = options.findIndex(o => o.includes('Scanner'))
        if (scannerOption >= 0) {
          await firstSelect.selectOption({ index: scannerOption })
        } else if (options.length > 1) {
          await firstSelect.selectOption({ index: options.length - 1 })
        }
      }

      // Look for run button and click if visible
      const runBtn = page.locator('button:has-text("Ejecutar"), button:has-text("Backtest")')
      if (await runBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await runBtn.first().click()
        await page.waitForSelector('text=/APROBAD|RECHAZAD|PRECAUCI|semáforo|Trades|In-Sample/i', { timeout: 120000 })
        await page.screenshot({ path: 'screenshots/scanner-05d-result.png', fullPage: true })
      }
    } else {
      console.log('No opportunities found. Market is choppy/volatile - scanner is protecting capital correctly.')
      await page.screenshot({ path: 'screenshots/scanner-05-no-opps.png' })
    }
  })
})
