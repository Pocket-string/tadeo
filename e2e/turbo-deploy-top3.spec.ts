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

async function optimizeAndDeploy(page: Page, symbol: string, tf: string) {
  await page.goto(`${BASE}/paper-trading`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  await page.locator('select').first().selectOption(symbol)
  await page.locator('button').filter({ hasText: new RegExp(`^${tf}$`) }).click()

  // Run optimizer
  await page.getByRole('button', { name: /ai optimizer/i }).click()

  await page.waitForFunction(() => {
    const body = document.body.innerText.toLowerCase()
    return body.includes('variaciones exploradas') || body.includes('mejoras encontradas')
  }, { timeout: 180000 })

  await page.waitForTimeout(1000)

  // Deploy if profitable
  const deployBtn = page.getByRole('button', { name: /desplegar/i })
  if (await deployBtn.isVisible()) {
    await deployBtn.click()

    await page.waitForFunction(() => {
      return document.body.innerText.includes('Estrategia desplegada')
    }, { timeout: 30000 })

    await page.waitForTimeout(500)
    console.log(`DEPLOYED: ${symbol} ${tf}`)
    return true
  }

  console.log(`SKIP (no deploy button): ${symbol} ${tf}`)
  return false
}

test.describe('Deploy Top 3 Short TF Strategies', () => {
  test.setTimeout(600000)

  test('Optimize and deploy ETHUSDT 5m, SOLUSDT 5m, BTCUSDT 15m', async ({ page }) => {
    await login(page)

    const strategies = [
      { symbol: 'ETHUSDT', tf: '5m' },
      { symbol: 'SOLUSDT', tf: '5m' },
      { symbol: 'BTCUSDT', tf: '15m' },
    ]

    let deployed = 0
    for (const s of strategies) {
      try {
        const ok = await optimizeAndDeploy(page, s.symbol, s.tf)
        if (ok) deployed++
      } catch (e) {
        console.log(`FAILED ${s.symbol} ${s.tf}: ${e instanceof Error ? e.message : 'unknown'}`)
      }
    }

    await page.screenshot({ path: 'screenshots/top3-deployed.png', fullPage: true })
    console.log(`\nDeployed ${deployed}/3 strategies to paper trading`)
    expect(deployed).toBeGreaterThanOrEqual(1)

    // Verify sessions exist by checking tick-all
    const response = await page.request.post(`${BASE}/api/paper-trading/tick-all`, {
      headers: { 'x-auto-tick': 'true' },
    })
    const data = await response.json()
    console.log(`Active sessions: ${data.sessions}`)
    console.log('Results:', JSON.stringify(data.results?.map((r: { symbol: string; action: string; reason: string }) => `${r.symbol}: ${r.action} - ${r.reason}`)))
  })
})
