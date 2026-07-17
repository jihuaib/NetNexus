const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

const SOURCE_ID = 'statistics-source';
const CONNECTION_ID = 'statistics-connection';
const SESSION_TAB_NAME = 'global | 192.0.2.2 | 65000';

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
const CLIENT_TAB_LABEL = `${OFFLINE_CLIENT.sysName} · ${OFFLINE_CLIENT.remoteIp}`;

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

async function expectRouteClientTabStyle(page, root, online) {
    const label = root.getByTestId('bmp-statistics-client-tab-label');
    const address = root.getByTestId('bmp-statistics-client-address');
    const status = root.getByTestId('bmp-statistics-client-status');
    const stateClass = online ? 'is-online' : 'is-offline';

    await expect(label).toHaveClass(/(^|\s)client-tab-label(\s|$)/);
    await expect(address).toHaveText(CLIENT_TAB_LABEL);
    await expect(status).toHaveText(online ? '在线' : '已断开');
    await expect(status).toHaveClass(new RegExp(`(^|\\s)client-connection-state(\\s|$)`));
    await expect(status).toHaveClass(new RegExp(`(^|\\s)${stateClass}(\\s|$)`));

    const presentation = await root.locator('.client-tabs').evaluate(clientTabs => {
        const nav = clientTabs.querySelector(':scope > .nn-tabs-nav');
        const labelElement = clientTabs.querySelector('[data-testid="bmp-statistics-client-tab-label"]');
        const addressElement = labelElement.querySelector('.client-tab-address');
        const statusElement = clientTabs.querySelector('[data-testid="bmp-statistics-client-status"]');
        const navStyle = window.getComputedStyle(nav);
        const labelStyle = window.getComputedStyle(labelElement);
        const addressStyle = window.getComputedStyle(addressElement);
        const statusStyle = window.getComputedStyle(statusElement);

        return {
            navWidth: Math.round(nav.getBoundingClientRect().width),
            navFlexBasis: navStyle.flexBasis,
            labelMaxWidth: labelStyle.maxWidth,
            labelFontSize: labelStyle.fontSize,
            labelLineHeight: labelStyle.lineHeight,
            addressFontSize: addressStyle.fontSize,
            addressLineHeight: addressStyle.lineHeight,
            addressTextOverflow: addressStyle.textOverflow,
            addressWhiteSpace: addressStyle.whiteSpace,
            statusFontSize: statusStyle.fontSize,
            statusLineHeight: statusStyle.lineHeight,
            statusColor: statusStyle.color
        };
    });

    expect(presentation).toEqual({
        navWidth: 148,
        navFlexBasis: '148px',
        labelMaxWidth: '132px',
        labelFontSize: '14px',
        labelLineHeight: '22px',
        addressFontSize: '14px',
        addressLineHeight: '22px',
        addressTextOverflow: 'ellipsis',
        addressWhiteSpace: 'nowrap',
        statusFontSize: '12px',
        statusLineHeight: '12px',
        statusColor: online ? 'rgb(56, 158, 13)' : 'rgb(212, 107, 8)'
    });

    const addressWidth = await address.evaluate(element => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth
    }));
    expect(addressWidth.scrollWidth).toBeGreaterThan(addressWidth.clientWidth);

    await address.hover();
    await expect(page.getByRole('tooltip')).toHaveText(CLIENT_TAB_LABEL);
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
}

test('restores offline Session and Loc-RIB statistics with stable source queries', async ({ page }) => {
    const calls = await installBmpStatisticsMock(page, OFFLINE_CLIENT);

    await page.goto('/#/bmp/bgp-session-statis-report');
    const sessionPage = page.getByTestId('bmp-session-statistics-page');
    await expectRouteClientTabStyle(page, sessionPage, false);
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

    await page.goto('/#/bmp/bgp-loc-rib-statis-report');
    const locRibPage = page.getByTestId('bmp-loc-rib-statistics-page');
    await expectRouteClientTabStyle(page, locRibPage, false);
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 17);

    await expect
        .poll(() => calls.find(call => call.method === 'getBgpInstanceStatisticsReports')?.args[0])
        .toMatchObject({
            persistentSourceId: SOURCE_ID,
            sourceId: SOURCE_ID,
            persistentConnectionId: CONNECTION_ID,
            connectionId: CONNECTION_ID
        });
});

test('keeps statistics while a stable source reconnects and then disconnects', async ({ page }) => {
    await installBmpStatisticsMock(page, ONLINE_CLIENT);

    await page.goto('/#/bmp/bgp-session-statis-report');
    const sessionPage = page.getByTestId('bmp-session-statistics-page');
    await expectRouteClientTabStyle(page, sessionPage, true);
    const sessionPanel = await openSessionPanel(sessionPage);
    await expectSelectedRibType(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].label);
    await expectStatistic(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].typeName, 42);

    await emitBmpEvent(page, 'bmp:initiation', RECONNECTED_CLIENT);
    await emitBmpEvent(page, 'bmp:statisticsReport', sessionReport(RECONNECTED_CLIENT, RIB_TYPE.PRE_ADJ_RIB_IN, 99));
    await expect(sessionPage.getByTestId('bmp-statistics-client-tab-label')).toHaveCount(1);
    await expectSelectedRibType(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].label);
    await expectStatistic(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].typeName, 99);

    await emitBmpEvent(page, 'bmp:termination', RECONNECTED_CLIENT);
    await expectRouteClientTabStyle(page, sessionPage, false);
    await expectStatistic(sessionPanel, RIB_TYPE_DETAILS[RIB_TYPE.PRE_ADJ_RIB_IN].typeName, 99);

    await page.goto('/#/bmp/bgp-loc-rib-statis-report');
    const locRibPage = page.getByTestId('bmp-loc-rib-statistics-page');
    await expectRouteClientTabStyle(page, locRibPage, true);
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 17);

    await emitBmpEvent(page, 'bmp:initiation', RECONNECTED_CLIENT);
    await emitBmpEvent(page, 'bmp:statisticsReport', instanceReport(RECONNECTED_CLIENT, 88));
    await expect(locRibPage.getByTestId('bmp-statistics-client-tab-label')).toHaveCount(1);
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 88);

    await emitBmpEvent(page, 'bmp:termination', RECONNECTED_CLIENT);
    await expectRouteClientTabStyle(page, locRibPage, false);
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 88);
});

test('keeps four session RIB stages stable while reports alternate', async ({ page }) => {
    await installBmpStatisticsMock(page, ONLINE_CLIENT);

    await page.goto('/#/bmp/bgp-session-statis-report');
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
