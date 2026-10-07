const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BgpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');
const BgpConst = require('../../electron/const/bgpConst');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXPECTED_ROUTE_COUNT = 3;
const LARGE_ROUTE_COUNT = 5000;
const IPV4_UNICAST_ROUTES_PER_FULL_PACKET = 809;
const IPV4_UNICAST_FULL_PACKET_LEN = 4096;
const QP_ROUTES_PER_FULL_PACKET = 402;
const QP_FULL_PACKET_LEN = 4089;
const QP_NEXT_HOP_A = '2001:db8::a';
const QP_NEXT_HOP_B = '2001:db8::b';
const ADD_PATH_E2E_PREFIX_COUNT = 300;
const ADD_PATH_E2E_PATH_COUNT = 10;
const ADD_PATH_IPV4_32_NLRI_LEN = 9;
const ADD_PATH_SRV6_FIXED_SID = '2001:db8:880::1';
const FIXED_EXTENDED_COMMUNITIES = 'rt:65000:100 soo:65000:200 hex:0002fde800000064';
const OTHER_EXTENDED_COMMUNITIES = 'rt:192.0.2.1:300 soo:65536:400 hex:430a010203040506';
const FIXED_EXTENDED_HEX = ['0002fde800000064', '0003fde8000000c8', '0002fde800000064'];
const OTHER_EXTENDED_HEX = ['0102c0000201012c', '0203000100000190', '430a010203040506'];

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

function flattenWithdrawnRoutes(updates) {
    return updates.flatMap(update => update.mpUnreach?.withdrawnRoutes || update.withdrawnRoutes || []);
}

function routeIdentities(routes) {
    return routes.map(route => `${route.prefix ?? route.ip}/${route.length ?? route.mask}#${route.pathId ?? 0}`).sort();
}

function managedGroupConfig(groupId, prefix, { count = 1, paths = 1, med = 10, mask = 32 } = {}) {
    return {
        groupId,
        groupName: `Group ${groupId}`,
        addressFamily: 1,
        prefix,
        mask: String(mask),
        count: String(count),
        nlriEncoding: 'mpReach',
        nlriRules: [
            { type: 'mpNextHop', mode: 'fixed', value: '192.0.2.250' },
            { type: 'addPath', count: paths }
        ],
        attributeRules: [
            { type: 'origin', mode: 'fixed', value: 'IGP' },
            { type: 'asPath', mode: 'fixed', value: '65001' },
            { type: 'med', mode: 'fixed', value: med }
        ]
    };
}

async function getRouteSnapshot(controller) {
    const result = await controller.invokeWorker('getRoutes', { addressFamily: 1, page: 1, pageSize: 25 });
    expect(result.status).toBe('success');
    return result.data;
}

async function generateManagedGroup(page, config) {
    return page.evaluate(payload => window.bgpApi.generateIpv4Routes(payload), config);
}

async function getGroupStates(page) {
    const result = await page.evaluate(() => window.bgpApi.getRouteGroupStates());
    expect(result.status).toBe('success');
    return result.data.groups;
}

async function clearToasts(page) {
    await page.mouse.move(600, 500);
    await expect(page.locator('.nn-toast')).toHaveCount(0);
}

function ipv4TestPrefix(page) {
    return page.url().includes('/route-ipv4-label') ? 'bgp-ipv4-label' : 'bgp-ipv4';
}
function ipv4GenerateButton(page) {
    return page.getByTestId(
        ipv4TestPrefix(page) === 'bgp-ipv4'
            ? 'bgp-generate-ipv4-routes-button'
            : 'bgp-ipv4-label-generate-routes-button'
    );
}

async function openIpv4GroupMenu(page) {
    const groupId = await page
        .getByTestId(`${ipv4TestPrefix(page)}-route-workspace`)
        .getAttribute('data-active-group-id');
    await page.getByTestId(`${ipv4TestPrefix(page)}-tree-group-${groupId}`).click({ button: 'right' });
    await expect(page.getByTestId(`${ipv4TestPrefix(page)}-group-context-menu`)).toBeVisible();
}

async function expectGeneratedCount(page, count) {
    const generateButton = ipv4GenerateButton(page);
    await expect(generateButton).toBeEnabled();
    const selected = page.locator('[role="treeitem"][aria-selected="true"] .route-tree-title');
    const previous = await selected.evaluate(element => {
        const testId = element.dataset.testid;
        return {
            testId,
            index: Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)).indexOf(element)
        };
    });
    if (count === 0) await expect(generateButton).toHaveText('生成本组路由');
    await openIpv4GroupMenu(page);
    const menu = page.getByTestId(`${ipv4TestPrefix(page)}-group-context-menu`);
    if (count > 0) await expect(menu.locator('.nn-context-menu-meta')).toHaveText(`已生成 ${count} 条`);
    else
        await expect(page.getByTestId(`${ipv4TestPrefix(page)}-withdraw-group-button`)).toHaveAttribute(
            'aria-disabled',
            'true'
        );
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // Opening the group menu should not leave a different editor selected.
    await page.getByTestId(previous.testId).nth(previous.index).click();
}

async function withdrawTreeGroup(page, groupId) {
    await page.getByTestId(`${ipv4TestPrefix(page)}-tree-group-${groupId}`).click({ button: 'right' });
    await expect(page.getByTestId(`${ipv4TestPrefix(page)}-group-context-menu`)).toBeVisible();
    const action = page.getByTestId(`${ipv4TestPrefix(page)}-withdraw-group-button`);
    await expect(action).not.toHaveAttribute('aria-disabled', 'true');
    await action.click();
}

function extendedCommunityAttributes(update) {
    return update.pathAttributes.filter(
        attribute => attribute.typeCode === BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES
    );
}

function expectExtendedCommunityBytes(attribute, hexValues) {
    expect(attribute.length).toBe(hexValues.length * 8);
    expect(attribute.valueHex).toBe(hexValues.join(''));
    expect(attribute.extendedCommunities.map(community => community.rawHex)).toEqual(hexValues);
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

async function setTreeRuleMode(page, name) {
    await page.getByTestId(`${ipv4TestPrefix(page)}-attribute-mode-select`).click();
    await page.getByRole('option', { name, exact: true }).click();
}

async function addTreeRule(page, type) {
    const registry = require('../../shared/bgpAttributes.json');
    const section = registry.attributes.find(entry => entry.type === type).section || 'attributes';
    const groupId = await page
        .getByTestId(`${ipv4TestPrefix(page)}-route-workspace`)
        .getAttribute('data-active-group-id');
    await page.getByTestId(`${ipv4TestPrefix(page)}-tree-${section}-${groupId}`).click({ button: 'right' });
    const menu = page.getByTestId(`${ipv4TestPrefix(page)}-${section === 'nlri' ? 'nlri' : 'attribute'}-context-menu`);
    await expect(menu).toBeVisible();
    await menu.getByTestId(`${ipv4TestPrefix(page)}-add-attribute-button`).hover();
    await page.getByTestId(`${ipv4TestPrefix(page)}-add-attribute-${type}`).click();
}

async function removeTreeRule(page, node, section = 'attribute') {
    await node.click({ button: 'right' });
    const menu = page.getByTestId(`${ipv4TestPrefix(page)}-${section}-context-menu`);
    await expect(menu).toBeVisible();
    await menu.getByTestId(`${ipv4TestPrefix(page)}-remove-attribute-button`).click();
}

async function ensureTreeRule(page, type) {
    const node = page.getByTestId(`${ipv4TestPrefix(page)}-tree-attribute-${type}`);
    if (await node.count()) await node.first().click();
    else await addTreeRule(page, type);
}

async function clearTreePathAttributes(page) {
    const registry = require('../../shared/bgpAttributes.json');
    for (const definition of registry.attributes.filter(entry => (entry.section || 'attributes') === 'attributes')) {
        const nodes = page.getByTestId(`${ipv4TestPrefix(page)}-tree-attribute-${definition.type}`);
        while (await nodes.count()) {
            await removeTreeRule(page, nodes.first());
        }
    }
}

async function configureTreeMpNextHop(page, mode, value) {
    await ensureTreeRule(page, 'mpNextHop');
    await setTreeRuleMode(page, mode);
    if (value !== undefined)
        await page
            .getByTestId(`${ipv4TestPrefix(page)}-attribute-${mode === '值列表' ? 'values' : 'value'}-input`)
            .fill(value);
}

async function openAndStartIpv4Bgp(page, controller, { localAs = 65535, addPath = false } = {}) {
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

    if (addPath) {
        const result = await page.evaluate(
            ({ localAs, capabilities, addressFamily }) =>
                window.bgpApi.configIpv4Peer({
                    peerIp: '127.0.0.1',
                    peerAs: String(localAs),
                    holdTime: '90',
                    openCap: capabilities,
                    addressFamily: [addressFamily],
                    addressFamilyConfig: { [addressFamily]: { sendAddPath: true } }
                }),
            {
                localAs,
                addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
                capabilities: [
                    BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
                    BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
                    BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS,
                    BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH
                ]
            }
        );
        expect(result.status).toBe('success');
    }
    await controller.startMockClient({
        localAs,
        routerId: '192.0.2.2',
        holdTime: 90,
        addPathAddressFamilies: addPath ? ['ipv4-unc'] : []
    });
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

    test.afterEach(async ({ page }) => {
        if (!controller) {
            return;
        }

        // TCP UPDATEs can arrive before the page finishes refreshing its snapshot.
        // Let the UI finish before stopping its backend during test cleanup.
        const generateButton = page.getByTestId('bgp-generate-ipv4-routes-button');
        if (await generateButton.isVisible()) await expect(generateButton).toBeEnabled();
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
            await expect(page.getByText(`共 ${EXPECTED_ROUTE_COUNT} 条，每页 25 条`)).toBeVisible();

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

    test('sends IPv4 tree rules with MP_REACH and ADD-PATH, then withdraws with MP_UNREACH', async ({ page }) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openAndStartIpv4Bgp(page, controller, { localAs: 65535, addPath: true });
        await page.goto('/#/bgp/route-ipv4');
        await expect(page.getByTestId('bgp-generate-ipv4-routes-button')).toBeEnabled();
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.51.0.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('5');
        await expect(page.getByTestId('bgp-ipv4-route-count-input')).toHaveValue('5');
        await page.getByTestId('bgp-ipv4-nlri-encoding-select').click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await ensureTreeRule(page, 'addPath');
        await page.getByTestId('bgp-ipv4-attribute-count-input').fill('2');
        await expect(page.getByTestId('bgp-ipv4-route-range-preview')).toContainText('5 个前缀 × 2 条路径 = 10 条路由');
        await configureTreeMpNextHop(page, '固定值', '192.0.2.200');
        await clearTreePathAttributes(page);
        await addTreeRule(page, 'origin');
        await addTreeRule(page, 'asPath');
        await setTreeRuleMode(page, '值列表');
        await page.getByTestId('bgp-ipv4-attribute-values-input').fill('65001 65002\n65003');
        await addTreeRule(page, 'med');
        await setTreeRuleMode(page, '递增');
        await page.getByTestId('bgp-ipv4-attribute-start-input').fill('10');
        await page.getByTestId('bgp-ipv4-attribute-step-input').fill('10');
        await addTreeRule(page, 'localPref');
        await addTreeRule(page, 'communities');
        await setTreeRuleMode(page, '随机');
        await page.getByTestId('bgp-ipv4-attribute-base-input').fill('65000');
        await page.getByTestId('bgp-ipv4-attribute-min-input').fill('100');
        await page.getByTestId('bgp-ipv4-attribute-max-input').fill('200');
        await page.getByTestId('bgp-generate-ipv4-routes-button').click();

        const routes = await controller.waitForRoutes(1, 10);
        expect(routes.total, JSON.stringify(controller.lastGeneratedIpv4RouteConfig)).toBe(10);
        expect(routes.list.map(route => route.med)).toEqual(Array.from({ length: 10 }, (_, index) => (index + 1) * 10));
        expect(routes.list.map(route => route.asPath)).toEqual(
            Array.from({ length: 10 }, (_, index) => (index % 2 ? '65003' : '65001 65002'))
        );
        for (const route of routes.list) {
            expect(route.mpNextHop).toBe('192.0.2.200');
            expect(route.nextHop).toBe('');
            expect(route.nlriEncoding).toBe('mpReach');
            expect(route.communities).toHaveLength(1);
            const low = Number(route.communities[0].split(':')[1]);
            expect(low).toBeGreaterThanOrEqual(100);
            expect(low).toBeLessThanOrEqual(200);
        }
        const expectedRoutes = Array.from({ length: 5 }, (_, index) => [
            { prefix: `10.51.0.${index + 1}`, length: 32, pathId: 0 },
            { prefix: `10.51.0.${index + 1}`, length: 32, pathId: 1 }
        ]).flat();
        const updates = await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 10);
        expect(routeIdentities(flattenUpdateNlri(updates))).toEqual(routeIdentities(expectedRoutes));
        for (const [index, update] of updates.entries()) {
            expect(update.valid).toBe(true);
            expect(update.pathAttrTypes).toEqual([
                BgpConst.BGP_PATH_ATTR.ORIGIN,
                BgpConst.BGP_PATH_ATTR.AS_PATH,
                BgpConst.BGP_PATH_ATTR.MED,
                BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
                BgpConst.BGP_PATH_ATTR.COMMUNITY,
                BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI
            ]);
            expect(update.pathAttributes[1].asPath).toBe(index % 2 ? '65003' : '65001 65002');
            expect(update.pathAttributes[2].med).toBe((index + 1) * 10);
            expect(update.nlriCount).toBe(0);
            expect(update.mpReach).toMatchObject({ afi: 1, safi: 1, nextHop: '192.0.2.200' });
            expect(update.summary).toContain('UPDATE');
        }
        await expect(page.getByTestId('bgp-ipv4-route-table')).toContainText('10.51.0.5/32');
        await expect(page.getByText('共 10 条，每页 25 条')).toBeVisible();
        await expectGeneratedCount(page, 10);
        const groups = await getGroupStates(page);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            groupId: controller.lastGeneratedIpv4RouteConfig.groupId,
            addressFamily: 1,
            routeCount: 10
        });
        await clearToasts(page);
        await withdrawTreeGroup(page, groups[0].groupId);
        const afterWithdraw = await controller.waitForClientUpdates(
            items => flattenWithdrawnRoutes(items).length >= 10
        );
        const withdrawals = afterWithdraw.filter(update => update.mpUnreach);
        const withdrawn = withdrawals.flatMap(update => update.mpUnreach.withdrawnRoutes);
        expect(routeIdentities(withdrawn)).toEqual(routeIdentities(expectedRoutes));
        for (const update of withdrawals) {
            expect(update.valid).toBe(true);
            expect(update.withdrawnCount).toBe(0);
            expect(update.mpUnreach).toMatchObject({ afi: 1, safi: 1 });
        }
        await expectGeneratedCount(page, 0);
        expect((await getRouteSnapshot(controller)).total).toBe(0);
    });

    test('sends a zero-length MP next hop until explicitly configured and preserves deletion on reannouncement', async ({
        page
    }) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openAndStartIpv4Bgp(page, controller, { localAs: 65535 });
        const peer = await controller.waitForPeerState('127.0.0.1', 'Established');
        await page.goto('/#/bgp/route-ipv4');
        await expect(page.getByTestId('bgp-generate-ipv4-routes-button')).toBeEnabled();
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.66.0.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('1');
        await page.getByTestId('bgp-ipv4-nlri-encoding-select').click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        const mpNode = page.getByTestId('bgp-ipv4-tree-attribute-mpNextHop');
        await expect(mpNode).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-tree-attribute-nextHop').click();
        await setTreeRuleMode(page, '固定值');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('192.0.2.9');

        const expectNextHops = (update, nextHopLength, nextHop) => {
            expect(update.mpReach).toMatchObject({ afi: 1, safi: 1, nextHopLength });
            expect(routeIdentities(updateNlri(update))).toEqual(['10.66.0.1/32#0']);
            const mpAttribute = update.pathAttributes.find(attribute => attribute.typeCode === 14);
            expect(Buffer.from(mpAttribute.valueHex, 'hex')[3]).toBe(nextHopLength);
            if (nextHop !== undefined) expect(update.mpReach.nextHop).toBe(nextHop);
            expect(update.pathAttributes.find(attribute => attribute.typeCode === 3).nextHop).toBe('192.0.2.9');
        };
        const generateAndVerify = async (storedNextHop, nextHopLength, nextHop) => {
            const offset = controller.getClientUpdates().length;
            await page.getByTestId('bgp-generate-ipv4-routes-button').click();
            await expect(page.getByTestId('bgp-generate-ipv4-routes-button')).toBeEnabled();
            const snapshot = await getRouteSnapshot(controller);
            expect(snapshot.total).toBe(1);
            expect(snapshot.list[0]).toMatchObject({
                ip: '10.66.0.1',
                nlriEncoding: 'mpReach',
                mpNextHop: storedNextHop,
                nextHop: '192.0.2.9'
            });
            const updates = await controller.waitForClientUpdates(items =>
                items.slice(offset).some(update => updateNlri(update).some(route => route.prefix === '10.66.0.1'))
            );
            const update = updates
                .slice(offset)
                .find(item => updateNlri(item).some(route => route.prefix === '10.66.0.1'));
            expectNextHops(update, nextHopLength, nextHop);
        };

        await generateAndVerify(null, 0);
        await configureTreeMpNextHop(page, '自动');
        await generateAndVerify('', 4, peer.localIp);
        await configureTreeMpNextHop(page, '固定值', '192.0.2.210');
        await generateAndVerify('192.0.2.210', 4, '192.0.2.210');

        await removeTreeRule(page, mpNode, 'nlri');
        await expect(mpNode).toHaveCount(0);
        const groupId = await page.getByTestId('bgp-ipv4-route-workspace').getAttribute('data-active-group-id');
        await expect(page.getByTestId(`bgp-ipv4-tree-mp-nlri-${groupId}`)).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-save-workspace-button').click();
        await expect
            .poll(() => controller.savedIpv4RouteConfig.nlriRules.some(rule => rule.type === 'mpNextHop'))
            .toBe(false);
        await page.reload();
        await expect(page.getByTestId('bgp-ipv4-nlri-encoding-select')).toContainText('MP_REACH_NLRI');
        await expect(mpNode).toHaveCount(0);
        await generateAndVerify(null, 0);
        expect(controller.lastGeneratedIpv4RouteConfig.nlriRules.some(rule => rule.type === 'mpNextHop')).toBe(false);

        await controller.stopMockClient();
        await controller.waitForPeerState('127.0.0.1', 'Idle');
        await controller.startMockClient({ localAs: 65535, routerId: '192.0.2.2', holdTime: 90 });
        await controller.waitForClientEvent('established');
        await controller.waitForPeerState('127.0.0.1', 'Established');
        const reannounced = await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length === 1);
        expectNextHops(reannounced[0], 0);
        expect((await getRouteSnapshot(controller)).list[0].mpNextHop).toBeNull();
        await expect(mpNode).toHaveCount(0);
    });

    for (const negotiated of [true, false]) {
        test(`sends and withdraws Label group paths with ADD-PATH ${negotiated ? 'negotiated for Label' : 'negotiated only for UNC'}`, async ({
            page
        }) => {
            test.setTimeout(60000);
            await page.setViewportSize({ width: 1440, height: 1000 });
            controller.setBgpPort(await BgpE2eController.getFreePort());
            await page.goto('/#/bgp/bgp-config');
            const families = [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST];
            const start = await page.evaluate(
                addressFamily => window.bgpApi.startBgp({ localAs: '65535', routerId: '192.0.2.1', addressFamily }),
                families
            );
            expect(start.status).toBe('success');
            const configured = await page.evaluate(
                ({ addressFamily, openCap }) =>
                    window.bgpApi.configIpv4Peer({
                        peerIp: '127.0.0.1',
                        peerAs: '65535',
                        holdTime: '90',
                        openCap,
                        addressFamily,
                        addressFamilyConfig: Object.fromEntries(
                            addressFamily.map(family => [family, { sendAddPath: true }])
                        )
                    }),
                {
                    addressFamily: families,
                    openCap: [
                        BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
                        BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
                        BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS,
                        BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH
                    ]
                }
            );
            expect(configured.status).toBe('success');
            await controller.startMockClient({
                localAs: 65535,
                routerId: '192.0.2.2',
                addressFamilies: ['ipv4-unc', 'ipv4-label'],
                addPathAddressFamilies: [negotiated ? 'ipv4-label' : 'ipv4-unc']
            });
            await controller.waitForClientEvent('established');
            const peer = await controller.waitForPeerState(
                '127.0.0.1',
                'Established',
                10000,
                BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST
            );
            expect(peer.addPathSendEnabled).toBe(negotiated);
            const uncPeer = await controller.waitForPeerState('127.0.0.1', 'Established');
            expect(uncPeer.addPathSendEnabled).toBe(!negotiated);

            await page.goto('/#/bgp/route-ipv4-label');
            await expect(page.getByTestId('bgp-ipv4-label-generate-routes-button')).toBeEnabled();
            await page.getByTestId('bgp-ipv4-label-route-prefix-input').fill('10.64.0.1');
            await page.getByTestId('bgp-ipv4-label-route-mask-input').fill('32');
            await page.getByTestId('bgp-ipv4-label-route-count-input').fill('3');
            await page.getByTestId('bgp-ipv4-label-tree-attribute-label').click();
            await page.getByTestId('bgp-ipv4-label-attribute-value-input').fill('100');
            await ensureTreeRule(page, 'addPath');
            await page.getByTestId('bgp-ipv4-label-attribute-count-input').fill('2');
            await configureTreeMpNextHop(page, '固定值', '192.0.2.242');
            await page.getByTestId('bgp-ipv4-label-tree-attribute-med').click();
            await setTreeRuleMode(page, '递增');
            await page.getByTestId('bgp-ipv4-label-attribute-start-input').fill('10');
            await page.getByTestId('bgp-ipv4-label-attribute-step-input').fill('1');
            await page.getByTestId('bgp-ipv4-label-generate-routes-button').click();
            await expectGeneratedCount(page, 6);
            const original = JSON.parse(JSON.stringify(controller.lastGeneratedIpv4RouteConfig));
            const snapshot = await controller.waitForRoutes(12, 6);
            const allPaths = [0, 1, 2].flatMap(index => [0, 1].map(id => `10.64.0.${index + 1}/32#${id}`));
            expect(routeIdentities(snapshot.list)).toEqual(allPaths);
            expect(snapshot.list.every(route => route.label === 100)).toBe(true);
            const wirePaths = negotiated ? allPaths : allPaths.filter(key => key.endsWith('#0'));
            let updates = await controller.waitForClientUpdates(
                items => flattenUpdateNlri(items).length === wirePaths.length
            );
            expect(routeIdentities(flattenUpdateNlri(updates))).toEqual(wirePaths);
            for (const update of updates) {
                expect(update.mpReach).toMatchObject({ afi: 1, safi: 4, nextHop: '192.0.2.242' });
                expect(update.nlriCount).toBe(0);
                for (const route of updateNlri(update)) {
                    expect(route.labels[0].label).toBe(100);
                    const prefixIndex = Number(route.prefix.split('.').pop()) - 1;
                    expect(update.pathAttributes.find(attribute => attribute.typeCode === 4).med).toBe(
                        10 + prefixIndex * 2 + route.pathId
                    );
                }
            }

            let offset = controller.getClientUpdates().length;
            const overlap = await generateManagedGroup(page, { ...original, groupId: 'label-overlap' });
            expect(overlap.status).toBe('error');
            expect((await controller.waitForRoutes(12, 6)).total).toBe(6);
            expect(controller.getClientUpdates()).toHaveLength(offset);

            const shrunk = await generateManagedGroup(page, {
                ...original,
                nlriRules: original.nlriRules.map(rule => (rule.type === 'addPath' ? { ...rule, count: 1 } : rule))
            });
            expect(shrunk.status).toBe('success');
            const afterShrink = await controller.waitForRoutes(12, 3);
            expect(routeIdentities(afterShrink.list)).toEqual(allPaths.filter(key => key.endsWith('#0')));
            updates = await controller.waitForClientUpdates(
                items => flattenUpdateNlri(items.slice(offset)).length === 3
            );
            const shrunkWithdrawals = flattenWithdrawnRoutes(updates.slice(offset));
            expect(routeIdentities(shrunkWithdrawals)).toEqual(
                negotiated ? allPaths.filter(key => key.endsWith('#1')) : []
            );
            expect(
                updates
                    .slice(offset)
                    .filter(update => update.mpUnreach)
                    .every(update => update.mpUnreach.safi === 4)
            ).toBe(true);

            offset = controller.getClientUpdates().length;
            await page.getByTestId(`bgp-ipv4-label-tree-group-${original.groupId}`).click();
            await page.getByTestId('bgp-ipv4-label-route-prefix-input').fill('10.65.0.1');
            await withdrawTreeGroup(page, original.groupId);
            await expectGeneratedCount(page, 0);
            expect((await controller.waitForRoutes(12, 0)).total).toBe(0);
            updates = await controller.waitForClientUpdates(
                items => flattenWithdrawnRoutes(items.slice(offset)).length === 3
            );
            expect(routeIdentities(flattenWithdrawnRoutes(updates.slice(offset)))).toEqual(
                allPaths.filter(key => key.endsWith('#0'))
            );
            expect(updates.slice(offset).every(update => update.mpUnreach?.safi === 4)).toBe(true);
        });
    }

    test('replaces a group snapshot when path count or prefixes change and withdraws its actual routes after draft edits', async ({
        page
    }) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openAndStartIpv4Bgp(page, controller, { localAs: 65535, addPath: true });
        await page.goto('/#/bgp/route-ipv4');
        await expect(page.getByTestId('bgp-generate-ipv4-routes-button')).toBeEnabled();
        await page.getByTestId('bgp-ipv4-route-group-name').fill('Snapshot replacement');
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.54.0.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('2');
        await page.getByTestId('bgp-ipv4-nlri-encoding-select').click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await ensureTreeRule(page, 'addPath');
        await page.getByTestId('bgp-ipv4-attribute-count-input').fill('3');
        await configureTreeMpNextHop(page, '固定值', '192.0.2.250');
        await clearTreePathAttributes(page);
        await addTreeRule(page, 'origin');
        await addTreeRule(page, 'asPath');
        await addTreeRule(page, 'med');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('10');
        await page.getByTestId('bgp-generate-ipv4-routes-button').click();
        await expectGeneratedCount(page, 6);
        const originalConfig = JSON.parse(JSON.stringify(controller.lastGeneratedIpv4RouteConfig));
        expect(originalConfig.groupId).toBeTruthy();
        expect(originalConfig.groupName).toBe('Snapshot replacement');
        expect((await getRouteSnapshot(controller)).total).toBe(6);
        await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 6);

        let offset = controller.getClientUpdates().length;
        const shrunkConfig = {
            ...originalConfig,
            nlriRules: originalConfig.nlriRules.map(rule => (rule.type === 'addPath' ? { ...rule, count: 1 } : rule))
        };
        const shrunk = await generateManagedGroup(page, shrunkConfig);
        expect(shrunk.status).toBe('success');
        expect(shrunk.data).toMatchObject({ deleted: 4, total: 2 });
        const afterShrink = await getRouteSnapshot(controller);
        expect(afterShrink.list.map(route => [route.ip, route.pathId])).toEqual([
            ['10.54.0.1', 0],
            ['10.54.0.2', 0]
        ]);
        let updates = await controller.waitForClientUpdates(
            items =>
                flattenWithdrawnRoutes(items.slice(offset)).length === 4 &&
                flattenUpdateNlri(items.slice(offset)).length >= 2
        );
        expect(routeIdentities(flattenWithdrawnRoutes(updates.slice(offset)))).toEqual([
            '10.54.0.1/32#1',
            '10.54.0.1/32#2',
            '10.54.0.2/32#1',
            '10.54.0.2/32#2'
        ]);
        expect(routeIdentities(flattenUpdateNlri(updates.slice(offset)))).toEqual(['10.54.0.1/32#0', '10.54.0.2/32#0']);

        offset = controller.getClientUpdates().length;
        const movedConfig = { ...shrunkConfig, prefix: '10.55.0.1', count: '1' };
        const moved = await generateManagedGroup(page, movedConfig);
        expect(moved.status).toBe('success');
        expect(moved.data).toMatchObject({ added: 1, deleted: 2, total: 1 });
        updates = await controller.waitForClientUpdates(
            items =>
                flattenWithdrawnRoutes(items.slice(offset)).length === 2 &&
                flattenUpdateNlri(items.slice(offset)).length >= 1
        );
        expect(routeIdentities(flattenWithdrawnRoutes(updates.slice(offset)))).toEqual([
            '10.54.0.1/32#0',
            '10.54.0.2/32#0'
        ]);
        expect(routeIdentities(flattenUpdateNlri(updates.slice(offset)))).toEqual(['10.55.0.1/32#0']);

        offset = controller.getClientUpdates().length;
        const changed = await generateManagedGroup(page, {
            ...movedConfig,
            attributeRules: movedConfig.attributeRules.map(rule =>
                rule.type === 'med' ? { ...rule, value: 20 } : rule
            )
        });
        expect(changed.status).toBe('success');
        expect(changed.data).toMatchObject({ updated: 1, total: 1 });
        updates = await controller.waitForClientUpdates(items =>
            items
                .slice(offset)
                .some(
                    update =>
                        updateNlri(update).some(route => route.prefix === '10.55.0.1') &&
                        update.pathAttributes.some(attr => attr.med === 20)
                )
        );
        expect(flattenWithdrawnRoutes(updates.slice(offset))).toEqual([]);
        expect((await getRouteSnapshot(controller)).list[0]).toMatchObject({ ip: '10.55.0.1', pathId: 0, med: 20 });
        expect(await getGroupStates(page)).toMatchObject([
            { groupId: originalConfig.groupId, groupName: 'Snapshot replacement', routeCount: 1 }
        ]);

        await page.reload();
        await expect(page.getByTestId('bgp-ipv4-route-table')).toContainText('10.55.0.1/32');
        await expect(page.getByText('共 1 条，每页 25 条')).toBeVisible();
        await page.getByTestId(`bgp-ipv4-tree-nlri-${originalConfig.groupId}`).click();
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.99.0.1');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('9');
        await expectGeneratedCount(page, 1);
        offset = controller.getClientUpdates().length;
        await withdrawTreeGroup(page, originalConfig.groupId);
        await expectGeneratedCount(page, 0);
        updates = await controller.waitForClientUpdates(
            items => flattenWithdrawnRoutes(items.slice(offset)).length >= 1
        );
        expect(routeIdentities(flattenWithdrawnRoutes(updates.slice(offset)))).toEqual(['10.55.0.1/32#0']);
        expect(flattenUpdateNlri(updates.slice(offset))).toEqual([]);
        expect((await getRouteSnapshot(controller)).total).toBe(0);
        expect(await getGroupStates(page)).toEqual([]);
        await expect(page.getByTestId('bgp-ipv4-route-prefix-input')).toHaveValue('10.99.0.1');
        await expect(page.getByTestId('bgp-ipv4-route-count-input')).toHaveValue('9');
        const restored = await generateManagedGroup(page, movedConfig);
        expect(restored.status).toBe('success');
        expect(restored.data.total).toBe(1);
        expect((await getGroupStates(page))[0].groupId).toBe(originalConfig.groupId);
    });

    test('rejects overlapping groups even with a different Path ID and preserves both current snapshots', async ({
        page
    }) => {
        test.setTimeout(60000);
        await openAndStartIpv4Bgp(page, controller, { localAs: 65535, addPath: true });
        await page.goto('/#/bgp/route-ipv4');
        const firstConfig = managedGroupConfig('group-a', '10.57.0.13', { count: 2, paths: 2, mask: 24 });
        const secondConfig = managedGroupConfig('group-b', '10.58.0.1', { med: 90 });
        expect((await generateManagedGroup(page, firstConfig)).status).toBe('success');
        expect((await generateManagedGroup(page, secondConfig)).status).toBe('success');
        await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 5);
        const before = await getRouteSnapshot(controller);
        expect(before.total).toBe(5);
        expect(routeIdentities(before.list)).toEqual([
            '10.57.0.0/24#0',
            '10.57.0.0/24#1',
            '10.57.1.0/24#0',
            '10.57.1.0/24#1',
            '10.58.0.1/32#0'
        ]);
        const groupsBefore = await getGroupStates(page);
        expect(groupsBefore).toMatchObject([
            { groupId: 'group-a', groupName: 'Group group-a', addressFamily: 1, routeCount: 4 },
            { groupId: 'group-b', groupName: 'Group group-b', addressFamily: 1, routeCount: 1 }
        ]);
        expect(groupsBefore.every(group => Number(group.generatedAt) > 0)).toBe(true);
        const offset = controller.getClientUpdates().length;
        // The conflict is the third candidate, whose generated Path ID is 2.
        // Group A owns only IDs 0 and 1. Two earlier free candidates must also
        // roll back when normalized 10.57.0.200/24 collides with 10.57.0.0/24.
        const conflictingConfig = {
            ...managedGroupConfig('group-b', '10.59.0.1', { paths: 3, med: 999 }),
            routes: [
                { ip: '10.59.0.1', mask: 32 },
                { ip: '10.59.0.2', mask: 32 },
                { ip: '10.57.0.200', mask: 24 }
            ]
        };
        for (const groupId of ['group-b', 'group-c']) {
            const rejected = await generateManagedGroup(page, {
                ...conflictingConfig,
                groupId,
                groupName: 'Conflicting replacement'
            });
            expect(rejected.status).toBe('error');
            expect(rejected.msg).toContain('Group group-a');
            expect(rejected.msg).toContain('10.57.0.0/24');
            expect(await getRouteSnapshot(controller)).toEqual(before);
            expect(await getGroupStates(page)).toEqual(groupsBefore);
        }
        expect(controller.getClientUpdates().slice(offset)).toEqual([]);
        await page.reload();
        await expect(page.getByText('共 5 条，每页 25 条')).toBeVisible();
        await expect(page.getByTestId('bgp-ipv4-route-table')).toContainText('10.58.0.1/32');

        const withdrawn = await page.evaluate(() => window.bgpApi.withdrawRouteGroup({ groupId: 'group-a' }));
        expect(withdrawn.status).toBe('success');
        expect(withdrawn.data.deleted).toBe(4);
        expect((await getRouteSnapshot(controller)).list[0]).toMatchObject({ ip: '10.58.0.1', med: 90 });
        const accepted = await generateManagedGroup(page, {
            ...conflictingConfig,
            groupId: 'group-c',
            groupName: 'Recovered group'
        });
        expect(accepted.status).toBe('success');
        expect(accepted.data.total).toBe(4);
        expect((await getGroupStates(page)).map(group => group.groupId)).toEqual(['group-b', 'group-c']);
        const after = await getRouteSnapshot(controller);
        expect(after.list.find(route => route.ip === '10.57.0.0')).toMatchObject({ pathId: 2, med: 999 });
        expect(after.list.find(route => route.ip === '10.58.0.1')).toMatchObject({ pathId: 0, med: 90 });
        await recordStep(
            'Output: normalized prefix ownership ignores Path ID; late collisions preserve both snapshots and emit no UPDATE; withdrawing the owner releases its keys'
        );
    });

    test('withdraws the previous NLRI encoding when replacing the same prefix without ADD-PATH', async ({ page }) => {
        test.setTimeout(60000);
        await openAndStartIpv4Bgp(page, controller, { localAs: 65535 });
        await page.goto('/#/bgp/route-ipv4');
        const mpConfig = managedGroupConfig('encoding-transition', '10.59.0.1');
        expect((await generateManagedGroup(page, mpConfig)).status).toBe('success');
        await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 1);
        let offset = controller.getClientUpdates().length;
        const classicConfig = {
            ...mpConfig,
            nlriEncoding: 'auto',
            attributeRules: [...mpConfig.attributeRules, { type: 'nextHop', mode: 'fixed', value: '192.0.2.33' }]
        };
        expect((await generateManagedGroup(page, classicConfig)).status).toBe('success');
        let updates = await controller.waitForClientUpdates(
            items =>
                items.slice(offset).some(update => update.mpUnreach?.withdrawnCount === 1) &&
                items.slice(offset).some(update => update.nlriCount === 1)
        );
        expect(routeIdentities(flattenWithdrawnRoutes(updates.slice(offset)))).toEqual(['10.59.0.1/32#0']);
        const classic = updates.slice(offset).find(update => update.nlriCount === 1);
        expect(classic.mpReach).toBeNull();
        expect(classic.pathAttributes.find(attribute => attribute.typeCode === 3).nextHop).toBe('192.0.2.33');
        expect(routeIdentities(updateNlri(classic))).toEqual(['10.59.0.1/32#0']);
        offset = controller.getClientUpdates().length;
        expect(
            (
                await generateManagedGroup(page, {
                    ...mpConfig,
                    nlriRules: mpConfig.nlriRules.map(rule =>
                        rule.type === 'mpNextHop' ? { ...rule, value: '192.0.2.252' } : rule
                    )
                })
            ).status
        ).toBe('success');
        updates = await controller.waitForClientUpdates(
            items =>
                items.slice(offset).some(update => update.withdrawnCount === 1) &&
                items.slice(offset).some(update => update.mpReach?.nextHop === '192.0.2.252')
        );
        expect(routeIdentities(flattenWithdrawnRoutes(updates.slice(offset)))).toEqual(['10.59.0.1/32#0']);
        expect(routeIdentities(flattenUpdateNlri(updates.slice(offset)))).toEqual(['10.59.0.1/32#0']);
        expect((await getRouteSnapshot(controller)).total).toBe(1);
        expect((await getGroupStates(page))[0].routeCount).toBe(1);
    });

    test('restores generated group ownership from SQLite after a worker restart and withdraws it over TCP', async ({
        page
    }) => {
        test.setTimeout(60000);
        const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-group-e2e-'));
        const databasePath = path.join(tempDirectory, 'routes.sqlite3');
        try {
            controller.routeDatabasePath = databasePath;
            await openAndStartIpv4Bgp(page, controller, { localAs: 65535, addPath: true });
            await page.goto('/#/bgp/route-ipv4');
            const config = managedGroupConfig('persisted-group', '10.56.0.1', { paths: 2 });
            config.attributeRules.splice(2, 0, {
                type: 'extendedCommunities',
                mode: 'fixed',
                value: FIXED_EXTENDED_COMMUNITIES
            });
            config.attributeRules.push({
                type: 'extendedCommunities',
                mode: 'fixed',
                value: OTHER_EXTENDED_COMMUNITIES
            });
            expect((await generateManagedGroup(page, config)).status).toBe('success');
            const routeAttributesBefore = (await getRouteSnapshot(controller)).list.map(route => route.pathAttributes);
            expect(routeAttributesBefore[0].map(attribute => attribute.type)).toEqual([
                'origin',
                'asPath',
                'extendedCommunities',
                'med',
                'extendedCommunities'
            ]);
            const before = await getGroupStates(page);
            expect(before).toMatchObject([
                { groupId: 'persisted-group', groupName: 'Group persisted-group', routeCount: 2 }
            ]);
            await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 2);
            expect(fs.existsSync(databasePath)).toBe(true);
            const bgpConfig = { ...controller.savedBgpConfig };
            const peerConfig = { ...controller.savedIpv4PeerConfig };
            expect((await controller.stopBgp()).status).toBe('success');
            await controller.waitForMockClientExit();
            controller.worker = controller.createWorker();
            expect((await controller.startBgp(bgpConfig)).status).toBe('success');
            expect((await controller.configIpv4Peer(peerConfig)).status).toBe('success');
            await controller.startMockClient({
                localAs: 65535,
                routerId: '192.0.2.2',
                addPathAddressFamilies: ['ipv4-unc']
            });
            await controller.waitForClientEvent('established');
            await controller.waitForPeerState('127.0.0.1', 'Established');
            expect(await getGroupStates(page)).toEqual(before);
            const restored = await getRouteSnapshot(controller);
            expect(restored.total).toBe(2);
            expect(restored.list.map(route => route.pathAttributes)).toEqual(routeAttributesBefore);
            const updates = await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 2);
            expect(routeIdentities(flattenUpdateNlri(updates))).toEqual(['10.56.0.1/32#0', '10.56.0.1/32#1']);
            for (const update of updates.filter(item => updateNlri(item).length)) {
                expect(update.pathAttrTypes).toEqual([1, 2, 16, 4, 16, 14]);
                const extended = extendedCommunityAttributes(update);
                expectExtendedCommunityBytes(extended[0], FIXED_EXTENDED_HEX);
                expectExtendedCommunityBytes(extended[1], OTHER_EXTENDED_HEX);
            }
            const rejected = await generateManagedGroup(page, { ...config, groupId: 'restart-collision' });
            expect(rejected.status).toBe('error');
            expect(rejected.msg).toContain('Group persisted-group');
            expect(await getGroupStates(page)).toEqual(before);
            await page.reload();
            await expect(page.getByTestId('bgp-ipv4-route-table')).toContainText('10.56.0.1/32');
            await expect(page.getByText('共 2 条，每页 25 条')).toBeVisible();
            const offset = controller.getClientUpdates().length;
            const deleted = await page.evaluate(() => window.bgpApi.withdrawRouteGroup({ groupId: 'persisted-group' }));
            expect(deleted.status).toBe('success');
            expect(deleted.data.deleted).toBe(2);
            const finalUpdates = await controller.waitForClientUpdates(
                items => flattenWithdrawnRoutes(items.slice(offset)).length >= 2
            );
            expect(routeIdentities(flattenWithdrawnRoutes(finalUpdates.slice(offset)))).toEqual([
                '10.56.0.1/32#0',
                '10.56.0.1/32#1'
            ]);
            expect(await getGroupStates(page)).toEqual([]);
            expect((await getRouteSnapshot(controller)).total).toBe(0);
            expect((await generateManagedGroup(page, { ...config, groupId: 'restart-collision' })).status).toBe(
                'success'
            );
            await recordStep(
                'Output: closing and reopening a temporary SQLite database preserves group ownership and ordered duplicate Extended Community bytes; group withdrawal releases ownership'
            );
        } finally {
            await controller.cleanup();
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        }
    });

    test('sends ordered duplicate tree attributes with per-node eBGP local AS controls and independent MP next hops', async ({
        page
    }) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openAndStartIpv4Bgp(page, controller, { localAs: 100 });
        await page.goto('/#/bgp/route-ipv4');
        await expect(page.getByTestId('bgp-generate-ipv4-routes-button')).toBeEnabled();
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.52.0.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('3');
        await page.getByTestId('bgp-ipv4-nlri-encoding-select').click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await configureTreeMpNextHop(page, '值列表', '192.0.2.200\n192.0.2.201');
        await clearTreePathAttributes(page);

        const fixedRule = async (type, value) => {
            await addTreeRule(page, type);
            await setTreeRuleMode(page, '固定值');
            await page.getByTestId('bgp-ipv4-attribute-value-input').fill(value);
        };
        await fixedRule('nextHop', '192.0.2.10');
        await fixedRule('med', '10');
        await fixedRule('asPath', '65011 65012');
        const prependLocalAs = page.getByTestId('bgp-ipv4-attribute-prependLocalAs-switch');
        await expect(prependLocalAs).toBeChecked();
        await fixedRule('localPref', '200');
        await fixedRule('nextHop', '192.0.2.11');
        await fixedRule('asPath', '65021');
        await expect(prependLocalAs).toBeChecked();
        await prependLocalAs.click();
        await expect(prependLocalAs).not.toBeChecked();
        await fixedRule('med', '90');
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-nextHop')).toHaveCount(2);
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-med')).toHaveCount(2);
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-asPath')).toHaveCount(2);
        await page.getByTestId('bgp-ipv4-tree-attribute-nextHop').first().click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('192.0.2.10');
        await page.getByTestId('bgp-ipv4-tree-attribute-nextHop').nth(1).click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('192.0.2.11');
        await addTreeRule(page, 'origin');
        await removeTreeRule(page, page.getByTestId('bgp-ipv4-tree-attribute-origin'));
        await page.getByTestId('bgp-ipv4-save-workspace-button').click();
        await expect
            .poll(() =>
                controller.savedIpv4RouteConfig?.attributeRules
                    .filter(rule => rule.type === 'asPath')
                    .map(rule => rule.prependLocalAs)
            )
            .toEqual([true, false]);
        await page.reload();
        const asPathNodes = page.getByTestId('bgp-ipv4-tree-attribute-asPath');
        await expect(asPathNodes).toHaveCount(2);
        await asPathNodes.first().click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('65011 65012');
        await expect(prependLocalAs).toBeChecked();
        await asPathNodes.nth(1).click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('65021');
        await expect(prependLocalAs).not.toBeChecked();
        await page.getByTestId('bgp-generate-ipv4-routes-button').click();

        const routes = await controller.waitForRoutes(1, 3);
        expect(routes.total).toBe(3);
        expect(routes.list.map(route => route.mpNextHop)).toEqual(['192.0.2.200', '192.0.2.201', '192.0.2.200']);
        for (const route of routes.list) {
            expect(route.pathAttributes).toEqual([
                { type: 'nextHop', value: '192.0.2.10' },
                { type: 'med', value: 10 },
                { type: 'asPath', value: '65011 65012' },
                { type: 'localPref', value: 200 },
                { type: 'nextHop', value: '192.0.2.11' },
                { type: 'asPath', value: '65021', prependLocalAs: false },
                { type: 'med', value: 90 }
            ]);
        }
        const updates = await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 3);
        expect(updates).toHaveLength(2);
        for (const update of updates) {
            // These are deliberately abnormal BGP attributes. Verify the bytes
            // received over TCP rather than relying on semantic validity.
            expect(update.pathAttrTypes).toEqual([
                BgpConst.BGP_PATH_ATTR.NEXT_HOP,
                BgpConst.BGP_PATH_ATTR.MED,
                BgpConst.BGP_PATH_ATTR.AS_PATH,
                BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
                BgpConst.BGP_PATH_ATTR.NEXT_HOP,
                BgpConst.BGP_PATH_ATTR.AS_PATH,
                BgpConst.BGP_PATH_ATTR.MED,
                BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI
            ]);
            expect(update.pathAttributes).toMatchObject([
                { typeCode: 3, nextHop: '192.0.2.10' },
                { typeCode: 4, med: 10 },
                { typeCode: 2, asPath: '65535 65011 65012' },
                { typeCode: 5, localPref: 200 },
                { typeCode: 3, nextHop: '192.0.2.11' },
                { typeCode: 2, asPath: '65021' },
                { typeCode: 4, med: 90 },
                { typeCode: 14 }
            ]);
            expect(update.pathAttributes[0].valueHex).toBe('c000020a');
            expect(update.pathAttributes[4].valueHex).toBe('c000020b');
            expect(update.nlriCount).toBe(0);
            expect(update.mpReach).toMatchObject({ afi: 1, safi: 1 });
            const expectedPrefixes =
                update.mpReach.nextHop === '192.0.2.200' ? ['10.52.0.1', '10.52.0.3'] : ['10.52.0.2'];
            expect(['192.0.2.200', '192.0.2.201']).toContain(update.mpReach.nextHop);
            expect(update.mpReach.nlri.map(route => route.prefix)).toEqual(expectedPrefixes);
        }
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-origin')).toHaveCount(0);
        await clearToasts(page);
        await asPathNodes.nth(1).click();
        await prependLocalAs.click();
        await expect(prependLocalAs).toBeChecked();
        const reenabledOffset = controller.getClientUpdates().length;
        await page.getByTestId('bgp-generate-ipv4-routes-button').click();
        const reenabledUpdates = await controller.waitForClientUpdates(
            items => flattenUpdateNlri(items.slice(reenabledOffset)).length >= 3
        );
        for (const update of reenabledUpdates.slice(reenabledOffset)) {
            expect(
                update.pathAttributes
                    .filter(attribute => attribute.typeCode === BgpConst.BGP_PATH_ATTR.AS_PATH)
                    .map(attribute => attribute.asPath)
            ).toEqual(['65535 65011 65012', '65535 65021']);
        }
        await expect(page.getByText('共 3 条，每页 25 条')).toBeVisible();
        const sparseResult = await page.evaluate(() =>
            window.bgpApi.generateIpv4Routes({
                addressFamily: 1,
                prefix: '10.53.0.1',
                mask: '32',
                count: '1',
                nlriEncoding: 'mpReach',
                nlriRules: [{ type: 'mpNextHop', mode: 'fixed', value: '192.0.2.202' }],
                attributeRules: [{ type: 'med', mode: 'fixed', value: 0 }]
            })
        );
        expect(sparseResult.status).toBe('success');
        const sparseUpdates = await controller.waitForClientUpdates(items =>
            flattenUpdateNlri(items).some(route => route.prefix === '10.53.0.1')
        );
        const sparseUpdate = sparseUpdates.find(update =>
            updateNlri(update).some(route => route.prefix === '10.53.0.1')
        );
        expect(sparseUpdate.pathAttrTypes).toEqual([BgpConst.BGP_PATH_ATTR.MED, BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI]);
        expect(sparseUpdate.pathAttributes[0].med).toBe(0);
        expect(sparseUpdate.mpReach.nextHop).toBe('192.0.2.202');
        await recordStep(
            'Output: duplicate AS_PATH nodes retain independent local AS settings across reload; toggling prepend sends changed UPDATEs; ordered attributes, explicit Local Preference and independent MP next hops are preserved; a MED-only rule emits no mandatory attributes'
        );
    });

    test('sends repeated Extended Community tree attributes with ordered RT, SoO and raw eight-octet entries', async ({
        page
    }) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openAndStartIpv4Bgp(page, controller, { localAs: 65535 });
        await page.goto('/#/bgp/route-ipv4');
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.62.0.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('2');
        await page.getByTestId('bgp-ipv4-nlri-encoding-select').click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await configureTreeMpNextHop(page, '固定值', '192.0.2.253');
        await clearTreePathAttributes(page);
        await addTreeRule(page, 'origin');
        await addTreeRule(page, 'asPath');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('65001');
        await addTreeRule(page, 'extendedCommunities');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill(FIXED_EXTENDED_COMMUNITIES);
        await addTreeRule(page, 'med');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('77');
        await addTreeRule(page, 'extendedCommunities');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill(OTHER_EXTENDED_COMMUNITIES);
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-rt')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-extendedCommunities')).toHaveCount(2);
        await page.getByTestId('bgp-generate-ipv4-routes-button').click();

        const snapshot = await controller.waitForRoutes(1, 2);
        for (const route of snapshot.list) {
            expect(route.pathAttributes.map(attribute => attribute.type)).toEqual([
                'origin',
                'asPath',
                'extendedCommunities',
                'med',
                'extendedCommunities'
            ]);
            const extended = route.pathAttributes.filter(attribute => attribute.type === 'extendedCommunities');
            expect(extended.map(attribute => attribute.value)).toEqual([
                FIXED_EXTENDED_COMMUNITIES.split(' '),
                OTHER_EXTENDED_COMMUNITIES.split(' ')
            ]);
        }
        const updates = await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 2);
        expect(updates).toHaveLength(1);
        const update = updates[0];
        // Repeated attribute 16 deliberately tests an abnormal packet. Check
        // each descriptor's bytes instead of requiring semantic validity.
        expect(update.pathAttrTypes).toEqual([1, 2, 16, 4, 16, 14]);
        expect(update.pathAttributes[3].med).toBe(77);
        const extended = extendedCommunityAttributes(update);
        expectExtendedCommunityBytes(extended[0], FIXED_EXTENDED_HEX);
        expectExtendedCommunityBytes(extended[1], OTHER_EXTENDED_HEX);
        expect(extended[0].extendedCommunities.map(community => community.kind)).toEqual([
            'route-target',
            'site-of-origin',
            'route-target'
        ]);
        expect(extended[1].extendedCommunities.map(community => community.kind)).toEqual([
            'route-target',
            'site-of-origin',
            'raw'
        ]);
        expect(update.mpReach.nextHop).toBe('192.0.2.253');
        expect(routeIdentities(updateNlri(update))).toEqual(['10.62.0.1/32#0', '10.62.0.2/32#0']);
        await page.reload();
        const restoredNodes = page.getByTestId('bgp-ipv4-tree-attribute-extendedCommunities');
        await expect(restoredNodes).toHaveCount(2);
        await restoredNodes.nth(0).click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue(FIXED_EXTENDED_COMMUNITIES);
        await restoredNodes.nth(1).click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue(OTHER_EXTENDED_COMMUNITIES);
        await recordStep(
            'Output: two separate attribute-16 descriptors retain RT/SoO/raw entry order and exact 8-octet encodings, including duplicate entries; tree values survive a page reload'
        );
    });

    test('cycles Extended Community entry groups and generates SoO increments and four-octet ASN RT random values', async ({
        page
    }) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openAndStartIpv4Bgp(page, controller, { localAs: 65535 });
        await page.goto('/#/bgp/route-ipv4');
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.63.0.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('3');
        await page.getByTestId('bgp-ipv4-nlri-encoding-select').click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await configureTreeMpNextHop(page, '固定值', '192.0.2.254');
        await clearTreePathAttributes(page);
        await addTreeRule(page, 'origin');
        await addTreeRule(page, 'asPath');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('65001');
        await addTreeRule(page, 'extendedCommunities');
        await setTreeRuleMode(page, '值列表');
        await page
            .getByTestId('bgp-ipv4-attribute-values-input')
            .fill('rt:65000:100 soo:65000:200\nhex:430a010203040506 soo:192.0.2.1:20');
        await addTreeRule(page, 'extendedCommunities');
        await setTreeRuleMode(page, '递增');
        await page.getByTestId('bgp-ipv4-attribute-subtype-select').click();
        await page.getByRole('option', { name: 'Site of Origin (SoO)', exact: true }).click();
        await page.getByTestId('bgp-ipv4-attribute-base-input').fill('65000');
        await page.getByTestId('bgp-ipv4-attribute-start-input').fill('300');
        await page.getByTestId('bgp-ipv4-attribute-step-input').fill('10');
        await addTreeRule(page, 'extendedCommunities');
        await setTreeRuleMode(page, '随机');
        await page.getByTestId('bgp-ipv4-attribute-subtype-select').click();
        await page.getByRole('option', { name: 'Route Target (RT)', exact: true }).click();
        await page.getByTestId('bgp-ipv4-attribute-base-input').fill('65536');
        await page.getByTestId('bgp-ipv4-attribute-max-input').fill('402');
        await page.getByTestId('bgp-ipv4-attribute-min-input').fill('400');
        await page.getByTestId('bgp-generate-ipv4-routes-button').click();

        const snapshot = await controller.waitForRoutes(1, 3);
        expect(snapshot.list.map(route => route.ip)).toEqual(['10.63.0.1', '10.63.0.2', '10.63.0.3']);
        const expectedListHex = [
            ['0002fde800000064', '0003fde8000000c8'],
            ['430a010203040506', '0103c00002010014']
        ];
        const expectedIncrementHex = ['0003fde80000012c', '0003fde800000136', '0003fde800000140'];
        const updates = await controller.waitForClientUpdates(items => flattenUpdateNlri(items).length >= 3);
        expect(routeIdentities(flattenUpdateNlri(updates))).toEqual([
            '10.63.0.1/32#0',
            '10.63.0.2/32#0',
            '10.63.0.3/32#0'
        ]);
        for (const update of updates) {
            expect(update.pathAttrTypes).toEqual([1, 2, 16, 16, 16, 14]);
            expect(update.mpReach.nextHop).toBe('192.0.2.254');
            expect(updateNlri(update)).toHaveLength(1);
            const index = Number(updateNlri(update)[0].prefix.split('.').pop()) - 1;
            const extended = extendedCommunityAttributes(update);
            expectExtendedCommunityBytes(extended[0], expectedListHex[index % 2]);
            expectExtendedCommunityBytes(extended[1], [expectedIncrementHex[index]]);
            expect(extended[1].extendedCommunities[0].kind).toBe('site-of-origin');
            expect(extended[2].length).toBe(8);
            expect(extended[2].valueHex).toMatch(/^020200010000[0-9a-f]{4}$/u);
            expect(extended[2].extendedCommunities[0].kind).toBe('route-target');
            const randomValue = Buffer.from(extended[2].valueHex, 'hex').readUInt16BE(6);
            expect(randomValue).toBeGreaterThanOrEqual(400);
            expect(randomValue).toBeLessThanOrEqual(402);
        }
        await recordStep(
            'Output: each list line is a complete entry group and cycles per route; SoO increments encode subtype 3 and RT random values encode four-octet ASN 65536 with bounded 16-bit values'
        );
    });

    test('packetizes large IPv4 route batches into multiple parsed UPDATE packets', async ({ page }) => {
        await test.step('Start an iBGP IPv4 peer over the real BGP TCP path', async () => {
            const bgpPort = await openAndStartIpv4Bgp(page, controller, { localAs: 65535 });
            await recordStep(
                `Output: BGP TCP server started on 127.0.0.1:${bgpPort}, peerState=Established, peerType=IBGP`
            );
        });

        await test.step('Generate a legacy IPv4 configuration spanning multiple 4096-byte packets', async () => {
            await recordStep(`Input: route=/#/bgp/route-ipv4, prefix=10.60.0.1, mask=32, count=${LARGE_ROUTE_COUNT}`);

            await page.goto('/#/bgp/route-ipv4');
            await expect(page.getByTestId('bgp-route-ipv4-page')).toBeVisible();
            const generateResult = await page.evaluate(
                count =>
                    window.bgpApi.generateIpv4Routes({
                        addressFamily: 1,
                        prefix: '10.60.0.1',
                        mask: '32',
                        count: String(count),
                        customAttr: '',
                        rt: ''
                    }),
                LARGE_ROUTE_COUNT
            );
            expect(generateResult.status).toBe('success');
            await page.reload();

            await expect(page.getByText(`共 ${LARGE_ROUTE_COUNT} 条，每页 25 条`)).toBeVisible({ timeout: 20000 });
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
            await expect(page.getByText(`共 ${LARGE_ROUTE_COUNT} 条，每页 25 条`)).toBeVisible({ timeout: 20000 });
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
