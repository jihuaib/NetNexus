const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

const CLIENT = {
    persistentSourceId: 'tooltip-source',
    persistentConnectionId: 'tooltip-connection',
    connectionState: 'closed',
    isOnline: false,
    remoteIp: '192.0.2.10',
    remotePort: 49152,
    sysName: 'tooltip-router'
};
const CLIENT_KEY = encodeURIComponent(`source:${CLIENT.persistentSourceId}`);
const SESSION_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${CLIENT_KEY}&view=session`;
const LOC_RIB_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${CLIENT_KEY}&view=loc-rib`;

const SESSION_SCOPE = {
    persistentScopeId: 'tooltip-peer-scope',
    afi: 1,
    safi: 1,
    addrFamilyType: 1,
    ribType: 2,
    scopeState: 'down',
    routeSummary: { active: 1, stale: 0, total: 1 }
};

const SESSION = {
    persistentOwnerKey: 'tooltip-peer-owner',
    connectionState: 'closed',
    isOnline: false,
    sessionType: 0,
    sessionRd: '0:0',
    sessionIp: '192.0.2.2',
    sessionAs: 65000,
    sessionRouterId: '192.0.2.1',
    sessionState: 1,
    enabledAddrFamilyTypes: [],
    ribTypes: [],
    routeScopes: [SESSION_SCOPE]
};

const INSTANCE = {
    persistentOwnerKey: 'tooltip-loc-rib-owner',
    persistentScopeId: 'tooltip-loc-rib-scope',
    connectionState: 'closed',
    isOnline: false,
    instanceType: 3,
    instanceRd: '0:0',
    instanceIp: '0.0.0.0',
    instanceAs: 0,
    instanceRouterId: '192.0.2.1',
    instanceState: 1,
    addrFamilyType: 1,
    vrfTableNames: ['global'],
    routeSummary: { active: 1, stale: 0, total: 1 }
};

function route(ip, scopeId, routeId) {
    return {
        persistentScopeId: scopeId,
        persistentRouteId: routeId,
        routeKey: `0|0:0|${ip}|24`,
        addrFamilyType: 1,
        ip,
        mask: 24,
        rd: '0:0',
        pathId: 0,
        nextHop: '192.0.2.254',
        asPath: '65000 65100',
        parseStatus: 0,
        routeState: 'active'
    };
}

const SESSION_ROUTE = route('203.0.113.0', SESSION_SCOPE.persistentScopeId, 'tooltip-peer-route');
const INSTANCE_ROUTE = route('198.51.100.0', INSTANCE.persistentScopeId, 'tooltip-loc-rib-route');

function success(data) {
    return { status: 'success', data };
}

async function installBmpMock(page) {
    await page.exposeFunction('__bmpE2eCall', async method => {
        switch (method) {
            case 'getClientList':
                return success([CLIENT]);
            case 'getBgpSessions':
                return success([SESSION]);
            case 'getBgpRoutes':
                return success({
                    list: [SESSION_ROUTE],
                    total: 1,
                    summary: { active: 1, stale: 0, total: 1 }
                });
            case 'getBgpRouteDetail':
                return success(SESSION_ROUTE);
            case 'getBgpInstances':
                return success([INSTANCE]);
            case 'getBgpInstanceRoutes':
                return success({
                    list: [INSTANCE_ROUTE],
                    total: 1,
                    summary: { active: 1, stale: 0, total: 1 }
                });
            case 'getBgpInstanceRouteDetail':
                return success(INSTANCE_ROUTE);
            default:
                return success(null);
        }
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });
}

test.describe('BMP route detail tooltip dismissal', () => {
    test.beforeEach(async ({ page }) => {
        await installBmpMock(page);
    });

    test('keeps the Session route tooltip dismissed after the drawer restores focus', async ({ page }) => {
        await page.goto(SESSION_MONITOR_ROUTE);

        const detailButton = page.getByTestId('bmp-session-route-detail');
        await expect(detailButton).toBeVisible();
        await detailButton.hover();
        await expect(page.getByRole('tooltip')).toHaveText('查询路由detail');

        await detailButton.click();

        const drawer = page.getByRole('dialog', { name: '路由detail: 203.0.113.0' });
        await expect(drawer).toBeVisible();
        await expect(page.getByRole('tooltip')).toHaveCount(0);

        await drawer.getByRole('button', { name: '关闭' }).click();

        await expect(drawer).toBeHidden();
        await expect(detailButton).toBeFocused();
        await expect(page.getByRole('tooltip')).toHaveCount(0);

        await page.mouse.move(0, 0);
        await detailButton.hover();
        await expect(page.getByRole('tooltip')).toHaveText('查询路由detail');
    });

    test('keeps the Loc-RIB route tooltip dismissed after keyboard drawer close', async ({ page }) => {
        await page.goto(LOC_RIB_MONITOR_ROUTE);

        const detailButton = page.getByTestId('bmp-loc-rib-route-detail');
        await expect(detailButton).toBeVisible();
        await detailButton.focus();
        await expect(page.getByRole('tooltip')).toHaveText('查询路由detail');

        await detailButton.press('Enter');

        const drawer = page.getByRole('dialog', { name: '路由detail: 198.51.100.0' });
        await expect(drawer).toBeVisible();
        await expect(page.getByRole('tooltip')).toHaveCount(0);

        await page.keyboard.press('Escape');

        await expect(drawer).toBeHidden();
        await expect(detailButton).toBeFocused();
        await expect(page.getByRole('tooltip')).toHaveCount(0);

        await detailButton.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(detailButton).toBeFocused();
        await expect(page.getByRole('tooltip')).toHaveText('查询路由detail');
    });
});
