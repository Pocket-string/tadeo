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

test.describe('15m Timeframe Flow', () => {
  test.setTimeout(600000)

  test('Step 1: Ingest ETHUSDT 15m + SOLUSDT 1h', async ({ page }) => {
    await login(page)

    // Ingest ETHUSDT 15m
    await page.goto('/market-data')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    const symbolSelect = page.locator('select').first()
    await symbolSelect.selectOption('ETHUSDT')
    await page.locator('button').filter({ hasText: /^15m$/ }).click()
    await page.getByRole('button', { name: /ingestar/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('completada') || body.includes('Error')
    }, { timeout: 120000 })

    await page.waitForTimeout(2000)
    let body = await page.textContent('body') || ''
    console.log('ETH 15m ingested:', body.includes('completada'))
    await page.screenshot({ path: 'screenshots/15m-01-eth-ingested.png', fullPage: true })

    // Now ingest SOLUSDT 1h
    await symbolSelect.selectOption('SOLUSDT')
    await page.locator('button').filter({ hasText: /^1h$/ }).click()
    await page.getByRole('button', { name: /ingestar/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText
      // Need to check for a NEW completion message (the old one is still there)
      return body.includes('SOLUSDT') && body.includes('completada') || body.includes('Error')
    }, { timeout: 120000 })

    await page.waitForTimeout(2000)
    body = await page.textContent('body') || ''
    console.log('SOL 1h ingested:', body.includes('completada'))
    await page.screenshot({ path: 'screenshots/15m-02-sol-ingested.png', fullPage: true })
  })

  test('Step 2: AI Analysis on ETHUSDT 15m', async ({ page }) => {
    await login(page)
    await page.goto('/ai-analyst')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(3000)

    // Check available symbols
    const symbolSelect = page.locator('select').first()
    const symbolOptions = await symbolSelect.locator('option').allTextContents()
    console.log('Symbols:', symbolOptions)

    // Select ETHUSDT
    if (symbolOptions.some(o => o.includes('ETH'))) {
      await symbolSelect.selectOption(symbolOptions.find(o => o.includes('ETH'))!)
    }

    // Select 15m timeframe
    await page.locator('button').filter({ hasText: /^15m$/ }).click()

    await page.screenshot({ path: 'screenshots/15m-10-before.png', fullPage: true })
    await page.getByText('Analizar con AI').click()

    // Wait for results
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('Guardar Estrategia') || body.includes('Guardar') ||
             body.includes('Trend') || body.includes('rend') ||
             (body.includes('rror') && !body.includes('Analizar con AI'))
    }, { timeout: 180000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/15m-11-ai-result.png', fullPage: true })

    const body = await page.textContent('body') || ''
    console.log('Has analysis:', body.includes('Trend') || body.includes('rend'))
    console.log('Bias:', body.match(/Overall Bias[:\s]*([\w_]+)/i)?.[1] || 'unknown')

    // Save
    const saveBtn = page.getByRole('button', { name: /guardar/i })
    if (await saveBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await saveBtn.click()
      await page.waitForTimeout(3000)
      console.log('=== Strategy saved! ===')
    }
  })

  test('Step 3: Scientific Backtest on 15m strategy', async ({ page }) => {
    await login(page)
    await page.goto('/backtests/scientific')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    const strategySelect = page.locator('select').first()
    const options = await strategySelect.locator('option').allTextContents()
    console.log('Strategies:', options)

    // Pick the Bullish Trend Continuation strategy (or most recent)
    const bullishIdx = options.findIndex(o => o.toLowerCase().includes('bullish'))
    if (bullishIdx >= 0) {
      await strategySelect.selectOption({ index: bullishIdx })
      console.log('Selected:', options[bullishIdx])
    } else if (options.length > 0) {
      await strategySelect.selectOption({ index: 0 })
      console.log('Selected:', options[0])
    }

    // Change symbol to ETHUSDT (default is BTCUSDT)
    const symbolInput = page.locator('input[type="text"]').first()
    await symbolInput.clear()
    await symbolInput.fill('ETHUSDT')

    // Select 15m
    await page.locator('button').filter({ hasText: /^15m$/ }).click()
    await page.getByRole('button', { name: /ejecutar/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText
      return ((body.includes('Semaforo') || body.includes('In-Sample') || body.includes('Out-of-Sample')) &&
             !body.includes('Ejecutando backtest cientifico')) ||
             body.includes('Need at least') || body.includes('Not enough')
    }, { timeout: 240000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/15m-20-scientific.png', fullPage: true })

    const body = await page.textContent('body') || ''
    if (body.includes('APROBADO')) console.log('=== APPROVED ===')
    else if (body.includes('PRECAUCION')) console.log('=== CAUTION ===')
    else if (body.includes('RECHAZADO')) console.log('=== REJECTED ===')

    const winRate = body.match(/Win Rate[\s:]*(\d+[\.,]?\d*)%/i)
    const trades = body.match(/Total Trades[\s:]*(\d+)/i)
    if (winRate) console.log('Win Rate:', winRate[1] + '%')
    if (trades) console.log('Total Trades:', trades[1])
  })
})
