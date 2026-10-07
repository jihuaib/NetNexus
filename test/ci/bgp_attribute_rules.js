const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const {
    buildAttributeRuleContext,
    getGeneratedAttributeValues
} = require('../../electron/utils/bgp/simulator/bgpAttributeRules');
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForUnitTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { getAfiAndSafi } = require('../../electron/utils/bgp/bgpUtils');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const attributeRegistry = require('../../shared/bgpAttributes.json');
const { ATTRIBUTE_DEFAULTS } = require('../../electron/utils/bgp/bgpAttributeRegistry');

const coreRules = () =>
    attributeRegistry.attributes
        .filter(entry => entry.defaultNode && !entry.addressFamilies)
        .map(entry => ({ type: entry.type, ...JSON.parse(JSON.stringify(entry.default)) }));

function generated(rules, index = 0, random = () => 0.5, count = 4) {
    const nlriRules = rules.filter(
        rule => attributeRegistry.attributes.find(entry => entry.type === rule?.type)?.section === 'nlri'
    );
    const attributeRules = rules.filter(rule => !nlriRules.includes(rule));
    return getGeneratedAttributeValues(buildAttributeRuleContext({ attributeRules, nlriRules, count }, random), index);
}

assert.strictEqual(buildAttributeRuleContext({}).enabled, false, 'old configurations must retain legacy generation');
assert.strictEqual(buildAttributeRuleContext({ attributeRules: [] }).enabled, true);
assert.strictEqual(buildAttributeRuleContext({ nlriRules: [] }).enabled, true);
assert.throws(
    () => buildAttributeRuleContext({ attributeRules: [{ type: 'addPath', enabled: false, count: 2 }] }),
    /NLRI分支/
);
assert.throws(() => buildAttributeRuleContext({ nlriRules: [{ type: 'med', value: 0 }] }), /Path Attributes分支/);
assert.deepStrictEqual(generated([]), {
    attr: { pathAttributes: [] },
    label: undefined,
    mpNextHop: null,
    pathId: undefined
});
assert.strictEqual(generated([{ type: 'nextHop', mode: 'fixed', value: '010.0.0.1' }]).attr.nextHop, '10.0.0.1');
assert.deepStrictEqual(
    generated(
        [
            { type: 'origin', mode: 'list', values: ['IGP', 'EGP', 'INCOMPLETE'] },
            { type: 'asPath', mode: 'random', min: 64512, max: 64515, minLength: 1, maxLength: 3 },
            { type: 'nextHop', mode: 'increment', start: '192.0.2.254', step: 1 },
            { type: 'med', mode: 'random', min: 0, max: 10 },
            { type: 'localPref', mode: 'increment', start: 100, step: 10 },
            { type: 'communities', mode: 'increment', base: 65000, start: 100, step: 1 },
            { type: 'extendedCommunities', mode: 'random', subtype: 'rt', base: 65000, min: 100000, max: 100002 },
            { type: 'custom', mode: 'list', typeCode: 99, flags: 192, values: ['ca fe', 'be ef'] }
        ],
        2
    ),
    {
        attr: {
            pathAttributes: [
                { type: 'origin', value: 2 },
                { type: 'asPath', value: '64514 64514' },
                { type: 'nextHop', value: '192.0.3.0' },
                { type: 'med', value: 5 },
                { type: 'localPref', value: 120 },
                { type: 'communities', value: ['65000:102'] },
                { type: 'extendedCommunities', value: ['rt:65000:100001'] },
                { type: 'custom', value: 'c06302cafe' }
            ],
            origin: 2,
            asPath: '64514 64514',
            nextHop: '192.0.3.0',
            med: 5,
            localPref: 120,
            communities: ['65000:102'],
            extendedCommunities: ['rt:65000:100001'],
            customAttr: 'c06302cafe'
        },
        label: undefined,
        mpNextHop: null,
        pathId: undefined
    }
);
assert.strictEqual(generated([{ type: 'med', mode: 'random', min: 0, max: 10 }], 0, () => 0).attr.med, 0);
assert.strictEqual(generated([{ type: 'med', mode: 'random', min: 0, max: 10 }], 0, () => 1).attr.med, 10);
assert.strictEqual(generated([{ type: 'origin', mode: 'list', values: [0, 1] }], 3).attr.origin, 1);
assert.strictEqual(generated([{ type: 'asPath', mode: 'increment', start: 64512, step: 1 }], 3).attr.asPath, '64515');
assert.deepStrictEqual(
    generated([{ type: 'communities', mode: 'list', values: ['65000:1 65000:2', '65000:3'] }], 2).attr.communities,
    ['65000:1', '65000:2']
);
assert.deepStrictEqual(
    generated([{ type: 'communities', mode: 'increment', base: 65000, start: 100, step: 2, valueCount: 3 }], 2).attr
        .communities,
    ['65000:112', '65000:114', '65000:116'],
    'increment advances across every value in preceding routes'
);
assert.deepStrictEqual(
    generated([{ type: 'communities', mode: 'increment', base: 65000, start: 100, step: -1, valueCount: 3 }], 1).attr
        .communities,
    ['65000:97', '65000:96', '65000:95']
);
const communitySamples = [0, 0.8, 0.8, 0.1];
assert.deepStrictEqual(
    generated([{ type: 'communities', mode: 'random', base: 65000, min: 1, max: 10, valueCount: 4 }], 0, () =>
        communitySamples.shift()
    ).attr.communities,
    ['65000:1', '65000:9', '65000:9', '65000:2'],
    'random samples each value and preserves repeats and order'
);
assert.equal(communitySamples.length, 0);
for (const attrType of ['communities', 'extendedCommunities']) {
    const metadata = attributeRegistry.attributes.find(entry => entry.type === attrType);
    assert.equal(metadata.default.valueCount, 1);
    for (const mode of ['increment', 'random']) {
        for (const valueCount of [null, '', 0, -1, 1.5, NaN, Infinity, metadata.valueCountValidation.max + 1])
            assert.throws(
                () => generated([{ type: attrType, mode, base: 65000, start: 1, min: 0, max: 1, valueCount }]),
                /每路由值数量/
            );
        const context = buildAttributeRuleContext({
            count: 1,
            attributeRules: [
                {
                    type: attrType,
                    mode,
                    start: 0,
                    step: 0,
                    min: 0,
                    max: 1,
                    valueCount: metadata.valueCountValidation.max
                }
            ]
        });
        assert.equal(
            context.rules[0].valueCount,
            metadata.valueCountValidation.max,
            'the protocol count limit is accepted'
        );
    }
    assert.throws(
        () =>
            buildAttributeRuleContext({
                count: Number.MAX_SAFE_INTEGER,
                attributeRules: [{ type: attrType, mode: 'random', min: 0, max: 1, valueCount: 2 }]
            }),
        /生成属性值总数超出安全整数范围/
    );
}
for (const rule of [
    { mode: 'fixed', value: '65000:1 65000:1', valueCount: null },
    { mode: 'list', values: ['65000:1 65000:1'], valueCount: 0 }
])
    assert.deepStrictEqual(generated([{ type: 'communities', ...rule }]).attr.communities, ['65000:1', '65000:1']);
const addPathCommunities = buildAttributeRuleContext({
    count: 2,
    nlriRules: [{ type: 'addPath', count: 3 }],
    attributeRules: [{ type: 'communities', mode: 'increment', start: 65524, step: 1, valueCount: 2 }]
});
assert.deepStrictEqual(getGeneratedAttributeValues(addPathCommunities, 5).attr.communities, [
    '65000:65534',
    '65000:65535'
]);
assert.throws(
    () =>
        buildAttributeRuleContext({
            count: 2,
            nlriRules: [{ type: 'addPath', count: 3 }],
            attributeRules: [{ type: 'communities', mode: 'increment', start: 65525, step: 1, valueCount: 2 }]
        }),
    /最后一个属性值/
);
assert.deepStrictEqual(
    generated([{ type: 'extendedCommunities', mode: 'fixed', value: 'rt:65000:100000 soo:192.0.2.1:20 rt:65536:10' }])
        .attr.extendedCommunities,
    ['rt:65000:100000', 'soo:192.0.2.1:20', 'rt:65536:10']
);
assert.strictEqual(generated([{ type: 'label', mode: 'list', values: [16000, 16010] }], 3).label, 16010);
assert.strictEqual(
    generated([
        { type: 'custom', value: 'c0 63 01 ff' },
        { type: 'custom', value: '00', typeCode: 100 }
    ]).attr.customAttr,
    'c06301ffc0640100'
);
assert.ok(
    generated([{ type: 'custom', value: 'ff'.repeat(256), typeCode: 99 }]).attr.customAttr.startsWith('d0630100'),
    'long custom values require extended attribute length'
);
assert.throws(() => generated([{ type: 'med', mode: 'increment', start: 0xffffffff, step: 1 }]), /最后一个属性值/);
assert.throws(
    () => generated([{ type: 'nextHop', mode: 'increment', start: '255.255.255.254', step: 1 }]),
    /最后一个属性值/
);
assert.throws(() => generated([{ type: 'communities', mode: 'fixed', value: '65000:65536' }]), /Community数值/);
assert.throws(
    () => generated([{ type: 'extendedCommunities', mode: 'fixed', value: 'rt:65536:65536' }]),
    /Extended Community数值/
);
assert.throws(() => generated([{ type: 'custom', value: 'abc' }]), /偶数/);
assert.deepStrictEqual(
    generated([
        { type: 'med', value: 1 },
        { type: 'med', value: 2 }
    ]).attr.pathAttributes,
    [
        { type: 'med', value: 1 },
        { type: 'med', value: 2 }
    ]
);
assert.throws(() => generated([{ type: 'asPath', mode: 'random', min: 10, max: 9 }]), /最大值/);
assert.throws(() => generated([{ type: 'localPref', mode: 'list', values: [] }]), /不能为空/);
assert.deepStrictEqual(
    generated([
        { type: 'med', value: 5 },
        { type: 'med', value: 6, enabled: false }
    ]).attr,
    {
        med: 6,
        pathAttributes: [
            { type: 'med', value: 5 },
            { type: 'med', value: 6 }
        ]
    }
);

function makeFixture(addressFamily, peerType = BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP, options = {}) {
    const worker = new BgpWorker();
    const { afi, safi } = getAfiAndSafi(addressFamily);
    const instance = new BgpInstance(0, afi, safi, options.dbPath ? new BgpRouteSqliteStore(options.dbPath) : null);
    worker.bgpInstanceMap.set(BgpInstance.makeKey(0, afi, safi), instance);
    const responses = [];
    const errors = [];
    const sent = [];
    worker.messageHandler.sendSuccessResponse = (id, data) => responses.push({ id, data });
    worker.messageHandler.sendErrorResponse = (id, error) => errors.push({ id, error });
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        routerId: '192.0.2.254',
        peerIp: '192.0.2.1',
        peerType,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
        buildBgpMessageHeader(length, type) {
            const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
            header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
            header[BgpConst.BGP_MARKER_LEN + 2] = type;
            return header;
        },
        processCustomPkt: hex => Buffer.from(hex.replace(/\s/g, ''), 'hex'),
        sendRoute: buffer => sent.push(Buffer.from(buffer)),
        ...options.session
    };
    const peer = new BgpPeer(session, instance, options.peerOptions);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    instance.peerMap.set(session.peerIp, peer);
    return { worker, instance, responses, errors, sent, peer };
}

function attrs(packet) {
    return new Map(packet.pathAttributes.map(attr => [attr.typeCode, attr]));
}

{
    const { worker, instance, responses, errors, sent } = makeFixture(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    const attributeRules = [
        { type: 'origin', mode: 'list', values: [0, 1, 2] },
        { type: 'asPath', mode: 'list', values: ['64512 64513', '64520', '64530 64531'] },
        { type: 'nextHop', mode: 'increment', start: '192.0.2.10', step: 1 },
        { type: 'med', mode: 'increment', start: 10, step: 5 },
        { type: 'localPref', mode: 'increment', start: 100, step: 10 },
        { type: 'communities', mode: 'increment', base: 65000, start: 200, step: 1 },
        { type: 'extendedCommunities', mode: 'fixed', value: 'rt:65000:100000' },
        { type: 'custom', typeCode: 99, flags: 192, value: 'cafe' }
    ];
    worker.generateRoutes('first-group', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.0.0.1',
        mask: 32,
        count: 3,
        attributeRules
    });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(responses.length, 1);
    assert.strictEqual(sent.length, 3, 'different attributes must be encoded in distinct UPDATEs');
    const decoded = sent.map(buffer => parseBgpPacket(buffer, { asnSize: 4 }));
    decoded.forEach((packet, index) => {
        assert.ok(packet.valid);
        assert.deepStrictEqual(
            packet.nlri.map(nlri => nlri.prefix),
            [`10.0.0.${index + 1}`]
        );
        const attr = attrs(packet);
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.ORIGIN).value[0], index);
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.NEXT_HOP).nextHop, `192.0.2.${10 + index}`);
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.MED).med, 10 + index * 5);
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.LOCAL_PREF).localPref, 100 + index * 10);
        assert.deepStrictEqual(
            attr.get(BgpConst.BGP_PATH_ATTR.AS_PATH).segments.flatMap(segment => segment.asNumbers),
            attributeRules[1].values[index].split(' ').map(Number)
        );
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.COMMUNITY).communities[0].formatted, `65000:${200 + index}`);
        assert.strictEqual(
            attr.get(BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES).value.toString('hex'),
            '0002fde8000186a0'
        );
        assert.strictEqual(attr.get(99).value.toString('hex'), 'cafe');
    });
    const firstGroup = Array.from(instance.routeMap.values()).map(route =>
        route.getRouteInfo(instance.getRouteAttr(route))
    );
    sent.length = 0;
    worker.generateRoutes('second-group', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.0.1.1',
        mask: 32,
        count: 1,
        attributeRules: [
            { type: 'med', value: 999 },
            { type: 'extendedCommunities', value: 'rt:65000:999' }
        ]
    });
    assert.strictEqual(sent.length, 1, 'adding a new group must not retransmit old routes');
    assert.deepStrictEqual(
        Array.from(instance.routeMap.values())
            .slice(0, 3)
            .map(route => route.getRouteInfo(instance.getRouteAttr(route))),
        firstGroup,
        'a new group must never modify attributes of existing groups'
    );
    assert.strictEqual(instance.rt, '', 'tree rules must not change instance-level defaults');
    assert.strictEqual(instance.customAttr, '');
    const routeCount = instance.routeMap.size;
    assert.throws(
        () =>
            worker.generateRoutes('invalid-rule', {
                addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
                prefix: '10.0.2.1',
                mask: 32,
                count: 3000,
                attributeRules: [{ type: 'med', mode: 'increment', start: 0xffffff00, step: 1 }]
            }),
        /最后一个属性值/
    );
    assert.strictEqual(
        instance.routeMap.size,
        routeCount,
        'invalid rules must be rejected before any persistence batch'
    );
    assert.strictEqual(sent.length, 1, 'invalid rules must not send partial UPDATEs');
    instance.routeStore.close();
}

{
    const { worker, instance, sent } = makeFixture(
        BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST,
        BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP
    );
    worker.generateRoutes('label-rules', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST,
        prefix: '10.2.0.1',
        mask: 32,
        count: 3,
        nlriRules: [
            { type: 'label', mode: 'increment', start: 16000, step: 5 },
            { type: 'mpNextHop', mode: 'list', values: ['198.51.100.1', '198.51.100.2'] }
        ],
        attributeRules: [
            { type: 'nextHop', mode: 'list', values: ['198.51.100.1', '198.51.100.2'] },
            { type: 'med', mode: 'increment', start: 50, step: 1 },
            { type: 'asPath', mode: 'random', min: 64512, max: 64512, minLength: 2, maxLength: 2 }
        ]
    });
    assert.strictEqual(sent.length, 3);
    sent.forEach((buffer, index) => {
        const packet = parseBgpPacket(buffer, { asnSize: 4 });
        assert.ok(packet.valid);
        const attr = attrs(packet);
        const reach = attr.get(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI).mpReach;
        assert.strictEqual(
            reach.nextHop,
            index % 2 ? '198.51.100.2' : '198.51.100.1',
            'independent MP Next Hop must reach the eBGP wire'
        );
        assert.strictEqual(reach.nlri[0].labels[0].label, 16000 + index * 5);
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.MED).med, 50 + index);
        assert.deepStrictEqual(
            attr.get(BgpConst.BGP_PATH_ATTR.AS_PATH).segments.flatMap(segment => segment.asNumbers),
            [65000, 64512, 64512]
        );
        assert.strictEqual(
            attr.has(BgpConst.BGP_PATH_ATTR.LOCAL_PREF),
            false,
            'an omitted LOCAL_PREF must stay absent'
        );
    });
    instance.routeStore.close();
}

{
    const { worker, instance, sent } = makeFixture(
        BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP
    );
    worker.generateRoutes('long-path', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.3.0.1',
        mask: 32,
        count: 1,
        attributeRules: [
            { type: 'nextHop', mode: 'fixed', value: '203.0.113.1' },
            { type: 'asPath', mode: 'random', min: 64512, max: 64512, minLength: 255, maxLength: 255 }
        ]
    });
    const attr = attrs(parseBgpPacket(sent[0], { asnSize: 4 }));
    assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.NEXT_HOP).nextHop, '203.0.113.1');
    assert.deepStrictEqual(
        attr.get(BgpConst.BGP_PATH_ATTR.AS_PATH).segments.map(segment => segment.asNumbers.length),
        [255, 1],
        'eBGP local AS prepend must split paths exceeding the 255-AS segment limit'
    );
    assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.AS_PATH).segments[0].asNumbers[0], 65000);
    instance.routeStore.close();
}

{
    const { worker, instance } = makeFixture(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    worker.generateRoutes('legacy', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.4.0.1',
        mask: 32,
        count: 1,
        rt: '65000:1',
        customAttr: 'c0630101'
    });
    const oldRoute = Array.from(instance.routeMap.values())[0];
    const oldInfo = oldRoute.getRouteInfo(instance.getRouteAttr(oldRoute));
    worker.generateRoutes('tree-no-attributes', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.4.1.1',
        mask: 32,
        count: 1,
        rt: '65000:9',
        customAttr: 'c0630109',
        randomAsPathEnabled: true,
        attributeRules: []
    });
    const routes = Array.from(instance.routeMap.values());
    assert.deepStrictEqual(routes[0].getRouteInfo(instance.getRouteAttr(routes[0])), oldInfo);
    assert.strictEqual(instance.getRouteAttr(routes[1]).rt, '');
    assert.strictEqual(instance.getRouteAttr(routes[1]).customAttr, '');
    assert.strictEqual(
        instance.getRouteAttr(routes[1]).asPath,
        '',
        'removed tree attributes must not fall back to hidden legacy fields'
    );
    instance.routeStore.close();
}

const addPathParseContext = {
    asnSize: 4,
    isAddPathReceiveEnabled: (afi, safi) =>
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    getAddPathReceiveInfo: (afi, safi) => ({
        enabled: afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    })
};
const srv6Options = {
    peerOptions: { sendSrv6PrefixSid: true },
    session: {
        localIp: '2001:db8::fe',
        peerIp: '2001:db8::1',
        localCapFlags:
            BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS |
            BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING |
            BgpConst.BGP_CAP_FLAGS.ADD_PATH,
        isAddPathSendEnabled: addPathParseContext.isAddPathReceiveEnabled
    }
};

{
    const { worker, instance, sent } = makeFixture(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    const rules = coreRules();
    worker.generateRoutes('explicit-defaults', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.5.0.1',
        mask: 32,
        count: 1,
        attributeRules: rules
    });
    const attr = attrs(parseBgpPacket(sent[0]));
    assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.ORIGIN).value[0], 0);
    assert.strictEqual(
        attr.get(BgpConst.BGP_PATH_ATTR.NEXT_HOP).nextHop,
        '192.0.2.254',
        'auto next hop must use the session local address'
    );
    assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.MED).med, 0, 'the explicit MED default must be sent');
    assert.strictEqual(
        attr.get(BgpConst.BGP_PATH_ATTR.LOCAL_PREF).localPref,
        100,
        'the explicit Local Pref default must be sent'
    );
    sent.length = 0;
    worker.generateRoutes('disabled-optional-attrs', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.5.1.1',
        mask: 32,
        count: 1,
        attributeRules: rules.filter(rule => rule.type !== 'med').filter(rule => rule.type !== 'localPref')
    });
    const missingAttrs = attrs(parseBgpPacket(sent[0]));
    assert.strictEqual(
        missingAttrs.has(BgpConst.BGP_PATH_ATTR.MED),
        false,
        'removed MED must not send a hidden zero default'
    );
    assert.strictEqual(
        missingAttrs.has(BgpConst.BGP_PATH_ATTR.LOCAL_PREF),
        false,
        'disabled Local Pref must not send a hidden 100 default'
    );
    const routes = Array.from(instance.routeMap.values());
    assert.strictEqual(instance.getRouteAttr(routes[1]).attributePolicy, 'configured');
    const info = routes[1].getRouteInfo(instance.getRouteAttr(routes[1]));
    assert.strictEqual(info.med, null, 'route detail must reflect absent MED');
    assert.strictEqual(info.localPref, null, 'route detail must reflect absent Local Pref');
    assert.strictEqual(instance.getRouteAttr(routes[0]).med, 0, 'new group presence must not change the earlier group');
    instance.routeStore.close();
}

{
    const { worker, instance, sent } = makeFixture(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, undefined, srv6Options);
    const structure = {
        locatorBlockLength: 32,
        locatorNodeLength: 16,
        functionLength: 24,
        argumentLength: 16,
        transpositionLength: 8,
        transpositionOffset: 64
    };
    worker.generateRoutes('tree-add-path-srv6', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.6.0.1',
        mask: 32,
        count: 2,
        addPathEnabled: false,
        addPathCount: 'invalid',
        srv6Enabled: false,
        srv6Sid: 'not-an-ip',
        srv6EndpointBehavior: 65535,
        nlriRules: [
            { type: 'addPath', count: 2 },
            { type: 'mpNextHop', mode: 'auto' }
        ],
        attributeRules: [
            ...coreRules(),
            {
                type: 'srv6',
                enabled: true,
                mode: 'increment',
                start: '2001:db8:6::1',
                step: 2,
                endpointBehavior: 17,
                ...structure
            }
        ]
    });
    const routes = Array.from(instance.routeMap.values());
    assert.deepStrictEqual(
        routes.map(route => [route.ip, route.pathId]),
        [
            ['10.6.0.1', 0],
            ['10.6.0.1', 1],
            ['10.6.0.2', 0],
            ['10.6.0.2', 1]
        ]
    );
    assert.deepStrictEqual(
        routes.map(route => instance.getRouteAttr(route).srv6Sid),
        ['2001:db8:6::1', '2001:db8:6::3', '2001:db8:6::5', '2001:db8:6::7']
    );
    assert.strictEqual(sent.length, 4, 'different SIDs must have different UPDATE attribute groups');
    sent.forEach((buffer, index) => {
        const packet = parseBgpPacket(buffer, addPathParseContext);
        assert.ok(packet.valid);
        const packetAttrs = attrs(packet);
        const sidInfo = packetAttrs.get(BgpConst.BGP_PATH_ATTR.PREFIX_SID).prefixSid.srv6Services[0].sidInfos[0];
        assert.strictEqual(sidInfo.sid, `2001:db8:6::${1 + index * 2}`);
        assert.strictEqual(sidInfo.endpointBehavior, 17);
        assert.deepStrictEqual(
            sidInfo.sidStructure,
            structure,
            'all six configured structure values must reach the wire'
        );
        const reach = packetAttrs.get(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI).mpReach;
        assert.strictEqual(reach.nextHop, '2001:db8::fe');
        assert.strictEqual(reach.nlri[0].pathId, index % 2);
    });
    const storedStructure = routes[0].getRouteInfo(instance.getRouteAttr(routes[0])).srv6SidStructure;
    assert.deepStrictEqual(storedStructure, structure);
    sent.length = 0;
    worker.generateRoutes('disabled-nodes', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.6.1.1',
        mask: 32,
        count: 2,
        addPathEnabled: true,
        addPathCount: 10,
        srv6Enabled: true,
        srv6Sid: '2001:db8:ffff::1',
        srv6EndpointBehavior: 65535,
        nlriRules: [{ type: 'mpNextHop', mode: 'auto' }],
        attributeRules: coreRules()
    });
    const added = Array.from(instance.routeMap.values()).slice(4);
    assert.deepStrictEqual(
        added.map(route => route.pathId),
        [0, 0],
        'missing node must ignore top-level ADD-PATH settings'
    );
    assert.ok(
        added.every(route => !instance.getRouteAttr(route).srv6Sid),
        'missing node must ignore top-level SRv6 settings'
    );
    assert.ok(
        sent
            .map(buffer => parseBgpPacket(buffer, addPathParseContext))
            .every(packet => !attrs(packet).has(BgpConst.BGP_PATH_ATTR.PREFIX_SID)),
        'missing SRv6 must not send Prefix-SID'
    );
    assert.deepStrictEqual(
        instance.getRouteAttr(Array.from(instance.routeMap.values())[0]).srv6SidStructure,
        structure,
        'a new group must preserve earlier SID structures'
    );
    sent.length = 0;
    worker.generateRoutes('list-sids', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.6.2.1',
        mask: 32,
        count: 3,
        attributeRules: [
            { type: 'srv6', mode: 'list', values: ['2001:db8:9::1', '2001:db8:9::2'], endpointBehavior: 20 }
        ]
    });
    const listRoutes = Array.from(instance.routeMap.values()).slice(6);
    assert.deepStrictEqual(
        listRoutes.map(route => instance.getRouteAttr(route).srv6Sid),
        ['2001:db8:9::1', '2001:db8:9::2', '2001:db8:9::1']
    );
    const count = instance.routeMap.size;
    assert.throws(
        () =>
            worker.generateRoutes('overflow-sids', {
                addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
                prefix: '10.6.3.1',
                mask: 32,
                count: 2,
                nlriRules: [
                    { type: 'addPath', count: 2 },
                    { type: 'mpNextHop', mode: 'auto' }
                ],
                attributeRules: [
                    { type: 'srv6', mode: 'increment', start: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', step: 1 }
                ]
            }),
        /递增超出/
    );
    assert.strictEqual(
        instance.routeMap.size,
        count,
        'SID range validation must use the total generated route count before any write'
    );
    assert.throws(
        () => generated([{ type: 'srv6', value: '2001:db8::1', locatorBlockLength: 100, locatorNodeLength: 100 }]),
        /总位数/
    );
    assert.throws(
        () => generated([{ type: 'srv6', value: '2001:db8::1', transpositionLength: 100, transpositionOffset: 100 }]),
        /转置范围/
    );
    assert.throws(
        () => buildAttributeRuleContext({ nlriRules: [{ type: 'addPath', count: 4294967297 }] }),
        /ADD-PATH数量/
    );
    assert.throws(() => generated([null]), /节点必须为对象/);
    instance.routeStore.close();
}

{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-tree-attributes-'));
    const dbPath = path.join(directory, 'routes.sqlite');
    try {
        const before = makeFixture(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, undefined, { ...srv6Options, dbPath });
        before.worker.generateRoutes('persisted-tree', {
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            prefix: '10.7.0.1',
            mask: 32,
            count: 1,
            attributeRules: [
                { type: 'origin', value: 0 },
                {
                    type: 'srv6',
                    value: '2001:db8:7::1',
                    locatorBlockLength: 40,
                    locatorNodeLength: 24,
                    functionLength: 24,
                    argumentLength: 8,
                    transpositionLength: 4,
                    transpositionOffset: 80
                }
            ]
        });
        const infoBefore = Array.from(before.instance.routeMap.values())[0].getRouteInfo(
            before.instance.getRouteAttr(Array.from(before.instance.routeMap.values())[0])
        );
        before.instance.routeStore.close();
        const after = makeFixture(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, undefined, { ...srv6Options, dbPath });
        const route = Array.from(after.instance.routeMap.values())[0];
        const storedAttr = after.instance.getRouteAttr(route);
        assert.deepStrictEqual(
            route.getRouteInfo(storedAttr),
            infoBefore,
            'route values and omission must survive a new SQLite store instance'
        );
        assert.deepStrictEqual(storedAttr.configuredAttributes, ['origin', 'srv6']);
        after.peer.sendRoute();
        const packetAttrs = attrs(parseBgpPacket(after.sent[0], addPathParseContext));
        assert.strictEqual(
            packetAttrs.has(BgpConst.BGP_PATH_ATTR.MED),
            false,
            'SQLite hydration must not restore hidden MED'
        );
        assert.strictEqual(
            packetAttrs.has(BgpConst.BGP_PATH_ATTR.LOCAL_PREF),
            false,
            'SQLite hydration must not restore hidden Local Pref'
        );
        assert.deepStrictEqual(
            packetAttrs.get(BgpConst.BGP_PATH_ATTR.PREFIX_SID).prefixSid.srv6Services[0].sidInfos[0].sidStructure,
            storedAttr.srv6SidStructure
        );
        after.instance.routeStore.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

{
    // A registry edit must affect both rule defaults and legacy encoder fallbacks.
    const savedDefaults = JSON.parse(JSON.stringify(ATTRIBUTE_DEFAULTS));
    let instance;
    try {
        ATTRIBUTE_DEFAULTS.origin.value = 2;
        ATTRIBUTE_DEFAULTS.med.value = 7;
        ATTRIBUTE_DEFAULTS.med.step = 3;
        ATTRIBUTE_DEFAULTS.localPref.value = 175;
        ATTRIBUTE_DEFAULTS.custom.flags = 128;
        ATTRIBUTE_DEFAULTS.communities.base = '65100';
        ATTRIBUTE_DEFAULTS.asPath.minLength = 2;
        ATTRIBUTE_DEFAULTS.srv6.locatorBlockLength = 32;
        ATTRIBUTE_DEFAULTS.label.value = 32;
        assert.strictEqual(generated([{ type: 'med', mode: 'increment', start: 0 }], 2).attr.med, 6);
        assert.deepStrictEqual(
            generated([{ type: 'communities', mode: 'increment', start: 100 }], 2).attr.communities,
            ['65100:102']
        );
        assert.strictEqual(generated([{ type: 'custom', typeCode: 99, value: 'ff' }]).attr.customAttr, '806301ff');
        assert.strictEqual(
            generated([{ type: 'asPath', mode: 'random', min: 64512, max: 64512 }]).attr.asPath,
            '64512 64512',
            'omitted maxLength must retain the selected minLength'
        );
        const fixture = makeFixture(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, undefined, srv6Options);
        instance = fixture.instance;
        fixture.worker.generateRoutes('registry-defaults', {
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            prefix: '10.8.0.1',
            mask: 32,
            count: 1,
            srv6Enabled: true,
            srv6Sid: '2001:db8:8::1',
            srv6EndpointBehavior: 19
        });
        const attr = attrs(parseBgpPacket(fixture.sent[0], addPathParseContext));
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.ORIGIN).value[0], 2);
        assert.strictEqual(
            fixture.peer.getOriginValue('IGP'),
            0,
            'explicit IGP must stay zero even when the fallback differs'
        );
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.MED).med, 7);
        assert.strictEqual(attr.get(BgpConst.BGP_PATH_ATTR.LOCAL_PREF).localPref, 175);
        assert.strictEqual(
            attr.get(BgpConst.BGP_PATH_ATTR.PREFIX_SID).prefixSid.srv6Services[0].sidInfos[0].sidStructure
                .locatorBlockLength,
            32
        );
        assert.strictEqual(
            fixture.peer.buildLabeledUnicastNlri({ ip: '10.8.0.1', mask: 32 }).readUIntBE(1, 3) >>> 4,
            32
        );
        const route = Array.from(instance.routeMap.values())[0];
        assert.strictEqual(route.getRouteInfo().med, 7);
        assert.strictEqual(route.getRouteInfo().localPref, 175);
    } finally {
        instance?.routeStore.close();
        for (const [type, defaults] of Object.entries(savedDefaults)) Object.assign(ATTRIBUTE_DEFAULTS[type], defaults);
    }
}

async function testOversizedTreeAttributes() {
    const families = BgpConst.BGP_ADDR_FAMILY;
    for (const addressFamily of [
        families.IPV4_UNC,
        families.IPV6_UNC,
        families.IPV4_LABEL_UNICAST,
        families.IPV4_QP,
        families.IPV6_QP,
        families.IPV4_MVPN
    ]) {
        for (const encoding of addressFamily === families.IPV4_UNC ? ['auto', 'mpReach'] : ['auto']) {
            const f = makeFixture(addressFamily);
            try {
                const isQp = addressFamily === families.IPV4_QP || addressFamily === families.IPV6_QP;
                const ipv6 = addressFamily === families.IPV6_UNC || addressFamily === families.IPV6_QP;
                const method = isQp
                    ? 'generateQpRoutes'
                    : addressFamily === families.IPV4_MVPN
                      ? 'generateMvpnRoutes'
                      : 'generateRoutes';
                const config = {
                    addressFamily,
                    groupId: 'size-check',
                    prefix: ipv6 ? '2001:db8:40::1' : '10.40.0.1',
                    mask: ipv6 ? 128 : 32,
                    count: 1,
                    nlriEncoding: encoding,
                    routeType: 1,
                    rd: '100:1',
                    originatingRouterIp: '192.0.2.10',
                    attributeRules: [{ type: 'communities', mode: 'random', min: 1, max: 1, valueCount: 2 }],
                    nlriRules: isQp
                        ? [{ type: 'dqpn', mode: 'fixed', value: 1 }]
                        : addressFamily === families.IPV4_LABEL_UNICAST
                          ? [{ type: 'label', value: 16000 }]
                          : []
                };
                const generate = overrides => f.worker[method]('size', { ...config, ...overrides });
                await generate();
                const snapshot = f.instance.routeStore.getRouteGroupRoutes(config.groupId);
                f.sent.length = 0;
                for (const attributeRules of [
                    [{ type: 'communities', mode: 'random', min: 1, max: 1, valueCount: 1100 }],
                    [{ type: 'extendedCommunities', mode: 'random', base: 65000, min: 1, max: 1, valueCount: 600 }],
                    [
                        { type: 'communities', mode: 'random', min: 1, max: 1, valueCount: 600 },
                        { type: 'communities', mode: 'random', min: 2, max: 2, valueCount: 600 }
                    ]
                ]) {
                    await assert.rejects(generate({ attributeRules }), /4096字节上限/);
                    assert.deepStrictEqual(
                        f.instance.routeStore.getRouteGroupRoutes(config.groupId),
                        snapshot,
                        'oversized replacement must leave the previous snapshot intact'
                    );
                    assert.strictEqual(f.sent.length, 0);
                    assert.throws(
                        () =>
                            generate({
                                groupId: undefined,
                                prefix: ipv6 ? '2001:db8:40::2' : '10.40.0.2',
                                originatingRouterIp: '192.0.2.11',
                                attributeRules
                            }),
                        /4096字节上限/
                    );
                    assert.deepStrictEqual(f.instance.routeStore.getRouteGroupRoutes(config.groupId), snapshot);
                    assert.strictEqual(f.instance.routeMap.size, 1);
                    assert.strictEqual(
                        f.sent.length,
                        0,
                        'direct tree API must reject oversized messages before writes or sends'
                    );
                }
                f.peer.peerState = 0;
                await generate({
                    attributeRules: [{ type: 'communities', mode: 'random', min: 1, max: 1, valueCount: 1100 }]
                });
                f.peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
                const routes = Array.from(f.instance.routeMap.values());
                f.peer.sendRouteBatchNow(routes);
                assert.strictEqual(
                    f.sent.length,
                    0,
                    'the common sender cannot transmit an offline-generated oversized UPDATE'
                );
                f.peer.sendRoute();
                assert.strictEqual(
                    f.sent.length,
                    0,
                    'the paged stream also rejects oversized messages without hanging'
                );
            } finally {
                f.instance.routeStore.close();
            }
        }
    }
}

testOversizedTreeAttributes()
    .then(() =>
        console.log(
            'BGP attribute rules, multi-value generation, registry defaults, presence persistence, wire encoding, oversized rollback and bounded sends passed'
        )
    )
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
