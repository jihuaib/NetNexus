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
    const attributes = richAttributes(revision);
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
        ...attributes,
        pathAttributes: [...attributes.pathAttributes, { typeCode: 250, rawValueHex: 'CAFEBABE' }],
        nlriDetail: { pathId: 0, prefix: '203.0.113.0', length: 24, valid: true, rawNlri: 'A1B2C3D4' },
        routeTlvs: [
            {
                name: 'Path Marking',
                rawValueHex: 'BAD0C0DE',
                appliedNlriIndex: 0,
                decoded: {
                    sequenceNumber: 100 + revision,
                    statusNames: ['有效', '最佳路径'],
                    reasonName: '策略通过',
                    indexes: [0]
                }
            }
        ],
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

async function expectParsedOnly(dialog) {
    await expect(dialog.getByRole('tab')).toHaveText(['路由概览', 'BGP 属性', 'NLRI / TLV', '原始数据']);
    await expect(dialog.getByTestId('bmp-route-detail-raw-json')).toHaveCount(0);
    await expect(dialog.getByTestId('bmp-route-detail-tags-toggle')).toHaveCount(0);
    await expect(dialog.locator('.nn-json-viewer, details, summary, .raw-content')).toHaveCount(0);
    await expect(dialog.locator('.readable-card, .nn-card')).toHaveCount(0);
    const overview = dialog.getByTestId('bmp-route-detail-overview');
    if ((await overview.count()) === 1) {
        await expectOverviewTemplate(overview);
        await expect(dialog.locator('.summary-card')).toHaveCount(4);
    } else {
        await expect(dialog.locator('.summary-card')).toHaveCount(0);
    }
    for (const rawContent of ['deadbeef', 'CAFEBABE', 'A1B2C3D4', 'BAD0C0DE', 'full-response-v']) {
        await expect(dialog).not.toContainText(rawContent, { ignoreCase: true });
    }
    await expect(dialog).not.toContainText('查看原始内容');
    await expect(dialog).not.toContainText('原始编码');
    await expect(dialog).not.toContainText('[object Object]');
}

async function expectOverviewTemplate(overview) {
    const identity = overview.locator('.route-identity');
    await expect(identity).toBeVisible();
    await expect(identity.locator('.route-family')).not.toHaveText('');
    await expect(identity.locator('h3')).not.toHaveText('');
    await expect(identity.locator('p')).toContainText(CLIENT.sysName);
    const summaryCards = overview.locator('.summary-grid > .summary-card');
    await expect(summaryCards).toHaveCount(4);
    await expect(summaryCards.locator('.summary-label')).toHaveText([
        '路由状态',
        '解析状态',
        '路径状态信息',
        '路由属性'
    ]);
    await expect(summaryCards.nth(0)).toContainText('过期');
    await expect(summaryCards.nth(1)).toContainText('正常');
    await expect(summaryCards.nth(2)).toContainText('观测缺失');
    await expect(summaryCards.nth(3).locator('strong')).toHaveText(/^[1-9]\d*$/u);
    const sourceTable = overview.locator('.overview-table');
    await expect(sourceTable.locator('tbody tr')).toHaveCount(5);
    await expect(sourceTable.locator('tbody tr > .nn-table-cell:first-child')).toHaveText([
        'RIB 阶段',
        'VRF / RD',
        'BMP Client',
        'Peer / 实例地址',
        'Peer / 实例 AS'
    ]);
    for (const duplicateField of ['下一跳', '本地优先级', 'MED', 'AS 路径（生效）']) {
        await expect(overview.getByText(duplicateField, { exact: true })).toHaveCount(0);
    }
    const evidence = overview.locator('.evidence-alert');
    await expect(evidence).toBeVisible();
    await expect(evidence).toContainText('Path Marking：观测缺失');
}

async function expectOriginalJson(dialog, expected, restoreOverview = true) {
    const rawJson = dialog.getByTestId('bmp-route-detail-raw-json');
    await expect(rawJson).toHaveCount(0);
    await dialog.getByRole('tab', { name: '原始数据', exact: true }).click();
    await expect(rawJson).toBeVisible();
    expect(JSON.parse(await rawJson.locator('pre code').textContent())).toEqual(expected);
    const expectedRoute = expected.route || expected;
    for (const attribute of ['nextHop', 'asPath']) {
        if (typeof expectedRoute[attribute] === 'string' && expectedRoute[attribute]) {
            await expect(rawJson).toContainText(expectedRoute[attribute]);
        }
    }
    const serialized = JSON.stringify(expected);
    for (const rawContent of ['CAFEBABE', 'A1B2C3D4', 'BAD0C0DE']) {
        if (serialized.includes(rawContent)) {
            await expect(rawJson).toContainText(rawContent);
        }
    }
    if (restoreOverview) {
        await dialog.getByRole('tab', { name: '路由概览', exact: true }).click();
        await expect(rawJson).toHaveCount(0);
        await expectParsedOnly(dialog);
    }
}

async function expectDetailTables(panel, overview = false) {
    const tables = panel.getByRole('table');
    await expect(tables).not.toHaveCount(0);
    for (let index = 0; index < (await tables.count()); index += 1) {
        const table = tables.nth(index);
        await expect(table).toBeVisible();
        if (overview && index === 0) {
            await expect(table.locator('thead th')).toHaveText(['信息', '内容']);
        } else {
            const columns = await table.locator('thead th').allTextContents();
            expect(columns.map(column => column.trim())).toEqual([
                expect.stringMatching(/^(属性|分组)$/u),
                '字段',
                '解析结果'
            ]);
        }
    }
}

for (const view of ['session', 'loc-rib']) {
    test(`${view} opens complete parsed route tables and refreshes the details on reopen`, async ({
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
        await expectDetailTables(overview, true);
        await expect(overview.locator('.route-identity h3')).toHaveText('203.0.113.0/24');
        await expect(overview).not.toContainText('192.0.2.254');
        await expect(overview).not.toContainText('65000 → 65101');
        await expect(overview).toContainText(CLIENT.sysName);
        await expect(overview).toContainText('192.0.2.2');
        await expect(overview).toContainText(view === 'session' ? 'Pre-policy Adj-RIB-In' : 'Loc-RIB');
        await expect(overview).toContainText('global');
        await expectParsedOnly(modal);
        await page.screenshot({
            path: testInfo.outputPath(`${view}-route-overview.png`),
            fullPage: true,
            animations: 'disabled'
        });

        await modal.getByRole('tab', { name: 'BGP 属性', exact: true }).click();
        const attributes = modal.getByTestId('bmp-route-detail-attributes');
        await expect(attributes).toBeVisible();
        await expectDetailTables(attributes);
        for (const value of [
            'IGP（本 AS 内部起源）',
            '65000 → 65101',
            '192.0.2.254',
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
        await expect(attributes.getByRole('row').filter({ hasText: '下一跳' })).toContainText('192.0.2.254');
        await expect(attributes.getByRole('row').filter({ hasText: 'Local Preference' })).toContainText('100');
        await expect(
            attributes.getByRole('row').filter({ hasText: 'MED' }).locator('.nn-table-cell').last()
        ).toHaveText('0');
        const unknown = attributes.getByRole('row').filter({ hasText: '未知路径属性（250）' });
        await expect(unknown).toHaveCount(1);
        await expect(unknown).toContainText('无可读解析结果');
        await expectParsedOnly(modal);
        await attributes.evaluate(panel => {
            panel.scrollTop = 0;
        });
        await page.screenshot({
            path: testInfo.outputPath(`${view}-route-attributes.png`),
            fullPage: true,
            animations: 'disabled'
        });

        await modal.getByRole('tab', { name: 'NLRI / TLV', exact: true }).click();
        const nlri = modal.getByTestId('bmp-route-detail-nlri');
        await expect(nlri).toContainText('203.0.113.0/24');
        await expectDetailTables(nlri);
        const tlvs = modal.getByTestId('bmp-route-detail-tlvs');
        await expect(tlvs).toContainText('Path Marking');
        await expect(tlvs).toContainText('最佳路径');
        await expect(tlvs).toContainText('策略通过');
        await expect(tlvs.getByRole('row').filter({ hasText: '设备上报序号' })).toContainText('101');
        await expectParsedOnly(modal);
        await expectOriginalJson(modal, fullRoutes[0], false);

        await modal.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(modal).toBeHidden();
        await expect(modal.getByTestId('bmp-route-detail-raw-json')).toHaveCount(0);
        await expect(detailButton).toBeFocused();

        await detailButton.click();
        await expect.poll(() => calls.filter(call => call.method === method).length).toBe(2);
        await expect(modal.getByTestId('bmp-route-detail-overview')).toBeVisible();
        await expectDetailTables(modal.getByTestId('bmp-route-detail-overview'), true);
        await modal.getByRole('tab', { name: 'BGP 属性', exact: true }).click();
        await expect(modal.getByTestId('bmp-route-detail-attributes')).toContainText('65000 → 65102');
        await expect(modal.getByTestId('bmp-route-detail-attributes')).not.toContainText('65000 → 65101');
        await expectDetailTables(modal.getByTestId('bmp-route-detail-attributes'));
        await expectParsedOnly(modal);
        await modal.getByRole('tab', { name: 'NLRI / TLV', exact: true }).click();
        await expect(
            modal.getByTestId('bmp-route-detail-tlvs').getByRole('row').filter({ hasText: '设备上报序号' })
        ).toContainText('102');
        await expectParsedOnly(modal);
        await expectOriginalJson(modal, fullRoutes[1], false);
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
    await expectDetailTables(modal.getByTestId('bmp-route-detail-overview'), true);
    await expectParsedOnly(modal);
    await expectOriginalJson(modal, lensRecord);
    await modal.getByRole('tab', { name: 'BGP 属性', exact: true }).click();
    await expectDetailTables(modal.getByTestId('bmp-route-detail-attributes'));
    await expectParsedOnly(modal);
    await modal.getByRole('tab', { name: 'NLRI / TLV', exact: true }).click();
    const nlri = modal.getByTestId('bmp-route-detail-nlri');
    await expectDetailTables(nlri);
    for (const value of ['MAC/IP Advertisement', 'aa:bb:cc:dd:ee:01', '192.0.2.11', 'VNI 10000', 'VXLAN']) {
        await expect(nlri).toContainText(value);
    }
    await expect(nlri).not.toContainText('raw:');
    await expectParsedOnly(modal);
    await nlri.evaluate(panel => {
        panel.scrollTop = 0;
    });
    await page.screenshot({
        path: testInfo.outputPath('route-lens-route-details.png'),
        fullPage: true,
        animations: 'disabled'
    });
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

test('shows every parsed community tag in its table row without expansion', async ({ page }, testInfo) => {
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
    const attributes = modal.getByTestId('bmp-route-detail-attributes');
    await expectDetailTables(attributes);
    const communities = attributes.getByRole('row').filter({ hasText: '标准 Community' });
    await expect(communities).toHaveCount(1);
    await expect(communities.locator('.community-tags .nn-tag')).toHaveCount(45);
    for (let index = 0; index < 45; index++) await expect(communities).toContainText(`65000:${500 + index}`);
    await expectParsedOnly(modal);
    await expect(communities.getByRole('button')).toHaveCount(0);
    await page.screenshot({
        path: testInfo.outputPath('route-community-table.png'),
        fullPage: true,
        animations: 'disabled'
    });
    await expectOriginalJson(modal, fullRoutes[0]);
});

test('wraps parsed route fields in a narrow dark viewport without truncation', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 680, height: 640 });
    await page.addInitScript(() => localStorage.setItem('netnexus.themePreset', 'dark'));
    const { fullRoutes, release } = await installMock(page, 'session');
    const longField = '路由策略评估 · 入站策略处理结果 · 策略匹配后的路由传播限制和下一跳可达性检查结果';
    const parsedValue = '允许向内部邻居传播，下一跳 192.0.2.254 已通过可达性检查';
    fullRoutes[0].routeTlvs[0].decoded.路由策略评估 = {
        入站策略处理结果: {
            策略匹配后的路由传播限制和下一跳可达性检查结果: parsedValue
        }
    };
    release();
    const clientKey = encodeURIComponent(`source:${CLIENT.persistentSourceId}`);
    await page.goto(`/#/monitor/bmp-client?clientKey=${clientKey}&view=session`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('bmp-session-route-detail').click();
    const modal = page.getByTestId('bmp-route-detail-modal');
    await expect(modal).toBeVisible();
    await modal.getByRole('tab', { name: 'NLRI / TLV', exact: true }).click();
    const panel = modal.getByTestId('bmp-route-detail-nlri');
    await expectDetailTables(panel);
    await expectParsedOnly(modal);
    const longFieldRow = panel.getByRole('row').filter({ hasText: longField });
    await expect(longFieldRow).toHaveCount(1);
    await expect(longFieldRow).toContainText(parsedValue);
    const fieldCell = longFieldRow.locator('.nn-table-cell').nth(1);
    await expect(fieldCell).toHaveText(longField);
    await fieldCell.scrollIntoViewIfNeeded();

    const cellStyles = await panel.locator('.nn-table-cell').evaluateAll(cells =>
        cells.map(cell => {
            const style = getComputedStyle(cell);
            return {
                whiteSpace: style.whiteSpace,
                textOverflow: style.textOverflow,
                fontSize: parseFloat(style.fontSize)
            };
        })
    );
    for (const style of cellStyles) {
        expect(style.whiteSpace).toBe('normal');
        expect(style.textOverflow).toBe('clip');
        expect(style.fontSize).toBeLessThanOrEqual(13);
    }
    const fieldGeometry = await fieldCell.evaluate(cell => ({
        height: cell.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(cell).lineHeight),
        horizontalOverflow: cell.scrollWidth - cell.clientWidth
    }));
    expect(fieldGeometry.height).toBeGreaterThan(fieldGeometry.lineHeight * 2);
    expect(fieldGeometry.horizontalOverflow).toBeLessThanOrEqual(1);
    const tableOverflows = await panel
        .locator('.nn-table, table')
        .evaluateAll(tables => tables.map(table => table.scrollWidth - table.clientWidth));
    expect(Math.max(...tableOverflows)).toBeLessThanOrEqual(1);
    const modalGeometry = await modal.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
        };
    });
    expect(modalGeometry.left).toBeGreaterThanOrEqual(0);
    expect(modalGeometry.right).toBeLessThanOrEqual(modalGeometry.viewportWidth);
    expect(modalGeometry.top).toBeGreaterThanOrEqual(0);
    expect(modalGeometry.bottom).toBeLessThanOrEqual(modalGeometry.viewportHeight);
    await page.screenshot({
        path: testInfo.outputPath('route-detail-dark-narrow.png'),
        fullPage: true,
        animations: 'disabled'
    });
    await expectOriginalJson(modal, fullRoutes[0]);
    const overview = modal.getByTestId('bmp-route-detail-overview');
    await expectDetailTables(overview, true);
    const summaryGeometry = await overview.locator('.summary-grid > .summary-card').evaluateAll(cards =>
        cards.map(card => {
            const box = card.getBoundingClientRect();
            return { left: box.left, top: box.top };
        })
    );
    expect(summaryGeometry[0].top).toBeCloseTo(summaryGeometry[1].top, 0);
    expect(summaryGeometry[2].top).toBeCloseTo(summaryGeometry[3].top, 0);
    expect(summaryGeometry[0].left).toBeCloseTo(summaryGeometry[2].left, 0);
    expect(summaryGeometry[1].left).toBeCloseTo(summaryGeometry[3].left, 0);
    expect(summaryGeometry[2].top).toBeGreaterThan(summaryGeometry[0].top);
    await page.screenshot({
        path: testInfo.outputPath('route-overview-dark-narrow.png'),
        fullPage: true,
        animations: 'disabled'
    });
});
