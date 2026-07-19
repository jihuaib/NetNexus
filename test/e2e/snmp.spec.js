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

    test('shows live MIB file progress in the MIB page without a global notification', async ({ page }) => {
        await page.goto('/#/snmp/snmp-mib');

        const recompileButton = page.getByRole('button', { name: '重新编译' });
        await expect(recompileButton).toBeEnabled();
        await recompileButton.click();

        const inlineProgress = page.locator('.mib-compile-progress');
        await expect(inlineProgress).toBeVisible();
        await expect(inlineProgress).toContainText(/(准备编译|编译 \d+\/3)/u);
        await expect(inlineProgress.getByRole('progressbar', { name: 'MIB编译进度' })).toBeVisible();
        await expect(page.locator('.mib-compile-notification')).toHaveCount(0);

        await expect(recompileButton).toBeEnabled();
        await expect(inlineProgress).toHaveCount(0);
    });

    test('keeps a long OID inside the translation result dialog', async ({ page }) => {
        const longOid = ['1', '3', '6', '1', ...Array.from({ length: 90 }, (_, index) => String(100000 + index))].join(
            '.'
        );
        await page.setViewportSize({ width: 520, height: 720 });
        await page.goto('/#/snmp/snmp-mib');

        await page.getByPlaceholder('输入OID，例如 1.3.6.1.2.1.1.3.0').fill(longOid);
        await page.getByRole('button', { name: '解析OID', exact: true }).click();

        const dialog = page.getByRole('dialog', { name: 'OID解析结果' });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.nn-alert-description')).toHaveText(longOid);

        const layout = await dialog.evaluate(element => {
            const overflow = selector => {
                const target = element.querySelector(selector);
                return target ? Math.ceil(target.scrollWidth - target.clientWidth) : Number.POSITIVE_INFINITY;
            };
            const bounds = element.getBoundingClientRect();
            return {
                alertOverflow: overflow('.nn-alert-description'),
                bodyOverflow: overflow('.nn-modal-body'),
                queryOidOverflow: overflow('.oid-result-detail .nn-descriptions-item-content'),
                left: bounds.left,
                right: bounds.right,
                viewportWidth: window.innerWidth
            };
        });

        expect(layout.alertOverflow).toBeLessThanOrEqual(1);
        expect(layout.bodyOverflow).toBeLessThanOrEqual(1);
        expect(layout.queryOidOverflow).toBeLessThanOrEqual(1);
        expect(layout.left).toBeGreaterThanOrEqual(8);
        expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth - 8);
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
