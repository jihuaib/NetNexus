const { test, expect } = require('@playwright/test');
const { BgpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');

const EXPECTED_ROUTE_COUNT = 3;

async function recordStep(title) {
    await test.step(title, async () => {});
}

function formatClientEvent(event) {
    return Object.entries(event)
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join(', ');
}

function formatRoute(route, index) {
    return `${index}. ${route.ip}/${route.mask} | nextHop=${route.nextHop || '(default)'} | asPath=${route.asPath || '(default)'} | rt=${route.rt || '(none)'}`;
}

test.describe('BGP pages', () => {
    let controller;

    test.beforeEach(async ({ page }) => {
        controller = new BgpE2eController();

        await page.exposeFunction('__bgpE2eCall', (method, ...args) => controller.call(method, ...args));
        controller.onEvent(event => {
            page.evaluate(({ type, data }) => window.__bgpE2eEmit?.(type, data), event).catch(() => {});
        });

        await page.addInitScript({ content: getBrowserMockScript('bgp') });
    });

    test.afterEach(async () => {
        if (!controller) {
            return;
        }

        await controller.cleanup();
    });

    test('starts BGP, establishes an IPv4 peer, sends routes, and captures UPDATE packets', async ({ page }) => {
        let bgpPort;
        let establishedPeer;
        let routeSnapshot;

        await test.step('Open BGP config page and allocate a TCP port', async () => {
            await recordStep('Input: route=/#/bgp/bgp-config, bindHost=127.0.0.1, port=auto');

            bgpPort = await BgpE2eController.getFreePort();
            controller.setBgpPort(bgpPort);

            await page.goto('/#/bgp/bgp-config');
            await expect(page.getByTestId('bgp-config-page')).toBeVisible();

            await recordStep(`Output: allocatedPort=${bgpPort}, pageVisible=true`);
        });

        await test.step('Start BGP from the UI', async () => {
            await recordStep('Input: localAs=65535, routerId=192.168.56.1, addressFamily=IPv4-UNC');

            await page.getByTestId('bgp-start-button').click();
            await expect(page.getByTestId('bgp-stop-button')).toBeEnabled();
            await expect(page.getByTestId('bgp-instance-table')).toContainText('Ipv4-UNC', { timeout: 10000 });

            await recordStep(`Output: BGP TCP server started on 127.0.0.1:${bgpPort}, instance=Ipv4-UNC`);
        });

        await test.step('Configure the IPv4 BGP peer from the UI', async () => {
            await recordStep('Input: route=/#/bgp/bgp-peer-config, peerIp=127.0.0.1, peerAs=100, holdTime=90');

            await page.goto('/#/bgp/bgp-peer-config');
            await expect(page.getByTestId('bgp-peer-page')).toBeVisible();
            await page.getByTestId('bgp-ipv4-peer-ip-input').fill('127.0.0.1');
            await page.getByTestId('bgp-ipv4-peer-as-input').fill('100');
            await page.getByTestId('bgp-ipv4-peer-hold-time-input').fill('90');
            await page.getByTestId('bgp-config-ipv4-peer-button').click();

            const peerTable = page.getByTestId('bgp-ipv4-unc-peer-table');
            await expect(peerTable).toContainText('127.0.0.1', { timeout: 10000 });
            await expect(peerTable).toContainText('Idle');

            await recordStep('Output: peer row visible, peerState=Idle, addressFamily=IPv4-UNC');
        });

        await test.step('Run scripts/mockBgpClient.js and verify the neighbor reaches Established', async () => {
            await recordStep(
                `Input: script=scripts/mockBgpClient.js, host=127.0.0.1, port=${bgpPort}, localAs=100, routerId=192.0.2.2`
            );

            await controller.startMockClient({ localAs: 100, routerId: '192.0.2.2', holdTime: 90 });
            const clientEstablished = await controller.waitForClientEvent('established');
            establishedPeer = await controller.waitForPeerState('127.0.0.1', 'Established');

            const peerTable = page.getByTestId('bgp-ipv4-unc-peer-table');
            await expect(peerTable).toContainText('Established', { timeout: 10000 });
            await expect(peerTable).toContainText('EBGP');

            await recordStep(
                `Output: client=${formatClientEvent(clientEstablished)}, peer=${JSON.stringify(establishedPeer)}`
            );
            for (const event of controller.mockClientEvents.filter(item => item.event !== 'received-update')) {
                await test.step(`Output BGP handshake packet: ${formatClientEvent(event)}`, async () => {
                    expect(event.event).toBeTruthy();
                });
            }
        });

        await test.step('Generate IPv4 routes from the UI and verify worker route state', async () => {
            await recordStep(
                `Input: route=/#/bgp/route-ipv4, prefix=10.20.0.0, mask=24, count=${EXPECTED_ROUTE_COUNT}`
            );

            await page.goto('/#/bgp/route-ipv4');
            await expect(page.getByTestId('bgp-route-ipv4-page')).toBeVisible();
            await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.20.0.0');
            await page.getByTestId('bgp-ipv4-route-mask-input').fill('24');
            await page.getByTestId('bgp-ipv4-route-count-input').fill(String(EXPECTED_ROUTE_COUNT));
            await page.getByTestId('bgp-generate-ipv4-routes-button').click();

            const routeTable = page.getByTestId('bgp-ipv4-route-table');
            await expect(routeTable).toContainText('10.20.0.0/24', { timeout: 10000 });
            await expect(page.getByText(`共 ${EXPECTED_ROUTE_COUNT} 条，每页 20 条`)).toBeVisible();

            routeSnapshot = await controller.waitForRoutes(1, EXPECTED_ROUTE_COUNT);
            await recordStep(
                `Output: workerRoutes=${routeSnapshot.total}, firstRoute=${routeSnapshot.list[0].ip}/${routeSnapshot.list[0].mask}`
            );

            for (const [index, route] of routeSnapshot.list.entries()) {
                await test.step(`Output generated route ${formatRoute(route, index + 1)}`, async () => {
                    expect(route.ip).toMatch(/^10\.20\./u);
                    expect(Number(route.mask)).toBe(24);
                });
            }
        });

        await test.step('Verify the mock client captured BGP UPDATE packets', async () => {
            await recordStep(`Input: expectedReceivedUpdates>=1, expectedRoutes=${EXPECTED_ROUTE_COUNT}`);

            const firstUpdate = await controller.waitForClientEvent('received-update');
            const updates = controller.getClientUpdates();

            expect(updates.length).toBeGreaterThanOrEqual(1);
            await recordStep(`Output: updates=${updates.length}, firstUpdate=${formatClientEvent(firstUpdate)}`);

            for (const update of updates) {
                await test.step(`Output captured UPDATE: ${formatClientEvent(update)}`, async () => {
                    expect(update.summary).toContain('UPDATE');
                });
            }
        });
    });
});
