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

async function expectAutoHidingHorizontalScrollbar(locator) {
    const isXActive = () => locator.evaluate(element => element.classList.contains('nn-scrollbar-x-active'));
    const isYActive = () => locator.evaluate(element => element.classList.contains('nn-scrollbar-y-active'));

    await expect.poll(isXActive, { timeout: 2500 }).toBe(false);
    await expect.poll(isYActive).toBe(false);

    await locator.hover();
    await locator.dispatchEvent('pointermove');
    await expect.poll(isXActive).toBe(false);
    await expect.poll(isYActive).toBe(false);

    const scrollPosition = await locator.evaluate(element => {
        if (element.scrollWidth <= element.clientWidth && element.firstElementChild) {
            element.firstElementChild.style.minWidth = `${element.clientWidth + 100}px`;
        }
        const maximumScrollLeft = element.scrollWidth - element.clientWidth;
        const previousScrollLeft = element.scrollLeft;
        element.scrollLeft = previousScrollLeft < maximumScrollLeft ? previousScrollLeft + 20 : previousScrollLeft - 20;
        element.dispatchEvent(new Event('scroll'));
        return { maximumScrollLeft, previousScrollLeft, scrollLeft: element.scrollLeft };
    });
    expect(scrollPosition.maximumScrollLeft).toBeGreaterThan(0);
    expect(scrollPosition.scrollLeft).not.toBe(scrollPosition.previousScrollLeft);
    await expect.poll(isXActive).toBe(true);
    await expect.poll(isYActive).toBe(false);

    await expect.poll(isXActive, { timeout: 2500 }).toBe(false);
    await expect.poll(isYActive).toBe(false);
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

    const detailScrollbar = pageRoot.locator(`[data-testid="${detailTableTestId}"]:visible .nn-table-content`).first();
    const tabsScrollbar = pageRoot.locator('.bmp-inner-tabs:visible > .nn-tabs-nav .nn-tabs-nav-wrap').first();
    await expectAutoHidingHorizontalScrollbar(detailScrollbar);
    await expectAutoHidingHorizontalScrollbar(tabsScrollbar);
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

            const expectedSessionTab = page.getByRole('tab', {
                name: 'global | 192.0.2.2 | 65000',
                exact: true
            });
            await expect(expectedSessionTab).toBeVisible({ timeout: 10000 });
            await expectedSessionTab.click();
            await expect(expectedSessionTab).toHaveAttribute('aria-selected', 'true');

            const expectedSessionPanel = page.getByRole('tabpanel', {
                name: 'global | 192.0.2.2 | 65000',
                exact: true
            });
            await expect(expectedSessionPanel).toBeVisible();

            const sessionTable = expectedSessionPanel.getByTestId('bmp-session-table');
            await expect(sessionTable).toContainText('192.0.2.2', { timeout: 10000 });
            await expect(sessionTable).toContainText('65000');
            await expect(sessionTable).toContainText('Peer Up');

            const sessionRouteTable = expectedSessionPanel.getByTestId('bmp-session-route-table');
            await expect(sessionRouteTable).toContainText('10.10.0.0', { timeout: 10000 });
            await expect(sessionRouteTable).toContainText('192.0.2.254');
            await expect(sessionRouteTable).toContainText('65000 65100');
            await expect(expectedSessionPanel.getByText(`当前 ${EXPECTED_PUBLIC_ROUTE_COUNT}`)).toBeVisible();
            await expectBmpRouteLayout(page, 'bmp-session-page', 'bmp-session-table', 'bmp-session-route-table');
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

        await test.step('Find five RIB-pipeline anomaly classes in Route Assurance', async () => {
            await recordStep(
                'Input: route=/#/bmp/route-assurance, vrf=route-lens-lab; verify five-stage funnel, evidence semantics, filtering, alert errors, and Route Lens drilldown'
            );

            await page.goto('/#/bmp/route-assurance');
            const assurancePage = page.getByTestId('bmp-route-assurance-page');
            await expect(assurancePage).toBeVisible();
            await expect(page.getByRole('tab', { name: '路由矩阵', exact: true })).toHaveAttribute(
                'aria-selected',
                'true'
            );

            const assuranceRequestCount = () =>
                controller.timeline.filter(item => item.message === 'worker query: getRouteAssurance').length;
            const requestCountBeforeEnable = assuranceRequestCount();
            const analysisToggle = page.getByTestId('route-assurance-toggle');
            await expect(analysisToggle).toHaveAttribute('aria-checked', 'false');
            await expect(page.getByText('路由分析未开启，请先开启右上角分析开关')).toBeVisible();
            await page.waitForTimeout(1000);
            expect(assuranceRequestCount()).toBe(requestCountBeforeEnable);
            await analysisToggle.click();
            await expect(analysisToggle).toHaveAttribute('aria-checked', 'true');
            await expect
                .poll(
                    () =>
                        controller.timeline.some(
                            item =>
                                item.message === 'worker query: setRouteAssuranceEnabled' &&
                                item.data?.request?.enabled === true
                        ),
                    { timeout: 10000 }
                )
                .toBe(true);

            const vrfSelect = page.getByTestId('route-assurance-vrf');
            await expect(vrfSelect).toBeEnabled();
            await vrfSelect.click();
            await page.getByRole('option').filter({ hasText: 'route-lens-lab' }).click();
            await page.getByTestId('route-assurance-search').click();

            const expectedFunnel = {
                preIn: '6',
                postIn: '5',
                locRib: '4',
                preOut: '3',
                postOut: '2'
            };
            for (const [stage, count] of Object.entries(expectedFunnel)) {
                await expect(page.getByTestId(`route-assurance-stage-${stage}`).locator('strong')).toHaveText(count, {
                    timeout: 10000
                });
            }

            const issueRows = page.getByTestId('route-assurance-issue-row');
            await expect(issueRows).toHaveCount(5);
            const expectedIssues = [
                ['203.0.121.0/24', '入站阶段缺口', '设备上报'],
                ['203.0.122.0/24', '未进入 Loc-RIB', '推测分析'],
                ['203.0.123.0/24', '未生成出站路由', '推测分析'],
                ['203.0.124.0/24', '出站阶段缺口', '设备上报'],
                ['203.0.125.0/24', '多出口属性不一致', '观测事实']
            ];
            for (const [prefix, category, evidence] of expectedIssues) {
                const row = issueRows.filter({ hasText: prefix });
                await expect(row).toHaveCount(1);
                await expect(row).toContainText(category);
                await expect(row).toContainText(evidence);
            }

            await expect
                .poll(
                    () =>
                        controller.timeline.some(
                            item =>
                                item.message === 'worker query: getRouteAssurance' &&
                                item.data?.request?.vrf === 'route-lens-lab'
                        ),
                    { timeout: 10000 }
                )
                .toBe(true);

            const measureAssuranceLayout = () =>
                assurancePage.evaluate(root => {
                    const filter = root.querySelector('.filter-panel')?.getBoundingClientRect();
                    const funnel = root.querySelector('.funnel-section')?.getBoundingClientRect();
                    const matrix = root.querySelector('.matrix-section')?.getBoundingClientRect();
                    const tableContent = root
                        .querySelector('.assurance-table .nn-table-content')
                        ?.getBoundingClientRect();
                    const pagination = root.querySelector('.assurance-table .nn-pagination')?.getBoundingClientRect();
                    const generatedAt = root.querySelector('.generated-at');
                    const generatedStyle = generatedAt ? getComputedStyle(generatedAt) : null;
                    return {
                        filterTop: filter?.top || 0,
                        filterHeight: filter?.height || 0,
                        funnelTop: funnel?.top || 0,
                        matrixBottom: matrix?.bottom || 0,
                        tableHeight: tableContent?.height || 0,
                        paginationTop: pagination?.top || 0,
                        paginationBottom: pagination?.bottom || 0,
                        generatedBackground: generatedStyle?.backgroundColor || '',
                        generatedRadius: Number.parseFloat(generatedStyle?.borderRadius || '0')
                    };
                });
            const stableLayout = await measureAssuranceLayout();
            expect(stableLayout.tableHeight).toBeGreaterThan(100);
            expect(stableLayout.matrixBottom - stableLayout.paginationBottom).toBeGreaterThanOrEqual(0);
            expect(stableLayout.matrixBottom - stableLayout.paginationBottom).toBeLessThanOrEqual(14);
            expect(stableLayout.generatedBackground).not.toBe('rgba(0, 0, 0, 0)');
            expect(stableLayout.generatedRadius).toBeGreaterThan(8);

            await analysisToggle.click();
            await expect(analysisToggle).toHaveAttribute('aria-checked', 'false');
            await expect
                .poll(() => {
                    const toggleEvents = controller.timeline.filter(
                        item => item.message === 'worker query: setRouteAssuranceEnabled'
                    );
                    return toggleEvents.at(-1)?.data?.request?.enabled;
                })
                .toBe(false);
            await expect(issueRows).toHaveCount(0);
            await expect(page.getByText('路由分析未开启，请先开启右上角分析开关')).toBeVisible();
            await expect(assurancePage.locator('.generated-at')).toHaveCount(0);
            await analysisToggle.click();
            await expect(analysisToggle).toHaveAttribute('aria-checked', 'true');
            await expect(issueRows).toHaveCount(5, { timeout: 10000 });

            await page.getByTestId('route-assurance-query').fill('10.0.0.0/99');
            await page.getByTestId('route-assurance-search').click();
            const malformedCidrToast = page
                .getByRole('alert')
                .filter({ hasText: 'Route Assurance 查询失败：CIDR 前缀格式无效' });
            await expect(malformedCidrToast).toBeVisible();
            await expect(issueRows).toHaveCount(5);
            await expect(assurancePage.locator('[role="alert"]')).toHaveCount(0);
            const errorLayout = await measureAssuranceLayout();
            expect(errorLayout).toEqual(stableLayout);
            await malformedCidrToast.getByRole('button', { name: '关闭' }).click();

            await page.getByTestId('route-assurance-query').fill('');
            const categorySelect = page.getByTestId('route-assurance-category');
            await categorySelect.click();
            await page.getByRole('option').filter({ hasText: '出站阶段缺口' }).click();
            await page.getByTestId('route-assurance-search').click();
            await expect(issueRows).toHaveCount(1);
            const filteredLayout = await measureAssuranceLayout();
            expect(filteredLayout.tableHeight).toBe(stableLayout.tableHeight);
            expect(filteredLayout.paginationTop).toBe(stableLayout.paginationTop);
            expect(filteredLayout.paginationBottom).toBe(stableLayout.paginationBottom);
            const outboundGapRow = issueRows.filter({ hasText: '203.0.124.0/24' });
            await expect(outboundGapRow).toContainText('设备上报');
            await outboundGapRow.getByTestId('route-assurance-open-lens').click();

            const routeLensPage = page.getByTestId('bmp-route-lens-page');
            await expect(routeLensPage).toBeVisible();
            await expect(page.getByTestId('route-lens-query')).toHaveValue('203.0.124.0/24');
            await expect(page.getByTestId('route-lens-stage-preOut')).toContainText('203.0.124.0/24', {
                timeout: 10000
            });
            await expect(page.getByTestId('route-lens-stage-postOut')).not.toContainText('203.0.124.0/24');

            await recordStep(
                'Output: route-lens-lab funnel=6→5→4→3→2; five anomaly categories rendered with reported/observed/inferred evidence, invalid CIDR stayed in a floating alert, and outbound gap drilled into Route Lens'
            );
        });

        await test.step('Trace a prefix across the Route Lens pipeline', async () => {
            await recordStep(
                'Input: route=/#/bmp/route-lens, query=203.0.126.1 (IP longest-prefix lookup), then query=10.10.0.1 (Path Marking evidence)'
            );

            await page.goto('/#/bmp/route-lens');
            const routeLensPage = page.getByTestId('bmp-route-lens-page');
            await expect(routeLensPage).toBeVisible();
            await expect(page.getByRole('tab', { name: '路由追踪', exact: true })).toHaveAttribute(
                'aria-selected',
                'true'
            );

            const queryInput = page.getByTestId('route-lens-query');
            const searchButton = page.getByTestId('route-lens-search');
            await queryInput.fill('203.0.126.1');
            await searchButton.click();

            const flow = page.getByTestId('route-lens-flow');
            await expect(flow).toBeVisible({ timeout: 10000 });
            const stageTestIds = [
                'route-lens-stage-preIn',
                'route-lens-stage-postIn',
                'route-lens-stage-locRib',
                'route-lens-stage-preOut',
                'route-lens-stage-postOut'
            ];
            for (const testId of stageTestIds) {
                await expect(page.getByTestId(testId)).toHaveCount(1);
            }

            const preInStage = page.getByTestId('route-lens-stage-preIn');
            const postInStage = page.getByTestId('route-lens-stage-postIn');
            await expect(preInStage).toContainText('203.0.126.0/24');
            await expect(postInStage).toContainText('203.0.126.0/24');
            await expect(routeLensPage.getByText('设备上报', { exact: true }).first()).toBeVisible();
            await expect(routeLensPage.getByText('观测事实', { exact: true }).first()).toBeVisible();
            await expect(routeLensPage.getByText('推测关联', { exact: true }).first()).toBeVisible();
            await expect(routeLensPage.getByText('未上报 Path Marking', { exact: true }).first()).toBeVisible();

            await expect
                .poll(
                    () =>
                        controller.timeline.some(
                            item =>
                                item.message === 'worker query: getRouteLens' &&
                                item.data?.request?.query === '203.0.126.1'
                        ),
                    { timeout: 10000 }
                )
                .toBe(true);

            await queryInput.fill('10.10.0.1');
            await searchButton.click();
            await expect(preInStage).toContainText('10.10.0.0/24');
            await expect(preInStage).toContainText('Best');
            await expect(preInStage).toContainText('设备上报');
            await expect(preInStage).not.toContainText('未上报 Path Marking');

            await page.getByRole('radio', { name: 'Stale', exact: true }).click();
            await expect(routeLensPage).toContainText('未观测到与 10.10.0.1 匹配的路由');
            await page.getByRole('radio', { name: 'Current', exact: true }).click();
            await expect(preInStage).toContainText('10.10.0.0/24');

            const routeLensCallsBeforeRefresh = controller.timeline.filter(
                item => item.message === 'worker query: getRouteLens'
            ).length;
            await page.evaluate(() => {
                window.__bmpE2eEmit?.('bmp:routeUpdate', {
                    status: 'success',
                    data: { changedCount: 1 }
                });
            });
            await expect
                .poll(() => controller.timeline.filter(item => item.message === 'worker query: getRouteLens').length, {
                    timeout: 5000
                })
                .toBeGreaterThan(routeLensCallsBeforeRefresh);

            await queryInput.fill('203.0.120.1');
            await searchButton.click();
            const lifecyclePrefix = '203.0.120.0/24';
            const lifecycleStageIds = [
                'route-lens-stage-preIn',
                'route-lens-stage-postIn',
                'route-lens-stage-locRib',
                'route-lens-stage-preOut',
                'route-lens-stage-postOut'
            ];
            for (const stageTestId of lifecycleStageIds) {
                const stage = page.getByTestId(stageTestId);
                const routeCard = stage.getByTestId('route-lens-route-card').filter({ hasText: lifecyclePrefix });
                await expect(routeCard).toHaveCount(1);
                await expect(routeCard).toContainText('route-lens-lab');
            }

            for (const stageTestId of ['route-lens-stage-preIn', 'route-lens-stage-postIn']) {
                const ingressCard = page
                    .getByTestId(stageTestId)
                    .getByTestId('route-lens-route-card')
                    .filter({ hasText: lifecyclePrefix });
                await expect(ingressCard).toContainText('192.0.2.10');
                await expect(ingressCard).not.toContainText('192.0.2.12');
            }
            for (const stageTestId of ['route-lens-stage-preOut', 'route-lens-stage-postOut']) {
                const egressCard = page
                    .getByTestId(stageTestId)
                    .getByTestId('route-lens-route-card')
                    .filter({ hasText: lifecyclePrefix });
                await expect(egressCard).toContainText('192.0.2.12');
                await expect(egressCard).not.toContainText('192.0.2.10');
            }

            const locRibStage = page.getByTestId('route-lens-stage-locRib');
            const reportedLocRibCard = locRibStage
                .getByTestId('route-lens-route-card')
                .filter({ hasText: lifecyclePrefix });
            await expect(reportedLocRibCard).toContainText('Best');
            await expect(reportedLocRibCard).toContainText('Primary');
            await expect(reportedLocRibCard).toContainText('设备上报');

            const inboundDiff = routeLensPage
                .locator('.analysis-panel')
                .filter({ hasText: 'Inbound 属性差异' })
                .locator('.diff-card')
                .filter({ hasText: lifecyclePrefix });
            await expect(inboundDiff).toHaveCount(1);
            await expect(inboundDiff).toContainText('属性变化');
            await expect(inboundDiff).toContainText('观测事实 · 关联需核验');
            await expect(inboundDiff).toContainText('Local Pref');
            await expect(inboundDiff).toContainText('100');
            await expect(inboundDiff).toContainText('220');
            await expect(inboundDiff).toContainText('Communities');
            await expect(inboundDiff).toContainText('65000:100 65000:120');
            await expect(inboundDiff).toContainText('65000:120 65000:220');

            const outboundDiff = routeLensPage
                .locator('.analysis-panel')
                .filter({ hasText: 'Outbound 属性差异' })
                .locator('.diff-card')
                .filter({ hasText: lifecyclePrefix });
            await expect(outboundDiff).toHaveCount(1);
            await expect(outboundDiff).toContainText('属性变化');
            await expect(outboundDiff).toContainText('观测事实 · 关联需核验');
            await expect(outboundDiff).toContainText('Next Hop');
            await expect(outboundDiff).toContainText('192.0.2.210');
            await expect(outboundDiff).toContainText('192.0.2.1');
            await expect(outboundDiff).toContainText('AS Path');
            await expect(outboundDiff).toContainText('65008 65108');
            await expect(outboundDiff).toContainText('65000 65008 65108');
            await expect(outboundDiff).toContainText('Communities');
            await expect(outboundDiff).toContainText('65000:120 65000:220');
            await expect(outboundDiff).toContainText('65000:220 65000:999');

            const evpnIdentity = 'evpn:mac-ip:65000:1:tag=101:mac=aa:bb:cc:dd:ee:01:ip=192.0.2.11';
            await queryInput.fill(evpnIdentity);
            await searchButton.click();
            const evpnCard = preInStage.getByTestId('route-lens-route-card').filter({ hasText: evpnIdentity });
            await expect(evpnCard).toHaveCount(1);
            await expect(evpnCard).toContainText('NLRI 精确匹配');
            await evpnCard.click();

            const evpnDrawer = page.getByRole('dialog', { name: `${evpnIdentity} · Pre Adj-RIB-In` });
            await expect(evpnDrawer).toBeVisible();
            await expect(evpnDrawer).toContainText('L2VPN EVPN');
            await expect(evpnDrawer).toContainText('MAC/IP Advertisement');
            await expect(evpnDrawer).toContainText('VNI 10000');
            await expect(evpnDrawer).toContainText('"matchType": "text-exact"');
            await expect(evpnDrawer).toContainText('"matchedField": "ip"');
            await evpnDrawer.getByRole('button', { name: '关闭' }).click();

            await queryInput.fill('AA:BB:CC:DD:EE:01');
            await searchButton.click();
            const evpnContainsCard = preInStage.getByTestId('route-lens-route-card').filter({ hasText: evpnIdentity });
            await expect(evpnContainsCard).toHaveCount(1);
            await expect(evpnContainsCard).toContainText('NLRI 文本包含');

            const bgpLsIdentity = 'bgp-ls:Link:10.10.0.1->10.10.0.2';
            await queryInput.fill(bgpLsIdentity);
            await searchButton.click();
            const bgpLsCard = preInStage.getByTestId('route-lens-route-card').filter({ hasText: bgpLsIdentity });
            await expect(bgpLsCard).toHaveCount(1);
            await expect(bgpLsCard).toContainText('NLRI 精确匹配');
            await expect(bgpLsCard).not.toContainText('/520');
            await bgpLsCard.click();

            const bgpLsDrawer = page.getByRole('dialog', { name: `${bgpLsIdentity} · Pre Adj-RIB-In` });
            await expect(bgpLsDrawer).toBeVisible();
            await expect(bgpLsDrawer).toContainText('Link-State');
            await expect(bgpLsDrawer).toContainText('OSPFv2');
            await expect(bgpLsDrawer).toContainText('Local Node Descriptors');
            await expect(bgpLsDrawer).toContainText('65009');
            await expect(bgpLsDrawer).toContainText('"matchType": "text-exact"');
            await bgpLsDrawer.getByRole('button', { name: '关闭' }).click();

            await queryInput.fill('BGP-LS:LINK');
            await searchButton.click();
            const bgpLsContainsCard = preInStage
                .getByTestId('route-lens-route-card')
                .filter({ hasText: bgpLsIdentity });
            await expect(bgpLsContainsCard).toHaveCount(1);
            await expect(bgpLsContainsCard).toContainText('NLRI 文本包含');

            const measureRouteLensLayout = () =>
                routeLensPage.evaluate(root => {
                    const queryPanel = root.querySelector('.query-panel');
                    const result = root.querySelector('.lens-result');
                    const queryRect = queryPanel?.getBoundingClientRect();
                    const resultRect = result?.getBoundingClientRect();
                    return {
                        queryTop: queryRect?.top || 0,
                        queryBottom: queryRect?.bottom || 0,
                        queryHeight: queryRect?.height || 0,
                        resultTop: resultRect?.top || 0
                    };
                });
            const expectStableRouteLensLayout = (before, after) => {
                expect(Math.abs(after.queryTop - before.queryTop)).toBeLessThanOrEqual(1);
                expect(Math.abs(after.queryBottom - before.queryBottom)).toBeLessThanOrEqual(1);
                expect(Math.abs(after.queryHeight - before.queryHeight)).toBeLessThanOrEqual(1);
                expect(Math.abs(after.resultTop - before.resultTop)).toBeLessThanOrEqual(1);
            };
            const successfulLayout = await measureRouteLensLayout();

            await queryInput.fill('10.10.0.0/99');
            await searchButton.click();
            const malformedCidrToast = page
                .getByRole('alert')
                .filter({ hasText: 'Route Lens 查询失败：CIDR 前缀格式无效' });
            await expect(malformedCidrToast).toBeVisible();
            await expect(bgpLsContainsCard).toBeVisible();
            await expect(routeLensPage.locator('[role="alert"]')).toHaveCount(0);
            expectStableRouteLensLayout(successfulLayout, await measureRouteLensLayout());
            await malformedCidrToast.getByRole('button', { name: '关闭' }).click();

            await queryInput.fill('');
            await searchButton.click();
            const emptyQueryToast = page
                .getByRole('alert')
                .filter({ hasText: 'Route Lens 查询失败：请输入 Prefix、IP 或 NLRI 标识' });
            await expect(emptyQueryToast).toBeVisible();
            await expect(bgpLsContainsCard).toBeVisible();
            await expect(routeLensPage.locator('[role="alert"]')).toHaveCount(0);
            expectStableRouteLensLayout(successfulLayout, await measureRouteLensLayout());
            await emptyQueryToast.getByRole('button', { name: '关闭' }).click();

            await recordStep(
                'Output: ingress Peer 192.0.2.10 reported RIB-In, Loc-RIB selected the route, and egress Peer 192.0.2.12 reported RIB-Out with NextHop/AS-Path/Community rewrites; EVPN and BGP-LS exact/substring NLRI queries rendered correctly; malformed CIDR and empty input used alert toasts without shifting the result layout'
            );
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
            const statisticsPage = page.getByTestId('bmp-session-statistics-page');
            const statisticsTab = statisticsPage.getByRole('tab', {
                name: '192.0.2.2 | AS 65000',
                exact: true
            });
            await expect(statisticsTab).toBeVisible({ timeout: 10000 });
            await statisticsTab.click();
            const statisticsPanel = statisticsPage.getByRole('tabpanel', {
                name: '192.0.2.2 | AS 65000',
                exact: true
            });
            await expect(statisticsPanel).toBeVisible();
            await expect(
                statisticsPanel
                    .locator('.report-table')
                    .getByRole('cell', { name: String(EXPECTED_ADJ_RIB_STATS_ROUTE_COUNT), exact: true })
                    .first()
            ).toBeVisible();

            await recordStep(`Output: session statistics visible, routeCount=${EXPECTED_ADJ_RIB_STATS_ROUTE_COUNT}`);
        });

        await test.step('Verify BGP Loc-RIB statistics page', async () => {
            await recordStep('Input: route=/#/bmp/bgp-loc-rib-statis-report, expectedInstance=global-evpn');

            await page.goto('/#/bmp/bgp-loc-rib-statis-report');
            const statisticsPage = page.getByTestId('bmp-loc-rib-statistics-page');
            const statisticsTab = statisticsPage.getByRole('tab', { name: 'global-evpn', exact: true });
            await expect(statisticsTab).toBeVisible({ timeout: 10000 });
            await statisticsTab.click();
            const statisticsPanel = statisticsPage.getByRole('tabpanel', { name: 'global-evpn', exact: true });
            await expect(statisticsPanel).toBeVisible();
            await expect(
                statisticsPanel
                    .locator('.report-table')
                    .getByRole('cell', { name: String(EXPECTED_LOC_RIB_ROUTE_COUNT), exact: true })
                    .first()
            ).toBeVisible();

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

    test('keeps persisted BGP session history when the live BMP client disconnects', async ({ page }) => {
        const bmpPort = await BmpE2eController.getFreePort();
        const expectedSessionTabName = 'global | 192.0.2.2 | 65000';

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

            const sessionTab = page.getByRole('tab', { name: expectedSessionTabName, exact: true });
            await expect(sessionTab).toBeVisible({ timeout: 10000 });
            await sessionTab.click();
            await expect(sessionTab).toHaveAttribute('aria-selected', 'true');

            const sessionPanel = page.getByRole('tabpanel', { name: expectedSessionTabName, exact: true });
            await expect(sessionPanel).toBeVisible();
            await expect(sessionPanel.getByTestId('bmp-session-table')).toContainText('192.0.2.2');
            await expect(sessionPanel.getByTestId('bmp-session-route-table')).toContainText('10.10.0.0', {
                timeout: 10000
            });

            await recordStep('Output: BGP session and route are visible before disconnect');
        });

        await test.step('Disconnect mock BMP client and verify persisted session and routes remain offline', async () => {
            await recordStep('Input: mock BMP client sends TCP FIN while BMP server keeps running');

            const exitInfo = await controller.disconnectMockClient({ timeout: 5000 });
            expect(exitInfo.code).toBe(0);
            expect(exitInfo.signal).toBeNull();

            const sessionTab = page.getByRole('tab', { name: expectedSessionTabName, exact: true });
            await expect(sessionTab).toBeVisible({ timeout: 10000 });
            await sessionTab.click();
            await expect(sessionTab).toHaveAttribute('aria-selected', 'true');

            const sessionPanel = page.getByRole('tabpanel', { name: expectedSessionTabName, exact: true });
            await expect(sessionPanel).toBeVisible();
            const sessionTable = sessionPanel.getByTestId('bmp-session-table');
            await expect(sessionTable).toContainText('192.0.2.2');
            await expect(sessionTable.getByText('已断开', { exact: true })).toBeVisible({ timeout: 10000 });

            await sessionPanel.getByRole('radio', { name: '过期', exact: true }).click();
            const sessionRouteTable = sessionPanel.getByTestId('bmp-session-route-table');
            await expect(sessionRouteTable).toContainText('10.10.0.0', { timeout: 10000 });
            await expect(sessionRouteTable.locator('tr.route-stale-row', { hasText: '10.10.0.0' })).toBeVisible();

            await page.goto('/#/bmp/bmp-config');
            const clientTable = page.getByTestId('bmp-client-table');
            const persistedClientRow = clientTable.locator('.nn-table-tbody > .nn-table-row', {
                hasText: EXPECTED_CLIENT_NAME
            });
            await expect(persistedClientRow).toContainText(EXPECTED_CLIENT_NAME, { timeout: 10000 });
            await expect(persistedClientRow).toContainText('已断开');

            await recordStep(
                'Output: live BMP connection is closed, while the persisted client and BGP session remain disconnected with stale routes'
            );
        });
    });
});
