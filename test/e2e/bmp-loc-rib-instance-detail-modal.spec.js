const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

const CONNECTION = {
    connectionId: 'loc-rib-detail-connection',
    generation: 1786798062462000,
    state: 'open',
    localIp: '127.0.0.1',
    localPort: 1790,
    remoteIp: '127.0.0.1',
    remotePort: 57835,
    openedAtMs: 1786798062462,
    closedAtMs: null,
    closeReason: null
};

const CLIENT = {
    persistentSourceId: 'loc-rib-detail-source',
    sourceId: 'loc-rib-detail-source',
    persistentConnectionId: CONNECTION.connectionId,
    connectionId: CONNECTION.connectionId,
    connectionState: 'open',
    isOnline: true,
    connection: CONNECTION,
    localIp: CONNECTION.localIp,
    localPort: CONNECTION.localPort,
    remoteIp: CONNECTION.remoteIp,
    remotePort: CONNECTION.remotePort,
    sysName: 'loc-rib-detail-router'
};

const CLIENT_KEY = encodeURIComponent(`source:${CLIENT.persistentSourceId}`);
const LOC_RIB_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${CLIENT_KEY}&view=loc-rib`;
const ROUTE_SUMMARY = { active: 1200, stale: 3, total: 1203 };

const ROUTE_SCOPE = {
    persistentScopeId: 'loc-rib-detail-scope',
    scopeId: 'loc-rib-detail-scope',
    persistentSourceId: CLIENT.persistentSourceId,
    sourceId: CLIENT.persistentSourceId,
    persistentOwnerKey: 'loc-rib-detail-owner',
    ownerKey: 'loc-rib-detail-owner',
    persistentConnectionId: CONNECTION.connectionId,
    connectionId: CONNECTION.connectionId,
    scopeKind: 'loc-rib',
    peerType: 3,
    peerRd: '65000:100',
    afi: 1,
    safi: 1,
    addrFamilyType: 1,
    ribType: 'loc-rib',
    currentEpoch: 7,
    eorEpoch: 7,
    scopeState: 'ready',
    staleReason: null,
    staleSinceMs: null,
    refreshStartedMs: 1786798062464,
    cleanupPendingEpoch: null,
    connectionState: 'open',
    isOnline: true,
    connection: CONNECTION,
    routeSummary: ROUTE_SUMMARY
};

const INSTANCE = {
    persistentSourceId: CLIENT.persistentSourceId,
    sourceId: CLIENT.persistentSourceId,
    persistentOwnerKey: ROUTE_SCOPE.ownerKey,
    ownerKey: ROUTE_SCOPE.ownerKey,
    persistentScopeId: ROUTE_SCOPE.scopeId,
    scopeId: ROUTE_SCOPE.scopeId,
    persistentConnectionId: CONNECTION.connectionId,
    connectionId: CONNECTION.connectionId,
    connectionState: 'open',
    isOnline: true,
    connection: CONNECTION,
    instanceType: 3,
    instanceFlags: 0x80,
    rawInstanceFlags: 0x80,
    instanceRd: '65000:100',
    instanceRdRaw: 'raw:0000fde800000064',
    instanceIp: '172.28.115.3',
    instanceAs: 65100,
    instanceRouterId: '192.0.2.2',
    instanceTimestampMs: 1786285469507,
    localIp: '172.28.115.2',
    localPort: 179,
    remotePort: 36766,
    instanceState: 0,
    afi: 1,
    safi: 1,
    addrFamilyType: 1,
    vrfTableNames: ['blue'],
    recvAddressFamilies: [
        { afi: 1, safi: 1 },
        { afi: 1, safi: 128 }
    ],
    sendAddressFamilies: [
        { afi: 1, safi: 1 },
        { afi: 1, safi: 128 }
    ],
    enabledAddressFamilies: [
        { afi: 1, safi: 1 },
        { afi: 1, safi: 128 }
    ],
    enabledAddrFamilyTypes: [1, 4],
    ribTypes: [1],
    recvAddPathMap: { '1|1': 1, '1|128': 3 },
    sendAddPathMap: { '1|1': 2, '1|128': 3 },
    // BmpBgpInstance serializes effective ADD-PATH maps with raw AFI|SAFI keys.
    // Do not add addrFamilyType fallbacks here; this fixture must catch the wrong lookup shape.
    addPathReceiveMap: { '1|1': true, '1|128': true },
    addPathSendMap: { '1|1': false, '1|128': true },
    isAddPath: true,
    peerUpTlvs: [{ type: 5, value: 'blue' }],
    ribEpoch: 7,
    scopeState: 'ready',
    routeSummary: ROUTE_SUMMARY,
    routeScopes: [ROUTE_SCOPE],
    diagnosticMarker: 'loc-rib-raw-only'
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function updateInstanceTopology(instance, scopeUpdate, routeSummary) {
    const nextInstance = clone(instance);
    nextInstance.routeScopes = nextInstance.routeScopes.map(scope =>
        scope.persistentScopeId === ROUTE_SCOPE.persistentScopeId ? { ...scope, ...scopeUpdate, routeSummary } : scope
    );
    nextInstance.ribEpoch = scopeUpdate.currentEpoch;
    nextInstance.scopeState = scopeUpdate.scopeState;
    nextInstance.routeSummary = routeSummary;
    return nextInstance;
}

const STALE_INSTANCE = updateInstanceTopology(
    INSTANCE,
    {
        currentEpoch: 8,
        eorEpoch: null,
        scopeState: 'stale',
        staleReason: 'connection-replaced',
        staleSinceMs: 1786798062464
    },
    { active: 0, stale: 1200, total: 1200 }
);

const REFRESHED_INSTANCE = updateInstanceTopology(
    STALE_INSTANCE,
    {
        currentEpoch: 8,
        eorEpoch: 8,
        scopeState: 'ready',
        staleReason: null,
        staleSinceMs: null
    },
    { active: 0, stale: 0, total: 0 }
);

const INSTANCE_ROUTE = {
    persistentScopeId: ROUTE_SCOPE.scopeId,
    persistentRouteId: 'loc-rib-detail-route-id',
    routeKey: '0|65000:100|198.51.100.0|24',
    addrFamilyType: 1,
    ip: '198.51.100.0',
    mask: 24,
    rd: '65000:100',
    pathId: 0,
    nextHop: '192.0.2.254',
    asPath: '65000 65100',
    origin: 'IGP',
    med: 10,
    parseStatus: 0,
    routeState: 'active',
    routeDetailMarker: 'original-route-detail-drawer'
};

function success(data) {
    return { status: 'success', data };
}

async function installBmpMock(page, calls, { instanceResponses = [INSTANCE], routeTotal = 1 } = {}) {
    let instanceResponseIndex = 0;
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        calls.push({ method, args });
        switch (method) {
            case 'getClientList':
                return success([CLIENT]);
            case 'getBgpInstances': {
                const response = instanceResponses[Math.min(instanceResponseIndex, instanceResponses.length - 1)];
                instanceResponseIndex += 1;
                return success([clone(response)]);
            }
            case 'getBgpInstanceRoutes': {
                const pageNumber = Number(args[0]?.page) || 1;
                const route =
                    routeTotal > 1
                        ? {
                              ...INSTANCE_ROUTE,
                              persistentRouteId: `${INSTANCE_ROUTE.persistentRouteId}-${pageNumber}`,
                              routeKey: `0|65000:100|198.51.${pageNumber}.0|24`,
                              ip: `198.51.${pageNumber}.0`
                          }
                        : INSTANCE_ROUTE;
                return success({
                    list: [route],
                    total: routeTotal,
                    summary: ROUTE_SUMMARY
                });
            }
            case 'getBgpInstanceRouteDetail':
                return success(INSTANCE_ROUTE);
            default:
                return success(null);
        }
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });
}

test('shows categorized Loc-RIB Instance details in a fixed-height modal and preserves the route drawer', async ({
    page
}) => {
    const calls = [];
    await installBmpMock(page, calls);
    await page.goto(LOC_RIB_MONITOR_ROUTE);

    const locRibPage = page.getByTestId('bmp-loc-rib-page');
    const instanceTable = locRibPage.getByTestId('bmp-loc-rib-instance-table');
    const routeTable = locRibPage.getByTestId('bmp-loc-rib-route-table');
    await expect(locRibPage).toBeVisible();
    await expect(instanceTable).toContainText('blue');
    await expect(routeTable).toContainText(INSTANCE_ROUTE.ip);

    await instanceTable.getByTestId('bmp-loc-rib-instance-detail-button').click();

    const dialog = page.getByRole('dialog', {
        name: 'Loc-RIB 详情 · blue · IPv4 Unicast',
        exact: true
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveClass(/(^|\s)nn-modal(\s|$)/u);
    await expect(page.getByTestId('bmp-loc-rib-instance-detail-modal')).toBeVisible();
    await expect(page.locator('.nn-drawer-content:visible')).toHaveCount(0);
    expect(calls.filter(call => call.method === 'getBgpInstanceRouteDetail')).toHaveLength(0);

    const modalHeight = async () => {
        const box = await dialog.boundingBox();
        return Math.round(box?.height || 0);
    };
    const fixedModalHeight = await modalHeight();
    expect(fixedModalHeight).toBeGreaterThan(0);

    const overview = dialog.getByTestId('bmp-loc-rib-instance-detail-overview');
    await expect(overview).toBeVisible();
    await expect(overview).toContainText('BMP 连接');
    await expect(overview).toContainText('在线');
    await expect(overview).toContainText('Peer Up');
    await expect(overview).toContainText('IPv4 Unicast');
    await expect(overview).toContainText('1,200');
    await expect(overview).toContainText('1,203');
    await expect(overview).toContainText('Local RIB');
    await expect(overview).toContainText('blue');
    await expect(overview).toContainText('172.28.115.3');
    await expect(overview).toContainText('65100');
    await expect(overview).toContainText('192.0.2.2');
    await expect(overview).toContainText('Filtered');

    const connection = overview.getByTestId('bmp-loc-rib-instance-detail-connection');
    await expect(connection).toContainText('来源 BGP 邻接');
    await expect(connection).toContainText('172.28.115.2:179');
    await expect(connection).toContainText('172.28.115.3:36766');
    await expect(connection).toContainText('BMP Collector 连接');
    await expect(connection).toContainText('127.0.0.1:1790');
    await expect(connection).toContainText('127.0.0.1:57835');

    await expect(page.getByTestId('bmp-loc-rib-instance-detail-raw-json')).toHaveCount(0);
    await expect(dialog).not.toContainText(INSTANCE.diagnosticMarker);

    await dialog.getByRole('tab', { name: 'RIB 状态 (1)', exact: true }).click();
    await expect.poll(modalHeight).toBe(fixedModalHeight);
    const ribState = dialog.getByTestId('bmp-loc-rib-instance-detail-rib-state');
    const scopeTable = ribState.getByTestId('bmp-loc-rib-instance-detail-scope-table');
    await expect(ribState).toBeVisible();
    await expect(ribState).toContainText('每个 Loc-RIB Instance 通常对应一个地址族 Scope');
    await expect(scopeTable.locator('.nn-table-tbody > .nn-table-row')).toHaveCount(1);
    await expect(scopeTable).toContainText('IPv4 Unicast');
    await expect(scopeTable).toContainText('AFI 1 / SAFI 1');
    await expect(scopeTable).toContainText('已就绪');
    await expect(scopeTable).toContainText('1,200');
    await expect(scopeTable).toContainText('1,203');
    await expect(scopeTable).toContainText('当前 7');
    await expect(scopeTable).toContainText('EOR 7');
    await expect(ribState).toContainText(ROUTE_SCOPE.scopeId);

    await dialog.getByRole('tab', { name: '能力协商', exact: true }).click();
    await expect.poll(modalHeight).toBe(fixedModalHeight);
    const capabilities = dialog.getByTestId('bmp-loc-rib-instance-detail-capabilities');
    await expect(capabilities).toBeVisible();
    await expect(capabilities).toContainText('IPv4 Unicast');
    await expect(capabilities).toContainText('VPNV4');
    await expect(capabilities).toContainText('仅接收');
    await expect(capabilities).toContainText('仅发送');
    await expect(capabilities).toContainText('收发');
    await expect(capabilities).toContainText('接收 开');
    await expect(capabilities).toContainText('发送 关');
    await expect(capabilities).toContainText('总体 ADD-PATH');
    await expect(capabilities).toContainText('已启用');
    await expect(capabilities).toContainText('Peer Up TLV');

    await dialog.getByRole('tab', { name: '高级诊断', exact: true }).click();
    await expect.poll(modalHeight).toBe(fixedModalHeight);
    const advanced = dialog.getByTestId('bmp-loc-rib-instance-detail-advanced');
    const rawJson = dialog.getByTestId('bmp-loc-rib-instance-detail-raw-json');
    await expect(advanced).toBeVisible();
    await expect(advanced).toContainText('以下信息主要用于持久化定位、重连恢复和问题排查');
    await expect(advanced).toContainText(CLIENT.persistentSourceId);
    await expect(advanced).toContainText(ROUTE_SCOPE.ownerKey);
    await expect(advanced).toContainText(ROUTE_SCOPE.scopeId);
    await expect(advanced).toContainText(CONNECTION.connectionId);
    await expect(advanced).toContainText('0x80');
    await expect(rawJson).toBeVisible();
    await expect(rawJson).toContainText('diagnosticMarker');
    await expect(rawJson).toContainText(INSTANCE.diagnosticMarker);

    await dialog.getByRole('tab', { name: '实例概览', exact: true }).click();
    await expect.poll(modalHeight).toBe(fixedModalHeight);
    await expect(page.getByTestId('bmp-loc-rib-instance-detail-raw-json')).toHaveCount(0);
    await expect(dialog).not.toContainText(INSTANCE.diagnosticMarker);

    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).toBeHidden();

    await routeTable.getByTestId('bmp-loc-rib-route-detail').click();

    const routeDrawer = page.getByRole('dialog', {
        name: `路由detail: ${INSTANCE_ROUTE.ip}`,
        exact: true
    });
    await expect(routeDrawer).toBeVisible();
    await expect(page.locator('.nn-drawer-content:visible')).toHaveCount(1);
    await expect(page.getByTestId('bmp-loc-rib-instance-detail-modal')).toBeHidden();
    await expect(routeDrawer.getByRole('tab', { name: '路由详情', exact: true })).toBeVisible();
    await expect(routeDrawer.getByRole('tab', { name: '事件轨迹', exact: true })).toBeVisible();
    await expect(routeDrawer).toContainText('persistentRouteId');
    await expect(routeDrawer).toContainText(INSTANCE_ROUTE.persistentRouteId);
    await expect(routeDrawer).toContainText('routeDetailMarker');
    await expect(routeDrawer).toContainText(INSTANCE_ROUTE.routeDetailMarker);
    await expect.poll(() => calls.filter(call => call.method === 'getBgpInstanceRouteDetail').length).toBe(1);

    await routeDrawer.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(routeDrawer).toBeHidden();
});

test('reloads the latest Loc-RIB topology every time details are opened without resetting route pagination', async ({
    page
}) => {
    const calls = [];
    await installBmpMock(page, calls, {
        instanceResponses: [STALE_INSTANCE, STALE_INSTANCE, REFRESHED_INSTANCE],
        routeTotal: 60
    });
    await page.goto(LOC_RIB_MONITOR_ROUTE);

    const routeTable = page.getByTestId('bmp-loc-rib-route-table');
    await expect(routeTable).toContainText('198.51.1.0');
    const pagination = routeTable.getByRole('navigation', { name: '表格分页' });
    const secondPageButton = pagination.getByRole('button', { name: '2', exact: true });
    await secondPageButton.click();
    await expect(routeTable).toContainText('198.51.2.0');
    await expect(secondPageButton).toHaveAttribute('aria-current', 'page');

    const detailButton = page.getByTestId('bmp-loc-rib-instance-detail-button');
    await detailButton.click();
    await expect.poll(() => calls.filter(call => call.method === 'getBgpInstances').length).toBe(2);

    const dialog = page.getByRole('dialog', {
        name: 'Loc-RIB 详情 · blue · IPv4 Unicast',
        exact: true
    });
    await dialog.getByRole('tab', { name: 'RIB 状态 (1)', exact: true }).click();
    const scopeTable = dialog.getByTestId('bmp-loc-rib-instance-detail-scope-table');
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(1);
    await expect(scopeTable).toContainText('1,200');
    await expect(secondPageButton).toHaveAttribute('aria-current', 'page');

    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await detailButton.click();
    await expect.poll(() => calls.filter(call => call.method === 'getBgpInstances').length).toBe(3);

    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'RIB 状态 (1)', exact: true }).click();
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(0);
    await expect(scopeTable.getByText('已就绪', { exact: true })).toHaveCount(1);
    const refreshedRow = scopeTable.locator('.nn-table-tbody > .nn-table-row').first();
    await expect(refreshedRow.locator('.nn-table-cell').nth(2)).toHaveText('0');
    await expect(refreshedRow.locator('.nn-table-cell').nth(3)).toHaveText('0');
    await expect(refreshedRow.locator('.nn-table-cell').nth(4)).toHaveText('0');
    await expect(secondPageButton).toHaveAttribute('aria-current', 'page');
});

test('debounces matching Instance and projection reset events into topology refreshes', async ({ page }) => {
    const calls = [];
    await installBmpMock(page, calls, {
        instanceResponses: [STALE_INSTANCE, STALE_INSTANCE, STALE_INSTANCE, REFRESHED_INSTANCE],
        routeTotal: 60
    });
    await page.goto(LOC_RIB_MONITOR_ROUTE);

    const routeTable = page.getByTestId('bmp-loc-rib-route-table');
    const pagination = routeTable.getByRole('navigation', { name: '表格分页' });
    const secondPageButton = pagination.getByRole('button', { name: '2', exact: true });
    await secondPageButton.click();
    await expect(secondPageButton).toHaveAttribute('aria-current', 'page');

    await page.getByTestId('bmp-loc-rib-instance-detail-button').click();
    await expect.poll(() => calls.filter(call => call.method === 'getBgpInstances').length).toBe(2);

    const dialog = page.getByRole('dialog', {
        name: 'Loc-RIB 详情 · blue · IPv4 Unicast',
        exact: true
    });
    await dialog.getByRole('tab', { name: 'RIB 状态 (1)', exact: true }).click();
    const scopeTable = dialog.getByTestId('bmp-loc-rib-instance-detail-scope-table');
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(1);

    const routeCallsBeforeInstanceUpdate = calls.filter(call => call.method === 'getBgpInstanceRoutes').length;
    await page.evaluate(
        ({ client, instance }) => {
            const event = { status: 'success', data: { client, instance } };
            window.__bmpE2eEmit('bmp:instanceUpdate', event);
            window.__bmpE2eEmit('bmp:instanceUpdate', event);
        },
        { client: CLIENT, instance: STALE_INSTANCE }
    );

    await expect.poll(() => calls.filter(call => call.method === 'getBgpInstances').length, { timeout: 5000 }).toBe(3);
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(1);
    expect(calls.filter(call => call.method === 'getBgpInstanceRoutes')).toHaveLength(routeCallsBeforeInstanceUpdate);
    await expect(secondPageButton).toHaveAttribute('aria-current', 'page');

    await page.evaluate(
        ({ sourceId, scopeId }) => {
            const event = {
                status: 'success',
                data: {
                    batch: true,
                    updates: [
                        {
                            persistentSourceId: sourceId,
                            persistentScopeId: scopeId,
                            reason: 'persistence-sweep',
                            projectionReset: true
                        }
                    ]
                }
            };
            window.__bmpE2eEmit('bmp:instanceRouteUpdate', event);
            window.__bmpE2eEmit('bmp:instanceRouteUpdate', event);
        },
        { sourceId: CLIENT.persistentSourceId, scopeId: ROUTE_SCOPE.persistentScopeId }
    );

    await expect.poll(() => calls.filter(call => call.method === 'getBgpInstances').length, { timeout: 5000 }).toBe(4);
    await expect(scopeTable.getByText('数据过期', { exact: true })).toHaveCount(0);
    await expect(scopeTable.getByText('已就绪', { exact: true })).toHaveCount(1);

    await dialog.getByRole('tab', { name: '实例概览', exact: true }).click();
    const overview = dialog.getByTestId('bmp-loc-rib-instance-detail-overview');
    await expect(overview.locator('.summary-card').filter({ hasText: '当前 RIB 条目' }).locator('strong')).toHaveText(
        '0'
    );
    await expect(overview.locator('.summary-card').filter({ hasText: '过期 RIB 条目' }).locator('strong')).toHaveText(
        '0'
    );
    await expect(overview.locator('.summary-card').filter({ hasText: 'RIB 记录总数' }).locator('strong')).toHaveText(
        '0'
    );

    await expect.poll(() => calls.filter(call => call.method === 'getBgpInstanceRoutes').at(-1)?.args[0]?.page).toBe(2);
    await expect(secondPageButton).toHaveAttribute('aria-current', 'page');
});
