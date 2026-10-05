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
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { collectBgpGeneratedRoutes } = require('../../electron/utils/bgp/simulator/bgpRouteGenerator');
const {
    buildAttributeRuleContext,
    getGeneratedAttributeValues
} = require('../../electron/utils/bgp/simulator/bgpAttributeRules');
const { normalizeEvpnSrv6Parameters, validateEvpnSrv6Sid } = require('../../shared/bgpEvpnSrv6');

const addressFamily = BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN;
const types = BgpConst.BGP_PATH_ATTR;
const structure = {
    locatorBlockLength: 32,
    locatorNodeLength: 32,
    functionLength: 64,
    argumentLength: 0,
    transpositionLength: 0,
    transpositionOffset: 0
};
const esi = '00:00:00:00:00:00:00:00:00:01';
const attributes = [
    { type: 'origin', value: 0 },
    { type: 'asPath', value: '65000' },
    { type: 'extendedCommunities', value: ['rt:65000:100'] }
];

function sid(type, value, endpointBehavior, options = {}) {
    return { type, mode: 'fixed', value, endpointBehavior, ...structure, ...options };
}
function config(routeType, overrides = {}, services = []) {
    return {
        addressFamily,
        routeType,
        encapsulationType: 'srv6',
        esi: routeType === 5 ? '00:00:00:00:00:00:00:00:00:00' : esi,
        ethernetTagId: 100,
        macAddress: '02:00:00:00:00:01',
        ipAddress: '192.0.2.1',
        originatingRouterIp: '192.0.2.254',
        prefix: '198.51.100.0',
        mask: 24,
        count: 3,
        attributeRules: attributes,
        nlriRules: [
            { type: 'rd', mode: 'fixed', value: routeType === 4 ? '192.0.2.254:100' : `65000:${100 + routeType}` },
            { type: 'mpNextHop', mode: 'fixed', value: '2001:db8::fe' },
            ...services
        ],
        ...overrides
    };
}

function fixture(dbPath) {
    const worker = new BgpWorker();
    const store = new BgpRouteSqliteStore({ dbPath }).open();
    const instance = new BgpInstance(0, 25, 70, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    worker.messageHandler.sendSuccessResponse = () => {};
    worker.messageHandler.sendErrorResponse = (_id, error) => {
        throw new Error(error);
    };
    const sent = [];
    const session = {
        localIp: '192.0.2.254',
        peerIp: '192.0.2.1',
        localAs: 65000,
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
        isAddPathSendEnabled: () => false,
        buildBgpMessageHeader(length, type) {
            const header = Buffer.alloc(19, 0xff);
            header.writeUInt16BE(length, 16);
            header[18] = type;
            return header;
        },
        processCustomPkt: hex => Buffer.from(hex, 'hex'),
        sendRoute: packet => sent.push(Buffer.from(packet))
    };
    const peer = new BgpPeer(session, instance);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    instance.peerMap.set(session.peerIp, peer);
    const packets = () =>
        sent.map(buffer => {
            const packet = parseBgpPacket(buffer, { asnSize: 4 });
            assert.ok(packet.valid, packet.error);
            return packet;
        });
    return {
        worker,
        store,
        instance,
        peer,
        sent,
        session,
        packets,
        generate: (groupId, routeConfig) =>
            worker.generateVpnEvpnRoutes(groupId, { ...routeConfig, groupId, groupName: groupId }),
        rows: groupId => store.getRouteGroupRoutes(groupId),
        reaches: () =>
            packets().flatMap(
                packet => packet.pathAttributes.find(attr => attr.typeCode === types.MP_REACH_NLRI)?.mpReach.nlri || []
            ),
        withdrawals: () =>
            packets().flatMap(
                packet =>
                    packet.pathAttributes.find(attr => attr.typeCode === types.MP_UNREACH_NLRI)?.mpUnreach
                        .withdrawnRoutes || []
            )
    };
}

function testNlriRules() {
    const base = config(2, { encapsulationType: 'mpls' });
    const values = (rd, label, random = () => 0.5) => {
        const rules = [rd, label, { type: 'mpNextHop', mode: 'auto' }];
        const context = buildAttributeRuleContext({ ...base, nlriRules: rules }, random);
        return [0, 1, 2].map(index => getGeneratedAttributeValues(context, index));
    };
    const list = values(
        { type: 'rd', mode: 'list', values: ['65000:1', '65536:2', '192.0.2.1:3'] },
        { type: 'label', mode: 'list', values: [0, 0xfffff] }
    );
    assert.deepEqual(
        list.map(value => value.rd),
        ['65000:1', '65536:2', '192.0.2.1:3']
    );
    assert.deepEqual(
        list.map(value => value.label),
        [0, 0xfffff, 0]
    );
    const inc = values(
        { type: 'rd', mode: 'increment', base: '192.0.2.1', start: 3, step: -1 },
        { type: 'label', mode: 'increment', start: 16000, step: 2 }
    );
    assert.deepEqual(
        inc.map(value => value.rd),
        ['192.0.2.1:3', '192.0.2.1:2', '192.0.2.1:1']
    );
    assert.deepEqual(
        inc.map(value => value.label),
        [16000, 16002, 16004]
    );
    for (const random of [() => 0, () => 1]) {
        const generated = values(
            { type: 'rd', mode: 'random', base: '65536', min: 1, max: 2 },
            { type: 'label', mode: 'random', min: 0, max: 0xfffff },
            random
        );
        assert.ok(generated.every(value => value.rd === (random() ? '65536:2' : '65536:1')));
        assert.ok(generated.every(value => value.label === (random() ? 0xfffff : 0)));
    }
    const vxlan = {
        ...base,
        encapsulationType: 'vxlan',
        nlriRules: [
            { type: 'rd', value: '65000:1' },
            { type: 'vni', mode: 'increment', start: 0xfffffd, step: 1 },
            { type: 'vni2', mode: 'list', values: [0, 0xffffff] },
            { type: 'mpNextHop', mode: 'auto' }
        ]
    };
    const routes = collectBgpGeneratedRoutes(vxlan);
    assert.deepEqual(
        routes.map(route => route.vni),
        [0xfffffd, 0xfffffe, 0xffffff]
    );
    assert.deepEqual(
        routes.map(route => route.vni2),
        [0, 0xffffff, 0]
    );
    assert.ok(routes.every(route => route.label === undefined && route.label2 === undefined));
    assert.throws(
        () => buildAttributeRuleContext({ ...vxlan, nlriRules: [...vxlan.nlriRules, { type: 'label', value: 16 }] }),
        /不适用/
    );
    assert.throws(
        () => buildAttributeRuleContext({ ...vxlan, nlriRules: vxlan.nlriRules.filter(rule => rule.type !== 'rd') }),
        /需要RD/
    );
    assert.throws(
        () => buildAttributeRuleContext({ ...vxlan, nlriRules: vxlan.nlriRules.filter(rule => rule.type !== 'vni') }),
        /需要VNI/
    );
    assert.throws(
        () => buildAttributeRuleContext({ ...vxlan, nlriRules: [...vxlan.nlriRules, vxlan.nlriRules[1]] }),
        /重复/
    );
    const es = config(4);
    assert.throws(
        () => buildAttributeRuleContext({ ...es, nlriRules: [...es.nlriRules, { type: 'label', value: 16 }] }),
        /不适用/
    );
    for (const rule of [
        { type: 'rd', value: '65000:1' },
        { type: 'rd', mode: 'list', values: ['192.0.2.1:1', '65000:1'] },
        { type: 'rd', mode: 'increment', base: '65000', start: 1, step: 1 },
        { type: 'rd', mode: 'random', base: '65536', min: 1, max: 3 }
    ])
        assert.throws(() => buildAttributeRuleContext({ ...es, nlriRules: [rule, es.nlriRules[1]] }), /RD必须为IPv4/);
}

function testSidValidation() {
    const route = config(2);
    const l2 = sid('srv6L2', '2001:db8::1', 23);
    const params = normalizeEvpnSrv6Parameters(l2, route);
    assert.ok(validateEvpnSrv6Sid('2001:db8::1', params, route));
    for (const changes of [
        { endpointBehavior: 24 },
        { argumentLength: 1, functionLength: 63 },
        { transpositionLength: 1 },
        { functionLength: 65 }
    ])
        assert.throws(() => normalizeEvpnSrv6Parameters({ ...l2, ...changes }, route), /Behavior|Argument|转置|总位数/);
    const short = normalizeEvpnSrv6Parameters({ ...l2, functionLength: 0 }, route);
    assert.throws(() => validateEvpnSrv6Sid('2001:db8::1', short, route), /位必须为0/);
    const ruleConfig = config(2, {}, [{ ...l2, mode: 'increment', start: '2001:db8::', functionLength: 0, step: 1 }]);
    assert.throws(() => buildAttributeRuleContext(ruleConfig), /步长/);
    assert.throws(
        () =>
            buildAttributeRuleContext(
                config(2, {}, [
                    sid('srv6L2', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 23, {
                        mode: 'increment',
                        start: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
                    })
                ])
            ),
        /超出IPv6/
    );
    const perEs = config(1, { ethernetTagId: 0xffffffff });
    assert.throws(
        () => validateEvpnSrv6Sid('2001:db8::1', normalizeEvpnSrv6Parameters(sid('srv6L2', '::', 24), perEs), perEs),
        /必须为::/
    );
    assert.throws(
        () => buildAttributeRuleContext(config(2, { ipAddress: '' }, [l2, sid('srv6L3', '2001:db8::2', 20)])),
        /不适用/
    );
    assert.throws(() => buildAttributeRuleContext(config(5, {}, [sid('srv6L3', '2001:db8::2', 18)])), /Behavior/);
    for (const encapsulationType of ['mpls', 'vxlan']) {
        const forwardType = encapsulationType === 'mpls' ? 'label' : 'vni';
        const perEsConfig = config(1, {
            encapsulationType,
            ethernetTagId: 0xffffffff,
            nlriRules: [
                { type: 'rd', mode: 'increment', base: '192.0.2.254', start: 1, step: 1 },
                { type: forwardType, mode: 'fixed', value: 0 },
                { type: 'mpNextHop', mode: 'auto' }
            ]
        });
        const routes = collectBgpGeneratedRoutes(perEsConfig);
        assert.deepEqual(
            routes.map(route => route.rd),
            ['192.0.2.254:1', '192.0.2.254:2', '192.0.2.254:3']
        );
        assert.ok(routes.every(route => route.ethernetTagId === 0xffffffff && route[forwardType] === 0));
        const withValue = value => ({
            ...perEsConfig,
            nlriRules: [perEsConfig.nlriRules[0], { type: forwardType, value }, perEsConfig.nlriRules[2]]
        });
        assert.throws(() => collectBgpGeneratedRoutes(withValue(16)), /Label必须为0/);
        assert.throws(
            () =>
                collectBgpGeneratedRoutes({
                    ...perEsConfig,
                    nlriRules: [{ type: 'rd', value: '192.0.2.1:0' }, ...perEsConfig.nlriRules.slice(1)]
                }),
            /RD数值不能为0/
        );
    }
}

async function testWireAndPersistence(directory) {
    const dbPath = path.join(directory, 'srv6.sqlite');
    let f = fixture(dbPath);
    try {
        const scenarios = [
            config(1, {}, [sid('srv6L2', '2001:db8:1::1', 23)]),
            config(2, {}, [sid('srv6L2', '2001:db8:2::1', 23), sid('srv6L3', '2001:db8:3::1', 19)]),
            config(3, {}, [sid('srv6L2', '2001:db8:4::1', 24, { mode: 'increment', start: '2001:db8:4::1', step: 1 })]),
            config(4, { esImportRt: '02:00:00:00:00:01' }),
            config(5, {}, [
                sid('srv6L3', '2001:db8:5::1', 19, { mode: 'list', values: ['2001:db8:5::1', '2001:db8:5::2'] })
            ])
        ];
        for (const routeConfig of scenarios) {
            const id = `type-${routeConfig.routeType}`;
            f.sent.length = 0;
            await f.generate(id, routeConfig);
            assert.equal(f.reaches().length, 3);
            for (const packet of f.packets()) {
                const mp = packet.pathAttributes.find(attr => attr.typeCode === types.MP_REACH_NLRI).mpReach;
                assert.equal(mp.nextHopLength, 16, 'IPv4 TCP transport carries the explicit IPv6 PE next hop');
                const prefixSid = packet.pathAttributes.filter(attr => attr.typeCode === types.PREFIX_SID);
                if (routeConfig.routeType === 4) {
                    assert.equal(prefixSid.length, 0);
                    assert.ok(mp.nlri.every(route => route.labels === undefined || route.labels.length === 0));
                } else {
                    assert.equal(prefixSid.length, 1, 'two service SIDs use one Prefix-SID path attribute');
                    assert.deepEqual(
                        prefixSid[0].prefixSid.srv6Services.map(service => service.serviceType),
                        routeConfig.routeType === 2 ? ['l2', 'l3'] : [routeConfig.routeType === 5 ? 'l3' : 'l2']
                    );
                    for (const service of prefixSid[0].prefixSid.srv6Services) {
                        assert.equal(service.sidInfos.length, 1);
                        assert.deepEqual(service.sidInfos[0].sidStructure, structure);
                    }
                    if ([1, 2, 5].includes(routeConfig.routeType))
                        assert.ok(mp.nlri.every(route => route.labels.every(label => label.raw24 === 0x30)));
                }
                if (routeConfig.routeType === 3) {
                    const pmsi = packet.pathAttributes.find(attr => attr.typeCode === types.PMSI_TUNNEL).pmsiTunnel;
                    assert.equal(pmsi.tunnelType, 6);
                    assert.equal(pmsi.label.raw24, 0);
                    assert.equal(
                        pmsi.tunnelIdentifierHex,
                        Buffer.from(mp.nlri[0].originatingRouterIp.split('.').map(Number)).toString('hex')
                    );
                }
            }
            const row = f.rows(id)[0];
            const info = f.instance.hydrateRoute(row).getRouteInfo(row.routeAttr);
            if (routeConfig.routeType === 4) assert.equal(info.srv6Services, undefined);
            else assert.equal(info.srv6Services.length, routeConfig.routeType === 2 ? 2 : 1);
        }
        f.sent.length = 0;
        const perEs = config(1, {
            ethernetTagId: 0xffffffff,
            nlriRules: [
                { type: 'rd', mode: 'increment', base: '192.0.2.254', start: 100, step: 1 },
                { type: 'mpNextHop', mode: 'fixed', value: '2001:db8::fe' },
                sid('srv6L2', '::', 24)
            ]
        });
        await f.generate('per-es', perEs);
        assert.deepEqual(
            f.reaches().map(route => route.rd),
            ['192.0.2.254:100', '192.0.2.254:101', '192.0.2.254:102']
        );
        assert.ok(f.reaches().every(route => route.ethernetTagId === 0xffffffff && route.labels[0].raw24 === 0));
        assert.ok(
            f
                .packets()
                .every(packet =>
                    packet.pathAttributes
                        .find(attr => attr.typeCode === types.EXTENDED_COMMUNITIES)
                        .value.includes(Buffer.from('0601000000000030', 'hex'))
                )
        );
        const stored = f.rows('type-2');
        const keys = stored.map(row => row.routeKey);
        f.sent.length = 0;
        await f.generate(
            'type-2',
            config(2, {}, [sid('srv6L2', '2001:db8:2::2', 23), sid('srv6L3', '2001:db8:3::2', 19)])
        );
        assert.deepEqual(
            f.rows('type-2').map(row => row.routeKey),
            keys
        );
        assert.equal(f.withdrawals().length, 0, 'service SID changes update the same NLRI');
        const snapshot = f.rows('type-2');
        const invalid = [
            config(2, {}, []),
            config(2, {}, [sid('srv6L2', '2001:db8::1', 24)]),
            config(2, {
                nlriRules: [
                    { type: 'rd', value: '65000:102' },
                    { type: 'mpNextHop', mode: 'fixed', value: '192.0.2.1' },
                    sid('srv6L2', '2001:db8::1', 23)
                ]
            }),
            config(2, {
                nlriRules: [
                    { type: 'rd', value: '65000:102' },
                    { type: 'mpNextHop', mode: 'auto' },
                    sid('srv6L2', '2001:db8::1', 23)
                ]
            }),
            config(
                2,
                { attributeRules: [...attributes, { type: 'extendedCommunities', value: ['hex:030c00000000000a'] }] },
                [sid('srv6L2', '2001:db8::1', 23)]
            )
        ];
        for (const candidate of invalid) {
            f.sent.length = 0;
            await assert.rejects(async () => f.generate('type-2', candidate), /SID|Behavior|Next Hop|Community/);
            assert.deepEqual(f.rows('type-2'), snapshot);
            assert.equal(f.sent.length, 0, 'invalid replacement preserves and does not announce the original group');
        }
        f.sent.length = 0;
        for (const value of ['0006000030c00002fe', '0106000000c00002fe'])
            await assert.rejects(
                async () =>
                    f.generate(
                        'bad-pmsi',
                        config(
                            3,
                            {
                                attributeRules: [...attributes, { type: 'custom', typeCode: 22, flags: 192, value }]
                            },
                            [sid('srv6L2', '2001:db8:4::1', 24)]
                        )
                    ),
                /PMSI/
            );
        assert.equal(f.sent.length, 0);
        await f.generate(
            'ipv6-encap-community',
            config(
                2,
                {
                    count: 1,
                    macAddress: '02:00:00:00:10:01',
                    attributeRules: [...attributes, { type: 'extendedCommunities', value: ['hex:030c00000000000e'] }]
                },
                [sid('srv6L2', '2001:db8:20::1', 23)]
            )
        );
        await f.worker.withdrawRouteGroup('remove-ipv6-encap-community', { groupId: 'ipv6-encap-community' });
        f.store.close();
        f = fixture(dbPath);
        assert.deepEqual(f.rows('type-2'), snapshot);
        f.peer.sendRoute();
        assert.equal(f.reaches().length, 18);
        assert.ok(f.sent.every(packet => packet.length <= 4096));
        for (const id of ['type-1', 'type-2', 'type-3', 'type-4', 'type-5', 'per-es']) {
            f.sent.length = 0;
            await f.worker.withdrawRouteGroup(id, { groupId: id });
            assert.equal(f.withdrawals().length, 3);
            assert.ok(
                f.packets().every(packet => !packet.pathAttributes.some(attr => attr.typeCode === types.PREFIX_SID))
            );
        }
        f.sent.length = 0;
        await f.generate('large', config(2, { count: 1500 }, [sid('srv6L2', '2001:db8:2::1', 23)]));
        assert.equal(f.reaches().length, 1500);
        assert.ok(f.sent.every(packet => packet.length <= 4096));
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('large', { groupId: 'large' });
        assert.equal(f.withdrawals().length, 1500);
        assert.ok(f.sent.every(packet => packet.length <= 4096));
    } finally {
        f.store.close();
    }
}

(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-evpn-srv6-'));
    try {
        testNlriRules();
        testSidValidation();
        await testWireAndPersistence(directory);
        console.log('EVPN NLRI rules, SRv6 wire encoding, reopen and withdrawal tests passed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
