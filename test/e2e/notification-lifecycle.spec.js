const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

async function emitUpdate(page, type, data = {}) {
    await page.evaluate(
        ({ type, data }) => {
            window.__featureE2eEmit('updater:update-status', { status: 'success', data: { type, data } });
        },
        { type, data }
    );
}

test.describe('Notification lifecycle and layout', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        await page.addInitScript(() => {
            window.updaterApi = {
                getCurrentVersion: async () => '5.0.5-test',
                getUpdatePolicy: async () => ({ automaticUpdatesSupported: true })
            };
            window.commonApi.getUpdateSettings = async () => ({
                status: 'success',
                data: { autoCheckOnStartup: true, autoDownload: false }
            });
        });
        await page.goto('/#/tools/packet-parser');
        await expect(page.locator('.main-layout')).toBeVisible();
    });

    test.afterEach(async () => {
        await harness?.cleanup();
    });

    test('dismisses available and downloaded notifications after five seconds', async ({ page }) => {
        const notification = page.locator('.update-notification');
        const releaseNotes = page.getByRole('dialog', { name: '新版本更新内容', exact: true });
        const states = [
            ['update-available', { version: '5.0.7', releaseNotes: '新版修复说明。' }, '发现新版本 5.0.7'],
            ['update-downloaded', { version: '5.0.7' }, '更新已下载完成']
        ];

        for (const [type, data, text] of states) {
            await emitUpdate(page, type, data);
            await expect(notification).toContainText(text);
            await page.waitForTimeout(4000);
            await expect(notification).toBeVisible();
            await expect(notification).not.toBeVisible({ timeout: 2000 });
            if (type === 'update-available') {
                await releaseNotes.getByRole('button', { name: '知道了', exact: true }).click();
            }
        }
        await emitUpdate(page, 'update-error', { error: '再次检查失败' });
        await expect(notification).toBeVisible();
        await notification.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(notification).not.toBeVisible();
        await emitUpdate(page, 'download-progress', { percent: 90 });
        await expect(notification).not.toBeVisible();
    });

    test('keeps downloads visible beyond previous dismissal timers and respects manual closure', async ({ page }) => {
        const notification = page.locator('.update-notification');
        await emitUpdate(page, 'update-error', { error: '首次检查失败' });
        await expect(notification).toHaveClass(/is-error/);
        await page.waitForTimeout(3000);
        await emitUpdate(page, 'download-started');
        await expect(notification).toHaveClass(/is-loading/);
        await page.waitForTimeout(2500);
        await expect(notification).toBeVisible();
        await emitUpdate(page, 'update-error', { error: '重试检查失败' });
        await emitUpdate(page, 'checking-for-update');
        await emitUpdate(page, 'update-available', { version: '5.0.7' });
        await expect(notification).toContainText('发现新版本 5.0.7');
        await page
            .getByRole('dialog', { name: '新版本更新内容', exact: true })
            .getByRole('button', { name: '知道了', exact: true })
            .click();
        await page.waitForTimeout(2500);
        await expect(notification).toBeVisible();
        await emitUpdate(page, 'download-started');
        await expect(notification).toHaveClass(/is-loading/);
        for (const percent of [20, 40, 60]) {
            await page.waitForTimeout(2000);
            await emitUpdate(page, 'download-progress', { percent });
            await expect(notification).toContainText(`下载进度: ${percent}%`);
            await expect(notification).toBeVisible();
        }
        await notification.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(notification).not.toBeVisible();
        await emitUpdate(page, 'download-progress', { percent: 80 });
        await expect(notification).not.toBeVisible();

        await emitUpdate(page, 'update-downloaded', { version: '5.0.7' });
        await expect(notification).toHaveClass(/is-success/);
        await expect(notification.getByRole('button', { name: '安装', exact: true })).toBeVisible();
        await page.waitForTimeout(4000);
        await expect(notification).toBeVisible();
        await expect(notification).not.toBeVisible({ timeout: 2000 });
        await emitUpdate(page, 'update-not-available');
        await expect(notification).not.toBeVisible();
        await emitUpdate(page, 'download-progress', { percent: 100 });
        await expect(notification).not.toBeVisible();
    });

    test('restarts dismissal when another update failure arrives', async ({ page }) => {
        const notification = page.locator('.update-notification');
        await emitUpdate(page, 'update-error', { error: '首次下载失败' });
        await expect(notification).toBeVisible();
        await page.waitForTimeout(3000);
        await emitUpdate(page, 'update-error', { error: '再次下载失败' });
        await expect(notification).toContainText('再次下载失败');
        await page.waitForTimeout(2500);
        await expect(notification).toBeVisible();
        await expect(notification).not.toBeVisible({ timeout: 4000 });
    });

    test('bounds long toast content and stacked notifications without covering navigation', async ({
        page
    }, testInfo) => {
        await page.getByRole('button', { name: '更多选项' }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        const settingsDialog = page.getByRole('dialog', { name: '设置', exact: true });
        await settingsDialog.getByRole('tab', { name: '更新', exact: true }).click();
        await expect(settingsDialog.locator('.update-settings')).toBeVisible();

        const message = '更新服务器返回错误：连接超时，请检查网络后重试。'.repeat(80);
        await emitUpdate(page, 'update-error', { error: message });
        const toast = page.locator('.nn-toast').first();
        await expect(toast).toBeVisible();
        await toast.hover();
        const content = toast.locator('.nn-toast-content');
        await expect(content).toContainText(message);
        await expect(content).toHaveCSS('user-select', 'text');
        const contentSize = await content.evaluate(element => ({
            height: element.getBoundingClientRect().height,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight
        }));
        expect(contentSize.height).toBeLessThanOrEqual(84);
        expect(contentSize.scrollHeight).toBeGreaterThan(contentSize.clientHeight);
        await toast.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(toast).not.toBeVisible();

        for (let index = 0; index < 6; index += 1) {
            await emitUpdate(page, 'update-error', { error: `${index + 1}: ${message}` });
        }
        const host = page.locator('.nn-toast-host');
        const geometry = await host.evaluate(element => {
            const box = element.getBoundingClientRect();
            return {
                top: box.top,
                right: window.innerWidth - box.right,
                width: box.width,
                height: box.height,
                scrollHeight: element.scrollHeight,
                clientHeight: element.clientHeight
            };
        });
        expect(geometry.top).toBe(48);
        expect(geometry.right).toBe(16);
        expect(geometry.width).toBeLessThanOrEqual(360);
        expect(geometry.height).toBeLessThanOrEqual(320);
        expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
        const screenshot = testInfo.outputPath('notification-layout.png');
        await page.screenshot({ path: screenshot });
        await testInfo.attach('notification-layout', { path: screenshot, contentType: 'image/png' });

        await page.keyboard.press('Escape');
        await expect(settingsDialog).not.toBeVisible();
        const sidebarToggle = page.getByRole('button', { name: /^(展开|收起)侧边栏$/ });
        const originalLabel = await sidebarToggle.getAttribute('aria-label');
        await sidebarToggle.click();
        await expect(sidebarToggle).not.toHaveAttribute('aria-label', originalLabel);
    });
});
