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

    test('automatically dismisses update failures and supports manual dismissal', async ({ page }) => {
        const notification = page.locator('.update-notification');
        await emitUpdate(page, 'checking-for-update');
        await emitUpdate(page, 'update-error', { error: '更新服务器暂时不可用' });
        await expect(notification).toHaveClass(/is-error/);
        await expect(notification).toContainText('更新服务器暂时不可用');
        await expect(notification).not.toBeVisible({ timeout: 7000 });

        await emitUpdate(page, 'update-error', { error: '再次检查失败' });
        await expect(notification).toBeVisible();
        await notification.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(notification).not.toBeVisible();
    });

    test('keeps a retried download visible after the previous failure timeout', async ({ page }) => {
        const notification = page.locator('.update-notification');
        await emitUpdate(page, 'update-error', { error: '首次检查失败' });
        await expect(notification).toHaveClass(/is-error/);
        await emitUpdate(page, 'checking-for-update');
        await emitUpdate(page, 'update-available', { version: '5.0.6' });
        await expect(notification).toContainText('发现新版本 5.0.6');
        await emitUpdate(page, 'download-started');
        await emitUpdate(page, 'download-progress', { percent: 42 });
        await expect(notification).toHaveClass(/is-loading/);
        await expect(notification).toContainText('下载进度: 42%');

        await page.waitForTimeout(5500);
        await expect(notification).toBeVisible();
        await emitUpdate(page, 'update-downloaded', { version: '5.0.6' });
        await expect(notification).toHaveClass(/is-success/);
        await expect(notification.getByRole('button', { name: '安装', exact: true })).toBeVisible();

        await emitUpdate(page, 'update-error', { error: '新版本检查失败' });
        await emitUpdate(page, 'update-available', { version: '5.0.7' });
        await expect(notification).toContainText('发现新版本 5.0.7');
        await expect(notification.getByRole('button', { name: '下载', exact: true })).toBeVisible();
        await expect(notification.getByRole('button', { name: '安装', exact: true })).toHaveCount(0);
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
