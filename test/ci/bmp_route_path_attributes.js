const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
const { canonicalizeBmpRouteAttr } = require('../../electron/worker/bmp/bmpRouteAttrStore');
const { buildRouteUpsertMutation, compactRoutePayload } = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { builders: b } = require('../../scripts/mockBmpClient');

function attribute(type, value, flags = 0x40) {
    return Buffer.concat([
        Buffer.from([flags | (value.length > 255 ? 0x10 : 0), type]),
        value.length > 255 ? b.u16(value.length) : Buffer.from([value.length]),
        value
    ]);
}

function update(attributes) {
    const values = Buffer.concat(attributes);
    const body = Buffer.concat([b.u16(0), b.u16(values.length), values, Buffer.from([24, 203, 0, 113])]);
    return Buffer.concat([Buffer.alloc(16, 255), b.u16(body.length + 19), Buffer.from([2]), body]);
}

const session = new BmpSession({ sendEvent() {} }, {});
Object.assign(session, { localIp: '127.0.0.1', localPort: 11019, remoteIp: '192.0.2.10', remotePort: 50000 });
const owner = new BmpBgpSession(session);
Object.assign(owner, { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65001 });

function route(prefix = '203.0.113.0') {
    const result = new BmpBgpRoute(null, null);
    Object.assign(result, { afi: 1, safi: 1, ip: prefix, mask: 24, nlriDetail: { prefix, length: 24, valid: true } });
    return result;
}

function mutation(current) {
    return buildRouteUpsertMutation(session, owner, current, 1, 1, 2, { kind: 'peer', scopeState: 'ready' });
}

// Real parsing must retain every decoded field, wire metadata, unknown attribute
// and repeated attribute, including zero-byte ATOMIC_AGGREGATE.
const packet = parseBgpPacket(
    update([
        attribute(1, Buffer.from([0])),
        attribute(2, Buffer.concat([Buffer.from([2, 1]), b.u32(65001)])),
        attribute(3, b.ip('192.0.2.1')),
        attribute(4, b.u32(10), 0x80),
        attribute(4, b.u32(20), 0x80),
        attribute(5, b.u32(100)),
        attribute(6, Buffer.alloc(0)),
        attribute(7, Buffer.concat([b.u32(65001), b.ip('192.0.2.2')]), 0xc0),
        attribute(8, Buffer.concat([b.u16(65001), b.u16(100)]), 0xc0),
        attribute(16, Buffer.from('0002fde900000064', 'hex'), 0xc0),
        attribute(22, Buffer.from('0006000641c0000202', 'hex'), 0xc0),
        attribute(23, Buffer.concat([b.u16(8), b.u16(0)]), 0xc0),
        attribute(40, Buffer.from('010007000000000007d1', 'hex'), 0xc0),
        attribute(35, b.u32(65002), 0xc0),
        attribute(9, b.ip('192.0.2.3'), 0x80),
        attribute(10, b.ip('192.0.2.4'), 0x80),
        attribute(32, Buffer.concat([b.u32(65001), b.u32(100), b.u32(200)]), 0xc0),
        attribute(99, Buffer.from('0100ff', 'hex'), 0xe0),
        attribute(1, Buffer.from([255]))
    ])
);
const current = route();
session.setRouteAttributes(current, packet);
const retained = current.getRouteInfo().pathAttributes;
assert.equal(retained.length, packet.pathAttributes.length);
packet.pathAttributes.forEach((parsed, index) => {
    const expected = { ...parsed, rawValueHex: parsed.value.toString('hex') };
    delete expected.value;
    assert.deepEqual(retained[index], expected, `attribute ${parsed.typeCode} must retain all parser fields`);
});
assert.equal(retained.find(attr => attr.typeCode === 6).rawValueHex, '');
assert.deepEqual(
    retained.filter(attr => attr.typeCode === 4).map(attr => attr.med),
    [10, 20]
);
assert.equal(retained.find(attr => attr.typeCode === 99).flags, 0xe0);
assert.equal(retained.at(-1).valid, false);
assert.ok(retained.at(-1).errors.length);
assert.equal(retained.find(attr => attr.typeCode === 40).prefixSid.labelIndex.labelIndex, 2001);

// External snapshots and reused parser buffers must not mutate stored/shared
// attributes or reuse a previous attribute hash after a new assignment.
const first = mutation(current);
// Plain/public route-info fallbacks must keep attributes in the shared object,
// with the same compact payload as the transient BmpBgpRoute fast path.
const routeInfo = current.getRouteInfo();
assert.deepEqual(compactRoutePayload(routeInfo), JSON.parse(first.route.routeJson));
for (const fallback of [
    { ...routeInfo, getRouteAttr: () => current.getRouteAttr() },
    { ...routeInfo, getRouteInfo: () => routeInfo, getRouteAttr: () => current.getRouteAttr() }
]) {
    const fallbackMutation = mutation(fallback);
    assert.equal(fallbackMutation.route.attrJson, first.route.attrJson);
    assert.deepEqual(JSON.parse(fallbackMutation.route.routeJson), JSON.parse(first.route.routeJson));
    assert.equal(Object.hasOwn(JSON.parse(fallbackMutation.route.routeJson), 'pathAttributes'), false);
    assert.deepEqual(JSON.parse(fallbackMutation.route.attrJson).pathAttributes, routeInfo.pathAttributes);
}
retained[1].segments[0].asNumbers[0] = 1;
assert.equal(current.getRouteInfo().pathAttributes[1].segments[0].asNumbers[0], 65001);
packet.pathAttributes.find(attr => attr.typeCode === 99).value[0] = 2;
assert.equal(current.getRouteInfo().pathAttributes.find(attr => attr.typeCode === 99).rawValueHex, '0100ff');
session.setRouteAttributes(current, packet);
assert.notEqual(mutation(current).route.attrId, first.route.attrId);
const external = [{ typeCode: 99, flags: 0x80, length: 1, rawValueHex: '01', decoded: { bytes: Buffer.from([1]) } }];
const canonical = canonicalizeBmpRouteAttr({ pathAttributes: Object.freeze(external) });
external[0].decoded.bytes[0] = 2;
assert.equal(canonical.pathAttributes[0].decoded.bytes, '01');
assert.equal(Object.hasOwn(canonicalizeBmpRouteAttr({ asPath: '65001' }), 'pathAttributes'), false);

// AS4 reconstruction changes the displayed path, while both wire paths remain
// inspectable with their own decoded segments and bytes.
const legacy = parseBgpPacket(
    update([
        attribute(1, Buffer.from([0])),
        attribute(2, Buffer.concat([Buffer.from([2, 2]), b.u16(65001), b.u16(23456)])),
        attribute(17, Buffer.concat([Buffer.from([2, 1]), b.u32(70000)]), 0xc0),
        attribute(3, b.ip('192.0.2.1'))
    ]),
    { asnSize: 2 }
);
// BMP session annotates this wire parsing context before extracting attributes.
legacy.asnSize = 2;
const as4 = session.extractRouteAttributes(legacy);
assert.equal(as4.asPath, '65001 70000');
assert.equal(as4.wireAsPath, '65001 23456');
assert.equal(as4.as4Path, '70000');
assert.deepEqual(as4.pathAttributes.find(attr => attr.typeCode === 2).segments[0].asNumbers, [65001, 23456]);

// A 10,000-NLRI MP batch has the same bounded shared attributes as one NLRI,
// despite extended wire lengths and different aggregate NLRI diagnostics.
const prefixes = count =>
    Buffer.concat(Array.from({ length: count }, (_, index) => Buffer.from([32, 10, index >> 8, index & 255, 1])));
const mpUpdate = count => parseBgpPacket(b.multiprotocolUpdate(1, 1, prefixes(count), { nextHop: '192.0.2.1' }));
const small = mpUpdate(1);
const large = mpUpdate(10000);
const largeReach = large.pathAttributes.find(attr => attr.mpReach).mpReach;
assert.equal(largeReach.nlri.length, 10000);
const smallAttrs = session.getSharedRouteAttributes(
    session.createRouteAttributeContext(small),
    1,
    1,
    small.pathAttributes.find(attr => attr.mpReach).mpReach
);
const largeContext = session.createRouteAttributeContext(large);
const largeAttrs = session.getSharedRouteAttributes(largeContext, 1, 1, largeReach);
assert.equal(session.getSharedRouteAttributes(largeContext, 1, 1, largeReach), largeAttrs);
assert.equal(canonicalizeBmpRouteAttr(largeAttrs).pathAttributes, largeAttrs.pathAttributes);
assert.ok(Object.isFrozen(largeAttrs.pathAttributes[1].mpReach));
assert.equal(JSON.stringify(largeAttrs), JSON.stringify(smallAttrs));
assert.ok(JSON.stringify(largeAttrs).length < 1000);
const mpHeader = largeAttrs.pathAttributes.find(attr => attr.mpReach);
assert.equal(mpHeader.headerLength, 9);
assert.equal(mpHeader.rawValueHex, '00010104c000020100');
assert.equal(mpHeader.nlriOmitted, true);
assert.equal(Object.hasOwn(mpHeader, 'length'), false);
assert.equal(Object.hasOwn(mpHeader.mpReach, 'nlri'), false);
const sharedRoute = route();
sharedRoute.assignSharedRouteAttr(largeAttrs);
const inlineGetter = sharedRoute.getInlineRouteAttr.bind(sharedRoute);
let publicCopies = 0;
sharedRoute.getInlineRouteAttr = () => {
    publicCopies += 1;
    return inlineGetter();
};
assert.equal(sharedRoute.nextHop, '192.0.2.1');
assert.equal(sharedRoute.origin, 'IGP');
assert.equal(sharedRoute.med, 0);
assert.equal(publicCopies, 0, 'scalar getters must avoid cloning the full path attribute array');
const sharedDetail = sharedRoute.getRouteInfo();
assert.equal(publicCopies, 1);
sharedDetail.pathAttributes.find(attr => attr.mpReach).mpReach.nextHop = '192.0.2.99';
assert.equal(
    sharedRoute.getImmutableRouteAttr().pathAttributes.find(attr => attr.mpReach).mpReach.nextHop,
    '192.0.2.1'
);

// Mixed AFs and repeated MP_REACH groups must retain only their own header.
const v6 = parseBgpPacket(
    b.multiprotocolUpdate(2, 1, Buffer.from('4020010db800010000', 'hex'), { nextHop: '2001:db8::1' })
);
const secondReach = parseBgpPacket(
    b.multiprotocolUpdate(1, 1, prefixes(1), { nextHop: '192.0.2.2' })
).pathAttributes.find(attr => attr.mpReach);
const withdrawal = {
    flags: 0x90,
    typeCode: 15,
    length: 40003,
    value: Buffer.concat([Buffer.from('000101', 'hex'), Buffer.alloc(40000)]),
    mpUnreach: {
        afi: 1,
        safi: 1,
        withdrawnRoutes: Array(10000).fill({ prefix: '10.0.0.1' }),
        valid: false,
        errors: ['Batch NLRI error']
    }
};
large.pathAttributes.push(
    secondReach,
    v6.pathAttributes.find(attr => attr.mpReach),
    withdrawal
);
const mixedContext = session.createRouteAttributeContext(large);
const firstGroup = session.getSharedRouteAttributes(mixedContext, 1, 1, largeReach);
const secondGroup = session.getSharedRouteAttributes(mixedContext, 1, 1, secondReach.mpReach);
assert.notEqual(firstGroup, secondGroup);
assert.deepEqual(
    firstGroup.pathAttributes.filter(attr => attr.mpReach).map(attr => attr.mpReach.nextHop),
    ['192.0.2.1']
);
assert.deepEqual(
    secondGroup.pathAttributes.filter(attr => attr.mpReach).map(attr => attr.mpReach.nextHop),
    ['192.0.2.2']
);
const unreachable = firstGroup.pathAttributes.find(attr => attr.mpUnreach);
assert.equal(unreachable.rawValueHex, '000101');
assert.equal(unreachable.headerLength, 3);
assert.deepEqual(unreachable.mpUnreach, { afi: 1, safi: 1 });
assert.equal(
    session.getSharedRouteAttributes(mixedContext, 1, 1).pathAttributes.some(attr => attr.mpReach),
    false
);

// The real durable route projection must return the complete array after reopen.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-path-attributes-'));
let store;
try {
    const dbPath = path.join(directory, 'bmp.sqlite3');
    store = new Store({ dbPath }).open();
    store.applyBatch({ batchId: 'path-attributes', mutations: [first] });
    store.close();
    store = new Store({ dbPath, readOnly: true }).open();
    const detail = store.queryRoutes({ scopeId: first.scope.id, routeState: 'all', pageSize: 1 }).list[0];
    assert.deepEqual(detail.pathAttributes, JSON.parse(first.route.attrJson).pathAttributes);
    assert.equal(detail.pathAttributes.find(attr => attr.typeCode === 99).rawValueHex, '0100ff');
} finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
}

console.log(
    'BMP full path attribute tests passed (wire fields, unknowns, AS4, bounded MP, immutability, SQLite roundtrip)'
);
