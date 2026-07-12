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

    test('keeps disabled MIB context actions visible and the menu inside the viewport', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 520 });
        await page.goto('/#/snmp/snmp-mib');

        const treeNode = page.locator('.mib-tree-scroll .nn-tree-node').filter({ hasText: 'sysDescr' });
        await expect(treeNode).toBeVisible();
        await treeNode.evaluate(element => {
            element.dispatchEvent(
                new MouseEvent('contextmenu', {
                    clientX: 896,
                    clientY: 516,
                    button: 2,
                    buttons: 2,
                    bubbles: true,
                    cancelable: true
                })
            );
        });

        const contextMenu = page.locator('.mib-context-menu');
        await expect(contextMenu).toBeVisible();
        await expect(contextMenu.getByRole('menuitem')).toHaveCount(7);
        await expect(contextMenu.getByRole('menuitem')).toHaveText([
            '复制OID',
            '解析OID',
            'GET 查询',
            'GET-NEXT 查询',
            'WALK 查询',
            'SET 设置',
            'Trap变量'
        ]);

        const getItem = contextMenu.getByRole('menuitem', { name: 'GET 查询', exact: true });
        const setItem = contextMenu.getByRole('menuitem', { name: 'SET 设置', exact: true });
        const trapItem = contextMenu.getByRole('menuitem', { name: 'Trap变量', exact: true });
        await expect(getItem).not.toHaveAttribute('aria-disabled', 'true');
        await expect(setItem).toHaveAttribute('aria-disabled', 'true');
        await expect(trapItem).toHaveAttribute('aria-disabled', 'true');
        await expect(setItem).toHaveCSS('color', 'rgb(140, 140, 140)');

        await expect
            .poll(async () => {
                const box = await contextMenu.boundingBox();
                if (!box) {
                    return Number.POSITIVE_INFINITY;
                }
                return Math.max(8 - box.x, 8 - box.y, box.x + box.width - 892, box.y + box.height - 512);
            })
            .toBeLessThanOrEqual(1);
    });
});
