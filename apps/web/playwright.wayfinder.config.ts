import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-wayfinder',
  testMatch: '**/*.pw.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4177',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 4177',
    url: 'http://127.0.0.1:4177/__ui',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
