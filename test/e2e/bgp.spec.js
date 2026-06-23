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
const ADD_PATH_E2E_PREFIX_COUNT = 300;
const ADD_PATH_E2E_PATH_COUNT = 10;
const ADD_PATH_IPV4_32_NLRI_LEN = 9;
const ADD_PATH_SRV6_FIXED_SID = '2001:db8:880::1';

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

function updateNlri(update) {
    return update.mpReach ? update.mpReach.nlri || [] : update.nlri || [];
}

function isFamilyUpdate(update, afi, safi) {
    return update.mpReach?.afi === afi && update.mpReach?.safi === safi;
}

function flattenUpdateNlri(updates) {
    return updates.flatMap(updateNlri);
}

function ipv4FromNumber(value) {
    return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function updateSrv6Sid(update) {
    return update.prefixSid?.srv6Services?.[0]?.sidInfos?.[0]?.sid || '';
}

function updateSrv6Endpoint(update) {
    return update.prefixSid?.srv6Services?.[0]?.sidInfos?.[0]?.endpointBehaviorName || '';
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

    test('negotiates ADD-PATH and SRv6 per address family and validates receiver-parsed UPDATEs', async ({ page }) => {
        test.setTimeout(120000);

        const ipv4BaseIp = (10 << 24) + (80 << 16) + 1;
        const ipv4TotalPaths = ADD_PATH_E2E_PREFIX_COUNT * ADD_PATH_E2E_PATH_COUNT;

        await test.step('Start BGP with IPv4-UNC and IPv6-UNC instances', async () => {
            const bgpPort = await BgpE2eController.getFreePort();
            controller.setBgpPort(bgpPort);

            await page.goto('/#/bgp/bgp-config');
            await expect(page.getByTestId('bgp-config-page')).toBeVisible();

            const startResult = await page.evaluate(
                addressFamily =>
                    window.bgpApi.startBgp({
                        localAs: '65535',
                        routerId: '192.168.56.1',
                        addressFamily
                    }),
                [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, BgpConst.BGP_ADDR_FAMILY.IPV6_UNC]
            );
            expect(startResult.status).toBe('success');
            await recordStep(`Output: BGP TCP server started on 127.0.0.1/::1:${bgpPort}, instances=IPv4-UNC,IPv6-UNC`);
        });

        await test.step('Configure an IPv6 peer with ADD-PATH and SRv6 enabled only for IPv4-UNC', async () => {
            const peerResult = await page.evaluate(
                ({ openCapIpv6, addressFamilyIpv6, addressFamilyConfig }) =>
                    window.bgpApi.configIpv6Peer({
                        peerIpv6: '::1',
                        peerIpv6As: '65535',
                        holdTimeIpv6: '90',
                        openCapIpv6,
                        addressFamilyIpv6,
                        addressFamilyConfig,
                        roleIpv6: '',
                        openCapCustomIpv6: ''
                    }),
                {
                    openCapIpv6: [
                        BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
                        BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
                        BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS,
                        BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH,
                        BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING
                    ],
                    addressFamilyIpv6: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, BgpConst.BGP_ADDR_FAMILY.IPV6_UNC],
                    addressFamilyConfig: {
                        [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]: {
                            sendAddPath: true,
                            sendSrv6PrefixSid: true
                        },
                        [BgpConst.BGP_ADDR_FAMILY.IPV6_UNC]: {
                            sendAddPath: false,
                            sendSrv6PrefixSid: false
                        }
                    }
                }
            );
            expect(peerResult.status).toBe('success');

            await controller.startMockClient({
                host: '::1',
                localAs: 65535,
                routerId: '192.0.2.2',
                holdTime: 90,
                addressFamilies: ['ipv4-unc', 'ipv6-unc'],
                addPathAddressFamilies: ['ipv4-unc'],
                extendedNextHop: true
            });
            await controller.waitForClientEvent('established');
            const ipv4Peer = await controller.waitForPeerState(
                '::1',
                'Established',
                10000,
                BgpConst.BGP_ADDR_FAMILY.IPV4_UNC
            );
            const ipv6Peer = await controller.waitForPeerState(
                '::1',
                'Established',
                10000,
                BgpConst.BGP_ADDR_FAMILY.IPV6_UNC
            );

            expect(ipv4Peer.addPathSendEnabled).toBe(true);
            expect(ipv4Peer.addPathReceiveEnabled).toBe(false);
            expect(ipv4Peer.sendSrv6PrefixSid).toBe(true);
            expect(ipv6Peer.addPathSendEnabled).toBe(false);
            expect(ipv6Peer.addPathReceiveEnabled).toBe(false);
            expect(ipv6Peer.sendSrv6PrefixSid).toBe(false);
            await recordStep(`Output: IPv4-UNC addPath=发送 srv6=发送, IPv6-UNC addPath=未协商 srv6=不发送`);
        });

        await test.step('Generate IPv4 ADD-PATH routes with fixed SRv6 SID and verify local RD/path-id state', async () => {
            const generateResult = await page.evaluate(
                ({ addressFamily, prefix, count, pathCount, fixedSid, endpointBehavior, sidMode }) =>
                    window.bgpApi.generateIpv4Routes({
                        addressFamily,
                        prefix,
                        mask: '32',
                        count: String(count),
                        addPathEnabled: true,
                        addPathCount: String(pathCount),
                        customAttr: '',
                        rt: '',
                        srv6Enabled: true,
                        srv6SidMode: sidMode,
                        srv6Sid: fixedSid,
                        srv6SidStep: '1',
                        srv6EndpointBehavior: endpointBehavior
                    }),
                {
                    addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
                    prefix: ipv4FromNumber(ipv4BaseIp),
                    count: ADD_PATH_E2E_PREFIX_COUNT,
                    pathCount: ADD_PATH_E2E_PATH_COUNT,
                    fixedSid: ADD_PATH_SRV6_FIXED_SID,
                    endpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT4,
                    sidMode: BgpConst.BGP_SRV6_SID_MODE.FIXED
                }
            );
            expect(generateResult.status).toBe('success');

            const routeSnapshot = await controller.waitForRoutes(
                BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
                ipv4TotalPaths,
                30000
            );
            expect(routeSnapshot.total).toBe(ipv4TotalPaths);
            expect(
                routeSnapshot.list.slice(0, ADD_PATH_E2E_PATH_COUNT).map(route => ({
                    prefix: `${route.ip}/${route.mask}`,
                    rd: route.rd,
                    pathId: route.pathId,
                    srv6Sid: route.srv6Sid
                }))
            ).toEqual(
                Array.from({ length: ADD_PATH_E2E_PATH_COUNT }, (_, pathId) => ({
                    prefix: `${ipv4FromNumber(ipv4BaseIp)}/32`,
                    rd: '0:0',
                    pathId,
                    srv6Sid: ADD_PATH_SRV6_FIXED_SID
                }))
            );
            await recordStep(`Output: generatedIPv4Routes=${routeSnapshot.total}, firstPrefixRD=0:0,pathId=0..9`);
        });

        await test.step('Verify the receiver parses IPv4 ADD-PATH SRv6 UPDATE packetization', async () => {
            const updates = await controller.waitForClientUpdates(items => {
                const ipv4Updates = items.filter(update =>
                    isFamilyUpdate(update, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
                );
                return ipv4Updates.reduce((sum, update) => sum + updateRouteCount(update), 0) >= ipv4TotalPaths;
            }, 30000);
            const ipv4Updates = updates.filter(update =>
                isFamilyUpdate(update, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
            );
            const ipv4Nlri = flattenUpdateNlri(ipv4Updates);
            const updateCounts = ipv4Updates.map(updateRouteCount);
            const fullUpdates = ipv4Updates.slice(0, -1);

            expect(ipv4Updates.length).toBeGreaterThan(1);
            expect(ipv4Nlri).toHaveLength(ipv4TotalPaths);
            expect(new Set(updateNlri(ipv4Updates[0]).map(route => route.pathId))).toEqual(
                new Set(Array.from({ length: ADD_PATH_E2E_PATH_COUNT }, (_, pathId) => pathId))
            );

            for (const update of ipv4Updates) {
                expect(update.valid).toBe(true);
                expect(update.length).toBeLessThanOrEqual(BgpConst.BGP_MAX_PKT_SIZE);
                expect(updateSrv6Sid(update)).toBe(ADD_PATH_SRV6_FIXED_SID);
                expect(updateSrv6Endpoint(update)).toBe('End.DT4');
                expect(update.pathAttrTypes).toContain(BgpConst.BGP_PATH_ATTR.PREFIX_SID);
            }

            for (const update of fullUpdates) {
                expect(update.length + ADD_PATH_IPV4_32_NLRI_LEN).toBeGreaterThanOrEqual(BgpConst.BGP_MAX_PKT_SIZE);
            }
            expect(updateCounts[updateCounts.length - 1]).toBeLessThan(updateCounts[0]);

            ipv4Nlri.forEach((route, index) => {
                const prefixIndex = Math.floor(index / ADD_PATH_E2E_PATH_COUNT);
                const expectedPathId = index % ADD_PATH_E2E_PATH_COUNT;
                expect({
                    prefix: route.prefix,
                    length: route.length,
                    pathId: route.pathId
                }).toEqual({
                    prefix: ipv4FromNumber(ipv4BaseIp + prefixIndex),
                    length: 32,
                    pathId: expectedPathId
                });
            });

            await recordStep(
                `Output: receiverParsedIPv4Updates=${ipv4Updates.length}, nlriPerUpdate=${updateCounts.join(',')}`
            );
        });

        await test.step('Generate IPv6 ADD-PATH local routes while IPv6 ADD-PATH send is disabled', async () => {
            const generateResult = await page.evaluate(
                ({ addressFamily, count, pathCount, endpointBehavior, sidMode }) =>
                    window.bgpApi.generateIpv6Routes({
                        addressFamily,
                        prefix: '2001:db8:990::1',
                        mask: '128',
                        count: String(count),
                        addPathEnabled: true,
                        addPathCount: String(pathCount),
                        customAttr: '',
                        rt: '',
                        srv6Enabled: false,
                        srv6SidMode: sidMode,
                        srv6Sid: '2001:db8:991::1',
                        srv6SidStep: '1',
                        srv6EndpointBehavior: endpointBehavior
                    }),
                {
                    addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV6_UNC,
                    count: ADD_PATH_E2E_PREFIX_COUNT,
                    pathCount: ADD_PATH_E2E_PATH_COUNT,
                    endpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6,
                    sidMode: BgpConst.BGP_SRV6_SID_MODE.FIXED
                }
            );
            expect(generateResult.status).toBe('success');

            const routeSnapshot = await controller.waitForRoutes(
                BgpConst.BGP_ADDR_FAMILY.IPV6_UNC,
                ipv4TotalPaths,
                30000
            );
            expect(routeSnapshot.total).toBe(ipv4TotalPaths);
            await recordStep(`Output: generatedIPv6LocalPathRoutes=${routeSnapshot.total}`);
        });

        await test.step('Verify the receiver parses IPv6 as ordinary NLRI without path-id or SRv6 leakage', async () => {
            const updates = await controller.waitForClientUpdates(items => {
                const ipv6Updates = items.filter(update =>
                    isFamilyUpdate(update, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
                );
                return (
                    ipv6Updates.reduce((sum, update) => sum + updateRouteCount(update), 0) >= ADD_PATH_E2E_PREFIX_COUNT
                );
            }, 30000);
            const ipv6Updates = updates.filter(update =>
                isFamilyUpdate(update, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
            );
            const ipv6Nlri = flattenUpdateNlri(ipv6Updates);

            expect(ipv6Nlri).toHaveLength(ADD_PATH_E2E_PREFIX_COUNT);
            for (const update of ipv6Updates) {
                expect(update.valid).toBe(true);
                expect(update.length).toBeLessThanOrEqual(BgpConst.BGP_MAX_PKT_SIZE);
                expect(update.prefixSid).toBeNull();
                expect(update.pathAttrTypes).not.toContain(BgpConst.BGP_PATH_ATTR.PREFIX_SID);
            }

            ipv6Nlri.forEach((route, index) => {
                expect(route).toEqual(
                    expect.objectContaining({
                        prefix: `2001:db8:990::${(index + 1).toString(16)}`,
                        length: 128,
                        pathId: 0
                    })
                );
            });

            await recordStep(
                `Output: receiverParsedIPv6Updates=${ipv6Updates.length}, ordinaryNlri=${ipv6Nlri.length}, encodedPathId=none`
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
