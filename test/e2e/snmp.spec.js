const { expect, test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/snmp/snmp-config', title: 'SNMP 配置' },
    { route: '/#/snmp/snmp-mib', title: 'MIB 管理', expectText: 'sysDescr' },
    { route: '/#/snmp/snmp-trap', title: 'SNMP Trap 监控', expectText: '192.0.2.80' }
];

test.describe('SNMP pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders SNMP pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });

    test('recompiles stored MIB files with an IPC-cloneable payload', async ({ page }) => {
        await page.goto('/#/snmp/snmp-mib');

        const recompileButton = page.getByRole('button', { name: '重新编译' });
        await expect(recompileButton).toBeEnabled();
        await recompileButton.click();

        const toast = page.locator('.nn-toast').filter({ hasText: 'MIB编译完成' });
        const fixedTabs = page.locator('.nn-main-container > .fixed-tabs');
        await expect(toast).toBeVisible();
        await expect(toast).toHaveCSS('pointer-events', 'none');
        await expect(toast.getByRole('button', { name: '关闭' })).toHaveCSS('pointer-events', 'auto');

        const [toastBox, tabsBox] = await Promise.all([toast.boundingBox(), fixedTabs.boundingBox()]);
        expect(toastBox).not.toBeNull();
        expect(tabsBox).not.toBeNull();
        expect(toastBox.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height + 7);

        await page.getByRole('tab', { name: 'Trap监控', exact: true }).click();
        await expect(page).toHaveURL(/#\/snmp\/snmp-trap$/u);
    });
});
