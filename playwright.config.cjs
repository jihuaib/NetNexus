const { defineConfig, devices } = require('@playwright/test');

const isCI = !!process.env.CI;
const usePackagedElectron = process.env.E2E_TARGET !== 'browser';
const port = Number(process.env.E2E_PORT || 3000);
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`;

module.exports = defineConfig({
    testDir: './test/e2e',
    timeout: usePackagedElectron ? 60000 : 30000,
    expect: {
        timeout: 5000
    },
    fullyParallel: false,
    forbidOnly: isCI,
    retries: isCI ? 2 : 0,
    reporter: isCI
        ? [['github'], ['list', { printSteps: true }], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
        : [
              ['list', { printSteps: true }],
              ['html', { open: 'never', outputFolder: 'playwright-report' }]
          ],
    use: {
        baseURL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: isCI ? 'retain-on-failure' : 'off'
    },
    webServer: usePackagedElectron
        ? undefined
        : {
              command: `npm start -- --host 127.0.0.1 --port ${port}`,
              url: baseURL,
              reuseExistingServer: !isCI,
              timeout: 120000,
              env: {
                  BROWSER: 'none'
              }
          },
    projects: usePackagedElectron
        ? [
              {
                  name: 'packaged-electron'
              }
          ]
        : [
              {
                  name: 'chromium',
                  use: { ...devices['Desktop Chrome'] }
              }
          ]
});
