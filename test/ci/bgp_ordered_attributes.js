const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForUnitTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { buildAttributeRuleContext, getGeneratedAttributeValues } = require('../../electron/utils/bgpAttributeRules');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');

const type = BgpConst.BGP_PATH_ATTR;
const family = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
const ordered = [
    { type: 'med', value: 11 },
    { type: 'origin', value: 2 },
    { type: 'asPath', value: '64512 64513' },
    { type: 'med', value: 22 },
    { type: 'nextHop', mode: 'fixed', value: '203.0.113.10' },
    { type: 'origin', value: 1 },
    { type: 'asPath', value: '' },
    { type: 'localPref', value: 1001 },
    { type: 'nextHop', mode: 'fixed', value: '198.51.100.11' },
    { type: 'communities', value: '65000:1' },
    { type: 'communities', value: '65000:2' },
    { type: 'extendedCommunities', value: 'rt:65000:11' },
    { type: 'extendedCommunities', value: 'rt:65000:22' },
    { type: 'custom', typeCode: 99, flags: 192, value: 'aa' },
    { type: 'custom', value: 'c06301bb' },
    { type: 'srv6', value: '2001:db8:10::1' },
    { type: 'srv6', value: '2001:db8:10::2' }
];
const expectedTypes = [4, 1, 2, 4, 3, 1, 2, 5, 3, 8, 8, 16, 16, 99, 99, 40, 40, 14];

function fixture(dbPath) {
    const worker = new BgpWorker();
    const instance = new BgpInstance(0, 1, 1, dbPath ? new BgpRouteSqliteStore(dbPath) : null);
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    const sent = [];
    const responses = [];
    worker.messageHandler.sendSuccessResponse = (id, data) => responses.push({ id, data });
    worker.messageHandler.sendErrorResponse = (_id, error) => {
        throw new Error(error);
    };
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS | BgpConst.BGP_CAP_FLAGS.ADD_PATH,
        isAddPathSendEnabled: () => true,
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
        instance,
        peer,
        sent,
        responses,
        generate(id, config = {}) {
            worker.generateRoutes(id, {
                addressFamily: family,
                prefix: '10.90.0.1',
                mask: 32,
                count: 1,
                nlriEncoding: 'mpReach',
                attributeRules: ordered,
                nlriRules: [{ type: 'mpNextHop', mode: 'fixed', value: '192.0.2.200' }],
                ...config
            });
        },
        packets() {
            return sent.map(buffer => {
                const packet = parseBgpPacket(buffer, { asnSize: 4, getAddPathReceiveInfo: () => ({ enabled: true }) });
                assert.ok(packet.valid, packet.error);
                return packet;
            });
        }
    };
}

const all = (packet, code) => packet.pathAttributes.filter(attribute => attribute.typeCode === code);
const reach = packet => all(packet, type.MP_REACH_NLRI)[0].mpReach;
function assertOrdered(packet) {
    assert.deepStrictEqual(
        packet.pathAttributes.map(attribute => attribute.typeCode),
        expectedTypes
    );
    assert.deepStrictEqual(
        all(packet, type.ORIGIN).map(attribute => attribute.value[0]),
        [2, 1]
    );
    assert.deepStrictEqual(
        all(packet, type.MED).map(attribute => attribute.med),
        [11, 22]
    );
    assert.deepStrictEqual(
        all(packet, type.NEXT_HOP).map(attribute => attribute.nextHop),
        ['203.0.113.10', '198.51.100.11']
    );
    assert.deepStrictEqual(
        all(packet, type.AS_PATH).map(attribute => attribute.segments.flatMap(segment => segment.asNumbers)),
        [[64512, 64513], []]
    );
    assert.strictEqual(all(packet, type.LOCAL_PREF)[0].localPref, 1001, 'explicit eBGP Local Pref must be sent');
    assert.deepStrictEqual(
        all(packet, 99).map(attribute => attribute.value.toString('hex')),
        ['aa', 'bb']
    );
    assert.deepStrictEqual(
        all(packet, type.PREFIX_SID).map(attribute => attribute.prefixSid.srv6Services[0].sidInfos[0].sid),
        ['2001:db8:10::1', '2001:db8:10::2']
    );
    assert.deepStrictEqual(packet.nlri, []);
}

{
    const f = fixture();
    f.generate('multiple-instances', {
        count: 3,
        nlriRules: [{ type: 'mpNextHop', mode: 'list', values: ['192.0.2.200', '2001:db8::201', '192.0.2.200'] }]
    });
    assert.strictEqual(f.instance.routeMap.size, 3);
    const routes = Array.from(f.instance.routeMap.values());
    assert.strictEqual(
        new Set(routes.map(route => route.attrId)).size,
        1,
        'MP next hop must not enter the path-attribute hash'
    );
    assert.deepStrictEqual(
        routes.map(route => route.mpNextHop),
        ['192.0.2.200', '2001:db8::201', '192.0.2.200']
    );
    assert.strictEqual(f.packets().length, 2, 'distinct MP next hops require separate UPDATE groups');
    f.packets().forEach(assertOrdered);
    assert.deepStrictEqual(
        f.packets().map(packet => [reach(packet).nextHop, reach(packet).nlri.length]),
        [
            ['192.0.2.200', 2],
            ['2001:db8::201', 1]
        ]
    );
    assert.deepStrictEqual(
        routes[0].getRouteInfo(f.instance.getRouteAttr(routes[0])).pathAttributes,
        f.instance.getRouteAttr(routes[0]).pathAttributes
    );
    assert.strictEqual(f.instance.getRouteAttr(routes[0]).configuredAttributes.includes('mpNextHop'), false);
    f.sent.length = 0;
    f.generate('automatic-mp-nh', {
        prefix: '10.91.0.1',
        attributeRules: [{ type: 'nextHop', mode: 'fixed', value: '203.0.113.77' }],
        nlriRules: [{ type: 'mpNextHop', mode: 'auto', enabled: false }]
    });
    const automatic = f.packets()[0];
    assert.deepStrictEqual(
        automatic.pathAttributes.map(attribute => attribute.typeCode),
        [3, 14],
        'missing Origin, AS Path, MED and Local Pref must not be inserted'
    );
    assert.strictEqual(
        reach(automatic).nextHop,
        '192.0.2.254',
        'an existing auto MP next hop must use session address and ignore old enabled flags'
    );
    assert.strictEqual(all(automatic, type.NEXT_HOP)[0].nextHop, '203.0.113.77');
    f.sent.length = 0;
    f.generate('empty-path-attributes', {
        prefix: '10.92.0.1',
        attributeRules: [],
        nlriRules: [{ type: 'mpNextHop', mode: 'auto' }]
    });
    assert.deepStrictEqual(
        f.packets()[0].pathAttributes.map(attribute => attribute.typeCode),
        [14]
    );
    f.sent.length = 0;
    f.generate('five-prefixes-two-paths', {
        prefix: '10.93.0.1',
        count: 5,
        attributeRules: [{ type: 'med', mode: 'increment', start: 10, step: 1 }],
        nlriRules: [
            { type: 'addPath', count: 2 },
            { type: 'mpNextHop', mode: 'auto' }
        ]
    });
    const added = Array.from(f.instance.routeMap.values()).slice(-10);
    assert.deepStrictEqual(
        added.map(route => [route.ip, route.pathId]),
        Array.from({ length: 5 }, (_, index) => [
            [`10.93.0.${index + 1}`, 0],
            [`10.93.0.${index + 1}`, 1]
        ]).flat()
    );
    assert.deepStrictEqual(
        added.map(route => f.instance.getRouteAttr(route).pathAttributes[0].value),
        Array.from({ length: 10 }, (_, index) => 10 + index)
    );
    f.generate('last-two-prefixes', {
        prefix: '255.255.255.254',
        count: 2,
        attributeRules: [],
        nlriRules: [{ type: 'addPath', count: 2 }]
    });
    assert.throws(
        () =>
            f.generate('overflow-prefix', {
                prefix: '255.255.255.254',
                count: 3,
                attributeRules: [],
                nlriRules: [{ type: 'addPath', count: 2 }]
            }),
        /前缀递增超出/
    );
    f.generate('explicit-routes-already-total', {
        routes: [
            { ip: '10.95.0.1', mask: 32, pathId: 7 },
            { ip: '10.95.0.2', mask: 32, pathId: 8 }
        ],
        attributeRules: [],
        nlriRules: [{ type: 'addPath', count: 2 }]
    });
    assert.strictEqual(f.responses.at(-1).data.added, 2);
    assert.deepStrictEqual(
        Array.from(f.instance.routeMap.values())
            .slice(-2)
            .map(route => route.pathId),
        [0, 1],
        'explicit route lists are actual rows and use the configured Path ID cycle without multiplying'
    );
    f.generate('explicit-id-without-generator', {
        routes: [
            { ip: '10.96.0.1', mask: 32, pathId: 7 },
            { ip: '10.96.0.2', mask: 32, pathId: 8 }
        ],
        attributeRules: [],
        nlriRules: []
    });
    assert.deepStrictEqual(
        Array.from(f.instance.routeMap.values())
            .slice(-2)
            .map(route => route.pathId),
        [7, 8]
    );
    const regenerate = (id, med) =>
        f.generate(id, {
            prefix: '10.97.0.1',
            attributeRules: [{ type: 'med', value: med }],
            nlriRules: [{ type: 'addPath', count: 2 }]
        });
    regenerate('paths-first', 10);
    regenerate('paths-again', 20);
    assert.strictEqual(f.responses.at(-1).data.updated, 2, 'both paths keep their key on a repeated generation');
    const samePrefix = Array.from(f.instance.routeMap.values()).filter(route => route.ip === '10.97.0.1');
    assert.strictEqual(samePrefix.length, 2);
    assert.deepStrictEqual(
        samePrefix.map(route => [route.pathId, f.instance.getRouteAttr(route).med]),
        [
            [0, 20],
            [1, 20]
        ]
    );
    f.instance.routeStore.close();
}

{
    const f = fixture();
    try {
        f.generate('values-per-path', {
            count: 2,
            attributeRules: [
                { type: 'communities', mode: 'increment', start: 1, step: 1, valueCount: 3 },
                { type: 'communities', mode: 'random', min: 7, max: 7, valueCount: 2 },
                { type: 'extendedCommunities', mode: 'increment', base: 65000, start: 100, step: 2, valueCount: 2 },
                {
                    type: 'extendedCommunities',
                    mode: 'random',
                    subtype: 'soo',
                    base: '192.0.2.1',
                    min: 1,
                    max: 1,
                    valueCount: 3
                }
            ],
            nlriRules: [{ type: 'addPath', count: 2 }]
        });
        assert.strictEqual(f.instance.routeMap.size, 4);
        assert.strictEqual(f.packets().length, 4, 'each path uses its own continuous value sequence');
        f.packets().forEach((packet, index) => {
            assert.deepStrictEqual(
                packet.pathAttributes.map(attr => attr.typeCode),
                [8, 8, 16, 16, 14]
            );
            const communities = all(packet, type.COMMUNITY);
            assert.deepStrictEqual(
                communities[0].communities.map(value => value.formatted),
                Array.from({ length: 3 }, (_, offset) => `65000:${1 + index * 3 + offset}`)
            );
            assert.deepStrictEqual(
                communities[1].communities.map(value => value.formatted),
                ['65000:7', '65000:7']
            );
            const extended = all(packet, type.EXTENDED_COMMUNITIES);
            assert.strictEqual(
                extended[0].value.toString('hex'),
                [100 + index * 4, 102 + index * 4]
                    .map(value => `0002fde8${value.toString(16).padStart(8, '0')}`)
                    .join('')
            );
            assert.strictEqual(extended[1].value.toString('hex'), '0103c00002010001'.repeat(3));
            assert.deepStrictEqual(
                reach(packet).nlri.map(route => [route.prefix, route.pathId]),
                [[`10.90.0.${1 + Math.floor(index / 2)}`, index % 2]]
            );
        });
    } finally {
        f.instance.routeStore.close();
    }
}

for (const [count, index, expected] of [
    [1, 2, 0],
    [2, 3, 1],
    [3, 2, 2],
    [0x100000000, 0xffffffff, 0xffffffff]
]) {
    const context = buildAttributeRuleContext({ nlriRules: [{ type: 'addPath', count }], count: 1 });
    assert.strictEqual(getGeneratedAttributeValues(context, index).pathId, expected);
}
for (const count of [0, -1, 0x100000001, 2.5]) {
    assert.throws(
        () => buildAttributeRuleContext({ nlriRules: [{ type: 'addPath', count }], count: 1 }),
        /ADD-PATH数量/
    );
}
assert.throws(
    () =>
        buildAttributeRuleContext({
            count: 2,
            nlriRules: [{ type: 'addPath', count: 2 }],
            attributeRules: [{ type: 'med', mode: 'increment', start: 0xfffffffd, step: 1 }]
        }),
    /最后一个属性值/,
    'attribute sequence bounds are checked against the total generated paths'
);

for (const [rule, index, expected] of [
    [{ mode: 'increment', start: '2001:db8::fffe', step: 2 }, 2, '2001:db8::1:2'],
    [{ mode: 'random', min: '2001:db8::1', max: '2001:db8::9' }, 0, '2001:db8::5'],
    [{ mode: 'increment', start: '192.0.2.254', step: 1 }, 2, '192.0.3.0']
]) {
    const context = buildAttributeRuleContext({ nlriRules: [{ type: 'mpNextHop', ...rule }], count: 3 }, () => 0.5);
    assert.strictEqual(getGeneratedAttributeValues(context, index).mpNextHop, expected);
}
assert.throws(
    () =>
        buildAttributeRuleContext({
            nlriRules: [{ type: 'mpNextHop', mode: 'random', min: '192.0.2.1', max: '2001:db8::1' }]
        }),
    /同一地址族/
);
assert.throws(
    () =>
        buildAttributeRuleContext({
            nlriRules: [
                { type: 'mpNextHop', mode: 'fixed', value: '192.0.2.1' },
                { type: 'mpNextHop', mode: 'fixed', value: '192.0.2.2' }
            ]
        }),
    /不能重复/
);

{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-ordered-attrs-'));
    const dbPath = path.join(directory, 'routes.sqlite');
    let active;
    try {
        active = fixture(dbPath);
        active.generate('saved-instances');
        const before = Array.from(active.instance.routeMap.values())[0];
        const attrId = before.attrId;
        const descriptor = active.instance.getRouteAttr(before).pathAttributes;
        active.instance.routeStore.close();
        active = fixture(dbPath);
        const saved = Array.from(active.instance.routeMap.values())[0];
        assert.strictEqual(saved.mpNextHop, '192.0.2.200');
        assert.strictEqual(saved.attrId, attrId);
        assert.deepStrictEqual(active.instance.getRouteAttr(saved).pathAttributes, descriptor);
        active.peer.sendRoute();
        assertOrdered(active.packets()[0]);
        active.sent.length = 0;
        active.generate('change-only-mp-nh', {
            nlriRules: [{ type: 'mpNextHop', mode: 'fixed', value: '2001:db8::200' }]
        });
        assert.strictEqual(
            active.responses[0].data.updated,
            1,
            'an MP next-hop-only change must be persisted and announced'
        );
        assert.strictEqual(Array.from(active.instance.routeMap.values())[0].attrId, attrId);
        assert.strictEqual(reach(active.packets()[0]).nextHop, '2001:db8::200');
        active.instance.routeStore.close();
    } finally {
        active?.instance.routeStore.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
console.log(
    'Ordered repeated attributes, explicit eBGP encoding, independent MP Next Hop, ADD-PATH totals, and SQLite reopen tests passed'
);
