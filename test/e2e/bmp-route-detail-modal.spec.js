const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');
const { richAttributes, evpnRoute } = require('../fixtures/bmpRouteDetail');

const CLIENT = {
    persistentSourceId: 'route-modal-source',
    persistentConnectionId: 'route-modal-connection',
    connectionState: 'closed',
    isOnline: false,
    localIp: '127.0.0.1',
    localPort: 1790,
    remoteIp: '192.0.2.10',
    remotePort: 49152,
    sysName: 'route-modal-router'
};
const SUMMARY = { active: 0, stale: 1, total: 1 };
const SESSION_SCOPE = {
    persistentScopeId: 'route-modal-session-scope',
    afi: 1,
    safi: 1,
    addrFamilyType: 1,
    ribType: 1,
    scopeState: 'down',
    routeSummary: SUMMARY
};
const SESSION = {
    persistentSourceId: CLIENT.persistentSourceId,
    persistentOwnerKey: 'route-modal-session-owner',
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
    persistentSourceId: CLIENT.persistentSourceId,
    persistentOwnerKey: 'route-modal-instance-owner',
    persistentScopeId: 'route-modal-instance-scope',
    connectionState: 'closed',
    isOnline: false,
    instanceType: 3,
    instanceRd: '0:0',
    instanceIp: '0.0.0.0',
    instanceAs: 0,
    instanceRouterId: '192.0.2.1',
    instanceState: 1,
    afi: 1,
    safi: 1,
    addrFamilyType: 1,
    vrfTableNames: ['global'],
    routeSummary: SUMMARY
};

function route(view, revision = 1) {
    return {
        persistentSourceId: CLIENT.persistentSourceId,
        persistentScopeId: view === 'session' ? SESSION_SCOPE.persistentScopeId : INSTANCE.persistentScopeId,
        persistentRouteId: `route-modal-${view}-route`,
        routeKey: '0|0:0|203.0.113.0|24',
        afi: 1,
        safi: 1,
        addrFamilyType: 1,
        ip: '203.0.113.0',
        mask: 24,
        rd: '0:0',
        pathId: 0,
        ...richAttributes(revision),
        nlriDetail: { pathId: 0, prefix: '203.0.113.0', length: 24, valid: true },
        source: {
            localIp: CLIENT.localIp,
            localPort: CLIENT.localPort,
            remoteIp: CLIENT.remoteIp,
            remotePort: CLIENT.remotePort,
            sysName: CLIENT.sysName
        },
        peer: { type: view === 'session' ? 0 : 3, rd: '0:0', ip: '192.0.2.2', as: 65000, vrf: 'global' },
        scopeKind: view === 'session' ? 'peer' : 'loc-rib',
        ribType: view === 'session' ? 1 : 'loc-rib',
        vrfName: 'global',
        parseStatus: 0,
        routeState: 'stale',
        staleReason: 'connection-closed',
        vendorDetails: { snapshot: `full-response-v${revision}`, enabled: false, weight: 0, note: null },
        emptyList: [],
        emptyObject: {}
    };
}

function success(data) {
    return { status: 'success', data };
}

async function installMock(page, view) {
    const fullRoutes = [route(view, 1), route(view, 2)];
    const lensRecord = { client: CLIENT, session: SESSION, af: 1, ribType: 1, route: fullRoutes[0] };
    const brief = {
        ...fullRoutes[0],
        asPath: '65000',
        communities: undefined,
        pathAttributes: undefined,
        vendorDetails: undefined,
        routeTlvs: undefined,
        nlriDetail: undefined,
        emptyList: undefined,
        emptyObject: undefined
    };
    const calls = [];
    let detailIndex = 0;
    let release;
    const pending = new Promise(resolve => {
        release = resolve;
    });
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        calls.push({ method, args });
        switch (method) {
            case 'getClientList':
                return success([CLIENT]);
            case 'getBgpSessions':
                return success([SESSION]);
            case 'getBgpInstances':
                return success([INSTANCE]);
            case 'getBgpRoutes':
            case 'getBgpInstanceRoutes':
                return success({ list: [brief], total: 1, summary: SUMMARY });
            case 'getBgpRouteDetail':
            case 'getBgpInstanceRouteDetail': {
                const current = fullRoutes[Math.min(detailIndex++, fullRoutes.length - 1)];
                await pending;
                return success(current);
            }
            case 'getRouteLens':
                return success({
                    stages: { preIn: [lensRecord] },
                    summary: { total: 1 },
                    policyDiffs: {
                        inbound: [
                            {
                                id: 'route-modal-diff',
                                title: '203.0.113.0/24',
                                status: 'modified',
                                changes: [{ field: 'localPref', before: 100, after: 200 }]
                            }
                        ]
                    }
                });
            default:
                return success(null);
        }
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });
    return { calls, fullRoutes, release, lensRecord };
}

async function expectOriginalJson(dialog, expected, restoreOverview = true) {
    const rawJson = dialog.getByTestId('bmp-route-detail-raw-json');
    await expect(rawJson).toHaveCount(0);
    await dialog.getByRole('tab', { name: '原始数据', exact: true }).click();
    await expect(rawJson).toBeVisible();
    expect(JSON.parse(await rawJson.locator('pre code').textContent())).toEqual(expected);
    if (restoreOverview) {
        await dialog.getByRole('tab', { name: '路由概览', exact: true }).click();
        await expect(rawJson).toHaveCount(0);
    }
}

for (const view of ['session', 'loc-rib']) {
    test(`${view} opens complete route details with readable attributes and fresh raw data`, async ({
        page
    }, testInfo) => {
        const { calls, fullRoutes, release } = await installMock(page, view);
        const clientKey = encodeURIComponent(`source:${CLIENT.persistentSourceId}`);
        await page.goto(`/#/monitor/bmp-client?clientKey=${clientKey}&view=${view}`);
        const detailButton = page.getByTestId(`bmp-${view}-route-detail`);
        await expect(detailButton).toBeVisible();
        await detailButton.click();

        const modal = page.getByTestId('bmp-route-detail-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toHaveClass(/(^|\s)nn-modal(\s|$)/u);
        await expect(modal.getByTestId('bmp-route-detail-loading')).toBeVisible();
        await expect(modal.getByTestId('bmp-route-detail-raw-json')).toHaveCount(0);
        const method = view === 'session' ? 'getBgpRouteDetail' : 'getBgpInstanceRouteDetail';
        await expect.poll(() => calls.filter(call => call.method === method).length).toBe(1);
        const request = calls.find(call => call.method === method).args[0];
        expect(request.routeKey).toBe(fullRoutes[0].routeKey);
        expect(request.client.persistentSourceId).toBe(CLIENT.persistentSourceId);
        release();

        const overview = modal.getByTestId('bmp-route-detail-overview');
        await expect(overview).toBeVisible();
        await expect(overview).toContainText('203.0.113.0');
        await expect(overview).toContainText('192.0.2.254');
        await expect(overview).toContainText(CLIENT.sysName);
        await expect(overview).toContainText('192.0.2.2');
        await expect(overview).toContainText(view === 'session' ? 'Pre-policy Adj-RIB-In' : 'Loc-RIB');
        await expect(overview).toContainText('global');
        await expect(modal.getByTestId('bmp-route-detail-raw-json')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath(`${view}-route-overview.png`), fullPage: true });

        await modal.getByRole('tab', { name: 'BGP 属性', exact: true }).click();
        const attributes = modal.getByTestId('bmp-route-detail-attributes');
        await expect(attributes).toBeVisible();
        for (const value of [
            'IGP（本 AS 内部起源）',
            '65000 → 65101',
            '65010',
            '192.0.2.10',
            'NO_EXPORT',
            'NO_ADVERTISE',
            'NO_EXPORT_SUBCONFED',
            '65000:100',
            '65000:200:300',
            '65000:400',
            '65000:500',
            '192.0.2.9',
            '192.0.2.11',
            '192.0.2.12'
        ]) {
            await expect(attributes).toContainText(value);
        }
        await expect(attributes).not.toContainText('[object Object]');
        await expect(attributes.locator('.nn-table')).toHaveCount(0);
        const unknown = attributes.getByTestId('bmp-route-detail-attribute-card').filter({ hasText: '99' });
        await expect(unknown).toHaveCount(1);
        await expect(unknown.locator('details')).not.toHaveAttribute('open');
        await unknown.getByText('查看原始内容', { exact: true }).click();
        await expect(unknown.locator('code')).toHaveText('deadbeef');
        await unknown.getByText('查看原始内容', { exact: true }).click();
        await expect(unknown.locator('details')).not.toHaveAttribute('open');
        await expect(attributes.locator('.nn-json-viewer')).toHaveCount(0);
        await attributes.evaluate(panel => {
            panel.scrollTop = 0;
        });
        await page.screenshot({ path: testInfo.outputPath(`${view}-route-attributes.png`), fullPage: true });

        await modal.getByRole('tab', { name: 'NLRI / TLV', exact: true }).click();
        await expect(modal.getByTestId('bmp-route-detail-nlri')).toContainText('203.0.113.0/24');

        await expectOriginalJson(modal, fullRoutes[0], false);
        await modal.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(modal).toBeHidden();
        await expect(modal.getByTestId('bmp-route-detail-raw-json')).toHaveCount(0);
        await expect(detailButton).toBeFocused();

        await detailButton.click();
        await expect.poll(() => calls.filter(call => call.method === method).length).toBe(2);
        await expect(modal.getByTestId('bmp-route-detail-overview')).toBeVisible();
        await modal.getByRole('tab', { name: 'BGP 属性', exact: true }).click();
        await expect(modal.getByTestId('bmp-route-detail-attributes')).toContainText('65000 → 65102');
        await expectOriginalJson(modal, fullRoutes[1]);
        await page.keyboard.press('Escape');
        await expect(modal).toBeHidden();
    });
}

test('Route Lens opens the shared modal and preserves route plus client/session context', async ({
    page
}, testInfo) => {
    const { lensRecord } = await installMock(page, 'session');
    Object.assign(lensRecord.route, evpnRoute());
    await page.goto('/#/bmp/route-lens');
    await page.getByTestId('route-lens-query').fill('203.0.113.0/24');
    await page.getByTestId('route-lens-search').click();
    await page.getByTestId('route-lens-route-card').click();
    const modal = page.getByTestId('bmp-route-detail-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.nn-modal-title')).toContainText('EVPN MAC/IP 路由');
    await expect(modal.locator('.nn-modal-title')).not.toContainText('evpn:mac-ip:');
    await expect(modal).toHaveClass(/(^|\s)nn-modal(\s|$)/u);
    await expect(modal.getByTestId('bmp-route-detail-overview')).toContainText(CLIENT.sysName);
    await expect(modal.getByTestId('bmp-route-detail-overview')).toContainText(SESSION.sessionIp);
    await expectOriginalJson(modal, lensRecord);
    await modal.getByRole('tab', { name: 'NLRI / TLV', exact: true }).click();
    const nlri = modal.getByTestId('bmp-route-detail-nlri');
    for (const value of ['MAC/IP Advertisement', 'aa:bb:cc:dd:ee:01', '192.0.2.11', 'VNI 10000', 'VXLAN']) {
        await expect(nlri).toContainText(value);
    }
    await expect(nlri).not.toContainText('raw:');
    await nlri.evaluate(panel => {
        panel.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath('route-lens-route-details.png'), fullPage: true });
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(modal).toBeHidden();
    await page.locator('.diff-card').click();
    const diffDrawer = page.getByRole('dialog', { name: 'Inbound 属性差异', exact: true });
    await expect(diffDrawer).toBeVisible();
    await expect(diffDrawer).toHaveClass(/(^|\s)nn-drawer-content(\s|$)/u);
    await expect(diffDrawer).toContainText('route-modal-diff');
    await expect(modal).toBeHidden();
    await diffDrawer.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByTestId('route-lens-route-card').click();
    await expect(modal.getByTestId('bmp-route-detail-overview')).toBeVisible();
    await expect(page.locator('.nn-drawer-content:visible')).toHaveCount(0);
});

test('keeps every community accessible through tags and in the original JSON', async ({ page }, testInfo) => {
    const { fullRoutes, release } = await installMock(page, 'session');
    Object.assign(
        fullRoutes[0],
        richAttributes(
            1,
            Array.from({ length: 45 }, (_, index) => 65000 * 65536 + 500 + index)
        )
    );
    release();
    const clientKey = encodeURIComponent(`source:${CLIENT.persistentSourceId}`);
    await page.goto(`/#/monitor/bmp-client?clientKey=${clientKey}&view=session`);
    await page.getByTestId('bmp-session-route-detail').click();
    const modal = page.getByTestId('bmp-route-detail-modal');
    await modal.getByRole('tab', { name: 'BGP 属性', exact: true }).click();
    const communities = modal.getByTestId('bmp-route-detail-attribute-card').filter({
        has: page.getByRole('heading', { name: '标准 Community', exact: true })
    });
    await expect(communities).toHaveCount(1);
    await expect(communities.locator('.community-tags .nn-tag')).toHaveCount(8);
    await expect(communities).not.toContainText('65000:544');
    const toggle = communities.getByTestId('bmp-route-detail-tags-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(communities.locator('.community-tags .nn-tag')).toHaveCount(45);
    for (let index = 0; index < 45; index++) await expect(communities).toContainText(`65000:${500 + index}`);
    await page.screenshot({ path: testInfo.outputPath('route-community-expanded.png'), fullPage: true });
    await toggle.click();
    await expect(communities.locator('.community-tags .nn-tag')).toHaveCount(8);
    await expectOriginalJson(modal, fullRoutes[0]);
});
