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

async function expectClientLabel(page, root) {
    const address = root.locator('.client-tab-address').first();
    await expect(address).toHaveText(CLIENT_LABEL);

    const presentation = await address.evaluate(element => {
        const style = window.getComputedStyle(element);
        return {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace
        };
    });
    expect(presentation.textOverflow).toBe('ellipsis');
    expect(presentation.whiteSpace).toBe('nowrap');
    expect(presentation.scrollWidth).toBeGreaterThan(presentation.clientWidth);

    await address.hover();
    await expect(page.getByRole('tooltip')).toHaveText(CLIENT_LABEL);
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
}

async function expectScrollOnlyScrollbar(locator, axis) {
    const isXActive = () => locator.evaluate(element => element.classList.contains('nn-scrollbar-x-active'));
    const isYActive = () => locator.evaluate(element => element.classList.contains('nn-scrollbar-y-active'));
    const isTargetAxisActive = axis === 'x' ? isXActive : isYActive;
    const isOtherAxisActive = axis === 'x' ? isYActive : isXActive;

    await expect(locator).toBeVisible();
    await expect.poll(isXActive, { timeout: 2500 }).toBe(false);
    await expect.poll(isYActive).toBe(false);

    await locator.hover();
    await locator.dispatchEvent('pointermove');
    await expect.poll(isXActive).toBe(false);
    await expect.poll(isYActive).toBe(false);

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
            scrollOffset: isHorizontal ? element.scrollLeft : element.scrollTop
        };
    }, axis);
    expect(scrollPosition.maximumScrollOffset).toBeGreaterThan(0);
    expect(scrollPosition.scrollOffset).not.toBe(scrollPosition.previousScrollOffset);
    await expect.poll(isTargetAxisActive).toBe(true);
    await expect.poll(isOtherAxisActive).toBe(false);
    await expect.poll(isTargetAxisActive, { timeout: 2500 }).toBe(false);
    await expect.poll(isOtherAxisActive).toBe(false);
}

test('restores offline BGP and Loc-RIB pages through persistent scope selectors', async ({ page }) => {
    const calls = [];

    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        calls.push({ method, args });
        switch (method) {
            case 'getClientList':
                return success([CLIENT]);
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

    await page.goto('/#/bmp/bgp-session');
    const sessionPage = page.getByTestId('bmp-session-page');
    await expectClientLabel(page, sessionPage);
    await expect(sessionPage).toContainText('192.0.2.2');
    await expect(sessionPage).toContainText('已断开');
    await expect(sessionPage).toContainText('203.0.113.0');
    await expect(sessionPage.getByText('过期 1')).toBeVisible();
    await expectScrollOnlyScrollbar(
        sessionPage.locator('.client-tabs:visible > .nn-tabs-nav > .nn-tabs-nav-wrap').first(),
        'y'
    );
    await expectScrollOnlyScrollbar(
        sessionPage.locator('.bmp-inner-tabs:visible > .nn-tabs-nav .nn-tabs-nav-wrap').first(),
        'x'
    );
    await expectScrollOnlyScrollbar(
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

    await page.goto('/#/bmp/bgp-loc-rib');
    const locRibPage = page.getByTestId('bmp-loc-rib-page');
    await expectClientLabel(page, locRibPage);
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
