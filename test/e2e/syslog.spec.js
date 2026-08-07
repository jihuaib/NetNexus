const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [{ route: '/#/syslog/syslog-config', title: 'Syslog服务器配置' }];

test.describe('Syslog pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders the Syslog configuration page', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });

    test('redirects the legacy message-log route to Syslog configuration', async ({ page }) => {
        await page.goto('/#/syslog/syslog-message-log');
        await expect.poll(() => new URL(page.url()).hash).toBe('#/syslog/syslog-config');
        await expect(page.getByText('Syslog服务器配置')).toBeVisible();
        await expect(page.getByRole('tab', { name: '消息日志' })).toHaveCount(0);
    });

    test('opens and renders the lightweight Syslog monitor window route', async ({ page }) => {
        await page.goto('/#/syslog/syslog-config');
        const openMonitorButton = page.getByTestId('open-syslog-monitor-window');
        await expect(openMonitorButton).toBeVisible();
        await expect(page.getByTestId('clear-syslog-message-history')).toHaveCount(0);
        await expect(page.getByRole('tab', { name: '消息日志' })).toHaveCount(0);
        await openMonitorButton.click();
        await expect.poll(() => page.evaluate(() => window.__featureMonitorRequests)).toEqual(['syslog-message-log']);

        await page.goto('/#/monitor/syslog-message-log');
        await expect(page.getByTestId('syslog-monitor-shell')).toBeVisible();
        await expect(page.locator('.monitor-window-header')).toHaveCount(0);
        await expect(page.getByText('独立监控窗口')).toHaveCount(0);
        await expect.poll(() => page.title()).toBe('Syslog 消息监控 - NetNexus');
        await expect(page.getByText('netnexus test syslog message')).toBeVisible();
        await expect(page.locator('.sider')).toHaveCount(0);
        await expect(page.getByRole('tab', { name: 'Syslog配置' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '清空历史' })).toBeVisible();
        await expect(page.getByTestId('open-syslog-monitor-window')).toHaveCount(0);
        await expect(page.getByRole('button', { name: '刷新' })).toBeVisible();
    });
});
