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

test.describe('Turbo Simulator: Accelerated Learning', () => {
  test.setTimeout(300000)

  test('Step 1: Turbo Sim SOLUSDT 1h', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Select SOLUSDT + 1h (defaults)
    await page.screenshot({ path: 'screenshots/turbo-01-initial.png', fullPage: true })

    // Click Turbo Sim
    await page.getByRole('button', { name: /turbo sim/i }).click()

    // Wait for results
    await page.waitForFunction(() => {
      const body = document.body.innerText.toLowerCase()
      return body.includes('trades') && body.includes('win rate') && body.includes('pnl')
    }, { timeout: 60000 })

    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'screenshots/turbo-02-result.png', fullPage: true })

    const body = await page.textContent('body') || ''
    console.log('Has trades:', body.includes('Trades'))
    console.log('Has win rate:', body.includes('Win Rate'))
    console.log('Has verdict:', body.includes('VIABLE') || body.includes('PROMETEDORA') || body.includes('NO VIABLE'))
    expect(body).toMatch(/Trades|Win Rate/)
  })

  test('Step 2: Scan ALL Pairs x Timeframes', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Click Scan ALL
    await page.getByRole('button', { name: /scan all/i }).click()

    // Wait for multi-sim results (can take a while)
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('combinaciones') || body.includes('VIABLE') || body.includes('PROMETEDORA')
    }, { timeout: 120000 })

    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'screenshots/turbo-03-scan-all.png', fullPage: true })

    const body = await page.textContent('body') || ''
    console.log('Has scan results:', body.includes('combinaciones'))
    // Log which pairs are viable
    if (body.includes('VIABLE')) console.log('>>> FOUND VIABLE STRATEGIES <<<')
    if (body.includes('PROMETEDORA')) console.log('>>> FOUND PROMISING STRATEGIES <<<')
  })

  test('Step 3: AI Optimizer (Genetic)', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/paper-trading`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Click AI Optimizer
    await page.getByRole('button', { name: /ai optimizer/i }).click()

    // Wait for optimization results
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('variaciones exploradas') || body.includes('mejoras encontradas')
    }, { timeout: 120000 })

    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'screenshots/turbo-04-optimizer.png', fullPage: true })

    const body = await page.textContent('body') || ''
    console.log('Optimization complete:', body.includes('variaciones exploradas'))
    console.log('Improvements found:', body.includes('mejoras encontradas'))
  })
})
