import { test, Page } from '@playwright/test'

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

test.describe('Optimize Best Pairs', () => {
  test.setTimeout(300000)

  test('Optimize ETHUSDT 15m (best win rate from scan)', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Set ETHUSDT + 15m
    await page.locator('select').first().selectOption('ETHUSDT')
    await page.locator('button').filter({ hasText: /^15m$/ }).click()

    // Run optimizer
    await page.getByRole('button', { name: /ai optimizer/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText.toLowerCase()
      return body.includes('variaciones exploradas') || body.includes('mejoras encontradas')
    }, { timeout: 180000 })

    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'screenshots/opt-ethusdt-15m.png', fullPage: true })

    // Log key metrics from page
    const body = await page.textContent('body') || ''
    // Find win rate and PnL in the results
    const winMatch = body.match(/Win Rate[:\s]*(\d+\.?\d*)%/)
    const pnlMatch = body.match(/PnL[:\s]*([+-]?\d+\.?\d*)%/)
    console.log(`ETHUSDT 15m optimized: WinRate=${winMatch?.[1]}%, PnL=${pnlMatch?.[1]}%`)
    console.log('Improvements:', body.includes('mejoras encontradas'))
  })

  test('Optimize SOLUSDT 4h (second best from scan)', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Set SOLUSDT + 4h
    await page.locator('select').first().selectOption('SOLUSDT')
    await page.locator('button').filter({ hasText: /^4h$/ }).click()

    // Run optimizer
    await page.getByRole('button', { name: /ai optimizer/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText.toLowerCase()
      return body.includes('variaciones exploradas') || body.includes('mejoras encontradas')
    }, { timeout: 180000 })

    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'screenshots/opt-solusdt-4h.png', fullPage: true })

    const body = await page.textContent('body') || ''
    const winMatch = body.match(/Win Rate[:\s]*(\d+\.?\d*)%/)
    const pnlMatch = body.match(/PnL[:\s]*([+-]?\d+\.?\d*)%/)
    console.log(`SOLUSDT 4h optimized: WinRate=${winMatch?.[1]}%, PnL=${pnlMatch?.[1]}%`)
  })

  test('Optimize BNBUSDT 4h (trending regime)', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Set BNBUSDT + 4h
    await page.locator('select').first().selectOption('BNBUSDT')
    await page.locator('button').filter({ hasText: /^4h$/ }).click()

    // Run optimizer
    await page.getByRole('button', { name: /ai optimizer/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText.toLowerCase()
      return body.includes('variaciones exploradas') || body.includes('mejoras encontradas')
    }, { timeout: 180000 })

    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'screenshots/opt-bnbusdt-4h.png', fullPage: true })

    const body = await page.textContent('body') || ''
    const winMatch = body.match(/Win Rate[:\s]*(\d+\.?\d*)%/)
    const pnlMatch = body.match(/PnL[:\s]*([+-]?\d+\.?\d*)%/)
    console.log(`BNBUSDT 4h optimized: WinRate=${winMatch?.[1]}%, PnL=${pnlMatch?.[1]}%`)
  })
})
