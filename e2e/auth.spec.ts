import { test, expect } from '@playwright/test'

test.describe('Auth Pages - Sin autenticacion', () => {
  test.setTimeout(90000)

  test('login page carga correctamente', async ({ page }) => {
    await page.goto('/login', { timeout: 60000 })

    await expect(page.getByText('Bienvenido de vuelta')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Inicia sesión en tu cuenta para continuar')).toBeVisible()

    await expect(page.locator('#email')).toBeVisible()
    await expect(page.locator('#password')).toBeVisible()

    await expect(page.getByRole('button', { name: 'Iniciar Sesión' })).toBeVisible()

    await expect(page.getByText('Regístrate')).toBeVisible()
    await expect(page.getByText('¿Olvidaste tu contraseña?')).toBeVisible()
  })

  test('signup page carga correctamente', async ({ page }) => {
    await page.goto('/signup')

    await expect(page.getByText('Crea tu cuenta')).toBeVisible()
    await expect(page.getByText('Comienza gratis y gestiona tus citas como profesional')).toBeVisible()

    await expect(page.locator('#email')).toBeVisible()
    await expect(page.locator('#password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Crear Cuenta' })).toBeVisible()
    await expect(page.getByText('Inicia sesión')).toBeVisible()
  })

  test('forgot-password page carga correctamente', async ({ page }) => {
    await page.goto('/forgot-password')
    await expect(page.getByText('Recupera tu contraseña')).toBeVisible()
    await expect(page.locator('#email')).toBeVisible()
  })

  test('navegacion login -> signup funciona', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: 'Regístrate' }).click()
    await page.waitForURL('**/signup', { timeout: 15000 })
    await expect(page).toHaveURL(/signup/)
  })

  test('navegacion signup -> login funciona', async ({ page }) => {
    await page.goto('/signup')
    await page.getByRole('link', { name: 'Inicia sesión' }).click()
    await page.waitForURL('**/login', { timeout: 15000 })
    await expect(page).toHaveURL(/login/)
  })

  test('login con credenciales invalidas muestra error', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    await page.locator('#email').fill('invalid@test.com')
    await page.locator('#password').fill('wrongpassword')
    await page.getByRole('button', { name: 'Iniciar Sesión' }).click()

    // Error could be in English or Spanish depending on Supabase config
    await expect(page.locator('[class*="error"]').first()).toBeVisible({ timeout: 20000 })
  })

  test('login con credenciales validas redirige a dashboard', async ({ page }) => {
    const email = process.env.TEST_EMAIL || 'test@trader.com'
    const password = process.env.TEST_PASSWORD || 'testpassword123'

    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    await page.locator('#email').fill(email)
    await page.locator('#password').fill(password)
    await page.getByRole('button', { name: 'Iniciar Sesión' }).click()

    await page.waitForURL('**/dashboard', { timeout: 45000 })
    await expect(page).toHaveURL(/dashboard/)
  })

  test('root path muestra homepage publica', async ({ page }) => {
    await page.goto('/', { timeout: 30000 })
    await expect(page.getByRole('heading', { name: 'Trader' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Sistema agentico de trading algoritmico')).toBeVisible()
  })

  test('branding Trader visible en auth layout', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByText('Trading algoritmico sin emociones')).toBeVisible()
  })

  test('toggle password visibility funciona', async ({ page }) => {
    await page.goto('/login')

    const passwordInput = page.locator('#password')
    await expect(passwordInput).toHaveAttribute('type', 'password')

    await page.getByRole('button', { name: 'Mostrar contraseña' }).click()
    await expect(passwordInput).toHaveAttribute('type', 'text')

    await page.getByRole('button', { name: 'Ocultar contraseña' }).click()
    await expect(passwordInput).toHaveAttribute('type', 'password')
  })

  test('rutas protegidas redirigen a login', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForURL('**/login', { timeout: 15000 })
    await expect(page).toHaveURL(/login/)
  })
})
