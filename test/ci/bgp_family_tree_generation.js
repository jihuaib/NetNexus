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
const {
    buildAttributeRuleContext,
    getGeneratedAttributeValues
} = require('../../electron/utils/bgp/simulator/bgpAttributeRules');
const family = BgpConst.BGP_ADDR_FAMILY;
const type = BgpConst.BGP_PATH_ATTR;

function fixture(dbPath, addressFamily) {
    const worker = new BgpWorker();
    const store = new BgpRouteSqliteStore(dbPath);
    const { afi, safi } = getAfiAndSafi(addressFamily);
    const instance = new BgpInstance(0, afi, safi, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    const sent = [];
    const responses = [];
    worker.messageHandler.sendSuccessResponse = (_id, data) => responses.push(data);
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS | BgpConst.BGP_CAP_FLAGS.ADD_PATH,
        isAddPathSendEnabled: () => safi === 1 || safi === 4,
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
    const method =
        safi === 1 || safi === 4 ? 'generateRoutes' : safi === 241 ? 'generateQpRoutes' : 'generateMvpnRoutes';
    return {
        worker,
        store,
        instance,
        peer,
        sent,
        responses,
        generate(groupId, config = {}) {
            return worker[method]('generate', {
                addressFamily,
                groupId,
                groupName: groupId,
                prefix: afi === 1 ? '10.100.0.1' : '2001:db8:100::1',
                mask: afi === 1 ? 32 : 128,
                count: 3,
                routeGrowthMode: 'ip_dqpn',
                attributeRules: [],
                nlriRules: [],
                ...config
            });
        },
        rows: () => Array.from(instance.routeMap.values()),
        packets: () =>
            sent.map(buffer => {
                const packet = parseBgpPacket(buffer, {
                    asnSize: 4,
                    getAddPathReceiveInfo: () => ({ enabled: safi === 1 || safi === 4 })
                });
                assert.ok(packet.valid, packet.error);
                return packet;
            })
    };
}
const attrs = (f, code) => f.packets().flatMap(packet => packet.pathAttributes.filter(attr => attr.typeCode === code));
const reached = f => attrs(f, type.MP_REACH_NLRI).flatMap(attr => attr.mpReach.nlri);
const withdrawn = f => attrs(f, type.MP_UNREACH_NLRI).flatMap(attr => attr.mpUnreach.withdrawnRoutes);
const rawReached = f => attrs(f, type.MP_REACH_NLRI).map(attr => attr.value.subarray(5 + attr.value[3]));
const medNodes = [
    { type: 'med', value: 10 },
    { type: 'med', value: 20, enabled: false }
];

async function testPrefixStep(directory, addressFamily) {
    const dbPath = path.join(directory, `prefix-step-${addressFamily}.sqlite`);
    let f = fixture(dbPath, addressFamily);
    const ipv6 = addressFamily === family.IPV6_UNC;
    const labeled = addressFamily === family.IPV4_LABEL_UNICAST;
    const prefix = index => (ipv6 ? `2001:db8:110:${index}::` : `10.110.${index}.0`);
    const mask = ipv6 ? 64 : 24;
    const nlriRules = [{ type: 'addPath', count: 2 }];
    if (labeled) nlriRules.push({ type: 'label', value: 16000 });
    const config = { prefix: ipv6 ? `${prefix(1)}9` : '10.110.1.9', mask, count: 2, nlriRules };
    const wireRoutes = withdrawal =>
        f.packets().flatMap(packet => {
            const mp = packet.pathAttributes.find(
                attr => attr.typeCode === (withdrawal ? type.MP_UNREACH_NLRI : type.MP_REACH_NLRI)
            );
            return withdrawal
                ? mp?.mpUnreach.withdrawnRoutes || packet.withdrawnRoutes || []
                : mp?.mpReach.nlri || packet.nlri || [];
        });
    const identities = routes => routes.map(route => [route.ip || route.prefix, route.pathId]).sort();
    const expected = indexes =>
        indexes
            .flatMap(index => [
                [prefix(index), 0],
                [prefix(index), 1]
            ])
            .sort();
    try {
        await f.generate('step', config);
        assert.deepEqual(identities(f.rows()), expected([1, 2]), 'the omitted step remains one subnet');
        assert.deepEqual(identities(wireRoutes(false)), expected([1, 2]));
        f.sent.length = 0;
        await f.generate('step', { ...config, count: 3, ipStep: 2 });
        const generated = expected([1, 3, 5]);
        assert.deepEqual(identities(f.rows()), generated, 'step two advances subnets, independently of path count');
        assert.deepEqual(identities(wireRoutes(false)), generated, 'all six generated paths must reach the wire');
        assert.deepEqual(identities(wireRoutes(true)), expected([2]), 'replacement withdraws the old skipped subnet');
        assert.ok(f.sent.every(buffer => buffer.length <= 4096));
        if (labeled) assert.ok(wireRoutes(false).every(route => route.labels[0].label === 16000));
        const snapshot = f.store.getRouteGroupRoutes('step');
        for (const ipStep of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            f.sent.length = 0;
            assert.throws(() => f.generate('step', { ...config, ipStep }), /IP步长必须为正整数/);
            assert.deepEqual(f.store.getRouteGroupRoutes('step'), snapshot);
            assert.equal(f.sent.length, 0, 'invalid step must not modify or advertise the old snapshot');
        }
        f.sent.length = 0;
        assert.throws(
            () =>
                f.generate('step', {
                    ...config,
                    prefix: ipv6 ? 'ffff:ffff:ffff:fffe::' : '255.255.254.0',
                    ipStep: 2
                }),
            /超出地址范围/
        );
        assert.deepEqual(f.store.getRouteGroupRoutes('step'), snapshot);
        assert.equal(f.sent.length, 0, 'overflow validation must happen before withdrawals or inserts');
        f.store.close();
        f = fixture(dbPath, addressFamily);
        f.peer.sendRoute();
        assert.deepEqual(
            identities(wireRoutes(false)),
            generated,
            'SQLite replay preserves the actual stepped snapshot'
        );
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('edited-draft', {
            groupId: 'step',
            prefix: 'invalid-draft',
            ipStep: 999,
            count: 1,
            nlriRules: []
        });
        assert.deepEqual(
            identities(wireRoutes(true)),
            generated,
            'withdrawal uses saved routes instead of draft stride'
        );
        assert.equal(f.rows().length, 0);
        f.sent.length = 0;
        await f.generate('import', {
            ...config,
            prefix: 'not-used',
            mask: -1,
            count: 999,
            ipStep: 0,
            nlriRules: labeled ? [{ type: 'label', value: 16000 }] : [],
            routes: [
                { ip: prefix(8), mask, pathId: 7 },
                { ip: prefix(10), mask, pathId: 9 }
            ]
        });
        const imported = [
            [prefix(8), 7],
            [prefix(10), 9]
        ].sort();
        assert.deepEqual(
            identities(f.rows()),
            imported,
            'explicit imports ignore prefix generation fields and keep path IDs'
        );
        assert.deepEqual(identities(wireRoutes(false)), imported);
        await f.worker.withdrawRouteGroup('import-remove', { groupId: 'import' });
        await f.generate('owner', { ...config, prefix: prefix(5), count: 1 });
        const ownedSnapshot = f.store.getRouteGroupRoutes('owner');
        f.sent.length = 0;
        assert.throws(() => f.generate(undefined, { ...config, count: 3, ipStep: 2 }), /conflicts/);
        assert.deepEqual(f.store.getRouteGroupRoutes('owner'), ownedSnapshot);
        assert.equal(f.rows().length, 2, 'unmanaged tree ownership must preflight every stepped prefix');
        assert.equal(f.sent.length, 0, 'a late stepped collision cannot partly insert or advertise earlier prefixes');
        f.generate(undefined, { ...config, prefix: prefix(2), ipStep: 2 });
        assert.deepEqual(
            identities(wireRoutes(false)),
            expected([2, 4]),
            'unmanaged tree generation uses the same subnet step'
        );
        assert.equal(f.rows().length, 6);
    } finally {
        f.store.close();
    }
}

async function testQp(directory, addressFamily) {
    const dbPath = path.join(directory, `qp-${addressFamily}.sqlite`);
    let f = fixture(dbPath, addressFamily);
    try {
        const config = {
            ipStep: 2,
            attributeRules: medNodes,
            nlriRules: [
                { type: 'dqpn', mode: 'increment', start: 0, step: 1, enabled: false },
                { type: 'bsid', mode: 'list', values: ['2001:db8::10', '2001:db8::11', '2001:db8::10'] }
            ]
        };
        await f.generate('qp', config);
        assert.equal(f.rows().length, 3);
        assert.deepEqual(
            f.rows().map(route => route.dqpn),
            [0, 1, 2]
        );
        assert.equal(
            new Set(f.rows().map(route => route.attrId)).size,
            1,
            'BSID/DQPN must not enter the path attribute hash'
        );
        assert.equal(reached(f).length, 3);
        assert.equal(attrs(f, type.MP_REACH_NLRI).length, 2, 'different BSIDs split equal-attribute UPDATEs');
        assert.ok(attrs(f, type.MP_REACH_NLRI).every(attr => attr.value[3] === 16));
        assert.deepEqual(
            f.packets()[0].pathAttributes.map(attr => attr.typeCode),
            [4, 4, 14]
        );
        const before = f.store.getRouteGroupRoutes('qp');
        f.sent.length = 0;
        await assert.rejects(f.generate('conflict', config), /conflicts/);
        assert.deepEqual(f.store.getRouteGroupRoutes('qp'), before);
        assert.equal(f.sent.length, 0);
        assert.throws(
            () => f.generate('qp', { nlriRules: [{ type: 'dqpn', mode: 'increment', start: 0xffffff, step: 1 }] }),
            /最后|范围/
        );
        assert.deepEqual(f.store.getRouteGroupRoutes('qp'), before);
        const independent = { routeGrowthMode: undefined, ipStep: 0 };
        const assertRejectedSnapshot = async (overrides, error) => {
            const snapshot = f.store.getRouteGroupRoutes('qp');
            f.sent.length = 0;
            await assert.rejects(f.generate('qp', { ...independent, ...overrides }), error);
            assert.deepEqual(
                f.store.getRouteGroupRoutes('qp'),
                snapshot,
                'rejection must preserve the generated snapshot'
            );
            assert.equal(f.sent.length, 0, 'rejection must not withdraw or announce any NLRI');
        };
        await f.generate('qp', {
            ...independent,
            nlriRules: [{ type: 'dqpn', mode: 'increment', start: 10, step: 2 }]
        });
        assert.equal(
            new Set(f.rows().map(route => route.ip)).size,
            1,
            'zero IP step retains one prefix without a growth mode'
        );
        assert.deepEqual(
            f.rows().map(route => route.dqpn),
            [10, 12, 14]
        );
        await f.generate('qp', {
            ...independent,
            nlriRules: [{ type: 'dqpn', mode: 'list', values: [3, 7, 9] }]
        });
        assert.equal(new Set(f.rows().map(route => route.ip)).size, 1);
        assert.deepEqual(
            f.rows().map(route => route.dqpn),
            [3, 7, 9]
        );
        const originalRandom = Math.random;
        const samples = [0, 0.4, 0.8];
        try {
            Math.random = () => samples.shift();
            await f.generate('qp', {
                ...independent,
                nlriRules: [{ type: 'dqpn', mode: 'random', min: 0, max: 9 }]
            });
        } finally {
            Math.random = originalRandom;
        }
        assert.equal(new Set(f.rows().map(route => route.ip)).size, 1);
        assert.deepEqual(
            f.rows().map(route => route.dqpn),
            [0, 4, 8],
            'DQPN random mode samples each route independently'
        );
        await assertRejectedSnapshot(
            { ipStep: -1, nlriRules: [{ type: 'dqpn', mode: 'fixed', value: 7 }] },
            /非负整数/
        );
        await assertRejectedSnapshot({ nlriRules: [{ type: 'dqpn', mode: 'fixed', value: 7 }] }, /duplicate route key/);
        await assertRejectedSnapshot(
            { nlriRules: [{ type: 'dqpn', mode: 'list', values: [7, 8] }] },
            /duplicate route key/
        );
        await assertRejectedSnapshot({ nlriRules: [] }, /duplicate route key/);
        await f.generate('qp', {
            routeGrowthMode: undefined,
            ipStep: 2,
            nlriRules: [{ type: 'dqpn', mode: 'fixed', value: 7 }]
        });
        const steppedIps =
            addressFamily === family.IPV6_QP
                ? ['2001:db8:100::1', '2001:db8:100::3', '2001:db8:100::5']
                : ['10.100.0.1', '10.100.0.3', '10.100.0.5'];
        assert.deepEqual(
            f.rows().map(route => route.ip),
            steppedIps
        );
        assert.deepEqual(
            f.rows().map(route => route.dqpn),
            [7, 7, 7]
        );
        await f.generate('qp', {
            routeGrowthMode: undefined,
            ipStep: 2,
            nlriRules: [{ type: 'dqpn', mode: 'increment', start: 7, step: 1 }]
        });
        assert.deepEqual(
            f.rows().map(route => route.ip),
            steppedIps
        );
        assert.deepEqual(
            f.rows().map(route => route.dqpn),
            [7, 8, 9]
        );
        f.sent.length = 0;
        await f.generate('qp', {
            ...config,
            routeGrowthMode: 'ip',
            nlriRules: [{ type: 'dqpn', mode: 'increment', start: 7, step: 100 }]
        });
        assert.deepEqual(
            f.rows().map(route => route.dqpn),
            [7, 7, 7],
            'IP-only growth samples one DQPN index'
        );
        assert.ok(attrs(f, type.MP_REACH_NLRI).every(attr => attr.value[3] === 0));
        f.sent.length = 0;
        await f.generate('qp', {
            routeGrowthMode: 'dqpn',
            nlriRules: [{ type: 'dqpn', mode: 'list', values: [0, 1, 2] }]
        });
        assert.equal(new Set(f.rows().map(route => route.ip)).size, 1);
        assert.deepEqual(
            f.rows().map(route => route.dqpn),
            [0, 1, 2]
        );
        f.sent.length = 0;
        await f.generate('qp', { routeGrowthMode: 'ip', count: 2 });
        assert.deepEqual(
            f.rows().map(route => [route.dqpn, route.mpNextHop]),
            [
                [null, null],
                [null, null]
            ]
        );
        assert.ok(reached(f).every(route => route.dqpn === null));
        assert.ok(
            rawReached(f).every(raw => raw[1] === 2),
            'no DQPN node must omit its TLV, retaining the prefix TLV'
        );
        f.store.close();
        f = fixture(dbPath, addressFamily);
        assert.deepEqual(
            f.rows().map(route => [route.dqpn, route.mpNextHop]),
            [
                [null, null],
                [null, null]
            ]
        );
        f.peer.sendRoute();
        assert.equal(reached(f).length, 2);
        assert.ok(reached(f).every(route => route.dqpn === null));
        f.sent.length = 0;
        f.worker.getRouteDetail('null-detail', { addressFamily, route: f.rows()[0] });
        assert.equal(f.responses.at(-1).dqpn, null);
        assert.equal(f.responses.at(-1).mpNextHop, null);
        f.worker.deleteQpRoute('single', {
            addressFamily,
            prefix: f.rows()[0].ip,
            mask: f.rows()[0].mask,
            dqpn: null,
            startDqpn: null,
            count: 1
        });
        assert.equal(withdrawn(f).length, 1);
        assert.equal(withdrawn(f)[0].dqpn, null);
        assert.equal(f.store.listRouteGroups()[0].routeCount, 1);
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('snapshot', { groupId: 'qp', count: 999, prefix: 'bad-draft' });
        assert.equal(f.rows().length, 0);
        assert.equal(withdrawn(f).length, 1);
        f.sent.length = 0;
        await f.generate('auto', { count: 1, nlriRules: [{ type: 'bsid', mode: 'auto' }] });
        assert.equal(
            attrs(f, type.MP_REACH_NLRI)[0].value.subarray(4, 20).toString('hex'),
            '00000000000000000000ffffc00002fe'
        );
        await f.worker.withdrawRouteGroup('clear', { groupId: 'auto' });
        f.sent.length = 0;
        await f.generate('large', {
            count: 2101,
            nlriRules: [
                { type: 'dqpn', mode: 'increment', start: 1, step: 1 },
                { type: 'bsid', mode: 'fixed', value: '2001:db8::1' }
            ]
        });
        assert.equal(reached(f).length, 2101, 'managed QP paging must cross the 2000-route boundary without loss');
        assert.equal(new Set(reached(f).map(route => `${route.prefix}|${route.dqpn}`)).size, 2101);
        assert.ok(f.sent.every(buffer => buffer.length <= 4096));
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('large-withdraw', { groupId: 'large' });
        assert.equal(withdrawn(f).length, 2101);
    } finally {
        f.store.close();
    }
}

async function testIpv6(directory) {
    const dbPath = path.join(directory, 'ipv6.sqlite');
    let f = fixture(dbPath, family.IPV6_UNC);
    try {
        const config = {
            count: 2,
            nlriRules: [
                { type: 'addPath', count: 3 },
                { type: 'mpNextHop', mode: 'auto' }
            ],
            attributeRules: [{ type: 'asPath', value: '65011' }, ...medNodes, { type: 'srv6', value: '2001:db8:6::1' }]
        };
        await f.generate('ipv6', config);
        assert.equal(reached(f).length, 6);
        assert.deepEqual(
            f.rows().map(route => route.pathId),
            [0, 1, 2, 0, 1, 2]
        );
        assert.deepEqual(
            f.packets()[0].pathAttributes.map(attr => attr.typeCode),
            [2, 4, 4, 40, 14]
        );
        assert.equal(
            f.instance.getRouteAttr(f.rows()[0]).srv6EndpointBehavior,
            18,
            'IPv6 API omissions use the metadata family endpoint default'
        );
        assert.equal(attrs(f, type.MP_REACH_NLRI)[0].mpReach.afi, 2);
        assert.ok(attrs(f, type.MP_REACH_NLRI).every(attr => attr.value[3] === 16));
        f.sent.length = 0;
        const before = f.store.getRouteGroupRoutes('ipv6');
        await assert.rejects(
            f.generate('other', { ...config, nlriRules: [{ type: 'addPath', count: 1 }] }),
            /conflicts/
        );
        assert.deepEqual(f.store.getRouteGroupRoutes('ipv6'), before);
        assert.equal(f.sent.length, 0);
        f.store.close();
        f = fixture(dbPath, family.IPV6_UNC);
        f.peer.sendRoute();
        assert.equal(reached(f).length, 6);
        f.sent.length = 0;
        await f.generate('ipv6', { count: 1, prefix: '2001:db8:101::1' });
        assert.equal(withdrawn(f).length, 6);
        assert.equal(reached(f).length, 1);
        assert.equal(attrs(f, type.MP_REACH_NLRI)[0].value[3], 0);
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('draft', { groupId: 'ipv6', prefix: '2001:db8:ffff::1' });
        assert.equal(withdrawn(f)[0].prefix, '2001:db8:101::1');
    } finally {
        f.store.close();
    }
}

async function testMvpn(directory) {
    const dbPath = path.join(directory, 'mvpn.sqlite');
    let f = fixture(dbPath, family.IPV4_MVPN);
    const leafRouteKey = '020c00000064000000010000ffff';
    try {
        for (let routeType = 1; routeType <= 7; routeType += 1) {
            f.sent.length = 0;
            const config = {
                routeType,
                rd: '100:1',
                sourceAs: 0,
                sourceIp: '192.0.2.10',
                groupIp: '239.1.1.1',
                originatingRouterIp: '192.0.2.20',
                leafRouteKey,
                attributeRules: [{ type: 'extendedCommunities', value: 'rt:1:1' }, ...medNodes]
            };
            await f.generate('mvpn', config);
            assert.equal(f.rows().length, 3, `MVPN Type ${routeType} Count must generate distinct NLRIs`);
            assert.equal(reached(f).length, 3);
            assert.deepEqual(
                f
                    .packets()
                    .at(-1)
                    .pathAttributes.map(attr => attr.typeCode),
                [16, 4, 4, 14]
            );
            assert.ok(attrs(f, type.MP_REACH_NLRI).every(attr => attr.value[3] === 0));
            assert.equal(attrs(f, type.PMSI_TUNNEL).length, 0);
            assert.equal(attrs(f, type.PREFIX_SID).length, 0);
            const body = reached(f)[0].rawNlri;
            if (routeType === 2) {
                assert.deepEqual(
                    f.rows().map(route => route.sourceAs),
                    [0, 1, 2]
                );
                assert.equal(body.slice(16), '00000000', 'explicit Source AS zero must not use the session AS');
            }
            if ([6, 7].includes(routeType)) assert.equal(body, '00000064000000010000000020c000020a20ef010101');
            if (routeType === 4) {
                assert.equal(
                    body,
                    `${leafRouteKey}c0000214`,
                    'Leaf body is Route Key + Origin IP, without a separate RD'
                );
                const storedLeaf = f.rows()[0];
                f.worker.getRouteDetail('leaf-detail', { addressFamily: family.IPV4_MVPN, route: storedLeaf });
                assert.equal(f.responses.at(-1).leafRouteKey, leafRouteKey);
                f.store.close();
                f = fixture(dbPath, family.IPV4_MVPN);
                assert.equal(f.rows()[0].leafRouteKey, leafRouteKey);
                f.peer.sendRoute();
                assert.equal(reached(f)[0].rawNlri, body);
                f.sent.length = 0;
                f.worker.deleteMvpnRoutes('leaf-single', {
                    addressFamily: family.IPV4_MVPN,
                    routeType: 4,
                    leafRouteKey,
                    originatingRouterIp: '192.0.2.20',
                    count: 1
                });
                assert.equal(withdrawn(f)[0].rawNlri, body);
                assert.equal(f.rows().length, 2);
                assert.equal(f.store.listRouteGroups()[0].routeCount, 2);
            }
            const before = f.store.getRouteGroupRoutes('mvpn');
            f.sent.length = 0;
            await assert.rejects(f.generate('collision', config), /conflicts/);
            assert.deepEqual(f.store.getRouteGroupRoutes('mvpn'), before);
            assert.equal(f.sent.length, 0);
            await assert.rejects(
                f.generate('mvpn', {
                    routes: [
                        { ...config, sourceAs: 99, originatingRouterIp: '192.0.2.100' },
                        { ...config, sourceAs: 'invalid', sourceIp: 'invalid', originatingRouterIp: 'invalid' }
                    ]
                }),
                /IPv4|invalid|Source AS/i
            );
            assert.deepEqual(f.store.getRouteGroupRoutes('mvpn'), before);
            assert.equal(f.sent.length, 0);
            const remainingBody = f.peer.buildMvpnNlri(f.rows()[0]).subarray(2).toString('hex');
            await f.worker.withdrawRouteGroup('snapshot', { groupId: 'mvpn', routeType: 99, groupIp: 'invalid-draft' });
            assert.equal(withdrawn(f).length, routeType === 4 ? 2 : 3);
            assert.equal(withdrawn(f)[0].rawNlri, remainingBody);
            assert.equal(f.rows().length, 0);
        }
        f.sent.length = 0;
        await f.generate('explicit-pmsi', {
            routeType: 1,
            count: 3,
            rd: '100:1',
            originatingRouterIp: '192.0.2.1',
            attributeRules: [{ type: 'custom', typeCode: 22, flags: 192, value: '0006000100c0000201' }],
            nlriRules: [{ type: 'mpNextHop', mode: 'list', values: ['192.0.2.200', '192.0.2.201', '192.0.2.200'] }]
        });
        assert.equal(attrs(f, type.PMSI_TUNNEL).length, 2, 'PMSI is emitted only when explicitly configured');
        assert.equal(reached(f).length, 3);
        assert.equal(attrs(f, type.MP_REACH_NLRI).length, 2, 'MVPN MP Next Hop lists split equal-attribute UPDATEs');
        assert.equal(attrs(f, type.MP_REACH_NLRI)[0].value.subarray(4, 8).toString('hex'), 'c00002c8');
    } finally {
        f.store.close();
    }
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-family-trees-'));
    try {
        for (const mode of ['fixed', 'increment', 'random', 'list']) {
            const context = buildAttributeRuleContext(
                {
                    addressFamily: family.IPV4_QP,
                    count: 2,
                    nlriRules: [
                        {
                            type: 'dqpn',
                            mode,
                            value: 0xffffff,
                            start: 0,
                            step: 1,
                            min: 0,
                            max: 0xffffff,
                            values: [0, 0xffffff]
                        }
                    ]
                },
                () => 0.999999999
            );
            const value = getGeneratedAttributeValues(context, 1).dqpn;
            assert.ok(value >= 0 && value <= 0xffffff);
        }
        let randomCalls = 0;
        const fixedSample = buildAttributeRuleContext(
            {
                addressFamily: family.IPV4_QP,
                count: 3,
                routeGrowthMode: 'ip',
                nlriRules: [{ type: 'dqpn', mode: 'random', min: 0, max: 0xffffff }]
            },
            () => (++randomCalls === 1 ? 0 : 0.999999)
        );
        assert.deepEqual(
            [0, 1, 2].map(index => getGeneratedAttributeValues(fixedSample, index).dqpn),
            [0, 0, 0]
        );
        assert.equal(randomCalls, 1, 'IP-only growth must retain the first random DQPN sample');
        for (const addressFamily of [family.IPV4_UNC, family.IPV4_LABEL_UNICAST, family.IPV6_UNC])
            await testPrefixStep(directory, addressFamily);
        await testIpv6(directory);
        await testQp(directory, family.IPV4_QP);
        await testQp(directory, family.IPV6_QP);
        await testMvpn(directory);
        console.log(
            'IPv6, QP, and MVPN tree generation, ordered wire attributes, node absence, atomic snapshots, ownership, SQLite replay, paging, and actual NLRI withdrawals passed'
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
