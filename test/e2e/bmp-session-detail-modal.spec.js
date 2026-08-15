const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

const CLIENT = {
    persistentSourceId: 'session-detail-source',
    persistentConnectionId: 'session-detail-connection',
    connectionState: 'open',
    isOnline: true,
    localIp: '127.0.0.1',
    localPort: 1790,
    remoteIp: '127.0.0.1',
    remotePort: 57835,
    sysName: 'session-detail-router'
};
const CLIENT_KEY = encodeURIComponent(`source:${CLIENT.persistentSourceId}`);
const SESSION_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${CLIENT_KEY}&view=session`;

function routeScope({ id, afi, safi, addrFamilyType, ribType, scopeState, active, stale = 0, eorEpoch }) {
    return {
        persistentScopeId: id,
        afi,
        safi,
        addrFamilyType,
        ribType,
        currentEpoch: 0,
        eorEpoch,
        scopeState,
        routeSummary: { active, stale, total: active + stale }
    };
}

const ADDRESS_FAMILIES = [
    { id: 'ipv4-unicast', afi: 1, safi: 1, addrFamilyType: 1, active: 1024 },
    { id: 'ipv4-multicast', afi: 1, safi: 2, addrFamilyType: 16, active: 1 },
    { id: 'vpnv4', afi: 1, safi: 128, addrFamilyType: 4, active: 1024 },
    { id: 'evpn', afi: 25, safi: 70, addrFamilyType: 3, active: 1024 }
];
const ROUTE_SCOPES = ADDRESS_FAMILIES.flatMap(family =>
    [
        { ribType: 1, scopeState: 'ready', active: family.active, eorEpoch: 0 },
        { ribType: 2, scopeState: 'ready', active: family.active, eorEpoch: 0 },
        { ribType: 4, scopeState: 'syncing', active: 0, eorEpoch: null },
        { ribType: 5, scopeState: 'syncing', active: 0, eorEpoch: null }
    ].map(stage =>
        routeScope({
            id: `${family.id}-${stage.ribType}`,
            afi: family.afi,
            safi: family.safi,
            addrFamilyType: family.addrFamilyType,
            ...stage
        })
    )
);

const SESSION = {
    persistentSourceId: CLIENT.persistentSourceId,
    persistentOwnerKey: '0|raw:0000000000000000|172.28.115.3|65100',
    persistentConnectionId: CLIENT.persistentConnectionId,
    connectionState: 'open',
    isOnline: true,
    connection: {
        connectionId: CLIENT.persistentConnectionId,
        state: 'open',
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '127.0.0.1',
        remotePort: 57835,
        openedAtMs: 1786798062462,
        closedAtMs: null,
        closeReason: null
    },
    sessionType: 0,
    sessionFlags: 0,
    rawSessionFlags: 0,
    sessionRd: '0:0',
    sessionRdRaw: 'raw:0000000000000000',
    sessionIp: '172.28.115.3',
    sessionAs: 65100,
    sessionRouterId: '192.0.2.2',
    sessionState: 0,
    sessionTimestampMs: 1786285469507,
    localIp: '172.28.115.2',
    localPort: 179,
    remotePort: 36766,
    enabledAddressFamilies: ADDRESS_FAMILIES.map(({ afi, safi }) => ({ afi, safi })),
    recvAddressFamilies: ADDRESS_FAMILIES.map(({ afi, safi }) => ({ afi, safi })),
    sendAddressFamilies: ADDRESS_FAMILIES.map(({ afi, safi }) => ({ afi, safi })),
    enabledAddrFamilyTypes: ADDRESS_FAMILIES.map(({ addrFamilyType }) => addrFamilyType),
    ribTypes: [1, 2, 4, 5],
    recvAddPathMap: { '1|1': 1, '1|2': 2, '1|128': 3, '25|70': 1 },
    sendAddPathMap: { '1|1': 2, '1|2': 3, '1|128': 1, '25|70': 1 },
    addPathReceiveMap: { 1: true, 3: false, 4: true, 16: false },
    addPathSendMap: { 1: false, 3: false, 4: true, 16: true },
    addPathMap: { 1: true, 3: false, 4: true, 16: true },
    peerUpTlvs: [{ type: 1 }],
    peerDownTlvs: [],
    peerDownReason: null,
    peerDownFsmEventCode: null,
    vrfTableNames: [],
    routeSummary: { active: 6146, stale: 0, total: 6146 },
    routeScopes: ROUTE_SCOPES
};

const SESSION_ROUTE = {
    persistentScopeId: 'ipv4-unicast-1',
    persistentRouteId: 'session-detail-route',
    routeKey: '0|0:0|203.0.113.0|24',
    addrFamilyType: 1,
    ip: '203.0.113.0',
    mask: 24,
    rd: '0:0',
    pathId: 0,
    nextHop: '192.0.2.254',
    asPath: '65100',
    parseStatus: 0,
    routeState: 'active',
    detailMarker: 'session-route-drawer-still-works'
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function updateSessionScopes(session, scopeUpdates, routeSummary) {
    const nextSession = clone(session);
    nextSession.routeScopes = nextSession.routeScopes.map(scope => {
        const update = scopeUpdates[scope.persistentScopeId];
        return update ? { ...scope, ...update } : scope;
    });
    nextSession.routeSummary = routeSummary;
    return nextSession;
}

const STALE_SESSION = updateSessionScopes(
    SESSION,
    {
        'ipv4-unicast-1': {
            currentEpoch: 1,
            eorEpoch: null,
            scopeState: 'stale',
            routeSummary: { active: 0, stale: 1024, total: 1024 }
        },
        'ipv4-unicast-4': {
            currentEpoch: 1,
            // The previous epoch's EOR does not complete the current refresh.
            eorEpoch: 0,
            scopeState: 'syncing',
            routeSummary: { active: 0, stale: 12, total: 12 }
        }
    },
    { active: 5122, stale: 1036, total: 6158 }
);

const REFRESHED_SESSION = updateSessionScopes(
    STALE_SESSION,
    {
        'ipv4-unicast-1': {
            currentEpoch: 1,
            eorEpoch: 1,
            scopeState: 'ready',
            routeSummary: { active: 1024, stale: 0, total: 1024 }
        },
        'ipv4-unicast-4': {
            currentEpoch: 1,
            eorEpoch: null,
            scopeState: 'syncing',
            routeSummary: { active: 0, stale: 0, total: 0 }
        }
    },
    { active: 6146, stale: 0, total: 6146 }
);

function success(data) {
    return { status: 'success', data };
}

async function installBmpMock(page, { sessionResponses = [SESSION] } = {}) {
    const calls = [];
    let sessionResponseIndex = 0;
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        calls.push({ method, args });
        switch (method) {
            case 'getClientList':
                return success([CLIENT]);
            case 'getBgpSessions': {
                const response = sessionResponses[Math.min(sessionResponseIndex, sessionResponses.length - 1)];
                sessionResponseIndex += 1;
                return success([clone(response)]);
            }
            case 'getBgpRoutes':
                return success({
                    list: [SESSION_ROUTE],
                    total: 1,
                    summary: { active: 1, stale: 0, total: 1 }
                });
            case 'getBgpRouteDetail':
                return success(SESSION_ROUTE);
            default:
                return success(null);
        }
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });
    return { calls };
}

test('shows categorized BGP Session details in a modal and keeps raw JSON under diagnostics', async ({ page }) => {
    await installBmpMock(page);
    await page.goto(SESSION_MONITOR_ROUTE);

    const sessionPage = page.getByTestId('bmp-session-page');
    await expect(sessionPage).toBeVisible();
    await expect(sessionPage).toContainText('172.28.115.3');

    await sessionPage.getByTestId('bmp-session-detail-button').click();

    const dialog = page.getByRole('dialog', {
        name: 'BGP Session 详情 · 172.28.115.3',
        exact: true
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveClass(/(^|\s)nn-modal(\s|$)/u);
    await expect(page.getByTestId('bmp-session-detail-modal')).toBeVisible();
    await expect(page.locator('.nn-drawer-content:visible')).toHaveCount(0);

    const modalHeight = async () => Math.round((await dialog.boundingBox()).height);
    const fixedModalHeight = await modalHeight();

    const overview = dialog.getByTestId('bmp-session-detail-overview');
    await expect(overview).toBeVisible();
    await expect(overview).toContainText('BMP 连接');
    await expect(overview).toContainText('在线');
    await expect(overview).toContainText('Peer Up');
    await expect(overview).toContainText('6,146');
    await expect(overview).toContainText('4 / 16');
    await expect(overview).toContainText('Global');
    await expect(overview).toContainText('172.28.115.3');
    await expect(overview).toContainText('65100');
    await expect(overview).toContainText('192.0.2.2');
    await expect(page.getByTestId('bmp-session-detail-raw-json')).toHaveCount(0);

    const connection = overview.getByTestId('bmp-session-detail-connection');
    await expect(connection).toContainText('被监控的 BGP 邻接');
    await expect(connection).toContainText('172.28.115.2:179');
    await expect(connection).toContainText('172.28.115.3:36766');
    await expect(connection).toContainText('BMP Collector 连接');
    await expect(connection).toContainText('127.0.0.1:1790');
    await expect(connection).toContainText('127.0.0.1:57835');

    await dialog.getByRole('tab', { name: 'RIB 视图 (16)', exact: true }).click();
    await expect.poll(modalHeight).toBe(fixedModalHeight);
    const ribPanel = dialog.getByTestId('bmp-session-detail-rib-scopes');
    const scopeTable = ribPanel.getByTestId('bmp-session-detail-scope-table');
    await expect(ribPanel).toBeVisible();
    await expect(ribPanel).toContainText('一个地址族会拆成四个独立 RIB 视图');
    await expect(scopeTable.locator('.nn-table-tbody > .nn-table-row')).toHaveCount(4);
    await expect(scopeTable).toContainText('IPv4 Unicast');
    await expect(scopeTable).toContainText('IPv4 Multicast');
    await expect(scopeTable).toContainText('VPNV4');
    await expect(scopeTable).toContainText('L2VPN EVPN');
    await expect(scopeTable).toContainText('Pre-policy Adj-RIB-In');
    await expect(scopeTable).toContainText('Post-policy Adj-RIB-In');
    await expect(scopeTable).toContainText('Pre-policy Adj-RIB-Out');
    await expect(scopeTable).toContainText('Post-policy Adj-RIB-Out');
    await expect(scopeTable.getByText('已就绪', { exact: true })).toHaveCount(8);
    await expect(scopeTable.getByText('未上报', { exact: true })).toHaveCount(8);
    await expect(scopeTable.getByText('等待 EOR', { exact: true })).toHaveCount(0);
    await expect(scopeTable).toContainText('1,024');
    await expect(scopeTable).toContainText('2,048');

    await dialog.getByRole('tab', { name: '能力协商', exact: true }).click();
    await expect.poll(modalHeight).toBe(fixedModalHeight);
    const capabilities = dialog.getByTestId('bmp-session-detail-capabilities');
    await expect(capabilities).toBeVisible();
    await expect(capabilities).toContainText('IPv4 Unicast');
    await expect(capabilities).toContainText('IPv4 Multicast');
    await expect(capabilities).toContainText('VPNV4');
    await expect(capabilities).toContainText('L2VPN EVPN');
    await expect(capabilities).toContainText('仅接收');
    await expect(capabilities).toContainText('仅发送');
    await expect(capabilities).toContainText('收发');
    await expect(capabilities).toContainText('接收 开');
    await expect(capabilities).toContainText('发送 关');
    await expect(capabilities).toContainText('共同启用地址族');
    await expect(capabilities).toContainText('Peer Up TLV');

    await dialog.getByRole('tab', { name: '高级诊断', exact: true }).click();
    await expect.poll(modalHeight).toBe(fixedModalHeight);
    const advanced = dialog.getByTestId('bmp-session-detail-advanced');
    const rawJson = dialog.getByTestId('bmp-session-detail-raw-json');
    await expect(advanced).toBeVisible();
    await expect(advanced).toContainText('以下信息主要用于持久化定位、重连恢复和问题排查');
    await expect(advanced).toContainText('session-detail-source');
    await expect(rawJson).toBeVisible();
    await expect(rawJson).toContainText('persistentSourceId');

    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).toBeHidden();

    const routeDetailButton = page.getByTestId('bmp-session-route-detail');
    await expect(routeDetailButton).toBeVisible();
    await routeDetailButton.click();

    const routeDrawer = page.getByRole('dialog', { name: '路由detail: 203.0.113.0' });
    await expect(routeDrawer).toBeVisible();
    await expect(routeDrawer).toHaveClass(/(^|\s)nn-drawer-content(\s|$)/u);
    await expect(routeDrawer).toContainText('session-route-drawer-still-works');
});

test('reloads the latest Session topology every time details are opened', async ({ page }) => {
    const { calls } = await installBmpMock(page, {
        sessionResponses: [STALE_SESSION, STALE_SESSION, REFRESHED_SESSION]
    });
    await page.goto(SESSION_MONITOR_ROUTE);

    const detailButton = page.getByTestId('bmp-session-detail-button');
    await expect(detailButton).toBeVisible();
    await expect.poll(() => calls.filter(call => call.method === 'getBgpSessions').length).toBe(1);

    await detailButton.click();
    await expect.poll(() => calls.filter(call => call.method === 'getBgpSessions').length).toBe(2);

    const dialog = page.getByRole('dialog', {
        name: 'BGP Session 详情 · 172.28.115.3',
        exact: true
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'RIB 视图 (16)', exact: true }).click();

    const scopeTable = dialog.getByTestId('bmp-session-detail-scope-table');
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(1);
    await expect(scopeTable.getByText('未重新上报', { exact: true })).toHaveCount(1);
    await expect(scopeTable).toContainText('1,024 过期');

    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await detailButton.click();
    await expect.poll(() => calls.filter(call => call.method === 'getBgpSessions').length).toBe(3);

    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'RIB 视图 (16)', exact: true }).click();
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(0);
    await expect(scopeTable.getByText('未重新上报', { exact: true })).toHaveCount(0);
    await expect(scopeTable.getByText('已就绪', { exact: true })).toHaveCount(8);
    await expect(scopeTable.getByText('未上报', { exact: true })).toHaveCount(8);
    await expect(scopeTable).not.toContainText('1,024 过期');
});

test('debounces matching session updates into a fresh topology request while details stay open', async ({ page }) => {
    const { calls } = await installBmpMock(page, {
        sessionResponses: [STALE_SESSION, STALE_SESSION, REFRESHED_SESSION]
    });
    await page.goto(SESSION_MONITOR_ROUTE);

    await page.getByTestId('bmp-session-detail-button').click();
    await expect.poll(() => calls.filter(call => call.method === 'getBgpSessions').length).toBe(2);

    const dialog = page.getByRole('dialog', {
        name: 'BGP Session 详情 · 172.28.115.3',
        exact: true
    });
    await dialog.getByRole('tab', { name: 'RIB 视图 (16)', exact: true }).click();
    const scopeTable = dialog.getByTestId('bmp-session-detail-scope-table');
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(1);

    await page.evaluate(
        ({ client, session }) => {
            window.__bmpE2eEmit('bmp:sessionUpdate', {
                status: 'success',
                data: { client, session }
            });
        },
        { client: CLIENT, session: STALE_SESSION }
    );

    await expect.poll(() => calls.filter(call => call.method === 'getBgpSessions').length, { timeout: 5000 }).toBe(3);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('bmp-session-detail-rib-scopes')).toBeVisible();
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(0);
    await expect(scopeTable.getByText('已就绪', { exact: true })).toHaveCount(8);
    await expect(scopeTable).not.toContainText('1,024 过期');
});
