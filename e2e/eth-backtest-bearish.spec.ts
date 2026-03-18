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

test.describe('Bearish Strategy Backtest', () => {
  test.setTimeout(600000)

  test('Scientific Backtest on Bearish Momentum Short', async ({ page }) => {
    await login(page)
    await page.goto('/backtests/scientific')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    const strategySelect = page.locator('select').first()
    const options = await strategySelect.locator('option').allTextContents()
    console.log('Strategies:', options)

    // Find the Bearish Momentum Short strategy
    const bearishIdx = options.findIndex(o => o.toLowerCase().includes('bearish momentum'))
    if (bearishIdx >= 0) {
      await strategySelect.selectOption({ index: bearishIdx })
      console.log('Selected:', options[bearishIdx])
    } else {
      // Just pick first non-placeholder
      await strategySelect.selectOption({ index: 0 })
      console.log('Selected first:', options[0])
    }

    // Select 1h
    await page.locator('button').filter({ hasText: /^1h$/ }).click()
    await page.screenshot({ path: 'screenshots/bearish-00-before.png', fullPage: true })

    // Execute
    await page.getByRole('button', { name: /ejecutar/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText
      return (body.includes('Semaforo') || body.includes('In-Sample') || body.includes('Out-of-Sample')) &&
             !body.includes('Ejecutando backtest cientifico')
    }, { timeout: 240000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/bearish-01-result.png', fullPage: true })

    const body = await page.textContent('body') || ''
    if (body.includes('APROBADO')) console.log('=== APPROVED === Strategy is viable!')
    else if (body.includes('PRECAUCION')) console.log('=== CAUTION === Proceed with care')
    else if (body.includes('RECHAZADO')) console.log('=== REJECTED === Do not trade this')

    // Log key metrics
    const winRateMatch = body.match(/Win Rate[\s:]*(\d+[\.,]?\d*)%/i)
    const tradesMatch = body.match(/Total Trades[\s:]*(\d+)/i)
    if (winRateMatch) console.log('Win Rate:', winRateMatch[1] + '%')
    if (tradesMatch) console.log('Total Trades:', tradesMatch[1])
  })
})
