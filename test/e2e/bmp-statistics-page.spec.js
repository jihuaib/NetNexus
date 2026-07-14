const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

const SOURCE_ID = 'statistics-source';
const CONNECTION_ID = 'statistics-connection';

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

const sessionReport = (client, value = 42) => ({
    client,
    session: SESSION,
    statistics: [{ type: 0, typeName: 'Adj-RIB-In 路由数', value }],
    tlvs: [],
    updatedAt: '2026-07-15T00:00:00.000Z'
});

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
                return success([sessionReport(client)]);
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

test('restores offline Session and Loc-RIB statistics with stable source queries', async ({ page }) => {
    const calls = await installBmpStatisticsMock(page, OFFLINE_CLIENT);

    await page.goto('/#/bmp/bgp-session-statis-report');
    const sessionPage = page.getByTestId('bmp-session-statistics-page');
    await expect(sessionPage.getByTestId('bmp-statistics-client-status')).toHaveText('已断开');
    await expectStatistic(sessionPage, 'Adj-RIB-In 路由数', 42);

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
    await expect(locRibPage.getByTestId('bmp-statistics-client-status')).toHaveText('已断开');
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
    await expect(sessionPage.getByTestId('bmp-statistics-client-status')).toHaveText('已连接');
    await expectStatistic(sessionPage, 'Adj-RIB-In 路由数', 42);

    await emitBmpEvent(page, 'bmp:initiation', RECONNECTED_CLIENT);
    await emitBmpEvent(page, 'bmp:statisticsReport', sessionReport(RECONNECTED_CLIENT, 99));
    await expect(sessionPage.getByTestId('bmp-statistics-client-tab-label')).toHaveCount(1);
    await expectStatistic(sessionPage, 'Adj-RIB-In 路由数', 99);

    await emitBmpEvent(page, 'bmp:termination', RECONNECTED_CLIENT);
    await expect(sessionPage.getByTestId('bmp-statistics-client-status')).toHaveText('已断开');
    await expectStatistic(sessionPage, 'Adj-RIB-In 路由数', 99);

    await page.goto('/#/bmp/bgp-loc-rib-statis-report');
    const locRibPage = page.getByTestId('bmp-loc-rib-statistics-page');
    await expect(locRibPage.getByTestId('bmp-statistics-client-status')).toHaveText('已连接');
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 17);

    await emitBmpEvent(page, 'bmp:initiation', RECONNECTED_CLIENT);
    await emitBmpEvent(page, 'bmp:statisticsReport', instanceReport(RECONNECTED_CLIENT, 88));
    await expect(locRibPage.getByTestId('bmp-statistics-client-tab-label')).toHaveCount(1);
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 88);

    await emitBmpEvent(page, 'bmp:termination', RECONNECTED_CLIENT);
    await expect(locRibPage.getByTestId('bmp-statistics-client-status')).toHaveText('已断开');
    await expectStatistic(locRibPage, 'Loc-RIB 路由数', 88);
});
