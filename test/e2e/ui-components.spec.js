const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

async function openSettingsDialog(page) {
    const moreOptions = page.getByRole('button', { name: '更多选项' });
    await moreOptions.click();

    const settingsMenuItem = page.getByRole('menuitem', { name: '设置', exact: true });
    await expect(settingsMenuItem).toBeVisible();
    await settingsMenuItem.click();

    const settingsDialog = page.getByRole('dialog', { name: '设置' });
    await expect(settingsDialog).toBeVisible();
    return settingsDialog;
}

async function dragFromCenter(page, locator, targetX, targetY) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 8 });
    await page.mouse.up();
}

test.describe('Custom UI component interactions', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('navigates with the main sidebar menu', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        await expect(page.getByText('报文解析器', { exact: true })).toBeVisible();

        const ntpMenuItem = page.locator('.main-menu').getByRole('menuitem', { name: 'NTP服务器' });
        await ntpMenuItem.click();

        await expect(page).toHaveURL(/#\/ntp\/ntp-config$/u);
        await expect(page.getByText('NTP服务器配置', { exact: true })).toBeVisible();
        await expect(ntpMenuItem).toHaveAttribute('aria-current', 'page');
    });

    test('opens settings from the dropdown and operates its menu, modal and select', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        const settingsDialog = await openSettingsDialog(page);

        const themeSelect = settingsDialog.getByRole('combobox').first();
        await themeSelect.click();
        await expect(themeSelect).toHaveAttribute('aria-expanded', 'true');
        await page.getByRole('option', { name: '蓝色', exact: true }).click();
        await expect(themeSelect).toContainText('蓝色');
        await expect(page.locator('html')).toHaveAttribute('data-theme-preset', 'blue');

        const toolsCategory = settingsDialog.getByRole('menuitem', { name: '工具集合', exact: true });
        await toolsCategory.click();
        await expect(toolsCategory).toHaveAttribute('aria-current', 'page');
        await expect(settingsDialog.getByText('Tools设置', { exact: true })).toBeVisible();

        await settingsDialog.getByRole('button', { name: '关闭' }).click();
        await expect(settingsDialog).toBeHidden();
    });

    test('drags the settings modal within viewport bounds and resets its position after reopening', async ({
        page
    }) => {
        await page.goto('/#/tools/packet-parser');

        const settingsDialog = await openSettingsDialog(page);
        const modalHeader = settingsDialog.locator('.nn-modal-header');
        const initialBox = await settingsDialog.boundingBox();
        const initialHeaderBox = await modalHeader.boundingBox();
        expect(initialBox).not.toBeNull();
        expect(initialHeaderBox).not.toBeNull();

        await dragFromCenter(
            page,
            modalHeader,
            initialHeaderBox.x + initialHeaderBox.width / 2 - 60,
            initialHeaderBox.y + initialHeaderBox.height / 2
        );

        await expect.poll(async () => (await settingsDialog.boundingBox())?.x).toBeLessThan(initialBox.x - 40);
        await expect(settingsDialog).toBeVisible();

        const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        let headerBox = await modalHeader.boundingBox();
        await dragFromCenter(page, modalHeader, 0, headerBox.y + headerBox.height / 2);

        let boundedBox = await settingsDialog.boundingBox();
        expect(boundedBox.x).toBeGreaterThanOrEqual(7);
        expect(boundedBox.x).toBeLessThanOrEqual(9);
        expect(boundedBox.y).toBeGreaterThanOrEqual(7);
        expect(boundedBox.y + boundedBox.height).toBeLessThanOrEqual(viewport.height - 7);

        headerBox = await modalHeader.boundingBox();
        await dragFromCenter(page, modalHeader, viewport.width - 1, headerBox.y + headerBox.height / 2);

        boundedBox = await settingsDialog.boundingBox();
        expect(boundedBox.x + boundedBox.width).toBeGreaterThanOrEqual(viewport.width - 9);
        expect(boundedBox.x + boundedBox.width).toBeLessThanOrEqual(viewport.width - 7);
        expect(boundedBox.y).toBeGreaterThanOrEqual(7);
        expect(boundedBox.y + boundedBox.height).toBeLessThanOrEqual(viewport.height - 7);

        await settingsDialog.getByRole('button', { name: '关闭' }).click();
        await expect(settingsDialog).toBeHidden();

        const reopenedDialog = await openSettingsDialog(page);
        const reopenedBox = await reopenedDialog.boundingBox();
        expect(Math.abs(reopenedBox.x - initialBox.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(reopenedBox.y - initialBox.y)).toBeLessThanOrEqual(1);
    });

    test('opens and closes an existing BGP route detail drawer', async ({ page }) => {
        await page.goto('/#/bgp/route-ipv6');
        await expect(page.getByText('IPv6-UNC路由配置', { exact: true })).toBeVisible();

        await page.getByRole('button', { name: '生成IPv6路由' }).click();

        const routeList = page.locator('.bgp-route-list-card');
        await expect(routeList.getByText('2001:db8::/64', { exact: true }).first()).toBeVisible();
        await routeList.getByRole('button', { name: '详情', exact: true }).first().click();

        const routeDrawer = page.getByRole('dialog', { name: 'BGP路由详情' });
        await expect(routeDrawer).toBeVisible();
        await expect(routeDrawer).toContainText('"ip": "2001:db8::"');

        await routeDrawer.getByRole('button', { name: '关闭' }).click();
        await expect(routeDrawer).toBeHidden();
    });
});
