const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { formatEvents, recordStep, setupFeaturePagesE2e } = require('../../scripts/e2e-support');

test.describe('FTP page', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('runs the FTP client script and renders session data', async ({ page }) => {
        await test.step('Start FTP server and run scripts/mockFtpClient.js', async () => {
            await recordStep(
                test,
                `Input: route=/#/ftp/ftp-config, script=scripts/mockFtpClient.js, host=127.0.0.1, port=${harness.controller.ftpPort}, username=e2e-user`
            );

            await page.goto('/#/ftp/ftp-config');
            await expect(page.getByText('FTP服务器配置').first()).toBeVisible();
            await page.getByRole('button', { name: '启动服务器' }).click();

            const events = await harness.controller.runFtpClient();
            await expect(page.getByText('e2e-user').first()).toBeVisible({ timeout: 10000 });
            await expect(page.getByText('已登录').first()).toBeVisible({ timeout: 10000 });

            await recordStep(test, `Output: ftpClientEvents=${formatEvents(events)}, clientStatus=已登录`);
        });
    });
});
