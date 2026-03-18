import { test, Page } from '@playwright/test'

const TEST_EMAIL = 'jonathan.navarrete.ai@gmail.com'
const TEST_PASSWORD = '5438880'

async function login(page: Page) {
  await page.goto('/login', { timeout: 60000 })
  await page.waitForLoadState('networkidle')
  await page.locator('#email').fill(TEST_EMAIL)
  await page.locator('#password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Iniciar Sesión' }).click()
  await page.waitForURL('**/dashboard', { timeout: 45000 })
}

test.describe('AI-Optimized Strategy', () => {
  test.setTimeout(600000) // 10 min total

  test('Step 1: AI Analysis + Save Strategy', async ({ page }) => {
    await login(page)
    await page.goto('/ai-analyst')
    await page.waitForLoadState('networkidle')

    // Select 1h
    await page.locator('button').filter({ hasText: /^1h$/ }).click()
    await page.getByText('Analizar con AI').click()

    // Wait for results — include 'error' in check so we don't hang forever
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('Guardar Estrategia') || body.includes('Guardar') ||
             body.includes('Aplicar') || body.includes('Analisis de Mercado') ||
             body.includes('Trend') || body.includes('rend') ||
             (body.includes('rror') && !body.includes('Analizar con AI'))
    }, { timeout: 180000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/wf-30-ai-result.png', fullPage: true })

    const body = await page.textContent('body') || ''
    const hasError = body.includes('invalid_value') || body.includes('Too big')
    console.log('Has error:', hasError)
    console.log('Has save button:', body.includes('Guardar'))
    console.log('Has analysis:', body.includes('Trend') || body.includes('rend'))

    // Try to save AI strategy
    const saveBtn = page.getByRole('button', { name: /guardar/i })
    if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await saveBtn.click()
      await page.waitForTimeout(3000)
      await page.screenshot({ path: 'screenshots/wf-31-saved.png', fullPage: true })
      console.log('=== AI Strategy saved! ===')
    } else {
      console.log('No save button visible')
    }
  })

  test('Step 2: Scientific Backtest on latest strategy', async ({ page }) => {
    await login(page)
    await page.goto('/backtests/scientific')
    await page.waitForLoadState('networkidle')

    // Select latest strategy
    const strategySelect = page.locator('select').first()
    const options = await strategySelect.locator('option').allTextContents()
    console.log('Strategies:', options)
    if (options.length > 1) {
      await strategySelect.selectOption({ index: options.length - 1 })
    }

    // Select 1h
    await page.locator('button').filter({ hasText: /^1h$/ }).click()

    // Execute
    await page.getByRole('button', { name: /ejecutar/i }).click()

    await page.waitForFunction(() => {
      const body = document.body.innerText
      return (body.includes('Semaforo') || body.includes('In-Sample')) &&
             !body.includes('Ejecutando backtest cientifico')
    }, { timeout: 240000 })

    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/wf-32-scientific.png', fullPage: true })

    const body = await page.textContent('body') || ''
    if (body.includes('APROBADO')) console.log('=== APPROVED ===')
    else if (body.includes('PRECAUCION')) console.log('=== CAUTION ===')
    else if (body.includes('RECHAZADO')) console.log('=== REJECTED ===')
  })
})
