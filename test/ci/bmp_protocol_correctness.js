const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');
const { parseBmpPacket } = require('../../electron/utils/bmpPacketParser');
const { createRouteKey, KEY_SCHEMA_VERSION } = require('../../electron/utils/bmpPersistentRouteKey');
const { createIngestSnapshot, applyIngestSnapshot } = require('../../electron/worker/bmp/bmpIngestSnapshot');
const { builders } = require('../../scripts/mockBmpClient');

const { u16, u32, ip } = builders;
const families = [
    { afi: 1, safi: 1 },
    { afi: 2, safi: 1 },
    { afi: 25, safi: 70 },
    { afi: 1, safi: 133 },
    { afi: 1, safi: 241 }
];
const packet = (type, body = Buffer.alloc(0)) =>
    Buffer.concat([Buffer.alloc(16, 255), u16(19 + body.length), Buffer.from([type]), body]);
const attr = (type, value, flags = 0x40) => Buffer.concat([Buffer.from([flags, type, value.length]), value]);
const update = (attrs, nlri = Buffer.from([24, 203, 0, 113])) => {
    const bytes = Buffer.concat(attrs);
    return packet(2, Buffer.concat([u16(0), u16(bytes.length), bytes, nlri]));
};
const asPath = size =>
    attr(
        2,
        Buffer.concat([
            Buffer.from([2, 2]),
            ...(size === 2 ? [65000, 65001].map(u16) : [65000, 65001].map(u32)),
            Buffer.from([2, 1]),
            size === 2 ? u16(65002) : u32(70000)
        ])
    );
const origin = attr(1, Buffer.from([0]));
const nextHop = attr(3, ip('192.0.2.254'));

// Independent builders deliberately do not reuse mockBmpClient's OPEN order.
function open(routerId, mode) {
    const caps = Buffer.concat(
        families.flatMap(({ afi, safi }) => [
            Buffer.concat([Buffer.from([1, 4]), u16(afi), Buffer.from([0, safi])]),
            Buffer.concat([Buffer.from([69, 4]), u16(afi), Buffer.from([safi, mode])])
        ])
    );
    const params = Buffer.concat([Buffer.from([2, caps.length]), caps]);
    return packet(
        1,
        Buffer.concat([Buffer.from([4]), u16(65000), u16(90), ip(routerId), Buffer.from([params.length]), params])
    );
}

function peerHeader(kind = 'peer', flags = 0) {
    return Buffer.concat([
        Buffer.from([kind === 'peer' ? 0 : 3, flags]),
        Buffer.alloc(8),
        Buffer.alloc(12),
        kind === 'peer' ? ip('192.0.2.2') : Buffer.alloc(4),
        u32(65000),
        ip('192.0.2.1'),
        u32(1719811200),
        u32(123456)
    ]);
}

function peerUp(kind = 'peer', sentMode = 1, receivedMode = 2, version = 3) {
    return builders.bmpMessage(
        3,
        Buffer.concat([
            peerHeader(kind, kind === 'peer' ? 0 : 0x80),
            Buffer.alloc(12),
            ip('192.0.2.254'),
            u16(179),
            u16(50000),
            open('192.0.2.1', sentMode),
            open('192.0.2.2', receivedMode)
        ]),
        version
    );
}

function harness(kind = 'peer', sentMode = 3, receivedMode = 3) {
    const mutations = [],
        failures = [],
        routeUpdates = [];
    const session = new BmpSession(
        { sendEvent() {} },
        {
            bmpConfigData: { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 },
            persistence: {},
            enqueuePersistenceMutation(mutation) {
                mutations.push(mutation);
                return true;
            },
            handlePersistenceFailure(error) {
                failures.push(error);
            },
            enqueueRouteUpdateEvent(event) {
                routeUpdates.push(event);
            },
            enqueueInstanceRouteUpdateEvent(event) {
                routeUpdates.push(event);
            },
            invalidateRouteAssurance() {},
            requestPersistenceSweep() {}
        }
    );
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '192.0.2.10',
        remotePort: 50000,
        connectionId: `protocol-${kind}`,
        connectionGeneration: 1,
        openedAtMs: 1719811200000
    });
    session.processMessage(peerUp(kind, sentMode, receivedMode));
    return {
        session,
        mutations,
        failures,
        routeUpdates,
        send(bgp, flags = 0, version = 3, options = {}) {
            mutations.length = 0;
            routeUpdates.length = 0;
            session.processMessage(
                version === 3
                    ? builders.bmpMessage(0, Buffer.concat([peerHeader(kind, flags), bgp]), 3)
                    : builders.routeMonitoringMessage(
                          { peerType: kind === 'peer' ? 0 : 3, flags, timestamp: 1719811200, timestampMs: 123456 },
                          bgp,
                          options
                      )
            );
            assert.deepEqual(failures, [], 'protocol errors must not invoke the database fail-closed path');
            return mutations.filter(item => item.route);
        }
    };
}

// RFC 7854 Sent OPEN then Received OPEN, with intentionally asymmetric ADD-PATH.
for (const kind of ['peer', 'loc-rib']) {
    const wire = peerUp(kind, 1, 2, 4);
    const parsed = parseBmpPacket(wire);
    assert.equal(parsed.payload.sentOpen.parsed.routerId, '192.0.2.1');
    assert.equal(parsed.payload.receivedOpen.parsed.routerId, '192.0.2.2');
    const h = harness(kind, 1, 2);
    const owner =
        kind === 'peer' ? [...h.session.bgpSessionMap.values()][0] : [...h.session.bgpInstanceMap.values()][0];
    assert.equal(owner.getAddPathReceiveInfo(1, 1, 'receive').enabled, true);
    assert.equal(owner.getAddPathReceiveInfo(1, 1, 'send').enabled, false);
    const reversed = harness(kind, 2, 1);
    const reverseOwner =
        kind === 'peer'
            ? [...reversed.session.bgpSessionMap.values()][0]
            : [...reversed.session.bgpInstanceMap.values()][0];
    assert.equal(reverseOwner.getAddPathReceiveInfo(1, 1, 'receive').enabled, false);
    assert.equal(reverseOwner.getAddPathReceiveInfo(1, 1, 'send').enabled, true);
}

// A flag is authoritative for Peer AS_PATH width, not for Loc-RIB's reserved flags.
for (const version of [3, 4]) {
    const h = harness('peer', 0, 0);
    for (const [size, flags, expected] of [
        [2, 0x20, '65000 65001 65002'],
        [4, 0, '65000 65001 70000']
    ]) {
        const routes = h.send(update([origin, asPath(size), nextHop]), flags, version);
        assert.equal(routes.length, 1);
        assert.equal(JSON.parse(routes[0].route.attrJson).asPath, expected);
        assert.equal(routes[0].sourceTimestampMs, 1719811200123);
    }
    const truncatedFourOctetPath = attr(2, Buffer.concat([Buffer.from([2, 2]), u16(65000), u16(65001)]));
    assert.equal(
        h.send(update([origin, truncatedFourOctetPath, nextHop]), 0, version).length,
        0,
        'truncated A=0 AS_PATH is invalid'
    );
    const loc = harness('loc-rib', 0, 0);
    const locRoutes = loc.send(update([origin, asPath(4), nextHop]), 0xa0, version);
    assert.equal(locRoutes.length, 1);
    assert.equal(JSON.parse(locRoutes[0].route.attrJson).asPath, '65000 65001 70000');
}

for (const [bytes, expectedAsn] of [
    [Buffer.concat([u16(65000), ip('192.0.2.1')]), 65000],
    [Buffer.concat([u32(70000), ip('192.0.2.1')]), 70000]
]) {
    const parsed = parseBgpPacket(update([origin, attr(7, bytes, 0xc0)]), { asnSize: 4 });
    assert.equal(parsed.valid, true);
    const aggregator = parsed.pathAttributes.find(item => item.typeCode === 7);
    assert.equal(aggregator.aggregatorAs, expectedAsn);
    assert.equal(aggregator.aggregatorIp, '192.0.2.1');
}
const as4 = parseBgpPacket(update([attr(17, Buffer.concat([Buffer.from([2, 1]), u32(70000)]), 0xc0)]), { asnSize: 2 });
assert.equal(as4.valid, true);
assert.deepEqual(as4.pathAttributes[0].segments[0].asNumbers, [70000]);

// Complete boundaries: invalid UPDATEs remain diagnostic objects, never routes/EOR.
const shortUpdate = packet(2, Buffer.alloc(0));
const badWithdrawLength = packet(2, Buffer.concat([u16(8), u16(0)]));
const badAttrLength = packet(2, Buffer.concat([u16(0), u16(5), Buffer.from([0x40, 1, 1, 0])]));
const badAttrSection = packet(2, Buffer.concat([u16(0), u16(3), Buffer.from([0x40, 3, 4]), ip('192.0.2.1')]));
const shortExtendedAttr = packet(2, Buffer.concat([u16(0), u16(3), Buffer.from([0x50, 1, 0])]));
const invalidOrigin = update([attr(1, Buffer.from([3]))]);
const badCommunity = update([attr(8, Buffer.from([0]), 0xc0)]);
const badMpNextHop = update([attr(14, Buffer.from([0, 2, 1, 16, 0]), 0x80)], Buffer.alloc(0));
const invalidIpv4 = update([origin], Buffer.concat([Buffer.from([33]), Buffer.alloc(5)]));
const invalidIpv6 = builders.multiprotocolUpdate(2, 1, Buffer.concat([Buffer.from([129]), Buffer.alloc(17)]));
const invalidEvpn = builders.multiprotocolUpdate(25, 70, Buffer.from([2, 1, 0]));
const invalidFlowSpec = builders.multiprotocolUpdate(1, 133, Buffer.from([3, 1, 33, 0]));
const invalidQp = builders.multiprotocolUpdate(1, 241, Buffer.from([5, 2, 24, 203, 0]));
const invalidFallback = builders.multiprotocolUpdate(999, 200, Buffer.from([1, 0]));
const extraBgpBytes = Buffer.concat([packet(4), Buffer.from([0])]);
for (const bytes of [
    shortUpdate,
    badWithdrawLength,
    badAttrLength,
    badAttrSection,
    shortExtendedAttr,
    invalidOrigin,
    badCommunity,
    badMpNextHop,
    invalidIpv4,
    invalidIpv6,
    invalidEvpn,
    invalidFlowSpec,
    invalidQp,
    invalidFallback,
    extraBgpBytes
]) {
    assert.equal(parseBgpPacket(bytes, { asnSize: 4 }).valid, false);
}
assert.equal(parseBgpPacket(packet(1, Buffer.alloc(0))).valid, false);
assert.equal(parseBgpPacket(packet(3, Buffer.alloc(1))).valid, false);
assert.equal(parseBgpPacket(packet(4, Buffer.alloc(1))).valid, false);
assert.equal(parseBgpPacket(packet(5, Buffer.alloc(3))).valid, false);

// OPEN parameter/capability boundaries and RFC 9072's extended parameter format.
const baseOpen = Buffer.concat([Buffer.from([4]), u16(65000), u16(90), ip('192.0.2.1')]);
const extendedCap = Buffer.from([1, 4, 0, 1, 0, 1]);
const extendedParam = Buffer.concat([Buffer.from([2]), u16(extendedCap.length), extendedCap]);
const extendedOpen = packet(
    1,
    Buffer.concat([baseOpen, Buffer.from([255, 255]), u16(extendedParam.length), extendedParam])
);
assert.equal(parseBgpPacket(extendedOpen).valid, true);
assert.equal(parseBgpPacket(extendedOpen).capabilities[0].afi, 1);
for (const optional of [Buffer.from([1, 2]), Buffer.from([4, 2, 2, 69, 4]), Buffer.from([5, 2, 3, 69, 1, 0])]) {
    assert.equal(parseBgpPacket(packet(1, Buffer.concat([baseOpen, optional]))).valid, false);
}
for (const kind of ['peer', 'loc-rib']) {
    const h = harness(kind, 0, 0);
    for (const bytes of [
        shortUpdate,
        badAttrSection,
        invalidIpv4,
        invalidIpv6,
        invalidEvpn,
        invalidFlowSpec,
        invalidQp,
        invalidFallback
    ]) {
        for (const version of [3, 4]) {
            assert.equal(h.send(bytes, 0, version).length, 0);
            assert.equal(h.mutations.length, 0, 'invalid NLRI must not open a scope or acknowledge EOR');
            assert.equal(h.routeUpdates.length, 0);
        }
    }
    // Trailing BMPv3 data and truncated BMPv4 TLVs must not masquerade as EOR.
    assert.equal(h.send(Buffer.concat([builders.endOfRibUpdate(), Buffer.from([0])])).length, 0);
    assert.equal(h.mutations.length, 0);
    const malformedV4 = Buffer.concat([
        builders.routeMonitoringMessage({ peerType: kind === 'peer' ? 0 : 3 }, builders.endOfRibUpdate()),
        Buffer.from([0])
    ]);
    malformedV4.writeUInt32BE(malformedV4.length, 1);
    h.session.processMessage(malformedV4);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.send(builders.ipv4Update(['203.0.113.0'])).length, 1, 'later valid UPDATE still works');
    const beforePeerUp = h.mutations.length;
    const invalidPeerUp = peerUp(kind);
    invalidPeerUp[6 + 42 + 20 + 18] = 4; // A KEEPALIVE cannot replace the Sent OPEN.
    h.session.processMessage(invalidPeerUp);
    assert.equal(h.mutations.length, beforePeerUp, 'invalid Peer Up does not advance scopes/epochs');
}

const failedWriter = harness('peer', 0, 0);
const writerError = new Error('simulated SQLite writer failure');
failedWriter.session.bmpWorker.enqueuePersistenceMutation = () => {
    throw writerError;
};
failedWriter.session.processMessage(
    builders.bmpMessage(0, Buffer.concat([peerHeader(), builders.ipv4Update(['203.0.113.0'])]), 3)
);
assert.ok(failedWriter.failures.includes(writerError), 'genuine persistence errors must still fail closed');

// QP's DQPN TLV is optional. Absence must not alias an explicitly encoded 0/0.
const qpPrefixOnly = Buffer.from([5, 2, 24, 203, 0, 113]);
const qpExplicitZero = Buffer.from([7, 1, 0, 2, 24, 203, 0, 113]);
const qpPacket = nlri => builders.multiprotocolUpdate(1, 241, nlri);
const qpNlri = nlri => parseBgpPacket(qpPacket(nlri)).pathAttributes.find(item => item.mpReach).mpReach.nlri[0];
const prefixOnlyQp = qpNlri(qpPrefixOnly);
const zeroQp = qpNlri(qpExplicitZero);
assert.equal(parseBgpPacket(qpPacket(qpPrefixOnly)).valid, true);
assert.equal(prefixOnlyQp.dqpn, null);
assert.equal(prefixOnlyQp.dqpnBits, null);
assert.equal(zeroQp.dqpn, 0);
assert.equal(zeroQp.dqpnBits, 0);
const qpKey = nlri => createRouteKey({ afi: 1, safi: 241, nlri });
const prefixOnlyQpKey = qpKey(prefixOnlyQp);
const zeroQpKey = qpKey(zeroQp);
assert.notEqual(prefixOnlyQpKey.keyHex, zeroQpKey.keyHex);
assert.deepEqual(
    [prefixOnlyQpKey.canonicalIdentity.nlri.dqpn, prefixOnlyQpKey.canonicalIdentity.nlri.dqpnBits],
    [null, null]
);
assert.notEqual(prefixOnlyQpKey.canonicalJson, zeroQpKey.canonicalJson);
assert.throws(() => qpKey({ ...prefixOnlyQp, dqpn: 0 }), /must both be present or absent/);
assert.throws(() => qpKey({ ...prefixOnlyQp, dqpnBits: 0 }), /must both be present or absent/);
for (const kind of ['peer', 'loc-rib']) {
    const h = harness(kind, 0, 0);
    const prefixOnlyMutations = h.send(qpPacket(qpPrefixOnly));
    const zeroMutations = h.send(qpPacket(qpExplicitZero));
    assert.equal(prefixOnlyMutations.length, 1);
    assert.equal(zeroMutations.length, 1);
    assert.equal(prefixOnlyMutations[0].route.id, prefixOnlyQpKey.keyHex);
    assert.equal(zeroMutations[0].route.id, zeroQpKey.keyHex);
    assert.deepEqual(
        [
            JSON.parse(prefixOnlyMutations[0].route.routeJson).nlriDetail.dqpn,
            JSON.parse(prefixOnlyMutations[0].route.routeJson).nlriDetail.dqpnBits
        ],
        [null, null]
    );
    const withdraw = update(
        [attr(15, Buffer.concat([u16(1), Buffer.from([241]), qpPrefixOnly]), 0x80)],
        Buffer.alloc(0)
    );
    const withdrawMutations = h.send(withdraw);
    assert.equal(withdrawMutations.length, 1);
    assert.equal(withdrawMutations[0].route.id, prefixOnlyQpKey.keyHex);

    // The CI runtime has the application's SQLite ABI; ordinary Node also runs
    // all protocol/key probes above without loading an incompatible native ABI.
    if (process.versions.electron) {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-qp-optional-'));
        const store = new Store({ dbPath: path.join(directory, 'client.sqlite3') });
        try {
            store.open();
            const mutations = [...prefixOnlyMutations, ...zeroMutations];
            store.applyBatch({ batchId: `qp-${kind}-seed`, createdAtMs: 1719811200000, mutations });
            const scopeId = prefixOnlyMutations[0].scope.id;
            let routes = store.queryRoutes({ scopeId, pageSize: 10 }).list;
            assert.equal(routes.length, 2, 'prefix-only and explicit-zero QP routes both persist');
            assert.deepEqual(
                routes.map(route => route.nlriDetail.dqpn).sort((a, b) => Number(a) - Number(b)),
                [null, 0]
            );
            store.applyBatch({
                batchId: `qp-${kind}-withdraw`,
                createdAtMs: 1719811200001,
                mutations: withdrawMutations
            });
            routes = store.queryRoutes({ scopeId, pageSize: 10 }).list;
            assert.equal(routes.length, 1);
            assert.equal(routes[0].nlriDetail.dqpn, 0);
            assert.equal(routes[0].nlriDetail.dqpnBits, 0);
            assert.deepEqual(store.db.pragma('foreign_key_check'), []);
        } finally {
            store.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
}

function label(value) {
    const raw = (value << 4) | 1;
    return Buffer.from([(raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255]);
}
function evpn(type, overrides = {}) {
    const o = {
        esi: Buffer.alloc(10),
        rd: builders.rd(65000, 1),
        tag: 100,
        mac: 'aabbccddee01',
        prefix: '198.51.100.0',
        gateway: '192.0.2.1',
        label: 100,
        ...overrides
    };
    const common = [o.rd, o.esi, u32(o.tag)];
    let body;
    if (type === 1) body = Buffer.concat([...common, label(o.label)]);
    if (type === 2)
        body = Buffer.concat([
            ...common,
            Buffer.from([48]),
            Buffer.from(o.mac, 'hex'),
            Buffer.from([32]),
            ip('192.0.2.1'),
            label(o.label),
            ...(o.secondLabel ? [label(o.secondLabel)] : [])
        ]);
    if (type === 3) body = Buffer.concat([o.rd, u32(o.tag), Buffer.from([32]), ip('192.0.2.1')]);
    if (type === 4) body = Buffer.concat([o.rd, o.esi, Buffer.from([32]), ip('192.0.2.1')]);
    if (type === 5) body = Buffer.concat([...common, Buffer.from([24]), ip(o.prefix), ip(o.gateway), label(o.label)]);
    const parsed = parseBgpPacket(
        builders.multiprotocolUpdate(25, 70, Buffer.concat([Buffer.from([type, body.length]), body]))
    );
    assert.equal(parsed.valid, true, parsed.error);
    return parsed.pathAttributes.find(item => item.mpReach).mpReach.nlri[0];
}
const evpnKey = (type, overrides, pathId = 0) =>
    createRouteKey({ afi: 25, safi: 70, nlri: evpn(type, overrides), pathId }).keyHex;
assert.equal(KEY_SCHEMA_VERSION, 3);
for (const type of [2, 5]) {
    const key = evpnKey(type);
    assert.equal(evpnKey(type, { esi: Buffer.alloc(10, 1) }), key);
    assert.equal(evpnKey(type, { label: 300 }), key);
    assert.notEqual(evpnKey(type, { rd: builders.rd(65000, 2) }), key);
    assert.notEqual(evpnKey(type, { tag: 101 }), key);
    assert.notEqual(evpnKey(type, {}, 88), key);
}
assert.equal(
    evpnKey(2, { secondLabel: 200 }),
    evpnKey(2),
    'optional second label changes encoded length, not route identity'
);
assert.notEqual(evpnKey(2, { mac: 'aabbccddee02' }), evpnKey(2));
assert.equal(evpnKey(5, { gateway: '192.0.2.2' }), evpnKey(5));
assert.equal(evpnKey(5, { prefix: '198.51.100.127' }), evpnKey(5), 'RT5 prefix key masks insignificant bits');
assert.notEqual(evpnKey(5, { prefix: '198.51.101.0' }), evpnKey(5));
for (const type of [1, 4])
    assert.notEqual(evpnKey(type, { esi: Buffer.alloc(10, 1) }), evpnKey(type), 'ESI remains an RT1/RT4 key');
assert.notEqual(evpnKey(3, { tag: 101 }), evpnKey(3));

// Framing is tested in memory: no listener, external network or database.
function framingHarness() {
    const h = harness('peer', 0, 0);
    let destroyed = 0;
    h.session.socket = {
        destroy() {
            destroyed += 1;
        }
    };
    const frames = [];
    h.session.processMessage = bytes => frames.push(bytes);
    return { ...h, frames, destroyed: () => destroyed };
}
const small = builders.bmpMessage(4, Buffer.from([0, 1, 0, 1, 65]), 3);
const fast = framingHarness();
const coalesced = Buffer.concat([small, small, small]);
fast.session.recvMsg(coalesced);
assert.equal(fast.frames.length, 3);
fast.frames.forEach(bytes => {
    assert.equal(bytes.buffer, coalesced.buffer);
    assert.deepEqual(bytes, small);
});
assert.equal(fast.session.bufferedMessageBytes, 0, 'complete frames retain no copied buffer');
const split = framingHarness();
for (let offset = 0; offset < small.length; offset += 1) split.session.recvMsg(small.subarray(offset, offset + 1));
assert.equal(split.frames.length, 1);
assert.deepEqual(split.frames[0], small);
assert.equal(split.session.bufferedMessageBytes, 0);
const large = builders.bmpMessage(4, Buffer.alloc(150000, 65), 3);
const blocks = framingHarness();
blocks.session.recvMsg(large.subarray(0, 70000));
assert.ok(blocks.session.bufferedMessageBytes >= 70000 && blocks.session.bufferedMessageBytes <= large.length);
assert.equal(blocks.session.messageBuffer.length, 70000);
blocks.session.initializationTimer = { privateHandle: true };
const snapshot = createIngestSnapshot(blocks.session);
assert.equal(snapshot.bufferedMessageBytes, blocks.session.bufferedMessageBytes);
assert.equal(Object.hasOwn(snapshot.session, 'messageBuffer'), false);
assert.equal(Object.hasOwn(snapshot.session, 'initializationTimer'), false);
const mirrorTimer = { keep: true };
const mirror = { initializationTimer: mirrorTimer };
applyIngestSnapshot(mirror, snapshot);
assert.equal(mirror.ingestBufferedMessageBytes, blocks.session.bufferedMessageBytes);
assert.equal(mirror.initializationTimer, mirrorTimer);
blocks.session.recvMsg(large.subarray(70000));
assert.equal(blocks.frames.length, 1);
assert.deepEqual(blocks.frames[0], large);
assert.equal(createIngestSnapshot(blocks.session).bufferedMessageBytes, 0);
const maxHeader = Buffer.concat([Buffer.from([3]), u32(16 * 1024 * 1024), Buffer.from([4])]);
const bounded = framingHarness();
bounded.session.recvMsg(maxHeader);
assert.equal(bounded.destroyed(), 0, 'a legal maximum frame can remain fragmented');
assert.equal(bounded.session.bufferedMessageBytes, 6, 'header-only input does not allocate the announced body');
bounded.session.closeSession();
assert.equal(bounded.session.bufferedMessageBytes, 0);
for (const header of [
    Buffer.concat([Buffer.from([3]), u32(16 * 1024 * 1024 + 1), Buffer.from([4])]),
    Buffer.from([3, 0, 0, 0, 5, 4]),
    Buffer.from([2, 0, 0, 0, 6, 4])
]) {
    const h = framingHarness();
    h.session.recvMsg(Buffer.concat([header, small]));
    assert.equal(h.destroyed(), 1);
    assert.equal(h.frames.length, 0);
    assert.equal(h.session.bufferedMessageBytes, 0);
    h.session.recvMsg(small);
    assert.equal(h.frames.length, 0, 'a closed connection cannot process another buffered frame');
    assert.deepEqual(h.failures, []);
}

console.log(
    'BMP protocol correctness tests passed (RFC OPEN order, ASN widths, length guards, EVPN keys, bounded framing)'
);
