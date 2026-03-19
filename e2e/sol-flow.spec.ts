import { test, Page } from '@playwright/test'

const TEST_EMAIL = 'jonathan.navarrete.ai@gmail.com'
const TEST_PASSWORD = '5438880'

async function login(page: Page) {
  await page.goto('/login', { timeout: 60000 })
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#email').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(1000)
  await page.locator('#email').fill(TEST_EMAIL)
  await page.locator('#password').fill(TEST_PASSWORD)
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Iniciar Sesión' }).click()
  await page.waitForURL('**/dashboard', { timeout: 45000 })
}

test.describe('SOL Flow: AI → Backtest', () => {
  test.setTimeout(600000)

  test('AI Analysis + Save + Backtest on SOLUSDT 1h', async ({ page }) => {
    await login(page)
    await page.goto('/ai-analyst')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(3000)

    // Select SOLUSDT
    const symbolSelect = page.locator('select').first()
    const symbolOptions = await symbolSelect.locator('option').allTextContents()
    console.log('Symbols:', symbolOptions)

    if (symbolOptions.some(o => o.includes('SOL'))) {
      await symbolSelect.selectOption(symbolOptions.find(o => o.includes('SOL'))!)
    }

    // Select 1h
    await page.locator('button').filter({ hasText: /^1h$/ }).click()
    await page.getByText('Analizar con AI').click()

    // Wait for AI results
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('Guardar Estrategia') || body.includes('Guardar') ||
             body.includes('Trend') || body.includes('rend') ||
             (body.includes('rror') && !body.includes('Analizar con AI'))
    }, { timeout: 180000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/sol-01-ai.png', fullPage: true })

    const aiBody = await page.textContent('body') || ''
    console.log('Trend:', aiBody.match(/Direction[:\s]*([\w]+)/i)?.[1] || 'unknown')
    console.log('Bias:', aiBody.match(/Overall Bias[:\s]*([\w_]+)/i)?.[1] || 'unknown')

    // Save strategy
    const saveBtn = page.getByRole('button', { name: /guardar/i })
    if (await saveBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await saveBtn.click()
      await page.waitForTimeout(3000)
      console.log('=== SOL Strategy saved! ===')
    } else {
      console.log('No save button — possible error')
      return
    }

    // Now run scientific backtest
    await page.goto('/backtests/scientific')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    const strategySelect2 = page.locator('select').first()
    const strategyOptions = await strategySelect2.locator('option').allTextContents()
    console.log('Strategies:', strategyOptions)

    // Select most recent strategy (index 0 should be newest)
    await strategySelect2.selectOption({ index: 0 })
    console.log('Selected:', strategyOptions[0])

    // Change symbol to SOLUSDT
    const symbolInput = page.locator('input[type="text"]').first()
    await symbolInput.clear()
    await symbolInput.fill('SOLUSDT')

    // Select 1h
    await page.locator('button').filter({ hasText: /^1h$/ }).click()
    await page.screenshot({ path: 'screenshots/sol-10-before-backtest.png', fullPage: true })

    await page.getByRole('button', { name: /ejecutar/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText
      return ((body.includes('Semaforo') || body.includes('In-Sample') || body.includes('Out-of-Sample')) &&
             !body.includes('Ejecutando backtest cientifico')) ||
             body.includes('Need at least') || body.includes('Not enough')
    }, { timeout: 240000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/sol-11-scientific.png', fullPage: true })

    const body = await page.textContent('body') || ''
    if (body.includes('APROBADO')) console.log('=== SOL APPROVED ===')
    else if (body.includes('PRECAUCION')) console.log('=== SOL CAUTION ===')
    else if (body.includes('RECHAZADO')) console.log('=== SOL REJECTED ===')

    const winRate = body.match(/Win Rate[\s:]*(\d+[\.,]?\d*)%/i)
    const trades = body.match(/Total Trades[\s:]*(\d+)/i)
    if (winRate) console.log('Win Rate:', winRate[1] + '%')
    if (trades) console.log('Total Trades:', trades[1])
  })
})
