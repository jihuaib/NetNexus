const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BgpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');
const BgpConst = require('../../electron/const/bgpConst');

const EXPECTED_ROUTE_COUNT = 3;
const LARGE_ROUTE_COUNT = 5000;
const IPV4_UNICAST_ROUTES_PER_FULL_PACKET = 808;
const IPV4_UNICAST_FULL_PACKET_LEN = 4091;
const QP_ROUTES_PER_FULL_PACKET = 402;
const QP_FULL_PACKET_LEN = 4089;
const QP_NEXT_HOP_A = '2001:db8::a';
const QP_NEXT_HOP_B = '2001:db8::b';

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

function expectedPacketCounts(total, perFullPacket) {
    const counts = [];
    let rest = total;
    while (rest > 0) {
        const count = Math.min(rest, perFullPacket);
        counts.push(count);
        rest -= count;
    }
    return counts;
}

function updateRouteCount(update) {
    return update.mpReach ? update.mpReach.nlriCount : update.nlriCount;
}

async function openAndStartIpv4Bgp(page, controller, { localAs = 65535 } = {}) {
    const bgpPort = await BgpE2eController.getFreePort();
    controller.setBgpPort(bgpPort);

    await page.goto('/#/bgp/bgp-config');
    await expect(page.getByTestId('bgp-config-page')).toBeVisible();
    await page.getByTestId('bgp-start-button').click();
    await expect(page.getByTestId('bgp-stop-button')).toBeEnabled();
    await expect(page.getByTestId('bgp-instance-table')).toContainText('Ipv4-UNC', { timeout: 10000 });

    await page.goto('/#/bgp/bgp-peer-config');
    await expect(page.getByTestId('bgp-peer-page')).toBeVisible();
    await page.getByTestId('bgp-ipv4-peer-ip-input').fill('127.0.0.1');
    await page.getByTestId('bgp-ipv4-peer-as-input').fill(String(localAs));
    await page.getByTestId('bgp-ipv4-peer-hold-time-input').fill('90');
    await page.getByTestId('bgp-config-ipv4-peer-button').click();

    await controller.startMockClient({ localAs, routerId: '192.0.2.2', holdTime: 90 });
    await controller.waitForClientEvent('established');
    await controller.waitForPeerState('127.0.0.1', 'Established');

    return bgpPort;
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

        await test.step('Stop BGP from the UI and verify the mock client is disconnected', async () => {
            await recordStep('Input: click BGP stop button while mock client keeps its TCP connection open');

            await page.goto('/#/bgp/bgp-config');
            await expect(page.getByTestId('bgp-stop-button')).toBeEnabled();
            await page.getByTestId('bgp-stop-button').click();

            const closedEvent = await controller.waitForClientEvent('closed', () => true, 5000);
            const exitInfo = await controller.waitForMockClientExit({ timeout: 5000 });
            expect(exitInfo.code).toBe(0);
            expect(exitInfo.signal).toBeNull();
            expect(closedEvent.updateCount).toBeGreaterThanOrEqual(1);

            await expect(page.getByTestId('bgp-stop-button')).toBeDisabled();
            await expect(page.getByTestId('bgp-instance-table')).not.toContainText('Ipv4-UNC');

            await recordStep(
                `Output: stopButtonDisabled=true, mockClientExitCode=${exitInfo.code}, closedUpdates=${closedEvent.updateCount}`
            );
        });
    });

    test('packetizes large IPv4 route batches into multiple parsed UPDATE packets', async ({ page }) => {
        await test.step('Start an iBGP IPv4 peer over the real BGP TCP path', async () => {
            const bgpPort = await openAndStartIpv4Bgp(page, controller, { localAs: 65535 });
            await recordStep(
                `Output: BGP TCP server started on 127.0.0.1:${bgpPort}, peerState=Established, peerType=IBGP`
            );
        });

        await test.step('Generate more than one 4096-byte page worth of IPv4 routes', async () => {
            await recordStep(`Input: route=/#/bgp/route-ipv4, prefix=10.60.0.1, mask=32, count=${LARGE_ROUTE_COUNT}`);

            await page.goto('/#/bgp/route-ipv4');
            await expect(page.getByTestId('bgp-route-ipv4-page')).toBeVisible();
            await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.60.0.1');
            await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
            await page.getByTestId('bgp-ipv4-route-count-input').fill(String(LARGE_ROUTE_COUNT));
            await page.getByTestId('bgp-generate-ipv4-routes-button').click();

            await expect(page.getByText(`共 ${LARGE_ROUTE_COUNT} 条，每页 20 条`)).toBeVisible({ timeout: 20000 });
            const routeSnapshot = await controller.waitForRoutes(1, LARGE_ROUTE_COUNT, 20000);
            await recordStep(
                `Output: workerRoutes=${routeSnapshot.total}, firstRoute=${routeSnapshot.list[0].ip}/${routeSnapshot.list[0].mask}`
            );
        });

        await test.step('Verify every sent UPDATE is parsed and the batch spans multiple full packets plus a tail', async () => {
            const updates = await controller.waitForClientUpdates(items => {
                return items.reduce((sum, update) => sum + updateRouteCount(update), 0) >= LARGE_ROUTE_COUNT;
            }, 20000);
            const counts = updates.map(updateRouteCount);
            const fullPacketCount = counts.filter(count => count === IPV4_UNICAST_ROUTES_PER_FULL_PACKET).length;

            expect(updates.length).toBeGreaterThan(1);
            expect(fullPacketCount).toBeGreaterThan(1);
            expect(counts[counts.length - 1]).toBeLessThan(IPV4_UNICAST_ROUTES_PER_FULL_PACKET);
            expect(counts).toEqual(expectedPacketCounts(LARGE_ROUTE_COUNT, IPV4_UNICAST_ROUTES_PER_FULL_PACKET));
            expect(counts.reduce((sum, count) => sum + count, 0)).toBe(LARGE_ROUTE_COUNT);

            for (const update of updates) {
                expect(update.valid).toBe(true);
                expect(update.length).toBeLessThanOrEqual(BgpConst.BGP_MAX_PKT_SIZE);
                expect(update.pathAttrTypes).toEqual([
                    BgpConst.BGP_PATH_ATTR.ORIGIN,
                    BgpConst.BGP_PATH_ATTR.AS_PATH,
                    BgpConst.BGP_PATH_ATTR.NEXT_HOP,
                    BgpConst.BGP_PATH_ATTR.MED,
                    BgpConst.BGP_PATH_ATTR.LOCAL_PREF
                ]);
                if (updateRouteCount(update) === IPV4_UNICAST_ROUTES_PER_FULL_PACKET) {
                    expect(update.length).toBe(IPV4_UNICAST_FULL_PACKET_LEN);
                }
            }

            await recordStep(
                `Output: updates=${updates.length}, nlriPerUpdate=${counts.join(',')}, fullPackets=${fullPacketCount}`
            );
        });
    });

    test('packetizes interleaved IPv4 QP routes by shared attributes into multiple parsed UPDATE packets', async ({
        page
    }) => {
        await test.step('Start an IPv4 QP BGP instance and seed interleaved route attributes before peer establishment', async () => {
            const bgpPort = await BgpE2eController.getFreePort();
            controller.setBgpPort(bgpPort);

            await page.goto('/#/bgp/bgp-config');
            await expect(page.getByTestId('bgp-config-page')).toBeVisible();
            const startResult = await page.evaluate(
                addressFamily =>
                    window.bgpApi.startBgp({
                        localAs: '65535',
                        routerId: '192.168.56.1',
                        addressFamily: [addressFamily]
                    }),
                BgpConst.BGP_ADDR_FAMILY.IPV4_QP
            );
            expect(startResult.status).toBe('success');

            const seedResult = controller.seedInterleavedIpv4QpRoutes({
                count: LARGE_ROUTE_COUNT,
                nextHopA: QP_NEXT_HOP_A,
                nextHopB: QP_NEXT_HOP_B
            });
            expect(seedResult.routeCount).toBe(LARGE_ROUTE_COUNT);
            expect(seedResult.attrCount).toBe(2);
            expect(seedResult.attrGroupCount).toBe(2);

            await page.goto('/#/bgp/route-ipv4-qp');
            await expect(page.getByText('IPv4-QP路由配置')).toBeVisible();
            await expect(page.getByText(`共 ${LARGE_ROUTE_COUNT} 条，每页 20 条`)).toBeVisible({ timeout: 20000 });
            await recordStep(
                `Output: port=${bgpPort}, seededRoutes=${seedResult.routeCount}, attrCount=${seedResult.attrCount}, attrGroups=${seedResult.attrGroupCount}`
            );
        });

        await test.step('Establish a QP-capable iBGP peer and receive the pre-seeded routes', async () => {
            const peerResult = await page.evaluate(
                ({ addressFamily, openCap }) =>
                    window.bgpApi.configIpv4Peer({
                        peerIp: '127.0.0.1',
                        peerAs: '65535',
                        holdTime: '90',
                        openCap,
                        addressFamily: [addressFamily],
                        role: '',
                        openCapCustom: ''
                    }),
                {
                    addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_QP,
                    openCap: [
                        BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
                        BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
                        BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS
                    ]
                }
            );
            expect(peerResult.status).toBe('success');

            await controller.startMockClient({
                localAs: 65535,
                routerId: '192.0.2.2',
                holdTime: 90,
                addressFamilies: ['ipv4-qp']
            });
            await controller.waitForClientEvent('established');
            await controller.waitForPeerState('127.0.0.1', 'Established', 10000, BgpConst.BGP_ADDR_FAMILY.IPV4_QP);
            await recordStep('Output: IPv4-QP peerState=Established, peerType=IBGP');
        });

        await test.step('Verify QP UPDATEs are grouped by nextHop attribute after parser round-trip', async () => {
            const updates = await controller.waitForClientUpdates(items => {
                return items.reduce((sum, update) => sum + updateRouteCount(update), 0) >= LARGE_ROUTE_COUNT;
            }, 20000);
            const qpUpdates = updates.filter(update => update.mpReach?.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP);
            const parsedByNextHop = new Map();

            for (const update of qpUpdates) {
                expect(update.valid).toBe(true);
                expect(update.length).toBeLessThanOrEqual(BgpConst.BGP_MAX_PKT_SIZE);
                expect(update.mpReach.afi).toBe(BgpConst.BGP_AFI_TYPE.AFI_IPV4);
                expect(update.pathAttrTypes).toEqual([
                    BgpConst.BGP_PATH_ATTR.ORIGIN,
                    BgpConst.BGP_PATH_ATTR.AS_PATH,
                    BgpConst.BGP_PATH_ATTR.MED,
                    BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
                    BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI
                ]);
                if (!parsedByNextHop.has(update.mpReach.nextHop)) {
                    parsedByNextHop.set(update.mpReach.nextHop, { counts: [], lengths: [] });
                }
                parsedByNextHop.get(update.mpReach.nextHop).counts.push(updateRouteCount(update));
                parsedByNextHop.get(update.mpReach.nextHop).lengths.push(update.length);
            }

            const expectedGroupCounts = expectedPacketCounts(LARGE_ROUTE_COUNT / 2, QP_ROUTES_PER_FULL_PACKET);
            expect(parsedByNextHop.size).toBe(2);
            expect(parsedByNextHop.get(QP_NEXT_HOP_A)?.counts).toEqual(expectedGroupCounts);
            expect(parsedByNextHop.get(QP_NEXT_HOP_B)?.counts).toEqual(expectedGroupCounts);

            for (const group of parsedByNextHop.values()) {
                expect(group.counts.length).toBeGreaterThan(1);
                expect(group.counts.filter(count => count === QP_ROUTES_PER_FULL_PACKET).length).toBeGreaterThan(1);
                expect(group.counts[group.counts.length - 1]).toBeLessThan(QP_ROUTES_PER_FULL_PACKET);
                group.counts.forEach((count, index) => {
                    if (count === QP_ROUTES_PER_FULL_PACKET) {
                        expect(group.lengths[index]).toBe(QP_FULL_PACKET_LEN);
                    }
                });
            }

            const totalRoutes = [...parsedByNextHop.values()].reduce(
                (sum, group) => sum + group.counts.reduce((innerSum, count) => innerSum + count, 0),
                0
            );
            expect(totalRoutes).toBe(LARGE_ROUTE_COUNT);
            await recordStep(
                `Output: qpUpdates=${qpUpdates.length}, nextHopA=${parsedByNextHop.get(QP_NEXT_HOP_A)?.counts.join(',')}, nextHopB=${parsedByNextHop.get(QP_NEXT_HOP_B)?.counts.join(',')}`
            );
        });
    });
});
