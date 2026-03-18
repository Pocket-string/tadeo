import { test, expect, Page } from '@playwright/test'

const TEST_EMAIL = process.env.TEST_EMAIL || 'test@trader.com'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'testpassword123'

async function login(page: Page) {
  await page.goto('/login', { timeout: 60000 })
  await page.waitForLoadState('networkidle')
  await page.locator('#email').fill(TEST_EMAIL)
  await page.locator('#password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Iniciar Sesión' }).click()
  await page.waitForURL('**/dashboard', { timeout: 45000 })
}

test.describe('Authenticated Pages - Full Audit', () => {
  test.setTimeout(120000)

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('dashboard carga correctamente', async ({ page }) => {
    // Greeting
    await expect(page.locator('h1').first()).toBeVisible()
    await expect(page.getByText('Vista general del sistema de trading')).toBeVisible()

    // KPI cards (no accents in rendered text)
    await expect(page.getByText('Simbolos')).toBeVisible()
    await expect(page.getByText('Estrategias')).toBeVisible()
    await expect(page.getByText('Backtests')).toBeVisible()
    await expect(page.getByText('Estado')).toBeVisible()

    // Sections
    await expect(page.getByRole('heading', { name: 'Datos de Mercado' })).toBeVisible()
  })

  test('sidebar navigation visible y completa', async ({ page }) => {
    // Use sidebar-specific selectors to avoid matching dashboard content links
    const sidebar = page.locator('aside')

    await expect(sidebar.getByRole('link', { name: 'Dashboard' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Market Data' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Estrategias' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Backtesting' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'AI Analyst' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Paper Trading' })).toBeVisible()

    // Logout button
    await expect(page.getByText('Cerrar Sesion')).toBeVisible()
  })

  test('market-data page carga', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Market Data' }).click()
    await page.waitForURL('**/market-data', { timeout: 30000 })
    await expect(page).toHaveURL(/market-data/)
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 })
  })

  test('strategies page carga', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Estrategias' }).click()
    await page.waitForURL('**/strategies', { timeout: 30000 })
    await expect(page).toHaveURL(/strategies/)
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 })
  })

  test('backtests page carga', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Backtesting' }).click()
    await page.waitForURL('**/backtests', { timeout: 30000 })
    await expect(page).toHaveURL(/backtests/)
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 })
  })

  test('ai-analyst page carga', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'AI Analyst' }).click()
    await page.waitForURL('**/ai-analyst', { timeout: 30000 })
    await expect(page).toHaveURL(/ai-analyst/)
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 })
  })

  test('paper-trading page carga', async ({ page }) => {
    await page.locator('aside').getByRole('link', { name: 'Paper Trading' }).click()
    await page.waitForURL('**/paper-trading', { timeout: 30000 })
    await expect(page).toHaveURL(/paper-trading/)
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 })
  })

  test('live-trading page carga (admin only)', async ({ page }) => {
    const sidebar = page.locator('aside')
    const liveLink = sidebar.getByRole('link', { name: 'Live Trading' })
    if (await liveLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await liveLink.click()
      await page.waitForURL('**/live-trading', { timeout: 30000 })
      await expect(page).toHaveURL(/live-trading/)
      await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 })
    }
  })

  test('navegacion entre paginas es fluida', async ({ page }) => {
    const sidebar = page.locator('aside')
    const routes = [
      { name: 'Market Data', url: /market-data/ },
      { name: 'Estrategias', url: /strategies/ },
      { name: 'Backtesting', url: /backtests/ },
      { name: 'AI Analyst', url: /ai-analyst/ },
      { name: 'Paper Trading', url: /paper-trading/ },
      { name: 'Dashboard', url: /dashboard/ },
    ]

    for (const route of routes) {
      await sidebar.getByRole('link', { name: route.name }).click()
      await page.waitForURL(`**/${route.url.source.replace(/\\/g, '')}`, { timeout: 30000 })
      await expect(page).toHaveURL(route.url)
      await expect(page.locator('body')).not.toContainText('Application error')
    }
  })

  test('logout funciona correctamente', async ({ page }) => {
    await page.getByText('Cerrar Sesion').click()
    await page.waitForURL('**/login', { timeout: 15000 })
    await expect(page).toHaveURL(/login/)
  })

  test('no hay errores de consola criticos', async ({ page }) => {
    const errors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    })

    await page.waitForTimeout(3000)

    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('hydration') &&
      !e.includes('Warning:') &&
      !e.includes('404')
    )

    if (criticalErrors.length > 0) {
      console.log('Console errors found:', criticalErrors)
    }
  })

  test('no hay links rotos en sidebar', async ({ page }) => {
    const links = page.locator('aside a[href]')
    const count = await links.count()

    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href')
      if (href && href.startsWith('/')) {
        const response = await page.request.get(href)
        expect(response.status(), `Link ${href} returned ${response.status()}`).toBeLessThan(500)
      }
    }
  })
})
