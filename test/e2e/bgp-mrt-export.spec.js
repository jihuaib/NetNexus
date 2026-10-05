const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

const bridge = `(() => {
    const patch = api => Object.assign(api || {}, {
        loadIpv4UNCRouteConfig: () => window.__featureE2eCall('bgp.loadIpv4UNCRouteConfig'),
        saveIpv4UNCRouteConfig: config => window.__featureE2eCall('bgp.saveIpv4UNCRouteConfig', config),
        getRouteGroupStates: () => window.__featureE2eCall('bgp.getRouteGroupStates'),
        getRoutes: (...args) => window.__featureE2eCall('bgp.getRoutes', ...args),
        exportMrt: config => window.__featureE2eCall('bgp.exportMrt', config)
    });
    let current = patch(window.bgpApi);
    Object.defineProperty(window, 'bgpApi', { configurable: true, get: () => current, set: api => { current = patch(api); } });
})();`;

async function openPage(page, key) {
    await page.goto(`/#/bgp/route-${key}`);
    await expect(page.getByTestId(`bgp-${key}-export-mrt-button`)).toBeEnabled();
}
async function activeGroupId(page, key) {
    return page.getByTestId(`bgp-${key}-route-workspace`).getAttribute('data-active-group-id');
}
async function groupMenu(page, key, groupId) {
    await page.getByTestId(`bgp-${key}-tree-group-${groupId}`).click({ button: 'right' });
    await expect(page.getByTestId(`bgp-${key}-group-context-menu`)).toBeVisible();
}
async function dismissToasts(page) {
    const buttons = page.locator('.nn-toast:not(.nn-toast-leaving) .nn-toast-close');
    while (await buttons.count()) await buttons.first().click();
    await expect(page.locator('.nn-toast')).toHaveCount(0);
}

test.describe('BGP MRT export', () => {
    let harness;
    let exports;
    let exportResponse;
    let generated;
    let statesAvailable;
    let routeTotal;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        exports = [];
        generated = new Map();
        statesAvailable = false;
        routeTotal = 60;
        exportResponse = () => ({
            status: 'success',
            data: { filePath: '/tmp/generated-routes.mrt', routeCount: 60 }
        });
        const controller = harness.controller;
        const originalCall = controller.call.bind(controller);
        controller.call = async (method, ...args) => {
            if (method === 'bgp.exportMrt') {
                exports.push(args[0]);
                return exportResponse();
            }
            if (method === 'bgp.getRouteGroupStates')
                return statesAvailable
                    ? { status: 'success', data: { groups: [...generated.values()] } }
                    : { status: 'error', msg: 'BGP 未启动' };
            if (method === 'bgp.getRoutes') {
                const family = Number(args[0]);
                return {
                    status: 'success',
                    data: {
                        list: Array.from({ length: Math.min(25, routeTotal) }, (_, index) => ({
                            addressFamily: family,
                            ip: family === 2 ? `2001:db8::${index + 1}` : `192.0.2.${index + 1}`,
                            mask: family === 2 ? 128 : 32,
                            pathId: 0
                        })),
                        total: routeTotal
                    }
                };
            }
            return originalCall(method, ...args);
        };
        await page.addInitScript({ content: bridge });
    });
    test.afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    for (const profile of [
        { key: 'ipv4', family: 1 },
        { key: 'ipv4-label', family: 12 },
        { key: 'ipv6', family: 2 }
    ]) {
        test(`${profile.key} exports the entire displayed family while stopped and handles pending, cancellation and errors`, async ({
            page
        }) => {
            await openPage(page, profile.key);
            await expect(page.getByTestId(`bgp-${profile.key}-route-table`)).toContainText('共 60 条');
            await expect(page.getByRole('button', { name: '详情', exact: true })).toHaveCount(25);
            const groupId = await activeGroupId(page, profile.key);
            await groupMenu(page, profile.key, groupId);
            await expect(page.getByTestId(`bgp-${profile.key}-export-group-button`)).toHaveAttribute(
                'aria-disabled',
                'true'
            );
            await page.keyboard.press('Escape');

            let finishExport;
            exportResponse = () => new Promise(resolve => (finishExport = resolve));
            const button = page.getByTestId(`bgp-${profile.key}-export-mrt-button`);
            await button.click();
            await expect.poll(() => exports.length).toBe(1);
            await expect(button).toBeDisabled();
            expect(exports[0]).toEqual({ addressFamily: profile.family });
            await button.evaluate(element => element.click());
            expect(exports).toHaveLength(1);
            finishExport({ status: 'success', data: { filePath: '/tmp/all-60-routes.mrt', routeCount: 60 } });
            await expect(page.locator('.nn-toast-success')).toContainText('已导出 60 条路由到 /tmp/all-60-routes.mrt');
            await expect(button).toBeEnabled();
            await dismissToasts(page);

            exportResponse = () => ({ status: 'success', data: { canceled: true } });
            await button.click();
            await expect.poll(() => exports.length).toBe(2);
            await expect(button).toBeEnabled();
            await expect(page.locator('.nn-toast')).toHaveCount(0);

            routeTotal = 0;
            await page.reload();
            await expect(button).toBeEnabled();
            await expect(page.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
            exportResponse = () => ({ status: 'error', msg: '当前地址族没有可导出的路由' });
            await button.click();
            await expect(page.locator('.nn-toast-error')).toContainText('当前地址族没有可导出的路由');
            await expect(button).toBeEnabled();
            await dismissToasts(page);

            await page.evaluate(() => delete window.bgpApi.exportMrt);
            await button.click();
            await expect(page.locator('.nn-toast-error')).toContainText('请重启应用后使用 MRT 导出');
            expect(exports).toHaveLength(3);
        });
    }

    test('exports the right-clicked group snapshot family and keeps MRT actions away from leaves and unsupported families', async ({
        page
    }) => {
        statesAvailable = true;
        await openPage(page, 'ipv4-label');
        const firstId = await activeGroupId(page, 'ipv4-label');
        generated.set(firstId, {
            groupId: firstId,
            groupName: '已生成标签组',
            addressFamily: 12,
            routeCount: 7,
            generatedAt: Date.now()
        });
        await groupMenu(page, 'ipv4-label', firstId);
        await page.getByTestId('bgp-ipv4-label-refresh-group-state-button').click();
        await groupMenu(page, 'ipv4-label', firstId);
        await expect(page.getByTestId('bgp-ipv4-label-group-context-menu').locator('.nn-context-menu-meta')).toHaveText(
            '已生成 7 条'
        );
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('route-field-addressFamily')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-label-route-prefix-input').fill('draft is not regenerated');
        await page.getByTestId('bgp-ipv4-label-add-group-button').click();
        const secondId = await activeGroupId(page, 'ipv4-label');
        await groupMenu(page, 'ipv4-label', secondId);
        await expect(page.getByTestId('bgp-ipv4-label-export-group-button')).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        expect(secondId).not.toBe(firstId);

        exportResponse = () => ({ status: 'success', data: { filePath: '/tmp/label-group.mrt', routeCount: 7 } });
        await groupMenu(page, 'ipv4-label', firstId);
        await page.getByTestId('bgp-ipv4-label-export-group-button').click();
        await expect.poll(() => exports.length).toBe(1);
        expect(exports[0]).toEqual({ addressFamily: 12, groupId: firstId });
        await expect(page.locator('.nn-toast-success')).toContainText('已导出 7 条路由');
        await dismissToasts(page);

        await page.getByTestId('bgp-ipv4-label-tree-attribute-med').first().click({ button: 'right' });
        await expect(page.getByTestId('bgp-ipv4-label-attribute-context-menu')).toBeVisible();
        await expect(page.getByTestId('bgp-ipv4-label-export-group-button')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await page.getByTestId('bgp-ipv4-label-export-mrt-button').click();
        await expect.poll(() => exports.length).toBe(2);
        expect(exports[1]).toEqual({ addressFamily: 12 });
        await dismissToasts(page);

        for (const key of ['ipv4-qp', 'ipv6-qp', 'mvpn']) {
            await page.goto(`/#/bgp/route-${key}`);
            await expect(page.getByTestId(`bgp-${key}-generate-routes-button`)).toBeEnabled();
            await expect(page.getByTestId(`bgp-${key}-export-mrt-button`)).toHaveCount(0);
            await groupMenu(page, key, await activeGroupId(page, key));
            await expect(page.getByTestId(`bgp-${key}-export-group-button`)).toHaveCount(0);
            await page.keyboard.press('Escape');
        }
    });
});
