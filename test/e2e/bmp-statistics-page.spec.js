const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

const SOURCE_ID = 'statistics-source';
const CONNECTION_ID = 'statistics-connection';
const CLIENT_KEY = `source:${SOURCE_ID}`;
const SESSION_TAB_NAME = 'global | 192.0.2.2 | 65000';
const MONITOR_TABS = Object.freeze([
    { key: 'session', label: 'BGP 会话' },
    { key: 'loc-rib', label: 'Loc-RIB' },
    { key: 'session-statistics', label: '会话统计' },
    { key: 'loc-rib-statistics', label: 'Loc-RIB 统计' }
]);

const RIB_TYPE = Object.freeze({
    PRE_ADJ_RIB_IN: 1,
    POST_ADJ_RIB_IN: 2,
    PRE_ADJ_RIB_OUT: 4,
    POST_ADJ_RIB_OUT: 5
});

const RIB_TYPE_DETAILS = Object.freeze({
    [RIB_TYPE.PRE_ADJ_RIB_IN]: {
        label: 'Pre Adj RIB In',
        statisticType: 7,
        typeName: 'Pre Adj-RIB-In 路由数',
        initialValue: 42
    },
    [RIB_TYPE.POST_ADJ_RIB_IN]: {
        label: 'Post Adj RIB In',
        statisticType: 7,
        typeName: 'Post Adj-RIB-In 路由数',
        initialValue: 43
    },
    [RIB_TYPE.PRE_ADJ_RIB_OUT]: {
        label: 'Pre Adj RIB Out',
        statisticType: 14,
        typeName: 'Pre Adj-RIB-Out 路由数',
        initialValue: 24
    },
    [RIB_TYPE.POST_ADJ_RIB_OUT]: {
        label: 'Post Adj RIB Out',
        statisticType: 15,
        typeName: 'Post Adj-RIB-Out 路由数',
        initialValue: 25
    }
});

const RIB_TYPE_ORDER = [
    RIB_TYPE.PRE_ADJ_RIB_IN,
    RIB_TYPE.POST_ADJ_RIB_IN,
    RIB_TYPE.PRE_ADJ_RIB_OUT,
    RIB_TYPE.POST_ADJ_RIB_OUT
];

const OFFLINE_CLIENT = {
    persistentSourceId: SOURCE_ID,
    sourceId: SOURCE_ID,
    persistentConnectionId: CONNECTION_ID,
    connectionId: CONNECTION_ID,
    connectionState: 'closed',
    isOnline: false,
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.10',
    remotePort: 49152,
    sysName: 'statistics-router'
};

const ONLINE_CLIENT = {
    ...OFFLINE_CLIENT,
    connectionState: 'open',
    isOnline: true
};

const RECONNECTED_CLIENT = {
    ...ONLINE_CLIENT,
    persistentConnectionId: 'statistics-connection-2',
    connectionId: 'statistics-connection-2',
    remotePort: 49153
};

const OTHER_CLIENT = {
    ...ONLINE_CLIENT,
    persistentSourceId: 'other-statistics-source',
    sourceId: 'other-statistics-source',
    persistentConnectionId: 'other-statistics-connection',
    connectionId: 'other-statistics-connection',
    remoteIp: '198.51.100.10',
    remotePort: 49200,
    sysName: 'other-statistics-router'
};

const SESSION = {
    persistentSourceId: SOURCE_ID,
    persistentOwnerKey: 'statistics-session-owner',
    sessionType: 0,
    sessionRd: '0:0',
    sessionIp: '192.0.2.2',
    sessionAs: 65000
};

const INSTANCE = {
    persistentSourceId: SOURCE_ID,
    persistentOwnerKey: 'statistics-instance-owner',
    instanceType: 3,
    instanceRd: '0:0',
    instanceIp: '0.0.0.0',
    instanceAs: 0,
    vrfTableNames: ['global']
};

const sessionReport = (client, ribType = RIB_TYPE.PRE_ADJ_RIB_IN, value) => {
    const detail = RIB_TYPE_DETAILS[ribType];
    return {
        client,
        session: SESSION,
        ribType,
        statistics: [
            {
                type: detail.statisticType,
                typeName: detail.typeName,
                value: value ?? detail.initialValue
            }
        ],
        tlvs: [],
        updatedAt: '2026-07-15T00:00:00.000Z'
    };
};

const initialSessionReports = client => RIB_TYPE_ORDER.map(ribType => sessionReport(client, ribType));

const instanceReport = (client, value = 17) => ({
    client,
    instance: INSTANCE,
    statistics: [{ type: 8, typeName: 'Loc-RIB 路由数', afi: 1, safi: 1, value }],
    tlvs: [],
    updatedAt: '2026-07-15T00:00:00.000Z'
});

const success = data => ({ status: 'success', data });

function withReportDetails(report) {
    const scope = report.session ? 'session' : 'loc-rib';
    const ownerField = report.session ? 'session' : 'instance';
    return {
        ...report,
        [ownerField]: {
            ...report[ownerField],
            diagnosticMarker: `${scope}-statistics-raw-only-${report.ribType ?? 'loc-rib'}`,
            diagnosticEntries: Array.from({ length: 40 }, (_, index) => ({
                index,
                value: `statistics-diagnostic-${index}-` + 'x'.repeat(160)
            }))
        },
        tlvs: [
            { type: 65000, name: 'Fixture report context', valueText: `${scope}-tlv-marker` },
            { type: 65001, name: 'Diagnostic extension', valueText: 'statistics-extension-'.repeat(40) }
        ]
    };
}

async function installBmpStatisticsMock(page, client, { details = false } = {}) {
    const calls = [];
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        calls.push({ method, args });
        switch (method) {
            case 'getClientList':
                return success([client]);
            case 'getBgpStatisticsReports':
                return success(
                    initialSessionReports(client).map(report => (details ? withReportDetails(report) : report))
                );
            case 'getBgpInstanceStatisticsReports':
                return success([details ? withReportDetails(instanceReport(client)) : instanceReport(client)]);
            default:
                return success(null);
        }
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });
    return calls;
}

async function expectStatistic(root, typeName, value) {
    const row = root.locator('tbody tr').filter({ hasText: typeName });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(String(value));
}

async function emitBmpEvent(page, eventName, data) {
    await page.evaluate(
        ({ name, payload }) => {
            window.__bmpE2eEmit(name, { status: 'success', data: payload });
        },
        { name: eventName, payload: data }
    );
}

async function captureStatisticsDetail(page, scope, panel) {
    const screenshotDir = process.env.E2E_BMP_STATISTICS_SCREENSHOT_DIR;
    if (screenshotDir) {
        await page.screenshot({
            path: `${screenshotDir}/bmp-statistics-detail-${scope}-${panel}.png`,
            animations: 'disabled'
        });
    }
}

async function openSessionPanel(page) {
    const tab = page.getByRole('tab', { name: SESSION_TAB_NAME, exact: true });
    await expect(tab).toHaveCount(1);
    await expect(tab).toBeVisible();
    const density = await page.evaluate(root => {
        const card = root.querySelector('.bmp-full-card');
        const nav = root.querySelector('.bmp-inner-tabs > .nn-tabs-nav');
        const innerTab = nav?.querySelector('.nn-tabs-tab');
        const content = root.querySelector('.bmp-inner-tabs > .nn-tabs-content-holder');
        return {
            contentGap:
                nav && content
                    ? Math.round(content.getBoundingClientRect().top - nav.getBoundingClientRect().bottom)
                    : -1,
            tabHeight: innerTab ? Math.round(innerTab.getBoundingClientRect().height) : -1,
            topGap:
                card && innerTab
                    ? Math.round(innerTab.getBoundingClientRect().top - card.getBoundingClientRect().top)
                    : -1
        };
    });
    expect(density.topGap).toBeLessThanOrEqual(4);
    expect(density.tabHeight).toBeLessThanOrEqual(34);
    expect(density.contentGap).toBeLessThanOrEqual(4);
    await tab.click();
    const panel = page.getByRole('tabpanel', { name: SESSION_TAB_NAME, exact: true });
    await expect(panel).toBeVisible();
    return panel;
}

async function expectSelectedRibType(panel, label) {
    const select = panel.getByTestId('bmp-statistics-rib-type-select');
    await expect(select).toBeVisible();
    await expect(select.locator('.nn-select-single-value')).toHaveText(label);
}

async function selectRibType(page, panel, label) {
    const select = panel.getByTestId('bmp-statistics-rib-type-select');
    await select.click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expectSelectedRibType(panel, label);
}

async function expectSessionStatistic(page, sessionRoot, ribType, value) {
    const detail = RIB_TYPE_DETAILS[ribType];
    const panel = await openSessionPanel(sessionRoot);
    await selectRibType(page, panel, detail.label);
    await expectStatistic(panel, detail.typeName, value);
    return panel;
}

function getMonitorUrl(view) {
    return `/#/monitor/bmp-client?clientKey=${encodeURIComponent(CLIENT_KEY)}&view=${view}`;
}

function getMonitorTabNav(page) {
    return page.locator('.bmp-client-monitor-tabs > .nn-tabs-nav').first();
}

async function getCurrentMonitorView(page) {
    return page.evaluate(() => {
        const query = window.location.hash.split('?')[1] || '';
        return new URLSearchParams(query).get('view');
    });
}

async function expectUnifiedMonitor(page, selectedView) {
    const monitor = page.getByTestId('bmp-client-monitor-page');
    const tabNav = getMonitorTabNav(page);
    const selectedTab = MONITOR_TABS.find(tab => tab.key === selectedView);
    await expect(monitor).toBeVisible();
    await expect(tabNav).toBeVisible();
    await expect(tabNav.getByRole('tab')).toHaveCount(MONITOR_TABS.length);

    for (const tabDefinition of MONITOR_TABS) {
        const tab = tabNav.getByRole('tab', { name: tabDefinition.label, exact: true });
        await expect(tab).toHaveCount(1);
        await expect(tab).toHaveAttribute('aria-selected', String(tabDefinition.key === selectedView));
    }

    const density = await monitor.evaluate(root => {
        const nav = root.querySelector('.bmp-client-monitor-tabs > .nn-tabs-nav');
        const tab = nav?.querySelector('.nn-tabs-tab');
        const content = root.querySelector('.bmp-client-monitor-tabs > .nn-tabs-content-holder');
        return {
            contentGap:
                nav && content
                    ? Math.round(content.getBoundingClientRect().top - nav.getBoundingClientRect().bottom)
                    : -1,
            tabHeight: tab ? Math.round(tab.getBoundingClientRect().height) : -1,
            topGap: root.parentElement
                ? Math.round(root.getBoundingClientRect().top - root.parentElement.getBoundingClientRect().top)
                : -1
        };
    });
    expect(density.tabHeight).toBeLessThanOrEqual(34);
    expect(density.contentGap).toBeLessThanOrEqual(4);
    expect(density.topGap).toBeLessThanOrEqual(4);

    await expect(monitor.locator('.client-tabs')).toHaveCount(0);
    await expect.poll(() => getCurrentMonitorView(page)).toBe(selectedView);
    await expect
        .poll(() => page.title())
        .toBe(`${selectedTab.label} · ${OFFLINE_CLIENT.sysName} · ${OFFLINE_CLIENT.remoteIp}`);
    return monitor;
}

async function switchMonitorView(page, view) {
    const tabDefinition = MONITOR_TABS.find(tab => tab.key === view);
    if (!tabDefinition) throw new Error(`Unknown BMP monitor view: ${view}`);
    await getMonitorTabNav(page).getByRole('tab', { name: tabDefinition.label, exact: true }).click();
    return expectUnifiedMonitor(page, view);
}

async function flushRenderer(page) {
    await page.evaluate(
        () =>
            new Promise(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            })
    );
}

async function expectStatisticsRawUsesPanelScroll(panel) {
    const geometry = await panel.evaluate(element => {
        const jsonContent = element.querySelector('.nn-json-viewer-content');
        if (!jsonContent) return null;
        return {
            panelOverflow: element.scrollHeight - element.clientHeight,
            jsonOverflow: jsonContent.scrollHeight - jsonContent.clientHeight
        };
    });
    expect(geometry).not.toBeNull();
    expect(geometry.panelOverflow).toBeGreaterThan(0);
    expect(geometry.jsonOverflow).toBeLessThanOrEqual(1);
    const bottom = await panel.evaluate(element => {
        const viewer = element.querySelector('.nn-json-viewer');
        element.scrollTop = element.scrollHeight - element.clientHeight;
        return {
            remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
            viewerGap: element.getBoundingClientRect().bottom - viewer.getBoundingClientRect().bottom
        };
    });
    expect(Math.abs(bottom.remaining)).toBeLessThanOrEqual(1);
    expect(Math.abs(bottom.viewerGap)).toBeLessThanOrEqual(1);
}

async function expectStatisticsModalFitsViewport(modal, panel) {
    const geometry = await modal.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
            left: rect.left,
            right: rect.right,
            viewportWidth: window.innerWidth,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
            modalOverflow: element.scrollWidth - element.clientWidth
        };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    expect(geometry.modalOverflow).toBeLessThanOrEqual(1);
    const rawOverflow = await panel
        .locator('.nn-json-viewer-content')
        .evaluate(element => element.scrollWidth - element.clientWidth);
    expect(rawOverflow).toBeLessThanOrEqual(1);
    await expect(modal).toBeVisible();
}

test('loads one Client statistics and switches between unified monitor tabs', async ({ page }) => {
    const calls = await installBmpStatisticsMock(page, OFFLINE_CLIENT);

    await page.goto(getMonitorUrl('session-statistics'));
    await expectUnifiedMonitor(page, 'session-statistics');
    const sessionPage = page.getByTestId('bmp-session-statistics-page');
    await expect(sessionPage).toBeVisible();
    const sessionPanel = await openSessionPanel(sessionPage);
    const tabHeights = await page.evaluate(() => {
        const primaryTab = document.querySelector('.bmp-client-monitor-tabs > .nn-tabs-nav .nn-tabs-tab');
        const secondaryTab = document.querySelector('.bmp-inner-tabs > .nn-tabs-nav .nn-tabs-tab');
        return {
            primary: Math.round(primaryTab?.getBoundingClientRect().height || 0),
            secondary: Math.round(secondaryTab?.getBoundingClientRect().height || 0)
        };
    });
    expect(tabHeights.secondary).toBeGreaterThan(0);
    expect(tabHeights.primary).toBeGreaterThan(tabHeights.secondary);
    await expectSelectedRibType(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].label);
    await expectStatistic(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].typeName, 42);

    await expect
        .poll(() => calls.find(call => call.method === 'getBgpStatisticsReports')?.args[0])
        .toMatchObject({
            persistentSourceId: SOURCE_ID,
            sourceId: SOURCE_ID,
            persistentConnectionId: CONNECTION_ID,
            connectionId: CONNECTION_ID
        });

    await switchMonitorView(page, 'loc-rib-statistics');
    const locRibPage = page.getByTestId('bmp-loc-rib-statistics-page');
    await expect(locRibPage).toBeVisible();
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 17);

    await expect
        .poll(() => calls.find(call => call.method === 'getBgpInstanceStatisticsReports')?.args[0])
        .toMatchObject({
            persistentSourceId: SOURCE_ID,
            sourceId: SOURCE_ID,
            persistentConnectionId: CONNECTION_ID,
            connectionId: CONNECTION_ID
        });

    await switchMonitorView(page, 'session-statistics');
    await expectStatistic(page.getByTestId('bmp-session-statistics-page'), 'Pre Adj-RIB-In 路由数', 42);
});

test('ignores other Client events and keeps the monitored Client across reconnects', async ({ page }) => {
    const calls = await installBmpStatisticsMock(page, ONLINE_CLIENT);

    await page.goto(getMonitorUrl('loc-rib-statistics'));
    await expectUnifiedMonitor(page, 'loc-rib-statistics');
    const locRibPage = page.getByTestId('bmp-loc-rib-statistics-page');
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 17);

    await emitBmpEvent(page, 'bmp:statisticsReport', instanceReport(OTHER_CLIENT, 777));
    await flushRenderer(page);
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 17);

    await emitBmpEvent(page, 'bmp:statisticsReport', instanceReport(ONLINE_CLIENT, 88));
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 88);

    await switchMonitorView(page, 'session-statistics');
    const sessionPage = page.getByTestId('bmp-session-statistics-page');
    const sessionPanel = await openSessionPanel(sessionPage);
    await expectSelectedRibType(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].label);
    await expectStatistic(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].typeName, 42);

    await emitBmpEvent(page, 'bmp:initiation', RECONNECTED_CLIENT);
    await expect
        .poll(() => calls.filter(call => call.method === 'getBgpStatisticsReports').at(-1)?.args[0]?.connectionId)
        .toBe(RECONNECTED_CLIENT.connectionId);

    await emitBmpEvent(page, 'bmp:statisticsReport', sessionReport(OTHER_CLIENT, RIB_TYPE.PRE_ADJ_RIB_IN, 777));
    await flushRenderer(page);
    await expectStatistic(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].typeName, 42);

    await emitBmpEvent(page, 'bmp:statisticsReport', sessionReport(RECONNECTED_CLIENT, RIB_TYPE.PRE_ADJ_RIB_IN, 99));
    await expectSelectedRibType(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].label);
    await expectStatistic(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].typeName, 99);

    await emitBmpEvent(page, 'bmp:termination', RECONNECTED_CLIENT);
    await flushRenderer(page);
    await expectStatistic(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].typeName, 99);
});

test('keeps four session RIB stages stable while reports alternate', async ({ page }) => {
    await installBmpStatisticsMock(page, ONLINE_CLIENT);

    await page.goto(getMonitorUrl('session-statistics'));
    await expectUnifiedMonitor(page, 'session-statistics');
    const sessionPage = page.getByTestId('bmp-session-statistics-page');
    const sessionPanel = await openSessionPanel(sessionPage);
    const ribTypeSelect = sessionPanel.getByTestId('bmp-statistics-rib-type-select');

    await ribTypeSelect.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(4);
    await page.getByRole('option', { name: RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].label, exact: true }).click();

    for (const ribType of RIB_TYPE_ORDER) {
        await expectSessionStatistic(page, sessionPage, ribType, RIB_TYPE_DETAILS[ribType].initialValue);
    }

    const latestValues = new Map(RIB_TYPE_ORDER.map(ribType => [ribType, RIB_TYPE_DETAILS[ribType].initialValue]));

    const assertUpdateDoesNotChangeSelection = async (selectedRibType, updatedRibType, value) => {
        const selectedDetail = RIB_TYPE_DETAILS[selectedRibType];
        await selectRibType(page, sessionPanel, selectedDetail.label);
        await emitBmpEvent(page, 'bmp:statisticsReport', sessionReport(ONLINE_CLIENT, updatedRibType, value));
        await expectSelectedRibType(sessionPanel, selectedDetail.label);
        await expectStatistic(sessionPanel, selectedDetail.typeName, latestValues.get(selectedRibType));
        latestValues.set(updatedRibType, value);
    };

    await assertUpdateDoesNotChangeSelection(RIB_TYPE.POST_ADJ_RIB_OUT, RIB_TYPE.PRE_ADJ_RIB_IN, 101);
    await assertUpdateDoesNotChangeSelection(RIB_TYPE.PRE_ADJ_RIB_IN, RIB_TYPE.POST_ADJ_RIB_IN, 102);
    await assertUpdateDoesNotChangeSelection(RIB_TYPE.POST_ADJ_RIB_IN, RIB_TYPE.PRE_ADJ_RIB_OUT, 202);
    await assertUpdateDoesNotChangeSelection(RIB_TYPE.PRE_ADJ_RIB_OUT, RIB_TYPE.POST_ADJ_RIB_OUT, 203);

    for (const ribType of RIB_TYPE_ORDER) {
        await expectSessionStatistic(page, sessionPage, ribType, latestValues.get(ribType));
    }
    await expect(sessionPage.getByRole('tab', { name: SESSION_TAB_NAME, exact: true })).toHaveCount(1);
});

for (const scenario of [
    {
        view: 'session-statistics',
        nextView: 'loc-rib-statistics',
        pageTestId: 'bmp-session-statistics-page',
        ownerField: 'session',
        scope: 'session',
        client: OFFLINE_CLIENT,
        typeName: RIB_TYPE_DETAILS[RIB_TYPE.POST_ADJ_RIB_OUT].typeName,
        value: RIB_TYPE_DETAILS[RIB_TYPE.POST_ADJ_RIB_OUT].initialValue,
        marker: 'session-statistics-raw-only-5'
    },
    {
        view: 'loc-rib-statistics',
        nextView: 'session-statistics',
        pageTestId: 'bmp-loc-rib-statistics-page',
        ownerField: 'instance',
        scope: 'loc-rib',
        client: ONLINE_CLIENT,
        typeName: 'Loc-RIB 路由数',
        value: 17,
        marker: 'loc-rib-statistics-raw-only-loc-rib'
    }
]) {
    test(`${scenario.view} uses the shared categorized detail modal without losing report data`, async ({ page }) => {
        const calls = await installBmpStatisticsMock(page, scenario.client, { details: true });
        await page.goto(getMonitorUrl(scenario.view));
        await expectUnifiedMonitor(page, scenario.view);
        const reportPage = page.getByTestId(scenario.pageTestId);
        let reportPanel = reportPage;
        if (scenario.ownerField === 'session') {
            reportPanel = await openSessionPanel(reportPage);
            await selectRibType(page, reportPanel, RIB_TYPE_DETAILS[RIB_TYPE.POST_ADJ_RIB_OUT].label);
        }
        await expectStatistic(reportPanel, scenario.typeName, scenario.value);
        const callsBeforeDetails = calls.length;
        const detailButton = reportPanel.getByRole('button', { name: '详情', exact: true });
        await detailButton.click();

        const modal = page.getByTestId('bmp-statistics-detail-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toHaveClass(/(^|\s)nn-modal(\s|$)/u);
        await expect(page.locator('.nn-drawer-content:visible')).toHaveCount(0);
        const height = async () => Math.round((await modal.boundingBox())?.height || 0);
        const fixedHeight = await height();
        expect(fixedHeight).toBeGreaterThan(0);
        const overview = modal.getByTestId('bmp-statistics-detail-overview');
        await expect(overview).toBeVisible();
        await expect(overview).toContainText('BMP 连接');
        await expect(overview).toContainText(scenario.client.isOnline ? '在线' : '已断开');
        await expect(overview).toContainText('0:0');
        await expect(overview.locator('.summary-card').filter({ hasText: '统计项目' }).locator('strong')).toHaveText(
            '1'
        );
        await expect(overview.locator('.summary-card').filter({ hasText: 'TLV' }).locator('strong')).toHaveText('2');
        if (scenario.ownerField === 'session') {
            await expect(overview).toContainText('192.0.2.2');
            await expect(overview).toContainText(RIB_TYPE_DETAILS[RIB_TYPE.POST_ADJ_RIB_OUT].label);
        } else {
            await expect(overview).toContainText('global');
        }
        const advanced = modal.getByTestId('bmp-statistics-detail-advanced');
        await expect(advanced.locator('.nn-json-viewer-content')).toHaveCount(0);
        await expect(modal).not.toContainText(scenario.marker);
        await captureStatisticsDetail(page, scenario.scope, 'overview');

        await modal.getByRole('tab', { name: '统计明细', exact: true }).click();
        await expect.poll(height).toBe(fixedHeight);
        const statistics = modal.getByTestId('bmp-statistics-detail-table');
        await expect(statistics).toBeVisible();
        await expectStatistic(statistics, scenario.typeName, scenario.value);
        const latestValue = scenario.value + 100;
        const nextReport =
            scenario.ownerField === 'session'
                ? sessionReport(scenario.client, RIB_TYPE.POST_ADJ_RIB_OUT, latestValue)
                : instanceReport(scenario.client, latestValue);
        await emitBmpEvent(page, 'bmp:statisticsReport', withReportDetails(nextReport));
        await expectStatistic(statistics, scenario.typeName, latestValue);
        if (scenario.ownerField === 'session') {
            await emitBmpEvent(
                page,
                'bmp:statisticsReport',
                withReportDetails(sessionReport(scenario.client, RIB_TYPE.PRE_ADJ_RIB_IN, 777))
            );
            await flushRenderer(page);
            await expectStatistic(statistics, scenario.typeName, latestValue);
            await expectSelectedRibType(reportPanel, RIB_TYPE_DETAILS[RIB_TYPE.POST_ADJ_RIB_OUT].label);
        }
        const otherClientReport =
            scenario.ownerField === 'session'
                ? sessionReport(OTHER_CLIENT, RIB_TYPE.POST_ADJ_RIB_OUT, 888)
                : instanceReport(OTHER_CLIENT, 888);
        await emitBmpEvent(page, 'bmp:statisticsReport', withReportDetails(otherClientReport));
        await flushRenderer(page);
        await expectStatistic(statistics, scenario.typeName, latestValue);
        await modal.getByRole('tab', { name: 'TLV 扩展 (2)', exact: true }).click();
        await expect.poll(height).toBe(fixedHeight);
        const tlvs = modal.getByTestId('bmp-statistics-detail-tlvs');
        await expect(tlvs).toBeVisible();
        await expect(tlvs).toContainText(`${scenario.scope}-tlv-marker`);
        await captureStatisticsDetail(page, scenario.scope, 'tlv');

        await modal.getByRole('tab', { name: '原始数据', exact: true }).click();
        await expect.poll(height).toBe(fixedHeight);
        await expect(advanced).toBeVisible();
        const rawJson = advanced.locator('.nn-json-viewer-content');
        await expect(rawJson).toBeVisible();
        const rawReport = JSON.parse(await rawJson.textContent());
        expect(rawReport[scenario.ownerField].diagnosticMarker).toBe(scenario.marker);
        expect(rawReport.statistics).toHaveLength(1);
        expect(rawReport.statistics[0].typeName).toBe(scenario.typeName);
        expect(rawReport.statistics[0].value).toBe(latestValue);
        expect(rawReport.tlvs).toHaveLength(2);
        expect(rawReport.tlvs[0].valueText).toBe(`${scenario.scope}-tlv-marker`);
        if (scenario.ownerField === 'session') expect(rawReport.ribType).toBe(RIB_TYPE.POST_ADJ_RIB_OUT);
        await captureStatisticsDetail(page, scenario.scope, 'raw');
        await expectStatisticsRawUsesPanelScroll(advanced);
        await page.setViewportSize({ width: 480, height: 720 });
        await flushRenderer(page);
        await expectStatisticsModalFitsViewport(modal, advanced);
        await expectStatisticsRawUsesPanelScroll(advanced);

        await modal.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(modal).toBeHidden();
        await detailButton.click();
        await expect(modal).toBeVisible();
        await expect(modal.getByRole('tab', { name: '统计概览', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await expect(overview).toBeVisible();
        await expect(advanced.locator('.nn-json-viewer-content')).toHaveCount(0);
        await expect(modal).not.toContainText(scenario.marker);
        await modal.getByRole('tab', { name: '统计明细', exact: true }).click();
        await expectStatistic(modal.getByTestId('bmp-statistics-detail-table'), scenario.typeName, latestValue);
        expect(calls).toHaveLength(callsBeforeDetails);

        // The modal mask blocks clicks on the underlying monitor tabs. Change
        // only the hash query to exercise the real KeepAlive deactivation,
        // without reloading the application or its mocked connection.
        await page.evaluate(view => {
            const query = new URLSearchParams(window.location.hash.split('?')[1]);
            query.set('view', view);
            window.location.hash = `/monitor/bmp-client?${query}`;
        }, scenario.nextView);
        await expectUnifiedMonitor(page, scenario.nextView);
        await expect(modal).toBeHidden();
        await switchMonitorView(page, scenario.view);
        await expect(page.getByTestId('bmp-statistics-detail-modal')).toBeHidden();
        await detailButton.click();
        await expect(page.getByTestId('bmp-statistics-detail-modal')).toBeVisible();
        await page.evaluate(sourceId => {
            const query = new URLSearchParams(window.location.hash.split('?')[1]);
            query.set('clientKey', `source:${sourceId}`);
            window.location.hash = `/monitor/bmp-client?${query}`;
        }, OTHER_CLIENT.persistentSourceId);
        await expect(page.getByTestId('bmp-statistics-detail-modal')).toBeHidden();
    });
}
