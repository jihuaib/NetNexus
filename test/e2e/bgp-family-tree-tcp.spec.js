const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BgpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');
const BgpConst = require('../../electron/const/bgpConst');

const AF = BgpConst.BGP_ADDR_FAMILY;
const capabilities = [1, 2, 65];
const attributes = [
    { type: 'origin', mode: 'fixed', value: 'IGP' },
    { type: 'asPath', mode: 'fixed', value: '65000' },
    { type: 'med', mode: 'increment', start: 10, step: 1 },
    { type: 'med', mode: 'fixed', value: 99 },
    { type: 'localPref', mode: 'fixed', value: 150 },
    { type: 'extendedCommunities', mode: 'fixed', value: 'rt:65000:100' }
];
const profiles = [
    {
        family: AF.IPV4_QP,
        afi: 1,
        clientFamily: 'ipv4-qp',
        prefix: '198.51.100.1',
        mask: 32,
        api: 'generateIpv4QpRoutes'
    },
    {
        family: AF.IPV6_QP,
        afi: 2,
        clientFamily: 'ipv6-qp',
        prefix: '2001:db8:100::1',
        mask: 128,
        api: 'generateIpv6QpRoutes'
    }
];

function updates(controller, mark, afi, safi, withdraw = false) {
    return controller
        .getClientUpdates()
        .slice(mark)
        .filter(update => {
            const mp = withdraw ? update.mpUnreach : update.mpReach;
            return mp?.afi === afi && mp?.safi === safi && (withdraw ? mp.withdrawnCount : mp.nlriCount) > 0;
        });
}
async function announced(controller, mark, afi, safi, count) {
    await expect
        .poll(() => updates(controller, mark, afi, safi).reduce((sum, update) => sum + update.mpReach.nlriCount, 0))
        .toBe(count);
    return updates(controller, mark, afi, safi);
}
async function withdrawn(controller, mark, afi, safi, count) {
    await expect
        .poll(() =>
            updates(controller, mark, afi, safi, true).reduce((sum, update) => sum + update.mpUnreach.withdrawnCount, 0)
        )
        .toBe(count);
    return updates(controller, mark, afi, safi, true);
}
async function generate(page, api, config) {
    const result = await page.evaluate(({ method, payload }) => window.bgpApi[method](payload), {
        method: api,
        payload: config
    });
    expect(result.status, result.msg).toBe('success');
}
async function snapshot(controller, family, routeType) {
    const result = await controller.invokeWorker('getRoutes', {
        addressFamily: family,
        page: 1,
        pageSize: 100,
        ...(routeType ? { routeType } : {})
    });
    expect(result.status, result.msg).toBe('success');
    return result.data;
}
async function startPeer(page, controller, { family, clientFamily, addPath = false, srv6 = false }) {
    controller.setBgpPort(await BgpE2eController.getFreePort());
    const result = await page.evaluate(
        async ({ addressFamily, openCap, paths, sid }) => {
            const started = await window.bgpApi.startBgp({
                localAs: '65000',
                routerId: '192.0.2.10',
                addressFamily: [addressFamily]
            });
            if (started.status !== 'success') return started;
            return window.bgpApi.configIpv4Peer({
                peerIp: '127.0.0.1',
                peerAs: '65000',
                holdTime: '90',
                openCap,
                addressFamily: [addressFamily],
                addressFamilyConfig: { [addressFamily]: { sendAddPath: paths, srv6Enabled: sid } }
            });
        },
        { addressFamily: family, openCap: addPath ? [...capabilities, 69] : capabilities, paths: addPath, sid: srv6 }
    );
    expect(result.status, result.msg).toBe('success');
    await controller.startMockClient({
        localAs: 65000,
        routerId: '192.0.2.20',
        addressFamilies: [clientFamily],
        addPathAddressFamilies: addPath ? [clientFamily] : []
    });
    await controller.waitForClientEvent('established');
    await controller.waitForPeerState('127.0.0.1', 'Established', 10000, family);
}
function medValues(update) {
    return update.pathAttributes
        .filter(attribute => attribute.typeCode === 4)
        .map(attribute => Buffer.from(attribute.valueHex, 'hex').readUInt32BE(0));
}
function groupConfig(id, family, extra) {
    return {
        groupId: id,
        groupName: `Family ${id}`,
        addressFamily: family,
        count: '3',
        nlriEncoding: 'mpReach',
        attributeRules: attributes,
        ...extra
    };
}

test.describe('BGP family trees over actual TCP', () => {
    let controller;
    test.beforeEach(async ({ page }) => {
        controller = new BgpE2eController();
        await page.exposeFunction('__bgpE2eCall', (method, ...args) => controller.call(method, ...args));
        controller.onEvent(event =>
            page.evaluate(({ type, data }) => window.__bgpE2eEmit?.(type, data), event).catch(() => {})
        );
        await page.addInitScript({ content: getBrowserMockScript('bgp') });
        await page.goto('/#/bgp/bgp-config');
    });
    test.afterEach(async () => {
        if (controller) await controller.cleanup();
    });

    test('IPv6 sends every ADD-PATH prefix with explicit MP next hop, SRv6 and independent repeated attributes', async ({
        page
    }) => {
        await startPeer(page, controller, { family: AF.IPV6_UNC, clientFamily: 'ipv6-unc', addPath: true, srv6: true });
        const config = groupConfig('ipv6-wire', AF.IPV6_UNC, {
            prefix: '2001:db8:600::1',
            mask: '128',
            nlriRules: [
                { type: 'mpNextHop', mode: 'fixed', value: '2001:db8::200' },
                { type: 'addPath', count: 2 }
            ],
            attributeRules: [
                ...attributes,
                {
                    type: 'srv6',
                    mode: 'fixed',
                    value: '2001:db8:880::1',
                    endpointBehavior: 18,
                    locatorBlockLength: 48,
                    locatorNodeLength: 16,
                    functionLength: 16,
                    argumentLength: 0,
                    transpositionLength: 0,
                    transpositionOffset: 0
                }
            ]
        });
        const mark = controller.getClientUpdates().length;
        await generate(page, 'generateIpv6Routes', config);
        const packets = await announced(controller, mark, 2, 1, 6);
        const nlri = packets.flatMap(update => update.mpReach.nlri);
        expect(nlri.map(route => `${route.prefix}#${route.pathId}`).sort()).toEqual([
            '2001:db8:600::1#0',
            '2001:db8:600::1#1',
            '2001:db8:600::2#0',
            '2001:db8:600::2#1',
            '2001:db8:600::3#0',
            '2001:db8:600::3#1'
        ]);
        for (const update of packets) {
            expect(update.mpReach.nextHop).toBe('2001:db8::200');
            expect(update.mpReach.nextHopLength).toBe(16);
            expect(medValues(update)).toHaveLength(2);
            expect(medValues(update)[1]).toBe(99);
            expect(update.prefixSid.srv6Services[0].sidInfos[0]).toMatchObject({
                sid: '2001:db8:880::1',
                endpointBehavior: 18
            });
        }
        const rows = await snapshot(controller, AF.IPV6_UNC);
        expect(rows.total).toBe(6);
        expect(rows.list.every(route => route.mpNextHop === '2001:db8::200')).toBe(true);
        const withdrawalMark = controller.getClientUpdates().length;
        const result = await page.evaluate(() => window.bgpApi.withdrawRouteGroup({ groupId: 'ipv6-wire' }));
        expect(result.data.deleted).toBe(6);
        await withdrawn(controller, withdrawalMark, 2, 1, 6);
        expect((await snapshot(controller, AF.IPV6_UNC)).total).toBe(0);
    });

    for (const profile of profiles) {
        test(`${profile.clientFamily} keeps DQPN and BSID separate while replacing the generated snapshot`, async ({
            page
        }) => {
            await startPeer(page, controller, profile);
            const config = groupConfig(`${profile.clientFamily}-wire`, profile.family, {
                prefix: profile.prefix,
                mask: profile.mask,
                routeGrowthMode: 'ip_dqpn',
                ipStep: 2,
                nlriRules: [
                    { type: 'dqpn', mode: 'increment', start: 7, step: 3 },
                    { type: 'bsid', mode: 'list', values: ['2001:db8::a', '2001:db8::b'] }
                ]
            });
            let mark = controller.getClientUpdates().length;
            await generate(page, profile.api, config);
            const packets = await announced(controller, mark, profile.afi, 241, 3);
            expect(
                packets
                    .flatMap(update => update.mpReach.nlri)
                    .map(route => route.dqpn)
                    .sort((a, b) => a - b)
            ).toEqual([7, 10, 13]);
            expect(new Set(packets.map(update => update.mpReach.nextHop))).toEqual(
                new Set(['2001:db8::a', '2001:db8::b'])
            );
            const rows = await snapshot(controller, profile.family);
            expect(rows.list.map(route => route.dqpn)).toEqual([7, 10, 13]);
            expect(rows.list.map(route => route.ip)).toEqual(
                profile.afi === 1
                    ? ['198.51.100.1', '198.51.100.3', '198.51.100.5']
                    : ['2001:db8:100::1', '2001:db8:100::3', '2001:db8:100::5']
            );
            mark = controller.getClientUpdates().length;
            await generate(page, profile.api, { ...config, routeGrowthMode: 'ip', count: 2, nlriRules: [] });
            const empty = await announced(controller, mark, profile.afi, 241, 2);
            await withdrawn(controller, mark, profile.afi, 241, 3);
            expect(empty.every(update => update.mpReach.nextHopLength === 0)).toBe(true);
            expect(
                empty
                    .flatMap(update => update.mpReach.nlri)
                    .every(route => route.dqpn === undefined || route.dqpn === null)
            ).toBe(true);
            const absent = await snapshot(controller, profile.family);
            expect(absent.total).toBe(2);
            expect(absent.list.every(route => route.dqpn === null && route.mpNextHop === null)).toBe(true);
            mark = controller.getClientUpdates().length;
            await generate(page, profile.api, {
                ...config,
                routeGrowthMode: 'dqpn',
                count: 2,
                nlriRules: [
                    { type: 'dqpn', mode: 'increment', start: 100, step: 1 },
                    { type: 'bsid', mode: 'auto' }
                ]
            });
            const automatic = await announced(controller, mark, profile.afi, 241, 2);
            expect(automatic.every(update => update.mpReach.nextHopLength === 16)).toBe(true);
            expect(
                automatic.every(update => ['::ffff:7f00:1', '::ffff:127.0.0.1'].includes(update.mpReach.nextHop))
            ).toBe(true);
            expect(automatic.flatMap(update => update.mpReach.nlri).map(route => route.prefix)).toEqual([
                profile.prefix,
                profile.prefix
            ]);
            const states = await page.evaluate(() => window.bgpApi.getRouteGroupStates());
            expect(states.data.groups).toEqual([expect.objectContaining({ groupId: config.groupId, routeCount: 2 })]);
        });
    }

    test('MVPN preserves Leaf references and encodes distinct Type 6 source and group addresses', async ({ page }) => {
        await startPeer(page, controller, { family: AF.IPV4_MVPN, clientFamily: 'ipv4-mvpn' });
        const leafHex = '020c0000fde8000000640000fde8';
        const leaf = groupConfig('mvpn-leaf-wire', AF.IPV4_MVPN, {
            routeType: 4,
            leafRouteKey: leafHex,
            originatingRouterIp: '192.0.2.10',
            count: 2,
            nlriRules: [{ type: 'mpNextHop', mode: 'fixed', value: '192.0.2.200' }]
        });
        let mark = controller.getClientUpdates().length;
        await generate(page, 'generateIpv4MvpnRoutes', leaf);
        const leafPackets = await announced(controller, mark, 1, 5, 2);
        const leafNlri = leafPackets.flatMap(update => update.mpReach.nlri);
        expect(leafNlri.map(route => route.routeType)).toEqual([4, 4]);
        expect(leafNlri.map(route => route.rawNlri)).toEqual([`${leafHex}c000020a`, `${leafHex}c000020b`]);
        const leafRows = await snapshot(controller, AF.IPV4_MVPN, 4);
        expect(leafRows.list.map(route => route.leafRouteKey)).toEqual([leafHex, leafHex]);
        mark = controller.getClientUpdates().length;
        const joined = groupConfig('mvpn-join-wire', AF.IPV4_MVPN, {
            routeType: 6,
            rd: '065000:0100',
            sourceAs: 65001,
            sourceIp: '198.51.100.7',
            groupIp: '239.1.1.1',
            count: 2,
            nlriRules: []
        });
        await generate(page, 'generateIpv4MvpnRoutes', joined);
        const joinPackets = await announced(controller, mark, 1, 5, 2);
        expect(joinPackets.every(update => update.mpReach.nextHopLength === 0)).toBe(true);
        for (const [index, route] of joinPackets.flatMap(update => update.mpReach.nlri).entries()) {
            const bytes = Buffer.from(route.rawNlri, 'hex');
            expect(route.routeType).toBe(6);
            expect(bytes.readUInt32BE(8)).toBe(65001);
            expect(bytes[12]).toBe(32);
            expect([...bytes.subarray(13, 17)]).toEqual([198, 51, 100, 7]);
            expect(bytes[17]).toBe(32);
            expect([...bytes.subarray(18, 22)]).toEqual([239, 1, 1, 1 + index]);
        }
        const beforeCollision = (await snapshot(controller, AF.IPV4_MVPN)).total;
        const collision = await page.evaluate(config => window.bgpApi.generateIpv4MvpnRoutes(config), {
            ...joined,
            groupId: 'mvpn-other-owner'
        });
        expect(collision.status).toBe('error');
        expect(collision.msg).toContain('conflicts with route group');
        expect((await snapshot(controller, AF.IPV4_MVPN)).total).toBe(beforeCollision);
        mark = controller.getClientUpdates().length;
        const result = await page.evaluate(() => window.bgpApi.withdrawRouteGroup({ groupId: 'mvpn-leaf-wire' }));
        expect(result.data.deleted).toBe(2);
        const withdrawals = await withdrawn(controller, mark, 1, 5, 2);
        expect(withdrawals.flatMap(update => update.mpUnreach.withdrawnRoutes).map(route => route.rawNlri)).toEqual(
            leafNlri.map(route => route.rawNlri)
        );
        expect((await snapshot(controller, AF.IPV4_MVPN)).total).toBe(2);
    });
});
