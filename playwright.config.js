const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './generated-specs',
  timeout: Number(process.env.PLAYWRIGHT_TEST_TIMEOUT_MS || 120000),
  fullyParallel: false,
  workers: Number(process.env.PLAYWRIGHT_WORKERS || 1),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    actionTimeout: Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 20000),
    navigationTimeout: Number(process.env.PLAYWRIGHT_NAV_TIMEOUT_MS || 60000),
    headless: process.env.HEADLESS !== 'false',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    use: {
    video: process.env.PLAYWRIGHT_VIDEO || 'on',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
}
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
