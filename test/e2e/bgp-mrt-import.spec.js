const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

const filePath = '/tmp/exported-add-path.mrt';
const bridge = `(() => {
    const patch = api => Object.assign(api || {}, {
        loadIpv4UNCRouteConfig: () => window.__featureE2eCall('bgp.loadIpv4UNCRouteConfig'),
        getRouteGroupStates: () => window.__featureE2eCall('bgp.getRouteGroupStates')
    });
    let current = patch(window.bgpApi);
    Object.defineProperty(window, 'bgpApi', { configurable: true, get: () => current, set: api => { current = patch(api); } });
})();`;

async function openImport(page) {
    await page.goto('/#/bgp/route-ipv4');
    await expect(page.getByTestId('bgp-generate-ipv4-routes-button')).toBeEnabled();
    await page.getByRole('button', { name: '从 RouteViews 导入', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入 BGP MRT 路由文件' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '开始导入', exact: true })).toBeEnabled();
    return dialog;
}
async function dismissToasts(page) {
    const buttons = page.locator('.nn-toast:not(.nn-toast-leaving) .nn-toast-close');
    while (await buttons.count()) await buttons.first().click();
    await expect(page.locator('.nn-toast')).toHaveCount(0);
}

test.describe('BGP MRT import feedback', () => {
    let harness;
    let imports;
    let routeReads;
    let importResponse;
    let importedRows;
    let detailRequests;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        imports = [];
        routeReads = 0;
        importedRows = [];
        detailRequests = [];
        importResponse = {
            status: 'success',
            data: { imported: 2, added: 1, updated: 1, unchanged: 0, total: 2 },
            msg: '路由导入成功'
        };
        const controller = harness.controller;
        const originalCall = controller.call.bind(controller);
        controller.call = async (method, ...args) => {
            if (method === 'bgp.getDefaultMrtFiles')
                return { status: 'success', data: [{ path: filePath, name: 'exported-add-path.mrt', size: 256 }] };
            if (method === 'bgp.getRouteGroupStates') return { status: 'success', data: { groups: [] } };
            if (method === 'bgp.getRoutes') {
                routeReads += 1;
                return { status: 'success', data: { list: importedRows, total: importedRows.length } };
            }
            if (method === 'bgp.importRouteViewsData') {
                imports.push(args);
                if (importResponse.status === 'success' && importResponse.data?.imported > 0)
                    importedRows = [0, 7].map(pathId => ({ addressFamily: 1, ip: '192.0.2.0', mask: 24, pathId }));
                return importResponse;
            }
            if (method === 'bgp.getRouteDetail') {
                detailRequests.push(args);
                return { status: 'success', data: { ...args[1], addressFamily: args[0] } };
            }
            return originalCall(method, ...args);
        };
        await page.addInitScript({ content: bridge });
    });
    test.afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('closes and refreshes two imported ADD-PATH routes while preserving added and updated counts', async ({
        page
    }) => {
        const dialog = await openImport(page);
        const initialReads = routeReads;
        await dialog.getByRole('button', { name: '开始导入', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.locator('.nn-toast-success')).toContainText('路由导入成功');
        await expect(page.getByTestId('bgp-ipv4-route-table')).toContainText('共 2 条');
        await expect(page.getByRole('button', { name: '详情', exact: true })).toHaveCount(2);
        expect(imports).toEqual([[filePath, 10000, 1]]);
        expect(routeReads).toBeGreaterThan(initialReads);
        await dismissToasts(page);
        for (const [index, pathId] of [0, 7].entries()) {
            await page.getByRole('button', { name: '详情', exact: true }).nth(index).click();
            await expect.poll(() => detailRequests.at(-1)?.[1]?.pathId).toBe(pathId);
            const drawer = page.getByRole('dialog', { name: 'BGP路由详情' });
            await expect(drawer).toBeVisible();
            await drawer.getByRole('button', { name: '关闭', exact: true }).click();
            await expect(drawer).toBeHidden();
        }
    });

    test('keeps the file and dialog open for backend errors and legacy success with zero imported routes', async ({
        page
    }) => {
        const dialog = await openImport(page);
        const button = dialog.getByRole('button', { name: '开始导入', exact: true });
        const initialReads = routeReads;
        importResponse = { status: 'error', msg: 'MRT 文件中没有可导入 IPv4 的路由，请检查地址族和文件格式' };
        await button.click();
        await expect(page.locator('.nn-toast-error')).toContainText(importResponse.msg);
        await expect(page.locator('.nn-toast-success')).toHaveCount(0);
        await expect(dialog).toBeVisible();
        await expect(button).toBeEnabled();
        await expect(dialog).toContainText('exported-add-path.mrt');
        expect(routeReads).toBe(initialReads);
        await dismissToasts(page);

        importResponse = { status: 'success', data: { imported: 0, added: 0, updated: 0 }, msg: '路由导入成功' };
        await button.click();
        await expect(page.locator('.nn-toast-error')).toContainText(
            'MRT 文件中没有可导入当前地址族的路由，请检查地址族和文件格式'
        );
        await expect(page.locator('.nn-toast-success')).toHaveCount(0);
        await expect(dialog).toBeVisible();
        await expect(button).toBeEnabled();
        await expect(dialog).toContainText('exported-add-path.mrt');
        expect(imports).toEqual([
            [filePath, 10000, 1],
            [filePath, 10000, 1]
        ]);
        expect(routeReads).toBe(initialReads);
    });
});
