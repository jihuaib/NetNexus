const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BmpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');

const MOCK_BASE_ROUTE_COUNT = 26;
const EXPECTED_PUBLIC_ROUTE_COUNT = MOCK_BASE_ROUTE_COUNT + 3;
const EXPECTED_LOC_RIB_ROUTE_COUNT = Math.max(8, Math.min(25, MOCK_BASE_ROUTE_COUNT)) + 2;
const EXPECTED_MOCK_READY_ROUTE_COUNT = EXPECTED_LOC_RIB_ROUTE_COUNT;
const EXPECTED_ADJ_RIB_STATS_ROUTE_COUNT = MOCK_BASE_ROUTE_COUNT;
const EXPECTED_CLIENT_NAME = 'demo-bmp-router';
const EXPECTED_CLIENT_DESCRIPTION = 'NetNexus local BMP demo data';

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
        route.ip.startsWith('10.10.') ||
            route.ip === '203.0.118.0' ||
            route.ip === '203.0.126.0' ||
            route.ip === '203.0.128.0',
        `unexpected Adj-RIB route prefix ${route.prefix}`
    ).toBe(true);
}

function expectPublicLocRibRoute(route) {
    expect(
        route.ip.startsWith('10.30.') || route.ip === '198.51.101.0' || route.ip === '198.51.102.0',
        `unexpected Loc-RIB route prefix ${route.prefix}`
    ).toBe(true);
}

async function expectAutoHidingScrollbar(locator) {
    const isActive = () => locator.evaluate(element => element.classList.contains('nn-scrollbar-active'));
    const thumbColor = () =>
        locator.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor);

    await expect.poll(isActive, { timeout: 2500 }).toBe(false);
    await expect.poll(thumbColor).toBe('rgba(0, 0, 0, 0)');

    await locator.dispatchEvent('scroll');
    await expect.poll(isActive).toBe(true);
    await expect.poll(thumbColor).not.toBe('rgba(0, 0, 0, 0)');

    await expect.poll(isActive, { timeout: 2500 }).toBe(false);
    await expect.poll(thumbColor).toBe('rgba(0, 0, 0, 0)');
}

async function expectBmpRouteLayout(page, pageTestId, detailTableTestId, routeTableTestId) {
    const pageRoot = page.getByTestId(pageTestId);
    await expect(pageRoot.locator('.client-tab-label').first()).toHaveText(/\S/);

    const layout = await pageRoot.evaluate(
        (root, testIds) => {
            const clientTabs = root.querySelector('.client-tabs');
            const clientNav = clientTabs?.querySelector(':scope > .nn-tabs-nav');
            const clientNavWrap = clientNav?.querySelector('.nn-tabs-nav-wrap');
            const activeClientTab = clientNav?.querySelector('.nn-tabs-tab-active');
            const activeClientLabel = activeClientTab?.querySelector('.client-tab-label');
            const activeClientPane = clientTabs?.querySelector(
                ':scope > .nn-tabs-content-holder > .nn-tabs-content > .nn-tabs-tabpane-active'
            );
            const innerTabs = activeClientPane?.querySelector('.bmp-inner-tabs');
            const nav = innerTabs?.querySelector(':scope > .nn-tabs-nav');
            const navWrap = nav?.querySelector('.nn-tabs-nav-wrap');
            const navList = nav?.querySelector('.nn-tabs-nav-list');
            const tabs = [...(navList?.querySelectorAll(':scope > .nn-tabs-tab') || [])];
            const activeInnerPane = innerTabs?.querySelector(
                ':scope > .nn-tabs-content-holder > .nn-tabs-content > .nn-tabs-tabpane-active'
            );
            const detailTable = activeInnerPane?.querySelector(`[data-testid="${testIds.detailTableTestId}"]`);
            const routeTable = activeInnerPane?.querySelector(`[data-testid="${testIds.routeTableTestId}"]`);
            const detailContent = detailTable?.querySelector('.nn-table-content');
            const detailLastRow = detailTable?.querySelector('.nn-table-tbody > tr:last-child');
            const detailActionButton = detailTable?.querySelector('.nn-button-link');
            const detailActionCell = detailActionButton?.closest('td');
            const routeContent = routeTable?.querySelector('.nn-table-content');
            const routeRows = [...(routeTable?.querySelectorAll('.nn-table-tbody > .nn-table-row') || [])];
            const contentContainer = root.parentElement;
            const rootRect = root.getBoundingClientRect();
            const contentRect = contentContainer?.getBoundingClientRect();
            const clientNavRect = clientNav?.getBoundingClientRect();
            const activeClientTabRect = activeClientTab?.getBoundingClientRect();
            const activeClientLabelRect = activeClientLabel?.getBoundingClientRect();
            const navRect = nav?.getBoundingClientRect();
            const detailRect = detailTable?.getBoundingClientRect();
            const detailContentRect = detailContent?.getBoundingClientRect();
            const detailLastRowRect = detailLastRow?.getBoundingClientRect();

            return {
                innerTabsDirection: innerTabs ? getComputedStyle(innerTabs).flexDirection : '',
                navListDirection: navList ? getComputedStyle(navList).flexDirection : '',
                clientNavOverflowX: clientNavWrap ? getComputedStyle(clientNavWrap).overflowX : '',
                clientNavOverflowY: clientNavWrap ? getComputedStyle(clientNavWrap).overflowY : '',
                innerNavOverflowX: navWrap ? getComputedStyle(navWrap).overflowX : '',
                innerNavOverflowY: navWrap ? getComputedStyle(navWrap).overflowY : '',
                clientTabRightGap:
                    clientNavRect && activeClientTabRect
                        ? clientNavRect.right - activeClientTabRect.right
                        : Number.POSITIVE_INFINITY,
                clientLabelCenterGap:
                    clientNavRect && activeClientLabelRect
                        ? (activeClientLabelRect.left + activeClientLabelRect.right) / 2 -
                          (clientNavRect.left + clientNavRect.right) / 2
                        : Number.POSITIVE_INFINITY,
                tabTops: tabs.map(tab => tab.getBoundingClientRect().top),
                detailGap: navRect && detailRect ? detailRect.top - navRect.bottom : Number.POSITIVE_INFINITY,
                detailActionButtonWidth: detailActionButton?.getBoundingClientRect().width || 0,
                detailActionCellWidth: detailActionCell?.getBoundingClientRect().width || 0,
                detailHasHorizontalOverflow: Boolean(
                    detailContent && detailContent.scrollWidth > detailContent.clientWidth
                ),
                detailScrollbarHeight: detailContent
                    ? Number.parseFloat(getComputedStyle(detailContent, '::-webkit-scrollbar').height)
                    : Number.POSITIVE_INFINITY,
                tabsScrollbarHeight: navWrap
                    ? Number.parseFloat(getComputedStyle(navWrap, '::-webkit-scrollbar').height)
                    : Number.POSITIVE_INFINITY,
                detailLastRowBottomOverflow:
                    detailContent && detailContentRect && detailLastRowRect
                        ? detailLastRowRect.bottom - (detailContentRect.top + detailContent.clientHeight)
                        : Number.POSITIVE_INFINITY,
                pageTopGap: contentRect ? rootRect.top - contentRect.top : Number.POSITIVE_INFINITY,
                pageBottomGap: contentRect ? contentRect.bottom - rootRect.bottom : Number.POSITIVE_INFINITY,
                routeContentHeight: routeContent?.getBoundingClientRect().height || 0,
                routeRowHeights: routeRows.map(row => row.getBoundingClientRect().height)
            };
        },
        { detailTableTestId, routeTableTestId }
    );

    expect(layout.innerTabsDirection).toBe('column');
    expect(layout.navListDirection).toBe('row');
    expect(layout.clientNavOverflowX).toBe('hidden');
    expect(layout.clientNavOverflowY).toBe('auto');
    expect(layout.innerNavOverflowX).toBe('auto');
    expect(layout.innerNavOverflowY).toBe('hidden');
    expect(Math.abs(layout.clientTabRightGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.clientLabelCenterGap)).toBeLessThanOrEqual(1);
    expect(layout.tabTops.length).toBeGreaterThan(1);
    expect(Math.max(...layout.tabTops) - Math.min(...layout.tabTops)).toBeLessThanOrEqual(1);
    expect(layout.detailGap).toBeGreaterThanOrEqual(0);
    expect(layout.detailGap).toBeLessThanOrEqual(16);
    expect(layout.detailActionButtonWidth).toBeGreaterThanOrEqual(24);
    expect(layout.detailActionButtonWidth).toBeLessThanOrEqual(40);
    expect(layout.detailActionCellWidth).toBeGreaterThanOrEqual(64);
    expect(layout.detailActionCellWidth).toBeLessThanOrEqual(80);
    expect(layout.detailHasHorizontalOverflow).toBe(true);
    expect(layout.detailScrollbarHeight).toBe(6);
    expect(layout.tabsScrollbarHeight).toBe(6);
    expect(layout.detailLastRowBottomOverflow).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.pageTopGap - layout.pageBottomGap)).toBeLessThanOrEqual(1);
    expect(layout.routeContentHeight).toBeGreaterThan(200);
    expect(layout.routeRowHeights.length).toBeGreaterThan(1);
    expect(layout.routeRowHeights.every(height => height >= 24)).toBe(true);

    const detailScrollbar = pageRoot
        .locator(`[data-testid="${detailTableTestId}"]:visible .nn-table-content`)
        .first();
    const tabsScrollbar = pageRoot.locator('.bmp-inner-tabs:visible > .nn-tabs-nav .nn-tabs-nav-wrap').first();
    await Promise.all([expectAutoHidingScrollbar(detailScrollbar), expectAutoHidingScrollbar(tabsScrollbar)]);
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
            await controller.waitForMockData({ routes: EXPECTED_MOCK_READY_ROUTE_COUNT });

            const snapshot = controller.lastRouteQuerySnapshot;
            expect(snapshot).toBeTruthy();
            await recordStep(
                `Output: client=${snapshot.adjRib.client.sysName}, sessionRoutes=${snapshot.adjRib.total}, locRibRoutes=${snapshot.locRib.total}`
            );
        });

        await test.step('Verify BMP config page client table', async () => {
            await recordStep(
                `Input: expectedClient=${EXPECTED_CLIENT_NAME}, expectedDescription=${EXPECTED_CLIENT_DESCRIPTION}`
            );

            const clientTable = page.getByTestId('bmp-client-table');
            await expect(clientTable).toContainText(EXPECTED_CLIENT_NAME, { timeout: 10000 });
            await expect(clientTable).toContainText(EXPECTED_CLIENT_DESCRIPTION);
            await expect(clientTable).toContainText('BMPv4');
            await expect(clientTable).toContainText('draft-20');

            await recordStep(`Output: clientTable contains ${EXPECTED_CLIENT_NAME}, BMPv4, draft-20`);
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
            await expectBmpRouteLayout(
                page,
                'bmp-session-page',
                'bmp-session-table',
                'bmp-session-route-table'
            );
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

            const pagination = sessionRouteTable.getByRole('navigation', { name: '表格分页' });
            const secondPageButton = pagination.getByRole('button', { name: '2', exact: true });
            await expect(secondPageButton).toBeVisible();
            await secondPageButton.click();

            await expect(secondPageButton).toHaveAttribute('aria-current', 'page');
            await expect(sessionRouteTable).toContainText('10.10.25.0', { timeout: 10000 });
            await expect(sessionRouteTable).not.toContainText('10.10.0.0');
            await expect
                .poll(
                    () =>
                        controller.timeline.some(
                            item =>
                                item.message === 'worker query: getBgpRoutes' &&
                                item.data?.request?.page === 2 &&
                                item.data?.request?.pageSize === 25
                        ),
                    { timeout: 10000 }
                )
                .toBe(true);

            await recordStep('Output: Adj-RIB pagination onChange queried worker page=2 and rendered 10.10.25.0');
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
            await expectBmpRouteLayout(
                page,
                'bmp-loc-rib-page',
                'bmp-loc-rib-instance-table',
                'bmp-loc-rib-route-table'
            );
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

            const pagination = locRibRouteTable.getByRole('navigation', { name: '表格分页' });
            const secondPageButton = pagination.getByRole('button', { name: '2', exact: true });
            await expect(secondPageButton).toBeVisible();
            await secondPageButton.click();

            await expect(secondPageButton).toHaveAttribute('aria-current', 'page');
            await expect(locRibRouteTable).toContainText('10.30.23.0', { timeout: 10000 });
            await expect(locRibRouteTable).not.toContainText('10.30.0.0');
            await expect
                .poll(
                    () =>
                        controller.timeline.some(
                            item =>
                                item.message === 'worker query: getBgpInstanceRoutes' &&
                                item.data?.request?.page === 2 &&
                                item.data?.request?.pageSize === 25
                        ),
                    { timeout: 10000 }
                )
                .toBe(true);

            await recordStep('Output: Loc-RIB pagination onChange queried worker page=2 and rendered second page');
        });

        await test.step('Verify lazy-created Loc-RIB address-family tab appears after route update', async () => {
            await recordStep(
                'Input: inject Loc-RIB IPv4 Label route after the Loc-RIB page has loaded, without a matching Peer Up address family'
            );

            const lazyRoute = await controller.injectLazyLocRibLabelRoute();
            const lazyTab = page.getByText(`${lazyRoute.vrfName} | IPv4 Label`).first();
            await expect(lazyTab).toBeVisible({ timeout: 10000 });
            await lazyTab.click();

            const locRibRouteTable = page
                .getByLabel(`${lazyRoute.vrfName} | IPv4 Label`)
                .getByTestId('bmp-loc-rib-route-table');
            await expect(locRibRouteTable).toContainText(lazyRoute.prefix, { timeout: 10000 });
            await expect(locRibRouteTable).toContainText(`${lazyRoute.label}(BOS)`);
            await expect(locRibRouteTable).toContainText('0.0.0.0');

            await recordStep(
                `Output: lazyInstanceTab="${lazyRoute.vrfName} | IPv4 Label", route=${lazyRoute.prefix}, label=${lazyRoute.label}(BOS)`
            );
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
            await expect(page.getByTestId('bmp-client-table')).not.toContainText(EXPECTED_CLIENT_NAME);

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
            await controller.waitForMockData({ routes: EXPECTED_MOCK_READY_ROUTE_COUNT });

            await expect(page.getByTestId('bmp-client-table')).toContainText(EXPECTED_CLIENT_NAME, {
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
            await expect(page.getByTestId('bmp-client-table')).not.toContainText(EXPECTED_CLIENT_NAME, {
                timeout: 10000
            });

            await recordStep('Output: BMP client table and BGP session page no longer show the disconnected client');
        });
    });
});
