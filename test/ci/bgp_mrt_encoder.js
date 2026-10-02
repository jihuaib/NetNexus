const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { createMrtEncoder } = require('../../electron/utils/bgpMrtEncoder');

// Decode the MRT layout directly, without the product's BGP/MRT parsers.
function common(buffer) {
    assert.equal(buffer.readUInt16BE(4), 13);
    assert.equal(buffer.readUInt32BE(8), buffer.length - 12);
    return { timestamp: buffer.readUInt32BE(0), subtype: buffer.readUInt16BE(6), body: buffer.subarray(12) };
}

function decodePeerIndex(buffer) {
    const record = common(buffer);
    assert.equal(record.subtype, 1);
    const body = record.body;
    const collector = body.subarray(0, 4).toString('hex');
    const nameLength = body.readUInt16BE(4);
    const viewName = body.subarray(6, 6 + nameLength).toString('utf8');
    let offset = 6 + nameLength;
    const count = body.readUInt16BE(offset);
    offset += 2;
    const peers = [];
    for (let index = 0; index < count; index++) {
        const type = body[offset++];
        const id = body.subarray(offset, offset + 4).toString('hex');
        offset += 4;
        const ipSize = type & 1 ? 16 : 4;
        const ip = body.subarray(offset, offset + ipSize).toString('hex');
        offset += ipSize;
        const asSize = type & 2 ? 4 : 2;
        const asn = asSize === 4 ? body.readUInt32BE(offset) : body.readUInt16BE(offset);
        offset += asSize;
        peers.push({ type, id, ip, asn });
    }
    assert.equal(offset, body.length);
    return { timestamp: record.timestamp, collector, viewName, peers };
}

function decodeAttributes(buffer) {
    const attrs = [];
    for (let offset = 0; offset < buffer.length; ) {
        const flags = buffer[offset++];
        const type = buffer[offset++];
        const extended = Boolean(flags & 0x10);
        const length = extended ? buffer.readUInt16BE(offset) : buffer[offset];
        offset += extended ? 2 : 1;
        const value = buffer.subarray(offset, offset + length);
        assert.equal(value.length, length);
        offset += length;
        assert.ok(offset <= buffer.length);
        attrs.push({ type, flags, value });
    }
    return attrs;
}

function decodeRib(buffer) {
    const record = common(buffer);
    const body = record.body;
    let offset = 0;
    const sequence = body.readUInt32BE(offset);
    offset += 4;
    let afi, safi, pathId;
    const generic = record.subtype === 6 || record.subtype === 12;
    const addPath = [8, 10, 12].includes(record.subtype);
    if (generic) {
        afi = body.readUInt16BE(offset);
        offset += 2;
        safi = body[offset++];
        if (addPath) {
            pathId = body.readUInt32BE(offset);
            offset += 4;
        }
    } else {
        assert.ok([2, 4, 8, 10].includes(record.subtype));
        afi = record.subtype === 2 || record.subtype === 8 ? 1 : 2;
        safi = 1;
    }
    const lengthBits = body[offset++];
    const nlri = body.subarray(offset, offset + Math.ceil(lengthBits / 8));
    offset += nlri.length;
    assert.equal(body.readUInt16BE(offset), 1, 'each record contains exactly one saved route');
    offset += 2;
    const peerIndex = body.readUInt16BE(offset);
    offset += 2;
    const originatedTime = body.readUInt32BE(offset);
    offset += 4;
    if (addPath && !generic) {
        pathId = body.readUInt32BE(offset);
        offset += 4;
    }
    const attributeLength = body.readUInt16BE(offset);
    offset += 2;
    assert.equal(offset + attributeLength, body.length, 'no Path ID is permitted in a generic RIB entry');
    return {
        timestamp: record.timestamp,
        subtype: record.subtype,
        sequence,
        afi,
        safi,
        pathId,
        lengthBits,
        nlri,
        peerIndex,
        originatedTime,
        attrs: decodeAttributes(body.subarray(offset))
    };
}

function asPath(value) {
    const segments = [];
    for (let offset = 0; offset < value.length; ) {
        const type = value[offset++];
        const count = value[offset++];
        const asns = [];
        for (let index = 0; index < count; index++) {
            asns.push(value.readUInt32BE(offset));
            offset += 4;
        }
        assert.ok(offset <= value.length);
        segments.push({ type, asns });
    }
    return segments;
}

const options = {
    addressFamily: 1,
    routerId: '192.0.2.254',
    localAs: 70001,
    localIp: '198.51.100.1',
    timestamp: 1700000000,
    viewName: 'NetNexus 测试'
};
const configured = pathAttributes => ({
    attributePolicy: 'configured',
    configuredAttributes: pathAttributes.map(attr => attr.type),
    pathAttributes
});
const route = overrides => ({
    ip: '10.20.30.45',
    mask: 24,
    pathId: 0,
    mpNextHop: null,
    nlriEncoding: 'auto',
    createdAtMs: 1699999999123,
    routeAttr: configured([]),
    ...overrides
});
const ofType = (rib, type) => rib.attrs.filter(attr => attr.type === type);
const encoder = createMrtEncoder(options);
assert.deepEqual(decodePeerIndex(encoder.peerIndexTable()), {
    timestamp: options.timestamp,
    collector: 'c00002fe',
    viewName: options.viewName,
    peers: [{ type: 2, id: 'c00002fe', ip: 'c6336401', asn: 70001 }]
});
const ipv6Peer = createMrtEncoder({ ...options, localIp: '2001:db8::fe' });
assert.deepEqual(decodePeerIndex(ipv6Peer.peerIndexTable()).peers, [
    { type: 3, id: 'c00002fe', ip: '20010db80000000000000000000000fe', asn: 70001 }
]);

const ordered = [
    { type: 'nextHop', value: '203.0.113.10' },
    { type: 'asPath', value: '70000 65001' },
    { type: 'med', value: 10 },
    { type: 'communities', value: ['65000:1', '65000:1', '65000:65535'] },
    { type: 'extendedCommunities', value: ['rt:65000:100', 'soo:70000:20', 'hex:0102030405060708'] },
    { type: 'custom', value: 'c06302cafe' },
    { type: 'origin', value: 2 },
    { type: 'med', value: 90 },
    { type: 'communities', value: ['65000:7'] },
    {
        type: 'srv6',
        value: '2001:db8::a',
        srv6EndpointBehavior: 19,
        srv6SidStructure: {
            locatorBlockLength: 48,
            locatorNodeLength: 16,
            functionLength: 16,
            argumentLength: 0,
            transpositionLength: 0,
            transpositionOffset: 0
        }
    }
];
const saved = route({ routeAttr: configured(ordered) });
const original = JSON.stringify(saved);
const rib = decodeRib(encoder.encodeRoute(saved, { sequence: 7 }));
assert.deepEqual(
    [rib.subtype, rib.sequence, rib.afi, rib.safi, rib.pathId, rib.lengthBits, rib.peerIndex, rib.originatedTime],
    [8, 7, 1, 1, 0, 24, 0, 1699999999]
);
assert.equal(rib.nlri.toString('hex'), '0a141e', 'the NLRI includes only prefix octets, without the Path ID');
assert.deepEqual(
    rib.attrs.map(attr => attr.type),
    [3, 2, 4, 8, 16, 99, 1, 4, 8, 40]
);
assert.equal(ofType(rib, 3)[0].value.toString('hex'), 'cb00710a');
assert.deepEqual(asPath(ofType(rib, 2)[0].value), [{ type: 2, asns: [70000, 65001] }]);
assert.deepEqual(
    ofType(rib, 4).map(attr => attr.value.readUInt32BE()),
    [10, 90]
);
assert.deepEqual(
    ofType(rib, 8).map(attr => attr.value.toString('hex')),
    ['fde80001fde80001fde8ffff', 'fde80007']
);
assert.equal(ofType(rib, 16)[0].value.toString('hex'), '0002fde80000006402030001117000140102030405060708');
assert.equal(ofType(rib, 99)[0].value.toString('hex'), 'cafe');
assert.equal(ofType(rib, 1)[0].value[0], 2);
assert.equal(
    ofType(rib, 40)[0].value.toString('hex'),
    '0500220001001e0020010db800000000000000000000000a00001300010006301010000000'
);
assert.equal(JSON.stringify(saved), original, 'export must not modify saved attributes or NLRI');
const maxPath = decodeRib(encoder.encodeRoute({ ...saved, pathId: 0xffffffff }, { sequence: 8, originatedTime: 1234 }));
assert.equal(maxPath.pathId, 0xffffffff);
assert.equal(maxPath.originatedTime, 1234);
assert.equal(maxPath.sequence, 8);
assert.equal(decodeRib(createMrtEncoder({ ...options, addPath: false }).encodeRoute(saved)).subtype, 2);

for (const [addressFamily, ip, mask, mpNextHop, expected] of [
    [1, '10.20.30.45', 24, null, '00'],
    [1, '10.20.30.45', 24, '', '04c6336401'],
    [1, '10.20.30.45', 24, '192.0.2.200', '04c00002c8'],
    [1, '10.20.30.45', 24, '2001:db8::200', '1020010db8000000000000000000000200'],
    [2, '2001:db8:abcd:ffff::9', 65, null, '00'],
    [2, '2001:db8:abcd:ffff::9', 65, '', '1000000000000000000000ffffc6336401'],
    [2, '2001:db8:abcd:ffff::9', 65, '2001:db8::200', '1020010db8000000000000000000000200']
]) {
    const output = decodeRib(
        createMrtEncoder({ ...options, addressFamily }).encodeRoute(
            route({
                ip,
                mask,
                mpNextHop,
                nlriEncoding: 'mpReach',
                routeAttr: configured([{ type: 'nextHop', value: '203.0.113.10' }])
            })
        )
    );
    assert.equal(output.subtype, addressFamily === 1 ? 8 : 10);
    assert.deepEqual(
        output.attrs.map(attr => attr.type),
        [3, 14]
    );
    assert.equal(
        ofType(output, 3)[0].value.toString('hex'),
        'cb00710a',
        'Type 3 is independent of the compact MP next hop'
    );
    assert.equal(ofType(output, 14)[0].value.toString('hex'), expected);
    if (addressFamily === 2)
        assert.equal(output.nlri.toString('hex'), '20010db8abcdffff00', 'partial prefix octets clear host bits');
}
assert.equal(
    ofType(decodeRib(ipv6Peer.encodeRoute(route({ nlriEncoding: 'mpReach', mpNextHop: '' }))), 14)[0].value.toString(
        'hex'
    ),
    '1020010db80000000000000000000000fe'
);
assert.equal(
    ofType(
        decodeRib(encoder.encodeRoute(route({ routeAttr: configured([{ type: 'nextHop', value: '' }]) }))),
        3
    )[0].value.toString('hex'),
    'c6336401'
);
assert.deepEqual(decodeRib(encoder.encodeRoute(route())).attrs, [], 'missing attribute nodes remain absent');
assert.equal(decodeRib(encoder.encodeRoute(route({ ip: '255.255.255.255', mask: 0 }))).nlri.length, 0);
assert.equal(decodeRib(encoder.encodeRoute(route({ ip: '10.20.30.255', mask: 25 }))).nlri.toString('hex'), '0a141e80');
const plain6 = decodeRib(
    createMrtEncoder({ ...options, addressFamily: 2, addPath: false }).encodeRoute(
        route({ ip: '2001:db8::1', mask: 128 })
    )
);
assert.equal(plain6.subtype, 4);
assert.equal(plain6.pathId, undefined);
assert.equal(plain6.nlri.length, 16);

for (const [addPath, subtype] of [
    [true, 12],
    [false, 6]
]) {
    const labeled = createMrtEncoder({ ...options, addressFamily: 12, addPath });
    const output = decodeRib(
        labeled.encodeRoute(route({ mask: 32, label: 16000, pathId: 7, mpNextHop: '192.0.2.200' }))
    );
    assert.deepEqual(
        [output.subtype, output.afi, output.safi, output.lengthBits, output.pathId],
        [subtype, 1, 4, 56, addPath ? 7 : undefined]
    );
    assert.equal(output.nlri.toString('hex'), '03e8010a141e2d', 'Label 16000 with BOS precedes the IPv4 prefix');
    assert.equal(ofType(output, 14)[0].value.toString('hex'), '04c00002c8');
    const missing = decodeRib(labeled.encodeRoute(route({ mask: 32, label: null })));
    assert.equal(missing.lengthBits, 32);
    assert.equal(
        missing.nlri.toString('hex'),
        '0a141e2d',
        'a missing configured label must not silently insert label bytes'
    );
    assert.equal(ofType(missing, 14)[0].value.toString('hex'), '00');
}

const customMp = decodeRib(
    encoder.encodeRoute(route({ routeAttr: configured([{ type: 'custom', value: '800e0900010104c00002c800' }]) }))
);
assert.equal(
    ofType(customMp, 14)[0].value.toString('hex'),
    '04c00002c8',
    'raw MP_REACH values also use the standard MRT compact representation'
);
const large = decodeRib(
    encoder.encodeRoute(route({ routeAttr: configured([{ type: 'custom', value: 'd0631388' + 'aa'.repeat(5000) }]) }))
);
assert.equal(large.attrs[0].value.length, 5000, 'MRT record sizes are independent of the BGP UPDATE 4096-byte limit');
const maximum = decodeRib(
    encoder.encodeRoute(route({ routeAttr: configured([{ type: 'custom', value: 'd063fffb' + '00'.repeat(65531) }]) }))
);
assert.equal(maximum.attrs[0].value.length, 65531);
assert.throws(
    () =>
        encoder.encodeRoute(
            route({ routeAttr: configured([{ type: 'custom', value: 'd063fffc' + '00'.repeat(65532) }]) })
        ),
    /总长度不能超过65535/
);
assert.throws(
    () => encoder.encodeRoute(route({ routeAttr: configured([{ type: 'custom', value: 'c06304ffaa' }]) })),
    /属性值长度不完整/
);
assert.throws(
    () => encoder.encodeRoute(route({ routeAttr: configured([{ type: 'custom', value: '800e03000101' }]) })),
    /下一跳长度无效/
);

const legacy = decodeRib(
    encoder.encodeRoute(
        route({
            routeAttr: {
                origin: 1,
                asPath: '70000 65001',
                nextHop: '192.0.2.10',
                med: 42,
                localPref: 321,
                communities: ['65000:1'],
                srv6Sid: '2001:db8::1',
                srv6EndpointBehavior: 19
            }
        })
    )
);
assert.deepEqual(
    asPath(ofType(legacy, 2)[0].value),
    [{ type: 2, asns: [70000, 65001] }],
    'legacy RIB export never adds the synthetic local AS'
);
assert.equal(ofType(legacy, 5)[0].value.readUInt32BE(), 321);
assert.equal(ofType(legacy, 40).length, 1, 'stored legacy SRv6 is not filtered by a live peer capability');
assert.equal(ofType(legacy, 3)[0].value.toString('hex'), 'c000020a');
assert.equal(decodeRib(encoder.encodeRoute(route({ createdAtMs: undefined }))).originatedTime, options.timestamp);

for (const addressFamily of [3, 6, 8, 13, undefined])
    assert.throws(() => createMrtEncoder({ ...options, addressFamily }), /仅支持/);
for (const overrides of [
    { routerId: '::1' },
    { localIp: 'invalid' },
    { localAs: -1 },
    { localAs: 0x100000000 },
    { timestamp: -1 },
    { viewName: '界'.repeat(21846) },
    { addPath: 'true' }
])
    assert.throws(() => createMrtEncoder({ ...options, ...overrides }));
for (const overrides of [
    { ip: '::1' },
    { mask: 33 },
    { mask: -1 },
    { mask: 1.5 },
    { pathId: -1 },
    { pathId: 0x100000000 },
    { createdAtMs: -1000 },
    { routeAttr: null }
])
    assert.throws(() => encoder.encodeRoute(route(overrides)));
assert.throws(() => encoder.encodeRoute(route(), { sequence: 0x100000000 }), /序列号/);
assert.throws(() => encoder.encodeRoute(route(), { originatedTime: -1 }), /生成时间/);
console.log(
    'MRT TABLE_DUMP_V2 peer index, AS4, ordered repeated attributes, multi-values, compact independent next hops, ADD-PATH/Label layouts, presence, timestamps and 16-bit length boundaries passed'
);
