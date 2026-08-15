const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

const CLIENT = {
    persistentSourceId: 'offline-source',
    persistentConnectionId: 'offline-connection',
    connectionState: 'closed',
    isOnline: false,
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.10',
    remotePort: 49152,
    sysName: 'offline-router'
};
const CLIENT_LABEL = `${CLIENT.sysName} · ${CLIENT.remoteIp}`;
const OTHER_CLIENT = {
    ...CLIENT,
    persistentSourceId: 'unrelated-source',
    remoteIp: '192.0.2.99',
    sysName: 'unrelated-router'
};
const CLIENT_KEY = encodeURIComponent(`source:${CLIENT.persistentSourceId}`);
const SESSION_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${CLIENT_KEY}&view=session`;
const LOC_RIB_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${CLIENT_KEY}&view=loc-rib`;
const MISSING_CLIENT_KEY = 'source:missing-source';
const ENCODED_MISSING_CLIENT_KEY = encodeURIComponent(MISSING_CLIENT_KEY);
const MISSING_SESSION_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${ENCODED_MISSING_CLIENT_KEY}&view=session`;
const MISSING_LOC_RIB_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${ENCODED_MISSING_CLIENT_KEY}&view=loc-rib`;

const SESSION_SCOPE = {
    persistentScopeId: 'peer-scope',
    afi: 1,
    safi: 1,
    addrFamilyType: 1,
    ribType: 2,
    scopeState: 'down',
    routeSummary: { active: 0, stale: 1, total: 1 }
};

const SESSION = {
    persistentOwnerKey: 'peer-owner',
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
    persistentOwnerKey: 'loc-rib-owner',
    persistentScopeId: 'loc-rib-scope',
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
    routeSummary: { active: 0, stale: 1, total: 1 }
};

function staleRoute(ip, scopeId) {
    return {
        persistentScopeId: scopeId,
        routeKey: `0|0:0|${ip}|24`,
        addrFamilyType: 1,
        ip,
        mask: 24,
        rd: '0:0',
        pathId: 0,
        nextHop: '192.0.2.254',
        asPath: '65000 65100',
        parseStatus: 0,
        routeState: 'stale'
    };
}

function success(data) {
    return { status: 'success', data };
}

async function expectStandaloneMonitorLayout(page, root, pageType) {
    await expect.poll(() => page.title()).toBe(`${pageType} · ${CLIENT_LABEL}`);
    await expect(page.locator('.monitor-window-header')).toHaveCount(0);
    await expect(root.locator('.bmp-full-card > .nn-card-head')).toHaveCount(0);
    await expect(root.locator('.client-tabs')).toHaveCount(0);
}

async function expectNativeScrolling(locator, axis) {
    await expect(locator).toBeVisible();
    const scrollPosition = await locator.evaluate((element, targetAxis) => {
        const isHorizontal = targetAxis === 'x';
        if (isHorizontal && element.scrollWidth <= element.clientWidth && element.firstElementChild) {
            element.firstElementChild.style.minWidth = `${element.clientWidth + 100}px`;
        } else if (!isHorizontal) {
            element.style.maxHeight = '40px';
            if (element.firstElementChild) {
                element.firstElementChild.style.minHeight = '140px';
            }
        }
        const maximumScrollOffset = isHorizontal
            ? element.scrollWidth - element.clientWidth
            : element.scrollHeight - element.clientHeight;
        const previousScrollOffset = isHorizontal ? element.scrollLeft : element.scrollTop;
        if (isHorizontal) {
            element.scrollLeft = Math.min(20, maximumScrollOffset);
        } else {
            element.scrollTop = Math.min(20, maximumScrollOffset);
        }
        element.dispatchEvent(new Event('scroll'));
        return {
            maximumScrollOffset,
            previousScrollOffset,
            scrollOffset: isHorizontal ? element.scrollLeft : element.scrollTop,
            overflow: isHorizontal ? getComputedStyle(element).overflowX : getComputedStyle(element).overflowY,
            hasCustomScrollbarState:
                element.classList.contains('nn-scrollbar-x-active') ||
                element.classList.contains('nn-scrollbar-y-active')
        };
    }, axis);
    expect(scrollPosition.maximumScrollOffset).toBeGreaterThan(0);
    expect(scrollPosition.scrollOffset).not.toBe(scrollPosition.previousScrollOffset);
    expect(['auto', 'scroll']).toContain(scrollPosition.overflow);
    expect(scrollPosition.hasCustomScrollbarState).toBe(false);
}

test('restores offline BGP and Loc-RIB pages through persistent scope selectors', async ({ page }) => {
    const calls = [];

    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        calls.push({ method, args });
        switch (method) {
            case 'getClientList':
                return success([OTHER_CLIENT, CLIENT]);
            case 'getBgpSessions':
                return success([SESSION]);
            case 'getBgpRoutes':
                return success({
                    list: [staleRoute('203.0.113.0', SESSION_SCOPE.persistentScopeId)],
                    total: 1,
                    summary: { active: 0, stale: 1, total: 1 }
                });
            case 'getBgpInstances':
                return success([INSTANCE]);
            case 'getBgpInstanceRoutes':
                return success({
                    list: [staleRoute('198.51.100.0', INSTANCE.persistentScopeId)],
                    total: 1,
                    summary: { active: 0, stale: 1, total: 1 }
                });
            default:
                return success(null);
        }
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });

    await page.goto(SESSION_MONITOR_ROUTE);
    const sessionPage = page.getByTestId('bmp-session-page');
    await expectStandaloneMonitorLayout(page, sessionPage, 'BGP 会话');
    await expect(sessionPage).toContainText('192.0.2.2');
    await expect(sessionPage).toContainText('已断开');
    await expect(sessionPage).toContainText('203.0.113.0');
    await expect(sessionPage.getByText('过期 1')).toBeVisible();
    await expect(sessionPage.locator('.bmp-inner-tabs:visible > .nn-tabs-nav .nn-tabs-nav-wrap').first()).toHaveCSS(
        'overflow-x',
        'hidden'
    );
    await expectNativeScrolling(
        sessionPage.locator('[data-testid="bmp-session-table"]:visible .nn-table-content').first(),
        'x'
    );
    await expect
        .poll(() => {
            const request = calls.find(call => call.method === 'getBgpRoutes')?.args[0];
            return {
                sourceId: request?.client?.persistentSourceId,
                scopeId: request?.session?.persistentScopeId,
                routeState: request?.routeState
            };
        })
        .toEqual({ sourceId: CLIENT.persistentSourceId, scopeId: SESSION_SCOPE.persistentScopeId, routeState: 'all' });

    await page.goto(LOC_RIB_MONITOR_ROUTE);
    const locRibPage = page.getByTestId('bmp-loc-rib-page');
    await expectStandaloneMonitorLayout(page, locRibPage, 'Loc-RIB');
    await expect(locRibPage).toContainText('global');
    await expect(locRibPage).toContainText('已断开');
    await expect(locRibPage).toContainText('198.51.100.0');
    await expect(locRibPage.getByText('过期 1')).toBeVisible();
    await expect
        .poll(() => {
            const request = calls.find(call => call.method === 'getBgpInstanceRoutes')?.args[0];
            return {
                sourceId: request?.client?.persistentSourceId,
                scopeId: request?.instance?.persistentScopeId,
                routeState: request?.routeState
            };
        })
        .toEqual({ sourceId: CLIENT.persistentSourceId, scopeId: INSTANCE.persistentScopeId, routeState: 'all' });
});

test('shows a scoped empty state when the Client has no session or Loc-RIB instance', async ({ page }) => {
    await page.exposeFunction('__bmpE2eCall', async method => {
        if (method === 'getClientList') {
            return success([OTHER_CLIENT, CLIENT]);
        }
        if (method === 'getBgpSessions' || method === 'getBgpInstances') {
            return success([]);
        }
        return success(null);
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });

    await page.goto(SESSION_MONITOR_ROUTE);
    const sessionPage = page.getByTestId('bmp-session-page');
    await expectStandaloneMonitorLayout(page, sessionPage, 'BGP 会话');
    await expect(sessionPage.getByText('当前 Client 暂无会话数据')).toBeVisible();

    await page.goto(LOC_RIB_MONITOR_ROUTE);
    const locRibPage = page.getByTestId('bmp-loc-rib-page');
    await expectStandaloneMonitorLayout(page, locRibPage, 'Loc-RIB');
    await expect(locRibPage.getByText('当前 Client 暂无 Loc-RIB 数据')).toBeVisible();
});

test('shows an empty state when the monitored clientKey has no matching Client', async ({ page }) => {
    await page.exposeFunction('__bmpE2eCall', async method => {
        if (method === 'getClientList') {
            return success([OTHER_CLIENT, CLIENT]);
        }
        return success(null);
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });

    await page.goto(MISSING_SESSION_MONITOR_ROUTE);
    const sessionPage = page.getByTestId('bmp-session-page');
    await expect.poll(() => page.title()).toBe('BGP 会话');
    await expect(sessionPage.getByText('未找到指定 Client')).toBeVisible();

    await page.goto(MISSING_LOC_RIB_MONITOR_ROUTE);
    const locRibPage = page.getByTestId('bmp-loc-rib-page');
    await expect.poll(() => page.title()).toBe('Loc-RIB');
    await expect(locRibPage.getByText('未找到指定 Client')).toBeVisible();
});
