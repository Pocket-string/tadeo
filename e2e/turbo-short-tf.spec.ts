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

async function optimizePair(page: Page, symbol: string, tf: string) {
  await page.goto(`${BASE}/paper-trading`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  await page.locator('select').first().selectOption(symbol)
  await page.locator('button').filter({ hasText: new RegExp(`^${tf}$`) }).click()

  await page.getByRole('button', { name: /ai optimizer/i }).click()

  await page.waitForFunction(() => {
    const body = document.body.innerText.toLowerCase()
    return body.includes('variaciones exploradas') || body.includes('mejoras encontradas')
  }, { timeout: 180000 })

  await page.waitForTimeout(500)

  // Extract metrics from page
  const body = await page.textContent('body') || ''
  const winMatch = body.match(/Win Rate[:\s]*(\d+\.?\d*)%/)
  const pnlMatch = body.match(/PnL[:\s]*([+-]?\d+\.?\d*)%/)
  const tradesMatch = body.match(/Trades[:\s]*(\d+)/)
  const sharpeMatch = body.match(/Sharpe[:\s]*([+-]?\d+\.?\d*)/)

  const winRate = winMatch ? parseFloat(winMatch[1]) : 0
  const pnl = pnlMatch ? parseFloat(pnlMatch[1]) : 0
  const trades = tradesMatch ? parseInt(tradesMatch[1]) : 0
  const sharpe = sharpeMatch ? parseFloat(sharpeMatch[1]) : 0

  await page.screenshot({ path: `screenshots/short-${symbol}-${tf}.png`, fullPage: true })

  return { symbol, tf, winRate, pnl, trades, sharpe }
}

test.describe('Short Timeframe Exploration', () => {
  test.setTimeout(600000) // 10 min total

  test('Optimize all pairs on 5m and 15m', async ({ page }) => {
    await login(page)

    const combos = [
      { symbol: 'ETHUSDT', tf: '5m' },
      { symbol: 'ETHUSDT', tf: '15m' },
      { symbol: 'BNBUSDT', tf: '5m' },
      { symbol: 'BNBUSDT', tf: '15m' },
      { symbol: 'SOLUSDT', tf: '5m' },
      { symbol: 'SOLUSDT', tf: '15m' },
      { symbol: 'BTCUSDT', tf: '5m' },
      { symbol: 'BTCUSDT', tf: '15m' },
    ]

    const results = []

    for (const combo of combos) {
      try {
        const result = await optimizePair(page, combo.symbol, combo.tf)
        results.push(result)
        console.log(`${result.symbol} ${result.tf}: WR=${result.winRate}% PnL=${result.pnl}% Trades=${result.trades} Sharpe=${result.sharpe}`)
      } catch (e) {
        console.log(`${combo.symbol} ${combo.tf}: FAILED - ${e instanceof Error ? e.message : 'unknown'}`)
      }
    }

    // Summary
    console.log('\n=== SHORT TIMEFRAME RESULTS ===')
    const sorted = results.sort((a, b) => b.pnl - a.pnl)
    for (const r of sorted) {
      const verdict = r.pnl > 5 ? 'VIABLE' : r.pnl > 0 ? 'PROMISING' : 'SKIP'
      console.log(`[${verdict}] ${r.symbol} ${r.tf}: PnL=${r.pnl}% WR=${r.winRate}% Trades=${r.trades} Sharpe=${r.sharpe}`)
    }

    const viable = sorted.filter(r => r.pnl > 0)
    console.log(`\nViable strategies: ${viable.length}/${results.length}`)
    if (viable.length > 0) {
      console.log(`Best: ${viable[0].symbol} ${viable[0].tf} with PnL=${viable[0].pnl}%`)
    }
  })
})
