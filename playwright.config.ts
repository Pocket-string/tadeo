import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'auth-pages',
      testMatch: /auth\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'authenticated',
      testMatch: /authenticated\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'full-flow',
      testMatch: /full-flow\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'workflow',
      testMatch: /workflow\.spec\.ts|eth-.*\.spec\.ts|sol-.*\.spec\.ts|final-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'scanner',
      testMatch: /scanner-flow\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      timeout: 180000,
    },
    {
      name: 'paper-trading',
      testMatch: /paper-trading\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      timeout: 300000,
    },
    {
      name: 'turbo',
      testMatch: /turbo-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      timeout: 300000,
    },
  ],
})
