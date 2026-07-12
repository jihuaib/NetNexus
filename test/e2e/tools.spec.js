const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { expectAnyTextVisible, setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/tools/packet-parser', title: '报文解析器' },
    { route: '/#/tools/port-monitor', title: '端口连接列表', expectText: '3000' },
    { route: '/#/tools/network-info', title: '网络信息', expectText: 'NetNexus E2E Interface' },
    { route: '/#/tools/tcp-ao-mac', title: 'TCP-AO MAC 计算器' },
    { route: '/#/tools/http-api-tester', title: 'HTTP API测试', expectText: 'Mock Status' }
];

test.describe('Tools pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders tool pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });

    test('renders network route info with mock routes', async ({ page }) => {
        await page.goto('/#/tools/network-info');
        await expectAnyTextVisible(page, '网络信息', { timeout: 10000 });

        await page.getByText('路由信息').click();

        await expectAnyTextVisible(page, '0.0.0.0/0', { timeout: 10000 });
        await expectAnyTextVisible(page, '10.0.0.1', { timeout: 10000 });
        await expectAnyTextVisible(page, '2001:db8::/64', { timeout: 10000 });
        await expectAnyTextVisible(page, 'fe80::1', { timeout: 10000 });
    });

    test('keeps the network interface toolbar on one row and renders an empty MAC as text', async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 800 });
        await page.goto('/#/tools/network-info');
        await expectAnyTextVisible(page, 'NetNexus E2E Interface', { timeout: 10000 });

        const toolbar = page.locator('.network-interface-toolbar');
        const interfaceSelect = toolbar.locator('.network-interface-select');
        const refreshButton = toolbar.getByRole('button', { name: '刷新', exact: true });
        await expect(toolbar).toHaveCSS('flex-wrap', 'nowrap');

        const toolbarBox = await toolbar.boundingBox();
        const selectBox = await interfaceSelect.boundingBox();
        const refreshBox = await refreshButton.boundingBox();
        expect(
            Math.abs(selectBox.y + selectBox.height / 2 - (refreshBox.y + refreshBox.height / 2))
        ).toBeLessThanOrEqual(1);
        expect(selectBox.x).toBeGreaterThanOrEqual(toolbarBox.x - 1);
        expect(refreshBox.x + refreshBox.width).toBeLessThanOrEqual(toolbarBox.x + toolbarBox.width + 1);

        await interfaceSelect.click();
        await page.getByRole('option', { name: 'No MAC Interface (e2e1)', exact: true }).click();

        const emptyMacRow = page.locator('.network-info-table .nn-table-row').filter({ hasText: 'No MAC Interface' });
        const emptyMacCell = emptyMacRow.locator('.nn-table-cell').nth(2);
        await expect(emptyMacCell).toHaveText('-');
        await expect(emptyMacCell.locator('.nn-tag')).toHaveCount(0);
    });

    test('scrolls the port connection table horizontally in a narrow window', async ({ page }) => {
        await page.setViewportSize({ width: 1000, height: 800 });
        await page.goto('/#/tools/port-monitor');
        await expectAnyTextVisible(page, '3000', { timeout: 10000 });

        const tableContent = page.locator('.port-table .nn-table-content');
        const tableHeaders = page.locator('.port-table .nn-table-thead .nn-table-cell');
        const processHeader = tableHeaders.filter({ hasText: '进程名' });
        const actionHeader = tableHeaders.filter({ hasText: '操作' });
        await expect(tableContent).toBeVisible();

        const initialGeometry = await tableContent.evaluate(element => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            scrollLeft: element.scrollLeft
        }));
        expect(initialGeometry.scrollWidth).toBeGreaterThanOrEqual(1058);
        expect(initialGeometry.scrollWidth - initialGeometry.clientWidth).toBeGreaterThan(100);
        expect(initialGeometry.scrollLeft).toBe(0);
        expect((await processHeader.boundingBox()).width).toBeGreaterThanOrEqual(178);

        await tableContent.hover();
        await expect(tableContent).toHaveClass(/nn-scrollbar-active/u);
        await page.mouse.wheel(500, 0);
        await expect
            .poll(() =>
                tableContent.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)
            )
            .toBeLessThanOrEqual(1);

        const contentBox = await tableContent.boundingBox();
        const processBox = await processHeader.boundingBox();
        const actionBox = await actionHeader.boundingBox();
        expect(processBox.x).toBeGreaterThanOrEqual(contentBox.x - 1);
        expect(processBox.x + processBox.width).toBeLessThanOrEqual(actionBox.x + 1);
        expect(actionBox.x).toBeGreaterThanOrEqual(contentBox.x - 1);
        expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(contentBox.x + contentBox.width + 1);
    });
});
