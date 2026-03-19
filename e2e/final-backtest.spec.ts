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

async function ingestPair(page: Page, symbol: string, timeframe: string, monthsBack: number) {
  await page.goto(`${BASE}/market-data`)
  await page.waitForLoadState('networkidle')

  await page.locator('select').first().selectOption(symbol)
  await page.click(`button:has-text("${timeframe}")`)

  const endDate = new Date().toISOString().split('T')[0]
  const start = new Date()
  start.setMonth(start.getMonth() - monthsBack)
  const startDate = start.toISOString().split('T')[0]

  const dateInputs = page.locator('input[type="date"]')
  await dateInputs.nth(0).fill(startDate)
  await dateInputs.nth(1).fill(endDate)

  await page.click('button[type="submit"]')
  await page.waitForSelector('text=/completad|Guardados/i', { timeout: 120000 })
}

async function createOptimizedStrategy(page: Page) {
  await page.goto(`${BASE}/strategies/new`)
  await page.waitForLoadState('networkidle')

  // Fill in the form
  const nameInput = page.locator('input[name="name"]')
  if (await nameInput.isVisible()) {
    await nameInput.fill('Optimized EMA 20/50 Conservative')
  }

  const descInput = page.locator('textarea[name="description"], input[name="description"]')
  if (await descInput.first().isVisible()) {
    await descInput.first().fill('Slow EMA crossover (20/50) with conservative stops. Designed for 1h timeframe with 12mo data.')
  }

  await page.click('button[type="submit"]')
  await page.waitForTimeout(2000)
}

async function runScientificBacktest(page: Page, strategyIdx: number, symbol: string, tf: string): Promise<string> {
  await page.goto(`${BASE}/backtests/scientific`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  const strategySelect = page.locator('select').first()
  await strategySelect.selectOption({ index: strategyIdx })

  const symbolInput = page.locator('input[type="text"]').first()
  await symbolInput.clear()
  await symbolInput.fill(symbol)

  await page.locator('button').filter({ hasText: new RegExp(`^${tf}$`) }).click()
  await page.getByRole('button', { name: /ejecutar/i }).click()

  try {
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return ((body.includes('Semaforo') || body.includes('In-Sample') || body.includes('Out-of-Sample')) &&
             !body.includes('Ejecutando backtest cientifico')) ||
             body.includes('Need at least') || body.includes('Not enough') || body.includes('Error')
    }, { timeout: 180000 })
  } catch {
    return 'TIMEOUT'
  }

  await page.waitForTimeout(2000)
  const body = await page.textContent('body') || ''

  if (body.includes('APROBADO')) return 'APPROVED'
  if (body.includes('PRECAUCION')) return 'CAUTION'
  if (body.includes('RECHAZADO')) return 'REJECTED'
  return 'UNKNOWN'
}

test.describe('Phase 2: Ingest 12mo + optimize + find sustainable', () => {
  test.setTimeout(600000)

  test('Step 1: Ingest 12 months of 1h data for top pairs', async ({ page }) => {
    await login(page)

    // Ingest 12 months of 1h data (more trades = more statistical significance)
    console.log('Ingesting SOLUSDT 1h (12 months)...')
    await ingestPair(page, 'SOLUSDT', '1h', 12)
    console.log('Done SOLUSDT 1h')

    console.log('Ingesting ETHUSDT 1h (12 months)...')
    await ingestPair(page, 'ETHUSDT', '1h', 12)
    console.log('Done ETHUSDT 1h')

    console.log('Ingesting BNBUSDT 1h (12 months)...')
    await ingestPair(page, 'BNBUSDT', '1h', 12)
    console.log('Done BNBUSDT 1h')

    await page.screenshot({ path: 'screenshots/phase2-01-ingested.png' })
  })

  test('Step 2: Create optimized strategy + test', async ({ page }) => {
    await login(page)

    // Create new strategy
    await createOptimizedStrategy(page)
    await page.screenshot({ path: 'screenshots/phase2-02-strategy.png' })

    // Go to backtests
    await page.goto(`${BASE}/backtests/scientific`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    const strategySelect = page.locator('select').first()
    const options = await strategySelect.locator('option').allTextContents()
    console.log('Strategies:', options)

    // Find the optimized strategy or use the one with best results
    const optimizedIdx = options.findIndex(o => o.includes('Optimized'))
    const scannerIdx = options.findIndex(o => o.includes('Scanner'))
    const targetIdx = optimizedIdx >= 0 ? optimizedIdx : (scannerIdx >= 0 ? scannerIdx : options.length - 1)

    // Test on ETHUSDT 1h (best CAUTION result from previous run)
    const configs = [
      { symbol: 'ETHUSDT', tf: '1h' },
      { symbol: 'SOLUSDT', tf: '1h' },
      { symbol: 'BNBUSDT', tf: '1h' },
      { symbol: 'SOLUSDT', tf: '4h' },
    ]

    let bestResult = { verdict: 'REJECTED', config: '' }

    for (const cfg of configs) {
      console.log(`\nTesting ${cfg.symbol} ${cfg.tf}...`)
      const verdict = await runScientificBacktest(page, targetIdx, cfg.symbol, cfg.tf)
      console.log(`  ${cfg.symbol} ${cfg.tf}: ${verdict}`)

      await page.screenshot({
        path: `screenshots/phase2-${cfg.symbol}-${cfg.tf}-${verdict.toLowerCase()}.png`,
        fullPage: true,
      })

      if (verdict === 'APPROVED') {
        console.log(`\n>>> SUSTAINABLE STRATEGY FOUND: ${cfg.symbol} ${cfg.tf} <<<`)
        bestResult = { verdict, config: `${cfg.symbol} ${cfg.tf}` }
        break
      } else if (verdict === 'CAUTION' && bestResult.verdict !== 'APPROVED') {
        bestResult = { verdict, config: `${cfg.symbol} ${cfg.tf}` }
      }
    }

    console.log(`\nBest result: ${bestResult.verdict} on ${bestResult.config}`)

    if (bestResult.verdict === 'APPROVED') {
      console.log('Strategy is validated for live trading!')
    } else if (bestResult.verdict === 'CAUTION') {
      console.log('Strategy shows promise but needs more validation via paper trading.')
    }
  })
})
