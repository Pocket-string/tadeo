import { test, Page } from '@playwright/test'

const TEST_EMAIL = 'jonathan.navarrete.ai@gmail.com'
const TEST_PASSWORD = '5438880'

async function login(page: Page) {
  await page.goto('/login', { timeout: 60000 })
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#email').waitFor({ timeout: 15000 })
  await page.locator('#email').fill(TEST_EMAIL)
  await page.locator('#password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Iniciar Sesión' }).click()
  await page.waitForURL('**/dashboard', { timeout: 45000 })
}

test.describe('ETH Workflow: Ingest → AI → Backtest', () => {
  test.setTimeout(600000) // 10 min total

  test('Step 1: Ingest ETHUSDT 1h data', async ({ page }) => {
    await login(page)
    await page.goto('/market-data')
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: 'screenshots/eth-00-market-data.png', fullPage: true })

    // Select ETHUSDT from dropdown
    const symbolSelect = page.locator('select').first()
    await symbolSelect.selectOption('ETHUSDT')

    // Select 1h timeframe
    await page.locator('button').filter({ hasText: /^1h$/ }).click()

    // Submit ingestion
    await page.getByRole('button', { name: /ingestar/i }).click()

    // Wait for completion
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('completada') || body.includes('insertadas') ||
             body.includes('Error') || body.includes('error')
    }, { timeout: 120000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/eth-01-ingested.png', fullPage: true })

    const body = await page.textContent('body') || ''
    console.log('Ingestion result:', body.includes('completada') ? 'SUCCESS' : 'CHECK SCREENSHOT')

    // Log candle count if visible
    const match = body.match(/(\d[\d,]*)\s*velas?\s*insertadas/i) || body.match(/(\d[\d,]*)\s*candles?/i)
    if (match) console.log('Candles:', match[1])
  })

  test('Step 2: AI Analysis on ETHUSDT', async ({ page }) => {
    await login(page)
    await page.goto('/ai-analyst')
    await page.waitForLoadState('networkidle')

    // Check if ETHUSDT is selectable (might be a symbol selector)
    const symbolSelect = page.locator('select').first()
    const options = await symbolSelect.locator('option').allTextContents()
    console.log('Available symbols:', options)

    // Select ETHUSDT if available
    if (options.some(o => o.includes('ETH'))) {
      await symbolSelect.selectOption({ label: options.find(o => o.includes('ETH'))! })
    }

    // Select 1h
    await page.locator('button').filter({ hasText: /^1h$/ }).click()
    await page.screenshot({ path: 'screenshots/eth-10-before-analysis.png', fullPage: true })

    // Run AI analysis
    await page.getByText('Analizar con AI').click()

    // Wait for results
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('Guardar Estrategia') || body.includes('Guardar') ||
             body.includes('Aplicar') || body.includes('Analisis de Mercado') ||
             body.includes('Trend') || body.includes('rend') ||
             (body.includes('rror') && !body.includes('Analizar con AI'))
    }, { timeout: 180000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/eth-11-ai-result.png', fullPage: true })

    const body = await page.textContent('body') || ''
    console.log('Has analysis:', body.includes('Trend') || body.includes('rend'))
    console.log('Has error:', body.includes('invalid_value') || body.includes('Too big'))

    // Save strategy
    const saveBtn = page.getByRole('button', { name: /guardar/i })
    if (await saveBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await saveBtn.click()
      await page.waitForTimeout(3000)
      await page.screenshot({ path: 'screenshots/eth-12-saved.png', fullPage: true })
      console.log('=== ETH AI Strategy saved! ===')
    } else {
      console.log('No save button — check screenshot')
    }
  })

  test('Step 3: Scientific Backtest on ETH strategy', async ({ page }) => {
    await login(page)
    await page.goto('/backtests/scientific')
    await page.waitForLoadState('networkidle')

    // Select latest strategy (should be the ETH one we just saved)
    const strategySelect = page.locator('select').first()
    const options = await strategySelect.locator('option').allTextContents()
    console.log('Strategies:', options)

    // Find ETH strategy or pick latest
    const ethIdx = options.findIndex(o => o.toLowerCase().includes('eth'))
    if (ethIdx >= 0) {
      await strategySelect.selectOption({ index: ethIdx })
      console.log('Selected ETH strategy:', options[ethIdx])
    } else if (options.length > 1) {
      await strategySelect.selectOption({ index: options.length - 1 })
      console.log('Selected latest strategy:', options[options.length - 1])
    }

    // Select 1h
    await page.locator('button').filter({ hasText: /^1h$/ }).click()
    await page.screenshot({ path: 'screenshots/eth-20-before-backtest.png', fullPage: true })

    // Execute
    await page.getByRole('button', { name: /ejecutar/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText
      return (body.includes('Semaforo') || body.includes('In-Sample') || body.includes('Out-of-Sample')) &&
             !body.includes('Ejecutando backtest cientifico')
    }, { timeout: 240000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/eth-21-scientific.png', fullPage: true })

    const body = await page.textContent('body') || ''
    if (body.includes('APROBADO')) console.log('=== APPROVED === Strategy is viable!')
    else if (body.includes('PRECAUCION')) console.log('=== CAUTION === Proceed with care')
    else if (body.includes('RECHAZADO')) console.log('=== REJECTED === Do not trade this')

    // Log key metrics
    const winRateMatch = body.match(/Win Rate[:\s]*(\d+[\.,]?\d*)%/i)
    const profitMatch = body.match(/Profit[:\s]*\$?([-\d,\.]+)/i)
    const tradesMatch = body.match(/(\d+)\s*trades?/i)
    if (winRateMatch) console.log('Win Rate:', winRateMatch[1] + '%')
    if (profitMatch) console.log('Profit:', profitMatch[1])
    if (tradesMatch) console.log('Trades:', tradesMatch[1])
  })
})
