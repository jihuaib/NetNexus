const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BmpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');

const BASELINE_ROUTE_COUNT = 26;
const PRESSURE_ROUTE_COUNT = 8000;
const PRESSURE_INTERVAL_MS = 1;
const TAB_RESPONSE_BUDGET_MS = 2500;
const HEARTBEAT_INTERVAL_MS = 50;

const TAB_TARGETS = [
    {
        label: 'BGP会话',
        hash: '#/bmp/bgp-session',
        pageTestId: 'bmp-session-page'
    },
    {
        label: 'BGP Loc-RIB',
        hash: '#/bmp/bgp-loc-rib',
        pageTestId: 'bmp-loc-rib-page'
    },
    {
        label: 'BGP会话统计',
        hash: '#/bmp/bgp-session-statis-report',
        pageTestId: 'bmp-session-statistics-page'
    },
    {
        label: 'BGP Loc-RIB统计',
        hash: '#/bmp/bgp-loc-rib-statis-report',
        pageTestId: 'bmp-loc-rib-statistics-page'
    },
    {
        label: 'BMP配置',
        hash: '#/bmp/bmp-config',
        pageTestId: 'bmp-config-page'
    }
];

async function installRendererHeartbeat(page) {
    await page.evaluate(intervalMs => {
        const startedAt = performance.now();
        const heartbeat = {
            ticks: 0,
            maxDelayMs: 0,
            lastTickAt: startedAt,
            timer: null
        };
        heartbeat.timer = window.setInterval(() => {
            const now = performance.now();
            heartbeat.maxDelayMs = Math.max(heartbeat.maxDelayMs, now - heartbeat.lastTickAt - intervalMs);
            heartbeat.lastTickAt = now;
            heartbeat.ticks += 1;
        }, intervalMs);
        window.__bmpE2eHeartbeat = heartbeat;
    }, HEARTBEAT_INTERVAL_MS);
}

function readRendererHeartbeat(page) {
    return page.evaluate(() => ({
        ticks: window.__bmpE2eHeartbeat?.ticks || 0,
        maxDelayMs: window.__bmpE2eHeartbeat?.maxDelayMs || 0
    }));
}

async function stopRendererHeartbeat(page) {
    return page.evaluate(() => {
        const heartbeat = window.__bmpE2eHeartbeat;
        if (heartbeat?.timer) {
            window.clearInterval(heartbeat.timer);
        }
        return {
            ticks: heartbeat?.ticks || 0,
            maxDelayMs: heartbeat?.maxDelayMs || 0
        };
    });
}

test.describe('BMP write pressure responsiveness', () => {
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
        if (controller) {
            await controller.cleanup();
        }
    });

    test('keeps BMP tabs responsive while routes are continuously persisted', async ({ page }, testInfo) => {
        test.setTimeout(90000);

        const bmpPort = await BmpE2eController.getFreePort();
        await page.goto('/#/bmp/bmp-config');
        await expect(page.getByTestId('bmp-config-page')).toBeVisible();
        await page.getByTestId('bmp-port-input').fill(String(bmpPort));
        await page.getByTestId('bmp-start-button').click();
        await expect(page.getByTestId('bmp-stop-button')).toBeEnabled();

        await controller.startMockClient({ routes: BASELINE_ROUTE_COUNT, interval: 0 });
        await controller.waitForMockData({ routes: BASELINE_ROUTE_COUNT });
        await installRendererHeartbeat(page);

        await controller.startMockClient({
            routes: PRESSURE_ROUTE_COUNT,
            interval: PRESSURE_INTERVAL_MS,
            waitForCompletion: false,
            recordOutput: false
        });
        await expect
            .poll(() => controller.getMockClientProgress().routesSent, {
                timeout: 5000,
                message: 'the pressure client should begin streaming IPv4 routes'
            })
            .toBeGreaterThanOrEqual(200);

        const pressureStart = controller.getMockClientProgress();
        const persistenceStart = await controller.getPersistenceSnapshot();
        const topTabNav = page.locator('.fixed-tabs > .nn-tabs > .nn-tabs-nav').first();
        const tabLatencies = [];
        await expect(topTabNav).toBeVisible();

        for (let round = 1; round <= 2; round += 1) {
            for (const target of TAB_TARGETS) {
                const progressBeforeClick = controller.getMockClientProgress();
                expect(
                    progressBeforeClick.ingestRunning,
                    `route ingestion ended before round ${round} switched to ${target.label}`
                ).toBe(true);

                const heartbeatBeforeClick = await readRendererHeartbeat(page);
                const tab = topTabNav.getByRole('tab', { name: target.label, exact: true });
                const startedAt = Date.now();
                await tab.click({ timeout: TAB_RESPONSE_BUDGET_MS });
                const remainingBudget = Math.max(100, TAB_RESPONSE_BUDGET_MS - (Date.now() - startedAt));

                await expect
                    .poll(
                        async () => ({
                            hash: await page.evaluate(() => window.location.hash),
                            selected: await tab.getAttribute('aria-selected'),
                            pageVisible: await page.getByTestId(target.pageTestId).isVisible()
                        }),
                        {
                            timeout: remainingBudget,
                            intervals: [25, 50, 100],
                            message: `${target.label} should become active while SQLite writes continue`
                        }
                    )
                    .toEqual({
                        hash: target.hash,
                        selected: 'true',
                        pageVisible: true
                    });

                const latencyMs = Date.now() - startedAt;
                tabLatencies.push({ round, tab: target.label, latencyMs });
                expect(latencyMs, `${target.label} exceeded the response budget`).toBeLessThanOrEqual(
                    TAB_RESPONSE_BUDGET_MS
                );

                await expect
                    .poll(() => readRendererHeartbeat(page).then(result => result.ticks), {
                        timeout: 750,
                        intervals: [50],
                        message: `renderer heartbeat should continue after switching to ${target.label}`
                    })
                    .toBeGreaterThanOrEqual(heartbeatBeforeClick.ticks + 2);
            }
        }

        const pressureEnd = controller.getMockClientProgress();
        expect(pressureEnd.ingestRunning, 'the route stream must still be active after all tab switches').toBe(true);
        expect(pressureEnd.routesSent).toBeGreaterThan(pressureStart.routesSent + 200);

        const persistenceEnd = await controller.getPersistenceSnapshot();
        expect(persistenceEnd.enqueuedMutations).toBeGreaterThan(persistenceStart.enqueuedMutations + 200);
        expect(persistenceEnd.committedMutations).toBeGreaterThan(persistenceStart.committedMutations + 200);
        expect(persistenceEnd.tableCounts.currentRoutes).toBeGreaterThan(
            persistenceStart.tableCounts.currentRoutes + 200
        );

        const heartbeat = await stopRendererHeartbeat(page);
        expect(heartbeat.ticks).toBeGreaterThan(20);
        expect(heartbeat.maxDelayMs, 'renderer event loop was blocked by BMP ingestion').toBeLessThan(1500);

        await testInfo.attach('bmp-write-pressure-metrics', {
            body: Buffer.from(
                JSON.stringify(
                    {
                        pressureStart,
                        pressureEnd,
                        persistenceStart,
                        persistenceEnd,
                        heartbeat,
                        tabLatencies
                    },
                    null,
                    2
                )
            ),
            contentType: 'application/json'
        });
    });
});
