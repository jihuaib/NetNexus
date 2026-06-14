const { test, expect } = require('@playwright/test');
const { formatEvents, recordStep, setupFeaturePagesE2e } = require('../../scripts/e2e-support');

test.describe('TFTP page', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('runs the TFTP client script and renders transfer data', async ({ page }) => {
        await test.step('Start TFTP server and run scripts/mockTftpClient.js', async () => {
            await recordStep(
                test,
                `Input: route=/#/tftp/tftp-config, script=scripts/mockTftpClient.js, host=127.0.0.1, port=${harness.controller.tftpPort}, mode=write, filename=netnexus-e2e.txt`
            );

            await page.goto('/#/tftp/tftp-config');
            await expect(page.getByText('TFTP服务器配置').first()).toBeVisible();
            await page.getByRole('button', { name: '启动服务器' }).click();

            const events = await harness.controller.runTftpClient();
            await expect(page.getByText('运行中').first()).toBeVisible({ timeout: 10000 });
            await expect(page.getByText(/127\.0\.0\.1:/u).first()).toBeVisible({ timeout: 10000 });

            await page.goto('/#/tftp/tftp-transfer-log');
            await expect(page.getByText('TFTP传输日志').first()).toBeVisible();
            await expect(page.getByText('netnexus-e2e.txt').first()).toBeVisible({ timeout: 10000 });
            await expect(page.getByText('已完成').first()).toBeVisible({ timeout: 10000 });

            await recordStep(
                test,
                `Output: tftpClientEvents=${formatEvents(events)}, transfer=netnexus-e2e.txt completed`
            );
        });
    });
});
