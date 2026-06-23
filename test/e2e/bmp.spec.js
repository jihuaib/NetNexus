const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BmpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');

const MOCK_BASE_ROUTE_COUNT = 12;
const EXPECTED_PUBLIC_ROUTE_COUNT = MOCK_BASE_ROUTE_COUNT + 1;
const EXPECTED_LOC_RIB_ROUTE_COUNT = Math.max(8, Math.min(25, MOCK_BASE_ROUTE_COUNT)) + 1;
const EXPECTED_ADJ_RIB_STATS_ROUTE_COUNT = MOCK_BASE_ROUTE_COUNT;

async function recordStep(title) {
    await test.step(title, async () => {});
}

function formatRouteStep(route, index) {
    return [
        `${index}. ${route.prefix}`,
        `nextHop=${route.nextHop || '(none)'}`,
        `asPath=${route.asPath || '(none)'}`,
        `rd=${route.rd || '0:0'}`,
        `pathId=${route.pathId}`,
        `state=${route.routeState}`,
        `status=${route.pathStatusText || '(none)'}`,
        `routeKey=${route.routeKey}`
    ].join(' | ');
}

function expectPublicAdjRibRoute(route) {
    expect(
        route.ip.startsWith('10.10.') || route.ip === '203.0.118.0',
        `unexpected Adj-RIB route prefix ${route.prefix}`
    ).toBe(true);
}

function expectPublicLocRibRoute(route) {
    expect(
        route.ip.startsWith('10.30.') || route.ip === '198.51.101.0',
        `unexpected Loc-RIB route prefix ${route.prefix}`
    ).toBe(true);
}

test.describe('BMP pages', () => {
    let controller;

    test.beforeEach(async ({ page }) => {
        controller = new BmpE2eController();

        await page.exposeFunction('__bmpE2eCall', (method, ...args) => controller.call(method, ...args));
        controller.onEvent(event => {
            page.evaluate(({ type, data }) => window.__bmpE2eEmit?.(type, data), event).catch(() => {});
        });

        await page.addInitScript({ content: getBrowserMockScript('bmp') });
    });

    test.afterEach(async () => {
        if (!controller) {
            return;
        }

        await controller.cleanup();
    });

    test('starts BMP server, ingests mock client data, and renders BMP tabs', async ({ page }) => {
        let bmpPort;

        await test.step('Allocate a free BMP port and open the BMP config page', async () => {
            await recordStep('Input: route=/#/bmp/bmp-config, bindHost=127.0.0.1, port=auto');

            bmpPort = await BmpE2eController.getFreePort();
            controller.record('allocated BMP port', { port: bmpPort });

            await page.goto('/#/bmp/bmp-config');
            await expect(page.getByTestId('bmp-config-page')).toBeVisible();

            await recordStep(`Output: allocatedPort=${bmpPort}, pageVisible=true`);
        });

        await test.step('Start the BMP server from the UI', async () => {
            await recordStep(`Input: port=${bmpPort}, bmpV4TlvDraft=draft-20, auth=false`);

            await page.getByTestId('bmp-port-input').fill(String(bmpPort));
            await page.getByTestId('bmp-start-button').click();
            await expect(page.getByTestId('bmp-stop-button')).toBeEnabled();

            await recordStep(`Output: BMP TCP server started on 127.0.0.1:${bmpPort}, stopButtonEnabled=true`);
        });

        await test.step('Run scripts/mockBmpClient.js and wait for parsed BMP data', async () => {
            await recordStep(
                `Input: script=scripts/mockBmpClient.js, host=127.0.0.1, port=${bmpPort}, routes=${MOCK_BASE_ROUTE_COUNT}, interval=0`
            );

            await controller.startMockClient({ routes: MOCK_BASE_ROUTE_COUNT, interval: 0 });
            await controller.waitForMockData({ routes: EXPECTED_PUBLIC_ROUTE_COUNT });

            const snapshot = controller.lastRouteQuerySnapshot;
            expect(snapshot).toBeTruthy();
            await recordStep(
                `Output: client=${snapshot.adjRib.client.sysName}, sessionRoutes=${snapshot.adjRib.total}, locRibRoutes=${snapshot.locRib.total}`
            );
        });

        await test.step('Verify BMP config page client table', async () => {
            await recordStep('Input: expectedClient=mock-bmp-router, expectedDescription=NetNexus local BMP mock data');

            const clientTable = page.getByTestId('bmp-client-table');
            await expect(clientTable).toContainText('mock-bmp-router', { timeout: 10000 });
            await expect(clientTable).toContainText('NetNexus local BMP mock data');
            await expect(clientTable).toContainText('BMPv4');
            await expect(clientTable).toContainText('draft-20');

            await recordStep('Output: clientTable contains mock-bmp-router, BMPv4, draft-20');
        });

        await test.step('Verify BGP session page and Adj-RIB routes', async () => {
            await recordStep(
                `Input: route=/#/bmp/bgp-session, expectedSession=192.0.2.2 AS 65000, routeState=all, expectedRoutes=${EXPECTED_PUBLIC_ROUTE_COUNT}`
            );

            await page.goto('/#/bmp/bgp-session');
            await expect(page.getByTestId('bmp-session-page')).toBeVisible();

            const sessionTable = page.getByTestId('bmp-session-table');
            await expect(sessionTable).toContainText('192.0.2.2', { timeout: 10000 });
            await expect(sessionTable).toContainText('65000');
            await expect(sessionTable).toContainText('Peer Up');

            const sessionRouteTable = page.getByTestId('bmp-session-route-table');
            await expect(sessionRouteTable).toContainText('10.10.0.0', { timeout: 10000 });
            await expect(sessionRouteTable).toContainText('192.0.2.254');
            await expect(sessionRouteTable).toContainText('65000 65100');
            await expect(page.getByText(`当前 ${EXPECTED_PUBLIC_ROUTE_COUNT}`)).toBeVisible();

            const snapshot = controller.lastRouteQuerySnapshot;
            expect(snapshot).toBeTruthy();
            expect(snapshot.adjRib.total).toBe(EXPECTED_PUBLIC_ROUTE_COUNT);
            await recordStep(
                `Output: session=${snapshot.adjRib.session.sessionIp} AS ${snapshot.adjRib.session.sessionAs}, totalRoutes=${snapshot.adjRib.total}`
            );

            for (const [index, route] of snapshot.adjRib.routes.entries()) {
                await test.step(`Output Adj-RIB route ${formatRouteStep(route, index + 1)}`, async () => {
                    expectPublicAdjRibRoute(route);
                    expect(route.nextHop).toBe('192.0.2.254');
                    expect(route.asPath).toBe('65000 65100');
                    expect(route.routeState).toBe('active');
                });
            }
        });

        await test.step('Verify BGP Loc-RIB page and Loc-RIB routes', async () => {
            await recordStep(
                `Input: route=/#/bmp/bgp-loc-rib, expectedInstance=global Local RIB, routeState=all, expectedRoutes=${EXPECTED_LOC_RIB_ROUTE_COUNT}`
            );

            await page.goto('/#/bmp/bgp-loc-rib');
            await expect(page.getByTestId('bmp-loc-rib-page')).toBeVisible();

            const locRibInstanceTable = page.getByTestId('bmp-loc-rib-instance-table');
            await expect(locRibInstanceTable).toContainText('global', { timeout: 10000 });
            await expect(locRibInstanceTable).toContainText('Local RIB');

            const locRibRouteTable = page.getByTestId('bmp-loc-rib-route-table');
            await expect(locRibRouteTable).toContainText('10.30.0.0', { timeout: 10000 });
            await expect(locRibRouteTable).toContainText('0.0.0.0');
            await expect(page.getByText(`当前 ${EXPECTED_LOC_RIB_ROUTE_COUNT}`)).toBeVisible();

            const snapshot = controller.lastRouteQuerySnapshot;
            expect(snapshot).toBeTruthy();
            expect(snapshot.locRib.total).toBe(EXPECTED_LOC_RIB_ROUTE_COUNT);
            await recordStep(
                `Output: instance=${snapshot.locRib.instance.vrfTableNames.join(',')}, totalRoutes=${snapshot.locRib.total}`
            );

            for (const [index, route] of snapshot.locRib.routes.entries()) {
                await test.step(`Output Loc-RIB route ${formatRouteStep(route, index + 1)}`, async () => {
                    expectPublicLocRibRoute(route);
                    expect(route.nextHop).toBe('0.0.0.0');
                    expect(route.asPath).toBe('65000');
                    expect(route.routeState).toBe('active');
                });
            }
        });

        await test.step('Verify BGP session statistics page', async () => {
            await recordStep('Input: route=/#/bmp/bgp-session-statis-report, expectedSession=192.0.2.2 | AS 65000');

            await page.goto('/#/bmp/bgp-session-statis-report');
            await expect(page.getByText('192.0.2.2 | AS 65000')).toBeVisible({ timeout: 10000 });
            await expect(page.getByText(String(EXPECTED_ADJ_RIB_STATS_ROUTE_COUNT)).first()).toBeVisible();

            await recordStep(`Output: session statistics visible, routeCount=${EXPECTED_ADJ_RIB_STATS_ROUTE_COUNT}`);
        });

        await test.step('Verify BGP Loc-RIB statistics page', async () => {
            await recordStep('Input: route=/#/bmp/bgp-loc-rib-statis-report, expectedInstance=global');

            await page.goto('/#/bmp/bgp-loc-rib-statis-report');
            await expect(page.getByText('global').first()).toBeVisible({ timeout: 10000 });
            await expect(page.getByText(String(EXPECTED_LOC_RIB_ROUTE_COUNT)).first()).toBeVisible();

            await recordStep(`Output: Loc-RIB statistics visible, routeCount=${EXPECTED_LOC_RIB_ROUTE_COUNT}`);
        });

        await test.step('Stop BMP server from UI and verify the mock client is disconnected', async () => {
            await recordStep('Input: click BMP stop button while mock client keeps its TCP connection open');

            await page.goto('/#/bmp/bmp-config');
            await expect(page.getByTestId('bmp-stop-button')).toBeEnabled();
            await page.getByTestId('bmp-stop-button').click();

            const exitInfo = await controller.waitForMockClientExit({ timeout: 5000 });
            expect(exitInfo.code).toBe(0);
            expect(exitInfo.signal).toBeNull();
            expect(exitInfo.output).toContain('BMP mock connection closed');

            await expect(page.getByTestId('bmp-stop-button')).toBeDisabled();
            await expect(page.getByTestId('bmp-client-table')).not.toContainText('mock-bmp-router');

            await recordStep(`Output: stopButtonDisabled=true, mockClientExitCode=${exitInfo.code}, socketClosed=true`);
        });
    });

    test('removes BMP client and BGP session from the UI when the client disconnects', async ({ page }) => {
        const bmpPort = await BmpE2eController.getFreePort();

        await test.step('Start BMP server and connect mock client', async () => {
            await recordStep(`Input: route=/#/bmp/bmp-config, port=${bmpPort}, routes=${MOCK_BASE_ROUTE_COUNT}`);

            await page.goto('/#/bmp/bmp-config');
            await expect(page.getByTestId('bmp-config-page')).toBeVisible();
            await page.getByTestId('bmp-port-input').fill(String(bmpPort));
            await page.getByTestId('bmp-start-button').click();
            await expect(page.getByTestId('bmp-stop-button')).toBeEnabled();

            await controller.startMockClient({ routes: MOCK_BASE_ROUTE_COUNT, interval: 0 });
            await controller.waitForMockData({ routes: EXPECTED_PUBLIC_ROUTE_COUNT });

            await expect(page.getByTestId('bmp-client-table')).toContainText('mock-bmp-router', {
                timeout: 10000
            });

            await recordStep('Output: BMP mock client visible in config page');
        });

        await test.step('Verify BGP session is visible before client disconnect', async () => {
            await recordStep('Input: route=/#/bmp/bgp-session, expectedSession=192.0.2.2');

            await page.goto('/#/bmp/bgp-session');
            await expect(page.getByTestId('bmp-session-page')).toBeVisible();
            await expect(page.getByTestId('bmp-session-page')).toContainText('192.0.2.2', { timeout: 10000 });
            await expect(page.getByTestId('bmp-session-page')).toContainText('10.10.0.0', { timeout: 10000 });

            await recordStep('Output: BGP session and route are visible before disconnect');
        });

        await test.step('Disconnect mock BMP client and verify UI removes the session', async () => {
            await recordStep('Input: mock BMP client sends TCP FIN while BMP server keeps running');

            const exitInfo = await controller.disconnectMockClient({ timeout: 5000 });
            expect(exitInfo.code).toBe(0);
            expect(exitInfo.signal).toBeNull();

            await expect(page.getByTestId('bmp-session-page')).not.toContainText('192.0.2.2', {
                timeout: 10000
            });
            await expect(page.getByTestId('bmp-session-page')).not.toContainText('10.10.0.0');

            await page.goto('/#/bmp/bmp-config');
            await expect(page.getByTestId('bmp-client-table')).not.toContainText('mock-bmp-router', {
                timeout: 10000
            });

            await recordStep('Output: BMP client table and BGP session page no longer show the disconnected client');
        });
    });
});
