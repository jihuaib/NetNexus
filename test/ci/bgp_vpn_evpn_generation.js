const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { getAfiAndSafi } = require('../../electron/utils/bgp/bgpUtils');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { collectBgpGeneratedRoutes } = require('../../electron/utils/bgp/simulator/bgpRouteGenerator');
const {
    buildAttributeRuleContext,
    getGeneratedAttributeValues
} = require('../../electron/utils/bgp/simulator/bgpAttributeRules');
const {
    normalizeRouteDistinguisher,
    parseRouteDistinguisher,
    getRouteDistinguisherValueRange,
    composeRouteDistinguisher
} = require('../../shared/bgpRouteDistinguisher');
const {
    normalizeEvpnRoute,
    encodeVpnNlri,
    encodeEvpnNlri,
    encodeVpnNextHop,
    iterateVpnRouteInputs,
    iterateEvpnRouteInputs,
    makeVpnRouteKey,
    makeEvpnRouteKey
} = require('../../electron/utils/bgp/simulator/bgpVpnEvpn');
const {
    parseRouteDistinguisherNlri,
    parseRouteDistinguisherWithdrawalNlri
} = require('../../electron/utils/bgp/addressFamily/vpn');
const { parseEvpnNlri } = require('../../electron/utils/bgp/addressFamily/evpn');
const family = BgpConst.BGP_ADDR_FAMILY;
const type = BgpConst.BGP_PATH_ATTR;

function vpnRules(rd = {}, label = {}, nextHop = {}) {
    return [
        { type: 'rd', mode: 'fixed', value: '65000:10', ...rd },
        { type: 'label', mode: 'increment', start: 16000, step: 1, ...label },
        { type: 'mpNextHop', mode: 'auto', ...nextHop }
    ];
}

function evpnRules(config) {
    const rules = [{ type: 'rd', mode: 'fixed', value: config.rd ?? '65000:10' }];
    if ([1, 2, 3, 5].includes(Number(config.routeType))) {
        const vxlan = config.encapsulationType === 'vxlan';
        rules.push({
            type: vxlan ? 'vni' : 'label',
            mode: 'fixed',
            value: vxlan ? (config.vni ?? 1000) : (config.label ?? 16)
        });
        if (Number(config.routeType) === 2 && (config.label2 !== undefined || config.vni2 !== undefined))
            rules.push({ type: vxlan ? 'vni2' : 'label2', mode: 'fixed', value: vxlan ? config.vni2 : config.label2 });
    }
    rules.push({ type: 'mpNextHop', mode: 'auto' });
    return rules;
}

function testVpnRules() {
    assert.equal(normalizeRouteDistinguisher(' 00065000:00010 '), '65000:10');
    assert.equal(composeRouteDistinguisher('192.000.002.001', 65535), '192.0.2.1:65535');
    assert.deepEqual(parseRouteDistinguisher('65536:7'), {
        base: '65536',
        type: 2,
        maxAssigned: 65535,
        assigned: 7,
        canonical: '65536:7'
    });
    assert.deepEqual(getRouteDistinguisherValueRange('65535'), [0, 0xffffffff]);
    assert.deepEqual(getRouteDistinguisherValueRange('4294967295'), [0, 65535]);
    for (const invalid of ['', '4294967296:0', '65536:65536', '192.0.2.256:1', '1:4294967296', '1:-1'])
        assert.throws(() => normalizeRouteDistinguisher(invalid), /RD/);
    for (const addressFamily of [family.VPNV4, family.VPNV6]) {
        const config = { addressFamily, count: 3, nlriRules: vpnRules() };
        const values = (rd, label, random = () => 0.5) => {
            const context = buildAttributeRuleContext({ ...config, nlriRules: vpnRules(rd, label) }, random);
            return [0, 1, 2].map(index => getGeneratedAttributeValues(context, index));
        };
        const fixed = values({ value: '65000:4294967295' }, { mode: 'fixed', value: 0xfffff });
        assert.ok(fixed.every(value => value.rd === '65000:4294967295' && value.label === 0xfffff));
        assert.ok(fixed.every(value => value.attr.rd === undefined && value.attr.label === undefined));
        const increment = values(
            { mode: 'increment', base: '192.0.2.1', start: 65535, step: -1 },
            { mode: 'increment', start: 0xfffff, step: -1 }
        );
        assert.deepEqual(
            increment.map(value => value.rd),
            ['192.0.2.1:65535', '192.0.2.1:65534', '192.0.2.1:65533']
        );
        assert.deepEqual(
            increment.map(value => value.label),
            [0xfffff, 0xffffe, 0xffffd]
        );
        const list = values(
            { mode: 'list', values: ['65000:1', '65536:2', '192.0.2.1:3'] },
            { mode: 'list', values: [0, 1048575] }
        );
        assert.deepEqual(
            list.map(value => value.rd),
            ['65000:1', '65536:2', '192.0.2.1:3']
        );
        assert.deepEqual(
            list.map(value => value.label),
            [0, 1048575, 0]
        );
        for (const random of [() => 0, () => 1]) {
            const expected = random() === 0 ? 1 : 65535;
            const sampled = values(
                { mode: 'random', base: '4294967295', min: 1, max: 65535 },
                { mode: 'random', min: 0, max: 1048575 },
                random
            );
            assert.ok(sampled.every(value => value.rd === `4294967295:${expected}`));
            assert.ok(sampled.every(value => value.label === (expected === 1 ? 0 : 1048575)));
        }
        for (const rd of [
            { mode: 'increment', base: '65000', start: 0xffffffff, step: 1 },
            { mode: 'increment', base: '65536', start: 65535, step: 1 },
            { mode: 'increment', base: '192.0.2.1', start: 0, step: -1 },
            { mode: 'increment', base: '65000', start: 1, step: Number.MAX_SAFE_INTEGER },
            { mode: 'increment', base: '65000', start: 1, step: Number.MAX_SAFE_INTEGER + 1 },
            { mode: 'random', base: '65536', min: 0, max: 65536 },
            { mode: 'random', base: '65000', min: 10, max: 9 },
            { mode: 'list', values: [] },
            { mode: 'list', values: ['1:0', 'bad'] },
            { mode: 'increment', start: 1, step: 1 }
        ])
            assert.throws(() => values(rd), /RD|列表/);
        for (const label of [
            { mode: 'fixed', value: 0x100000 },
            { mode: 'increment', start: 0xfffff, step: 1 },
            { mode: 'increment', start: 0, step: -1 },
            { mode: 'random', min: 0, max: 0x100000 },
            { mode: 'random', min: 2, max: 1 },
            { mode: 'list', values: [1, 0x100000] }
        ])
            assert.throws(() => values({}, label), /Label|label|随机/);
        assert.throws(() => buildAttributeRuleContext({ addressFamily, rd: '65000:10', label: 16 }), /需要RD节点/);
        assert.throws(
            () => buildAttributeRuleContext({ ...config, nlriRules: vpnRules().filter(rule => rule.type !== 'rd') }),
            /需要RD节点/
        );
        assert.throws(
            () => buildAttributeRuleContext({ ...config, nlriRules: vpnRules().filter(rule => rule.type !== 'label') }),
            /需要Label节点/
        );
        assert.throws(
            () => buildAttributeRuleContext({ ...config, nlriRules: [...vpnRules(), vpnRules()[0]] }),
            /不能重复/
        );
        assert.throws(() => buildAttributeRuleContext({ ...config, attributeRules: [vpnRules()[0]] }), /NLRI分支/);
    }
}

function testEncoders() {
    for (const [addressFamily, afi, prefix, mask] of [
        [family.VPNV4, 1, '10.90.1.199', 25],
        [family.VPNV6, 2, '2001:db8:90:1::ffff', 65]
    ]) {
        const routes = collectBgpGeneratedRoutes({
            addressFamily,
            prefix,
            mask,
            count: 2,
            nlriRules: vpnRules()
        });
        assert.equal(routes.length, 2);
        assert.equal(routes[1].label, 16001);
        for (const route of routes) {
            const encoded = encodeVpnNlri(route, afi);
            const parsed = parseRouteDistinguisherNlri(encoded, 0, afi).route;
            assert.ok(parsed.valid, parsed.errors.join(', '));
            assert.equal(parsed.rd, '65000:10');
            assert.equal(parsed.length, mask);
            assert.equal(parsed.labels[0].label, route.label);
            const withdrawal = encodeVpnNlri(route, afi, { withdraw: true });
            assert.equal(withdrawal.subarray(1, 4).toString('hex'), '800000');
            assert.ok(parseRouteDistinguisherWithdrawalNlri(withdrawal, 0, afi).route.valid);
            assert.equal(makeVpnRouteKey(route, afi), makeVpnRouteKey({ ...route, label: 'bad' }, afi));
        }
    }
    assert.equal(encodeVpnNextHop('192.0.2.1', 1).toString('hex'), '0000000000000000c0000201');
    assert.equal(encodeVpnNextHop('192.0.2.1', 2).toString('hex'), '000000000000000000000000000000000000ffffc0000201');
    const examples = [
        { routeType: 1, esi: '00:00:00:00:00:00:00:00:00:01', ethernetTagId: 10, label: 16000 },
        { routeType: 2, macAddress: '02:00:00:00:00:01', label: 16000 },
        { routeType: 2, macAddress: '02:00:00:00:00:02', ipAddress: '2001:db8::2', label: 16000, label2: 17000 },
        { routeType: 3, originatingRouterIp: '192.0.2.3' },
        { routeType: 4, originatingRouterIp: '2001:db8::4', esi: '00:00:00:00:00:00:00:00:00:01' },
        { routeType: 5, prefix: '10.90.0.129', mask: 25, gatewayIp: '192.0.2.5', label: 16000 },
        { routeType: 5, prefix: '2001:db8:90::ffff', mask: 64, encapsulationType: 'vxlan', vni: 0xffffff }
    ];
    for (const example of examples) {
        const route = { rd: '192.0.2.254:10', ...example };
        const encoded = encodeEvpnNlri(route);
        const parsed = parseEvpnNlri(encoded, 0).route;
        assert.ok(parsed.valid, parsed.errors.join(', '));
        assert.equal(parsed.routeType, example.routeType);
        assert.equal(parsed.rd, route.rd);
        if (example.routeType === 5) assert.equal(encoded[1], example.prefix.includes(':') ? 58 : 34);
        if (example.vni !== undefined) assert.equal(parsed.labels[0].raw24, example.vni);
    }
    const mac = examples[1];
    assert.equal(
        makeEvpnRouteKey(mac),
        makeEvpnRouteKey({ ...mac, esi: 'irrelevant', label: 'bad', encapsulationType: 'irrelevant' })
    );
    const prefix = examples[5];
    assert.equal(
        makeEvpnRouteKey(prefix),
        makeEvpnRouteKey({ ...prefix, gatewayIp: 'irrelevant', esi: 'irrelevant', label: 'bad' })
    );
    assert.equal(
        normalizeEvpnRoute({ ...mac, gatewayIp: 'irrelevant', originatingRouterIp: 'irrelevant' }).gatewayIp,
        undefined
    );
    assert.deepEqual(
        Array.from(iterateEvpnRouteInputs({ ...mac, count: 3 })).map(route => route.macAddress),
        ['02:00:00:00:00:01', '02:00:00:00:00:02', '02:00:00:00:00:03']
    );
    assert.throws(
        () =>
            Array.from(
                iterateVpnRouteInputs({ addressFamily: family.VPNV4, prefix: '255.255.255.255', mask: 32, count: 2 })
            ),
        /超出地址/
    );
    assert.throws(
        () =>
            Array.from(
                collectBgpGeneratedRoutes({
                    addressFamily: family.VPNV6,
                    prefix: '2001:db8::',
                    mask: 64,
                    count: 2,
                    nlriRules: vpnRules({}, { start: 0xfffff })
                })
            ),
        /label/
    );
    assert.throws(
        () => Array.from(iterateEvpnRouteInputs({ routeType: 2, macAddress: 'ff:ff:ff:ff:ff:ff', count: 2 })),
        /48bit/
    );
    assert.throws(
        () => Array.from(iterateEvpnRouteInputs({ routeType: 1, ethernetTagId: 0xfffffffe, count: 3 })),
        /uint32/
    );
    assert.throws(
        () => encodeEvpnNlri({ routeType: 5, prefix: '2001:db8::', mask: 64, gatewayIp: '192.0.2.1' }),
        /IPv6/
    );
    assert.throws(() => encodeVpnNlri({ ip: '10.0.0.1', mask: 32, rd: '65536:65536' }, 1), /RD数值/);
    assert.throws(
        () =>
            normalizeEvpnRoute({
                routeType: 5,
                prefix: '10.0.0.0',
                mask: 24,
                esi: '00:00:00:00:00:00:00:00:00:01',
                gatewayIp: '192.0.2.1'
            }),
        /不能同时非零/
    );
    assert.throws(
        () =>
            normalizeEvpnRoute({
                routeType: 4,
                rd: '65000:10',
                esi: '00:00:00:00:00:00:00:00:00:01',
                originatingRouterIp: '192.0.2.1'
            }),
        /Type 1/
    );
    assert.equal(
        normalizeEvpnRoute({
            routeType: 4,
            rd: '192.0.2.1:10',
            esi: '01:02:00:00:00:00:01:00:00:00',
            originatingRouterIp: '192.0.2.1'
        }).esImportRt,
        '02:00:00:00:00:01'
    );
    for (const pathId of [1, 0xffffffff]) {
        assert.throws(
            () =>
                Array.from(
                    iterateVpnRouteInputs({ addressFamily: family.VPNV4, prefix: '10.0.0.0', mask: 24, pathId })
                ),
            /Path ID必须为0/
        );
        assert.throws(
            () =>
                Array.from(
                    iterateVpnRouteInputs({
                        addressFamily: family.VPNV6,
                        routes: [{ ip: '2001:db8::', mask: 64, pathId }]
                    })
                ),
            /Path ID必须为0/
        );
        assert.throws(
            () => Array.from(iterateEvpnRouteInputs({ routeType: 2, macAddress: '02:00:00:00:00:01', pathId })),
            /Path ID必须为0/
        );
        assert.throws(
            () =>
                Array.from(
                    iterateEvpnRouteInputs({ routes: [{ routeType: 5, prefix: '10.0.0.0', mask: 24, pathId }] })
                ),
            /Path ID必须为0/
        );
    }
}

function fixture(dbPath, addressFamily) {
    const worker = new BgpWorker();
    const store = new BgpRouteSqliteStore(dbPath);
    const { afi, safi } = getAfiAndSafi(addressFamily);
    const instance = new BgpInstance(0, afi, safi, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    const sent = [];
    worker.messageHandler.sendSuccessResponse = () => {};
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    const session = {
        localIp: '192.0.2.254',
        routerId: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
        isAddPathSendEnabled: () => false,
        buildBgpMessageHeader(length, packetType) {
            const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
            header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
            header[BgpConst.BGP_MARKER_LEN + 2] = packetType;
            return header;
        },
        processCustomPkt: hex => Buffer.from(hex, 'hex'),
        sendRoute: buffer => sent.push(Buffer.from(buffer))
    };
    const peer = new BgpPeer(session, instance);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    instance.peerMap.set(session.peerIp, peer);
    return {
        worker,
        store,
        instance,
        peer,
        sent,
        generate(groupId, config = {}) {
            return worker.generateVpnEvpnRoutes('generate', {
                addressFamily,
                groupId,
                groupName: groupId,
                ...(addressFamily === family.L2VPN_EVPN ? { rd: '65000:10' } : {}),
                count: 3,
                prefix: afi === 2 ? '2001:db8:90::' : '10.90.0.0',
                mask: afi === 2 ? 64 : 24,
                attributeRules: [
                    { type: 'origin', value: 0 },
                    { type: 'asPath', value: '65000' },
                    { type: 'extendedCommunities', value: ['rt:65000:10'] }
                ],
                nlriRules: addressFamily === family.L2VPN_EVPN ? evpnRules(config) : vpnRules(),
                ...config
            });
        },
        rows: () => Array.from(instance.routeMap.values()),
        packets: () =>
            sent.map(buffer => {
                const packet = parseBgpPacket(buffer, { asnSize: 4 });
                assert.ok(packet.valid, packet.error);
                return packet;
            })
    };
}
const reaches = f =>
    f
        .packets()
        .flatMap(
            packet => packet.pathAttributes.find(attr => attr.typeCode === type.MP_REACH_NLRI)?.mpReach.nlri || []
        );
const withdrawals = f =>
    f
        .packets()
        .flatMap(
            packet =>
                packet.pathAttributes.find(attr => attr.typeCode === type.MP_UNREACH_NLRI)?.mpUnreach.withdrawnRoutes ||
                []
        );

async function testVpn(directory, addressFamily) {
    const dbPath = path.join(directory, `vpn-${addressFamily}.sqlite`);
    let f = fixture(dbPath, addressFamily);
    try {
        await f.generate('vpn');
        assert.equal(f.rows().length, 3);
        assert.equal(reaches(f).length, 3);
        assert.deepEqual(
            reaches(f).map(route => route.labels[0].label),
            [16000, 16001, 16002]
        );
        const nextHop = f.packets()[0].pathAttributes.find(attr => attr.typeCode === type.MP_REACH_NLRI).mpReach;
        assert.equal(nextHop.nextHopLength, addressFamily === family.VPNV6 ? 24 : 12);
        f.sent.length = 0;
        await f.generate('vpn', { count: 2, nlriRules: vpnRules({}, { start: 17000 }) });
        assert.equal(f.rows().length, 2);
        assert.equal(withdrawals(f).length, 1, 'label updates retain their semantic prefix identity');
        assert.equal(reaches(f).length, 2);
        assert.deepEqual(
            reaches(f).map(route => route.labels[0].label),
            [17000, 17001]
        );
        f.store.close();
        f = fixture(dbPath, addressFamily);
        assert.deepEqual(
            f.rows().map(route => route.label),
            [17000, 17001]
        );
        f.peer.sendRoute();
        assert.equal(reaches(f).length, 2);
        f.sent.length = 0;
        await assert.rejects(
            async () => f.generate('bad', { count: 2, nlriRules: vpnRules({}, { start: 0xfffff }) }),
            /label/
        );
        assert.equal(f.rows().length, 2);
        assert.equal(f.sent.length, 0, 'an invalid schedule must not change or announce a partial group');
        await f.generate('other-rd', { count: 1, nlriRules: vpnRules({ value: '65000:11' }) });
        assert.equal(f.rows().length, 3, 'different RDs can advertise the same prefix');
        f.sent.length = 0;
        f.worker.deleteRoute('single', {
            addressFamily,
            rd: '65000:11',
            prefix: addressFamily === family.VPNV6 ? '2001:db8:90::' : '10.90.0.0',
            mask: addressFamily === family.VPNV6 ? 64 : 24,
            count: 1
        });
        assert.equal(f.rows().length, 2);
        assert.equal(withdrawals(f).length, 1);
        assert.equal(withdrawals(f)[0].rd, '65000:11', 'an identity-only deletion must preserve another RD');
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('withdraw', { groupId: 'vpn' });
        assert.equal(withdrawals(f).length, 2);
        assert.equal(f.rows().length, 0);
        f.sent.length = 0;
        await f.generate('large', { count: 1500 });
        assert.equal(reaches(f).length, 1500);
        assert.ok(f.sent.every(packet => packet.length <= 4096));
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('large-remove', { groupId: 'large' });
        assert.equal(withdrawals(f).length, 1500);
        assert.ok(f.sent.every(packet => packet.length <= 4096));
        for (const invalidRules of [
            vpnRules().filter(rule => rule.type !== 'rd'),
            vpnRules().filter(rule => rule.type !== 'label'),
            [...vpnRules(), vpnRules()[0]],
            vpnRules({ mode: 'increment', base: '65536', start: 65535, step: 1 }),
            vpnRules({ mode: 'list', values: ['65000:1', 'bad'] })
        ]) {
            f.sent.length = 0;
            await assert.rejects(async () => f.generate('invalid-rules', { nlriRules: invalidRules }), /RD|Label|重复/);
            assert.equal(f.rows().length, 0);
            assert.equal(f.sent.length, 0, 'invalid NLRI rules cannot commit or send any route');
        }
        const rdValues = ['65000:4294967295', '65536:65535', '192.0.2.254:65535'];
        f.sent.length = 0;
        await f.generate('rd-list', {
            nlriRules: vpnRules({ mode: 'list', values: rdValues }, { mode: 'list', values: [0, 1048575] })
        });
        assert.deepEqual(
            reaches(f).map(route => route.rd),
            rdValues
        );
        assert.deepEqual(
            reaches(f).map(route => route.labels[0].label),
            [0, 1048575, 0]
        );
        assert.ok(
            f.rows().every(route => {
                const attr = f.instance.getRouteAttr(route);
                return attr.rd === undefined && !attr.pathAttributes.some(entry => entry.type === 'rd');
            })
        );
        f.store.close();
        f = fixture(dbPath, addressFamily);
        assert.deepEqual(
            f.rows().map(route => route.rd),
            rdValues
        );
        f.peer.sendRoute();
        assert.deepEqual(
            reaches(f).map(route => route.rd),
            rdValues
        );
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('rd-list-remove', { groupId: 'rd-list' });
        assert.deepEqual(
            withdrawals(f).map(route => route.rd),
            rdValues
        );
        assert.equal(f.rows().length, 0);
        for (const [mode, rdRule, labelRule, expectedRd, expectedLabel] of [
            [
                'increment',
                { mode: 'increment', base: '192.0.2.254', start: 100, step: 2 },
                { mode: 'increment', start: 17000, step: 2 },
                ['192.0.2.254:100', '192.0.2.254:102', '192.0.2.254:104'],
                [17000, 17002, 17004]
            ],
            [
                'random',
                { mode: 'random', base: '65536', min: 9, max: 9 },
                { mode: 'random', min: 17000, max: 17000 },
                ['65536:9', '65536:9', '65536:9'],
                [17000, 17000, 17000]
            ]
        ]) {
            f.sent.length = 0;
            await f.generate(mode, { nlriRules: vpnRules(rdRule, labelRule) });
            assert.deepEqual(
                reaches(f).map(route => route.rd),
                expectedRd
            );
            assert.deepEqual(
                reaches(f).map(route => route.labels[0].label),
                expectedLabel
            );
            const identities = reaches(f).map(route => `${route.rd}|${route.prefix}|${route.length}`);
            f.sent.length = 0;
            await f.worker.withdrawRouteGroup(`${mode}-remove`, { groupId: mode });
            assert.deepEqual(
                withdrawals(f).map(route => `${route.rd}|${route.prefix}|${route.length}`),
                identities
            );
            assert.equal(f.rows().length, 0);
        }
        f.sent.length = 0;
        const explicit = {
            ip: addressFamily === family.VPNV6 ? '2001:db8:190::' : '198.51.100.0',
            mask: addressFamily === family.VPNV6 ? 64 : 24,
            rd: '65536:12',
            label: 17000
        };
        await f.generate('explicit', { routes: [explicit], nlriRules: [{ type: 'mpNextHop', mode: 'auto' }] });
        assert.equal(reaches(f)[0].rd, explicit.rd);
        assert.equal(reaches(f)[0].labels[0].label, explicit.label);
        await f.worker.withdrawRouteGroup('explicit-remove', { groupId: 'explicit' });
    } finally {
        f.store.close();
    }
}

async function testEvpn(directory) {
    const dbPath = path.join(directory, 'evpn.sqlite');
    let f = fixture(dbPath, family.L2VPN_EVPN);
    try {
        for (const config of [
            { routeType: 1, esi: '00:00:00:00:00:00:00:00:00:01', ethernetTagId: 10 },
            { routeType: 2, macAddress: '02:00:00:00:00:01', ipAddress: '192.0.2.1', label: 18000, label2: 19000 },
            { routeType: 3, originatingRouterIp: '192.0.2.3', encapsulationType: 'vxlan', vni: 10000 },
            {
                routeType: 4,
                rd: '192.0.2.254:10',
                esi: '00:00:00:00:00:00:00:00:00:01',
                esImportRt: '02:00:00:00:00:01',
                originatingRouterIp: '2001:db8::4'
            },
            { routeType: 5, prefix: '2001:db8:90::', mask: 64, encapsulationType: 'vxlan', vni: 10000 }
        ]) {
            f.sent.length = 0;
            await f.generate(`rt-${config.routeType}`, config);
            const nlri = reaches(f);
            assert.equal(nlri.length, 3);
            assert.ok(nlri.every(route => route.valid && route.routeType === config.routeType));
            if (config.encapsulationType === 'vxlan') assert.ok(nlri.every(route => route.encapsulationType === 'vni'));
            if (config.routeType === 3) {
                const pmsi = f
                    .packets()
                    .map(packet => packet.pathAttributes.find(attr => attr.typeCode === type.PMSI_TUNNEL));
                assert.ok(
                    pmsi.every(attr => attr?.pmsiTunnel.tunnelType === 6 && attr.pmsiTunnel.label.raw24 === 10000)
                );
                assert.equal(
                    new Set(pmsi.map(attr => attr.value.toString('hex'))).size,
                    3,
                    'IMET batches must keep their own ingress replication tunnel identifier'
                );
            }
            if (config.routeType === 4)
                assert.ok(
                    f
                        .packets()
                        .every(packet =>
                            packet.pathAttributes
                                .find(attr => attr.typeCode === type.EXTENDED_COMMUNITIES)
                                .value.includes(Buffer.from('0602020000000001', 'hex'))
                        )
                );
            const stored = f.rows().find(route => route.routeType === config.routeType);
            const identityFields = {
                1: ['rd', 'esi', 'ethernetTagId'],
                2: ['rd', 'ethernetTagId', 'macAddress', 'ipAddress'],
                3: ['rd', 'ethernetTagId', 'originatingRouterIp'],
                4: ['rd', 'esi', 'originatingRouterIp'],
                5: ['rd', 'ethernetTagId', 'ip', 'mask']
            }[config.routeType];
            f.sent.length = 0;
            f.worker.deleteRoute('single', {
                addressFamily: family.L2VPN_EVPN,
                routeType: config.routeType,
                count: 1,
                ...Object.fromEntries(identityFields.map(field => [field, stored[field]]))
            });
            assert.equal(withdrawals(f).length, 1, `EVPN Type ${config.routeType} identity-only single deletion`);
            assert.equal(f.rows().filter(route => route.routeType === config.routeType).length, 2);
            await f.generate(`rt-${config.routeType}`, config);
        }
        assert.equal(f.rows().length, 15);
        f.sent.length = 0;
        await f.generate('rt-5', {
            routeType: 5,
            prefix: '2001:db8:90::',
            mask: 64,
            gatewayIp: '2001:db8::5',
            encapsulationType: 'vxlan',
            vni: 11000
        });
        assert.equal(withdrawals(f).length, 0, 'gateway/VNI updates replace the existing IP prefix routes');
        assert.equal(reaches(f).length, 3);
        assert.ok(reaches(f).every(route => route.gatewayIp === '2001:db8::5' && route.labels[0].vni === 11000));
        f.store.close();
        f = fixture(dbPath, family.L2VPN_EVPN);
        assert.equal(f.rows().length, 15);
        f.peer.sendRoute();
        assert.equal(reaches(f).length, 15);
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('remove', { groupId: 'rt-2' });
        assert.equal(withdrawals(f).length, 3);
        assert.equal(f.rows().length, 12);
        await assert.rejects(
            f.generate('conflict', {
                routeType: 2,
                macAddress: '02:00:00:01:00:01',
                encapsulationType: 'vxlan',
                vni: 10000,
                attributeRules: [{ type: 'extendedCommunities', value: ['hex:030c00000000000a'] }]
            }),
            /必须为VXLAN/
        );
        assert.equal(f.rows().length, 12);
        f.sent.length = 0;
        await assert.rejects(
            async () =>
                f.generate('missing-next-hop', {
                    routeType: 2,
                    macAddress: '02:00:00:02:00:01',
                    nlriRules: evpnRules({ routeType: 2 }).filter(rule => rule.type !== 'mpNextHop')
                }),
            /需要MP Next Hop节点/
        );
        assert.equal(f.rows().length, 12);
        assert.equal(f.sent.length, 0, 'a missing mandatory MP next hop cannot commit or send invalid EVPN NLRI');
        await f.generate('large', {
            routeType: 2,
            macAddress: '02:00:00:02:00:01',
            count: 1500,
            encapsulationType: 'vxlan',
            vni: 10000
        });
        assert.equal(reaches(f).length, 1500);
        assert.ok(f.sent.every(packet => packet.length <= 4096));
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('large-remove', { groupId: 'large' });
        assert.equal(withdrawals(f).length, 1500);
        assert.ok(f.sent.every(packet => packet.length <= 4096));
    } finally {
        f.store.close();
    }
}

function testEvpnDefaults(directory) {
    const examples = [
        {
            addressFamily: family.L2VPN_EVPN,
            routeType: 2,
            macAddress: '02:00:00:03:00:01',
            encapsulationType: 'vxlan',
            vni: 10000,
            rd: '65000:10'
        },
        {
            addressFamily: family.L2VPN_EVPN,
            routeType: 3,
            originatingRouterIp: '192.0.2.3',
            encapsulationType: 'vxlan',
            vni: 10000,
            rd: '65000:10'
        },
        {
            addressFamily: family.L2VPN_EVPN,
            routeType: 4,
            originatingRouterIp: '192.0.2.4',
            rd: '192.0.2.254:10',
            esi: '01:02:00:00:00:00:01:00:00:00',
            encapsulationType: 'vxlan'
        }
    ];
    for (const [index, config] of examples.entries()) {
        const f = fixture(path.join(directory, `legacy-${index}.sqlite`), config.addressFamily);
        try {
            f.worker.generateVpnEvpnRoutes('legacy', { ...config, rt: '65000:10', count: 1 });
            assert.equal(f.rows().length, 1);
            const packet = f.packets()[0];
            assert.deepEqual(
                packet.pathAttributes.find(attr => attr.typeCode === type.AS_PATH).segments[0].asNumbers,
                [65000],
                'default eBGP routes prepend the local AS'
            );
            assert.ok(
                !packet.pathAttributes.some(attr => attr.typeCode === type.LOCAL_PREF),
                'default eBGP routes omit LOCAL_PREF'
            );
            const extended = packet.pathAttributes.find(attr => attr.typeCode === type.EXTENDED_COMMUNITIES);
            assert.ok(
                extended?.value.includes(Buffer.from('0002fde80000000a', 'hex')),
                'legacy route targets survive attribute policy conversion'
            );
            if (config.encapsulationType === 'vxlan')
                assert.ok(
                    extended.value.includes(Buffer.from('030c000000000008', 'hex')),
                    'automatic VXLAN encoding survives the legacy policy'
                );
            if (config.routeType === 3)
                assert.equal(
                    packet.pathAttributes.find(attr => attr.typeCode === type.PMSI_TUNNEL)?.pmsiTunnel.tunnelType,
                    6
                );
            if (config.routeType === 4) {
                assert.ok(
                    extended.value.includes(Buffer.from('0602020000000001', 'hex')),
                    'ES-Import derived from ESI Type 1 survives the legacy policy'
                );
                assert.throws(
                    () =>
                        f.worker.generateVpnEvpnRoutes('missing-es-import', {
                            ...config,
                            esi: '00:00:00:00:00:00:00:00:00:01'
                        }),
                    /显式ES-Import/
                );
            }
            f.sent.length = 0;
            f.peer.session.peerType = BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP;
            f.peer.sendRoute();
            assert.equal(
                f
                    .packets()[0]
                    .pathAttributes.find(attr => attr.typeCode === type.LOCAL_PREF)
                    ?.value.readUInt32BE(0),
                100,
                'default iBGP routes include LOCAL_PREF'
            );
        } finally {
            f.store.close();
        }
    }
}

async function main() {
    testVpnRules();
    testEncoders();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-vpn-evpn-'));
    try {
        await testVpn(directory, family.VPNV4);
        await testVpn(directory, family.VPNV6);
        await testEvpn(directory);
        testEvpnDefaults(directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    console.log(
        'BGP VPNv4/VPNv6 and EVPN generation, labels/VNI, IMET PMSI, semantic replacement, SQLite replay, withdrawal, bounds, and packetization tests passed'
    );
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
