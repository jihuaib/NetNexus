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

async function installBmpStatisticsMock(page, client) {
    const calls = [];
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        calls.push({ method, args });
        switch (method) {
            case 'getClientList':
                return success([client]);
            case 'getBgpStatisticsReports':
                return success(initialSessionReports(client));
            case 'getBgpInstanceStatisticsReports':
                return success([instanceReport(client)]);
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

test('loads one Client statistics and switches between unified monitor tabs', async ({ page }) => {
    const calls = await installBmpStatisticsMock(page, OFFLINE_CLIENT);

    await page.goto(getMonitorUrl('session-statistics'));
    await expectUnifiedMonitor(page, 'session-statistics');
    const sessionPage = page.getByTestId('bmp-session-statistics-page');
    await expect(sessionPage).toBeVisible();
    const sessionPanel = await openSessionPanel(sessionPage);
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
