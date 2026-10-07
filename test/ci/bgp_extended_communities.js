const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
const {
    normalizeExtendedCommunities,
    encodeExtendedCommunities,
    getExtendedCommunityValueRange
} = require('../../shared/bgpExtendedCommunities');
const {
    buildAttributeRuleContext,
    getGeneratedAttributeValues
} = require('../../electron/utils/bgp/simulator/bgpAttributeRules');
const { canonicalizeAttr } = require('../../electron/worker/bgp/bgpPathAttrStore');
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { extCommunitiesBufferToString } = require('../../electron/utils/bgp/bgpEncoding');
const registry = require('../../shared/bgpAttributes.json');
const type = BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES;
const hex = value => Buffer.from(encodeExtendedCommunities(value)).toString('hex');
const generated = (rule, index = 0, random = () => 0.5, count = 3) => {
    const context = buildAttributeRuleContext(
        { count, attributeRules: [{ type: 'extendedCommunities', ...rule }] },
        random
    );
    return getGeneratedAttributeValues(context, index).attr;
};
const ext = registry.attributes.find(entry => entry.type === 'extendedCommunities');
assert.equal(
    registry.attributes.some(entry => entry.type === 'rt'),
    false,
    'RT has no separate node'
);
assert.equal(ext.valueType, 'extendedCommunity');
assert.equal(ext.defaultNode, true);
assert.equal(ext.default.value, '');
assert.equal(ext.default.subtype, 'rt');
assert.equal(ext.resultColumn.key, 'extendedCommunities');
assert.equal(
    BgpRouteSqliteStore.SCHEMA_VERSION,
    7,
    'extended communities use the existing path attribute JSON storage'
);

assert.deepEqual(normalizeExtendedCommunities(''), []);
assert.deepEqual(
    normalizeExtendedCommunities(['', 'RT:065000:00100 SOO:192.000.002.001:020', 'HEX:FFFE010203040506']),
    ['rt:65000:100', 'soo:192.0.2.1:20', 'hex:fffe010203040506']
);
assert.equal(
    hex('rt:65000:100 soo:65000:200 rt:70000:65535 soo:192.0.2.1:65535 hex:fffe010203040506'),
    '0002fde8000000640003fde8000000c8020200011170ffff0103c0000201fffffffe010203040506'
);
assert.equal(hex('rt:0:4294967295'), '00020000ffffffff');
assert.equal(hex('soo:4294967295:65535'), '0203ffffffffffff');
// Verify the actual wire widths: AS2 communities have a four-byte local
// administrator; AS4 and IPv4 communities have a two-byte local administrator.
for (const [wire, expected] of [
    ['0003fde8000001f4', 'SOO 65000:500'],
    ['0003fde8ffffffff', 'SOO 65000:4294967295'],
    ['02020001117001f4', 'RT 70000:500'],
    ['0202ffffffffffff', 'RT 4294967295:65535'],
    ['0102c000020101f4', 'RT 192.0.2.1:500'],
    ['02030001117001f4', 'SOO 70000:500']
]) {
    assert.equal(extCommunitiesBufferToString(Buffer.from(wire, 'hex')), expected);
}
assert.deepEqual(normalizeExtendedCommunities('rt:1:2 rt:1:2 hex:0002000100000002'), [
    'rt:1:2',
    'rt:1:2',
    'hex:0002000100000002'
]);
assert.deepEqual(getExtendedCommunityValueRange('65535'), [0, 0xffffffff]);
assert.deepEqual(getExtendedCommunityValueRange('65536'), [0, 65535]);
assert.deepEqual(getExtendedCommunityValueRange('192.0.2.1'), [0, 65535]);
for (const invalid of [
    '65000:100',
    'rt:65000',
    'other:65000:100',
    'hex:00',
    'hex:000000000000000000',
    'hex:gg00000000000000',
    'rt:-1:1',
    'rt:4294967296:1',
    'rt:65536:65536',
    'soo:192.0.2.256:1',
    'soo:192.0.2.1:65536',
    'rt:65000:4294967296',
    'rt:1:1.1'
])
    assert.throws(() => normalizeExtendedCommunities(invalid), /Extended Community/);
assert.throws(() => normalizeExtendedCommunities([42]), /字符串/);
assert.throws(
    () => buildAttributeRuleContext({ attributeRules: [{ type: 'rt', value: '65000:1' }] }),
    /不支持的属性类型/
);
assert.deepEqual(generated({ ...ext.default }).extendedCommunities, []);
assert.equal(generated({ ...ext.default }).rt, undefined, 'an empty generic node must not silently configure RT');
assert.deepEqual(
    generated({ mode: 'list', values: ['rt:65000:1 soo:70000:2', 'hex:0102030405060708'] }, 3).extendedCommunities,
    ['hex:0102030405060708']
);
assert.deepEqual(
    generated({ mode: 'increment', subtype: 'soo', base: '192.0.2.1', start: 10, step: 2 }, 2).extendedCommunities,
    ['soo:192.0.2.1:14']
);
assert.deepEqual(
    generated({ mode: 'increment', subtype: 'soo', base: '192.0.2.1', start: 10, step: 2, valueCount: 3 }, 2)
        .extendedCommunities,
    ['soo:192.0.2.1:22', 'soo:192.0.2.1:24', 'soo:192.0.2.1:26']
);
for (const [base, start, expected] of [
    [65000, 4294967290, ['rt:65000:4294967293', 'rt:65000:4294967294', 'rt:65000:4294967295']],
    [70000, 65530, ['rt:70000:65533', 'rt:70000:65534', 'rt:70000:65535']],
    ['192.0.2.1', 65530, ['rt:192.0.2.1:65533', 'rt:192.0.2.1:65534', 'rt:192.0.2.1:65535']]
]) {
    assert.deepEqual(
        generated({ mode: 'increment', base, start, step: 1, valueCount: 3 }, 1, () => 0.5, 2).extendedCommunities,
        expected
    );
    assert.throws(() => generated({ mode: 'increment', base, start, step: 1, valueCount: 3 }), /最后一个属性值/);
}
const samples = [0.9, 0.1, 0.1];
assert.deepEqual(
    generated({ mode: 'random', subtype: 'soo', base: 70000, min: 0, max: 9, valueCount: 3 }, 0, () => samples.shift())
        .extendedCommunities,
    ['soo:70000:9', 'soo:70000:1', 'soo:70000:1']
);
assert.equal(samples.length, 0);
assert.deepEqual(generated({ mode: 'fixed', value: 'rt:1:2 rt:1:2', valueCount: null }).extendedCommunities, [
    'rt:1:2',
    'rt:1:2'
]);
assert.deepEqual(generated({ mode: 'list', values: ['soo:1:2 soo:1:2'], valueCount: 0 }).extendedCommunities, [
    'soo:1:2',
    'soo:1:2'
]);
assert.deepEqual(generated({ mode: 'increment', base: 65000, start: 10, step: -2 }, 2).extendedCommunities, [
    'rt:65000:6'
]);
assert.deepEqual(
    generated({ mode: 'random', subtype: 'soo', base: 65000, min: 0, max: 0xffffffff }, 0, () => 1).extendedCommunities,
    ['soo:65000:4294967295']
);
assert.deepEqual(
    generated({ mode: 'random', subtype: 'rt', base: 70000, min: 0, max: 65535 }, 0, () => 0).extendedCommunities,
    ['rt:70000:0']
);
assert.throws(() => generated({ mode: 'increment', base: 70000, start: 65534, step: 1 }), /最后一个属性值/);
assert.throws(
    () => generated({ mode: 'random', subtype: 'other', base: 65000, min: 0, max: 1 }),
    /Extended Community格式/
);
assert.throws(
    () => generated({ mode: 'random', subtype: 'rt', base: '192.0.2.1', min: 0, max: 65536 }),
    /extendedCommunities/
);
assert.deepEqual(canonicalizeAttr({ extendedCommunities: ['RT:065000:00100'] }).extendedCommunities, ['rt:65000:100']);
assert.equal(
    Object.prototype.hasOwnProperty.call(canonicalizeAttr({ rt: '65000:100' }), 'extendedCommunities'),
    false,
    'legacy attribute hashes must not acquire an unrelated default field'
);

function fixture(dbPath) {
    const worker = new BgpWorker();
    const instance = new BgpInstance(0, 1, 1, new BgpRouteSqliteStore(dbPath));
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    worker.routeStore = instance.routeStore;
    const sent = [];
    worker.messageHandler.sendSuccessResponse = () => {};
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
        buildBgpMessageHeader(length, packetType) {
            const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
            header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
            header[BgpConst.BGP_MARKER_LEN + 2] = packetType;
            return header;
        },
        processCustomPkt: value => Buffer.from(value, 'hex'),
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
        generate(config) {
            return worker.generateRoutes('ext', {
                addressFamily: 1,
                prefix: '10.50.0.1',
                mask: 32,
                count: 1,
                attributeRules: [],
                nlriRules: [],
                ...config
            });
        },
        packets() {
            return sent.map(buffer => {
                const packet = parseBgpPacket(buffer, { asnSize: 4 });
                assert.ok(packet.valid, packet.error);
                return packet;
            });
        }
    };
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-extended-community-'));
    let f;
    try {
        const dbPath = path.join(directory, 'routes.sqlite');
        f = fixture(dbPath);
        const rules = [
            {
                type: 'extendedCommunities',
                mode: 'list',
                values: [
                    'rt:65000:100 soo:65000:200 hex:fffe010203040506',
                    'soo:192.0.2.1:20 rt:70000:10 hex:800a010203040506'
                ]
            },
            { type: 'med', value: 77 },
            { type: 'extendedCommunities', value: 'hex:0002fde800000064 rt:65000:100' }
        ];
        await f.generate({ groupId: 'extended-group', count: 2, attributeRules: rules });
        const before = Array.from(f.instance.routeMap.values()).map(route =>
            route.getRouteInfo(f.instance.getRouteAttr(route))
        );
        for (const [index, packet] of f.packets().entries()) {
            assert.deepEqual(
                packet.pathAttributes.map(attribute => attribute.typeCode),
                [16, 4, 16]
            );
            const attrs = packet.pathAttributes.filter(attribute => attribute.typeCode === type);
            assert.equal(attrs.length, 2, 'each generic attribute instance must remain independent');
            assert.equal(attrs[0].value.toString('hex'), hex(rules[0].values[index]));
            assert.equal(attrs[1].value.toString('hex'), '0002fde8000000640002fde800000064');
            assert.equal(
                attrs[0].flags,
                0xc0,
                'short values use optional/transitive flags without forced extended length'
            );
            assert.equal(before[index].rt, '', 'generic RT entries must not set the legacy RT scalar');
            assert.deepEqual(
                before[index].pathAttributes[0].value,
                normalizeExtendedCommunities(rules[0].values[index])
            );
            assert.deepEqual(before[index].extendedCommunities, ['hex:0002fde800000064', 'rt:65000:100']);
        }
        const savedIds = Array.from(f.instance.routeMap.values()).map(route => route.attrId);
        f.instance.routeStore.close();
        f = fixture(dbPath);
        assert.deepEqual(
            Array.from(f.instance.routeMap.values()).map(route => route.getRouteInfo(f.instance.getRouteAttr(route))),
            before
        );
        assert.deepEqual(
            Array.from(f.instance.routeMap.values()).map(route => route.attrId),
            savedIds
        );
        f.peer.sendRoute();
        assert.deepEqual(
            f
                .packets()
                .map(packet =>
                    packet.pathAttributes.filter(attr => attr.typeCode === type).map(attr => attr.value.toString('hex'))
                ),
            rules[0].values.map(value => [hex(value), '0002fde8000000640002fde800000064'])
        );
        f.sent.length = 0;
        await assert.rejects(
            async () =>
                f.generate({
                    groupId: 'extended-group',
                    attributeRules: [{ type: 'extendedCommunities', value: 'hex:0002' }]
                }),
            /8字节/
        );
        assert.deepEqual(
            Array.from(f.instance.routeMap.values()).map(route => route.getRouteInfo(f.instance.getRouteAttr(route))),
            before
        );
        assert.equal(f.sent.length, 0, 'invalid extended community must preserve the old group and send no packet');

        const multiRules = [
            { type: 'communities', mode: 'increment', base: 65000, start: 100, step: 2, valueCount: 3 },
            {
                type: 'extendedCommunities',
                mode: 'increment',
                subtype: 'soo',
                base: '192.0.2.1',
                start: 10,
                step: 1,
                valueCount: 3
            },
            { type: 'communities', mode: 'random', base: 65000, min: 7, max: 7, valueCount: 2 },
            { type: 'extendedCommunities', mode: 'random', subtype: 'rt', base: 70000, min: 9, max: 9, valueCount: 2 }
        ];
        await f.generate({ groupId: 'multi-values', prefix: '10.53.0.1', count: 2, attributeRules: multiRules });
        const multiBefore = f.instance.routeStore.getRouteGroupRoutes('multi-values');
        const multiWire = f
            .packets()
            .map(packet => packet.pathAttributes.map(attr => [attr.typeCode, attr.value.toString('hex')]));
        assert.equal(multiWire.length, 2);
        for (const [index, packet] of f.packets().entries()) {
            assert.deepEqual(
                packet.pathAttributes.map(attr => attr.typeCode),
                [8, 16, 8, 16]
            );
            assert.deepEqual(
                packet.pathAttributes[0].communities.map(value => value.formatted),
                Array.from({ length: 3 }, (_, offset) => `65000:${100 + (index * 3 + offset) * 2}`)
            );
            assert.equal(
                packet.pathAttributes[1].value.toString('hex'),
                hex(Array.from({ length: 3 }, (_, offset) => `soo:192.0.2.1:${10 + index * 3 + offset}`))
            );
            assert.equal(packet.pathAttributes[2].value.toString('hex'), 'fde80007fde80007');
            assert.equal(packet.pathAttributes[3].value.toString('hex'), '02020001117000090202000111700009');
        }
        f.instance.routeStore.close();
        f = fixture(dbPath);
        assert.deepEqual(
            f.instance.routeStore.getRouteGroupRoutes('multi-values'),
            multiBefore,
            'generated arrays, their order and duplicate instances must survive SQLite reopen'
        );
        f.peer.sendRoute();
        assert.deepEqual(
            f
                .packets()
                .filter(packet => packet.nlri[0]?.prefix.startsWith('10.53.'))
                .map(packet => packet.pathAttributes.map(attr => [attr.typeCode, attr.value.toString('hex')])),
            multiWire
        );
        f.sent.length = 0;

        f.generate({ prefix: '10.51.0.1', attributeRules: [{ type: 'extendedCommunities', value: '' }] });
        assert.equal(f.packets()[0].pathAttributes.length, 1);
        assert.equal(f.packets()[0].pathAttributes[0].typeCode, type);
        assert.equal(
            f.packets()[0].pathAttributes[0].value.length,
            0,
            'empty explicit node is encoded once without injecting an RT'
        );
        f.sent.length = 0;
        const longValue = Array(40).fill('hex:0102030405060708');
        f.generate({ prefix: '10.52.0.1', attributeRules: [{ type: 'extendedCommunities', value: longValue }] });
        assert.equal(f.packets()[0].pathAttributes[0].value.length, 320);
        assert.equal(
            f.packets()[0].pathAttributes[0].flags,
            0xd0,
            'extended length is chosen from the actual value length'
        );
        assert.equal(f.packets()[0].pathAttributes[0].value.toString('hex'), '0102030405060708'.repeat(40));
        const oldDescriptor = f.peer.buildConfiguredPathAttribute({ type: 'rt', value: '65000:100' });
        assert.equal(
            Buffer.from(oldDescriptor).toString('hex'),
            'd01000080002fde800000064',
            'previously generated RT snapshots remain replayable'
        );
        f.instance.routeStore.close();
        const legacy = fixture();
        try {
            legacy.generate({ attributeRules: undefined, nlriRules: undefined, rt: '65000:100 192.0.2.1:20' });
            const attr = legacy.packets()[0].pathAttributes.find(attribute => attribute.typeCode === type);
            assert.equal(attr.value.toString('hex'), '0002fde8000000640102c00002010014');
        } finally {
            legacy.instance.routeStore.close();
        }
        console.log(
            'Generic Extended Community parsing, generation, ordered duplicate wire encoding, unknown raw octets, SQLite replay, rollback, and legacy RT compatibility tests passed'
        );
    } finally {
        f?.instance.routeStore.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
