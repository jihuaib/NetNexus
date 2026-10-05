const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { buildRouteUpsertMutation } = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { builders } = require('../../scripts/mockBmpClient');

// These probes exercise real wire parsing and real mutation construction, not
// an attribute-store mock. A SHA count is deterministic and is not a timing test.
function countAttributeHashes(callback) {
    const original = crypto.createHash;
    let count = 0;
    crypto.createHash = function (...args) {
        const hash = original.apply(this, args);
        const update = hash.update;
        hash.update = function (value, ...options) {
            if (
                args[0] === 'sha256' &&
                typeof value === 'string' &&
                value.startsWith('{"origin":') &&
                value.includes('"nextHop":')
            ) {
                count += 1;
            }
            return update.call(this, value, ...options);
        };
        return hash;
    };
    try {
        const result = callback();
        return { result, count };
    } finally {
        crypto.createHash = original;
    }
}

function makeHarness(kind) {
    const mutations = [];
    const routes = [];
    const failures = [];
    const worker = {
        bmpConfigData: { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 },
        persistence: {},
        enqueuePersistenceMutation(mutation) {
            mutations.push(mutation);
            return true;
        },
        handlePersistenceFailure(error) {
            failures.push(error);
        },
        enqueueRouteUpdateEvent() {},
        enqueueInstanceRouteUpdateEvent() {},
        invalidateRouteAssurance() {},
        requestPersistenceSweep() {}
    };
    const session = new BmpSession({ sendEvent() {} }, worker);
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '192.0.2.10',
        remotePort: 55000,
        connectionId: `attribute-reuse-${kind}`,
        connectionGeneration: 1,
        openedAtMs: 1719811200000
    });
    ['persistSessionRouteUpsert', 'persistInstanceRouteUpsert'].forEach(name => {
        const original = session[name];
        session[name] = function (owner, route, ...args) {
            routes.push({ owner, route, args });
            return original.call(this, owner, route, ...args);
        };
    });
    const addressFamilies = [
        { afi: 1, safi: 1 },
        { afi: 2, safi: 1 },
        { afi: 25, safi: 70 },
        { afi: 1, safi: 133 }
    ];
    const peer =
        kind === 'loc-rib'
            ? { peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB, flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED }
            : {};
    session.processMessage(builders.initiationMessage({ sysName: `attribute-reuse-${kind}` }));
    session.processMessage(
        builders.bmpMessage(
            BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
            kind === 'loc-rib'
                ? builders.locRibPeerUpPayload({
                      recvAddressFamilies: addressFamilies,
                      sendAddressFamilies: addressFamilies
                  })
                : builders.peerUpPayload({ recvAddressFamilies: addressFamilies, sendAddressFamilies: addressFamilies })
        )
    );
    assert.deepEqual(failures, []);
    return {
        session,
        send(update, options) {
            mutations.length = 0;
            routes.length = 0;
            const measured = countAttributeHashes(() =>
                session.processMessage(builders.routeMonitoringMessage(peer, update, options))
            );
            assert.deepEqual(failures, []);
            return {
                hashes: measured.count,
                mutations: mutations.filter(mutation => mutation.route),
                records: routes.slice()
            };
        }
    };
}

function assertOneAttribute(result, expectedRoutes) {
    assert.equal(result.hashes, 1, `${expectedRoutes} NLRI must serialize/hash their shared attributes once`);
    assert.equal(result.mutations.length, expectedRoutes);
    assert.equal(result.records.length, expectedRoutes);
    const shared = result.records[0].route.getImmutableRouteAttr();
    assert.ok(shared && Object.isFrozen(shared));
    result.records.forEach(({ route }) => assert.equal(route.getImmutableRouteAttr(), shared));
    result.mutations.forEach(mutation => {
        assert.equal(mutation.route.attrId, result.mutations[0].route.attrId);
        assert.equal(mutation.route.attrJson, result.mutations[0].route.attrJson);
    });
}

function indexedTlv(type, index, value) {
    return Buffer.concat([builders.u16(type), builders.u16(value.length), builders.u16(index), value]);
}

function mpReachAttribute(packet) {
    const end = 23 + packet.readUInt16BE(21);
    for (let position = 23; position < end; ) {
        const headerLength = packet[position] & 0x10 ? 4 : 3;
        const length = headerLength === 4 ? packet.readUInt16BE(position + 2) : packet[position + 2];
        const next = position + headerLength + length;
        if (packet[position + 1] === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI) return packet.subarray(position, next);
        position = next;
    }
    throw new Error('MP_REACH attribute missing from fixture');
}

function mixedUpdate() {
    const ipv4 = builders.ipv4Update(['203.0.113.0', '203.0.114.0'], { nextHop: '192.0.2.1' });
    const ipv6Nlri = Buffer.concat([
        Buffer.from('4020010db800010000', 'hex'),
        Buffer.from('4020010db800020000', 'hex')
    ]);
    const mp = builders.multiprotocolUpdate(2, 1, ipv6Nlri, { nextHop: '2001:db8::1' });
    const ipv4AttrEnd = 23 + ipv4.readUInt16BE(21);
    const attrs = Buffer.concat([ipv4.subarray(23, ipv4AttrEnd), mpReachAttribute(mp)]);
    const body = Buffer.concat([builders.u16(0), builders.u16(attrs.length), attrs, ipv4.subarray(ipv4AttrEnd)]);
    return Buffer.concat([
        Buffer.alloc(16, 0xff),
        builders.u16(body.length + 19),
        Buffer.from([BgpConst.BGP_PACKET_TYPE.UPDATE]),
        body
    ]);
}

function evpnNlri(sequence, label) {
    const rawLabel = (label << 4) | 1;
    const body = Buffer.concat([
        Buffer.from('0000fde800000001', 'hex'),
        Buffer.alloc(10),
        builders.u32(100),
        Buffer.from([48]),
        Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, sequence]),
        Buffer.from([32, 192, 0, 2, sequence]),
        Buffer.from([(rawLabel >> 16) & 0xff, (rawLabel >> 8) & 0xff, rawLabel & 0xff])
    ]);
    return Buffer.concat([Buffer.from([2, body.length]), body]);
}

for (const kind of ['peer', 'loc-rib']) {
    const harness = makeHarness(kind);
    const prefixes = Array.from({ length: 64 }, (_, index) => `10.1.${index}.0`);
    const update = builders.ipv4Update(prefixes, { nextHop: '192.0.2.1', communities: ['65000:1'] });
    const first = harness.send(update);
    assertOneAttribute(first, prefixes.length);
    const repeated = harness.send(update);
    assertOneAttribute(repeated, prefixes.length);
    assert.deepEqual(
        repeated.mutations.map(item => item.route.id),
        first.mutations.map(item => item.route.id)
    );
    assert.equal(repeated.mutations[0].route.attrId, first.mutations[0].route.attrId);
    assert.ok(
        repeated.mutations[0].sequence > first.mutations.at(-1).sequence,
        'repeat announcements still refresh durable route state'
    );
    const changed = harness.send(builders.ipv4Update(prefixes, { nextHop: '192.0.2.2', communities: ['65000:2'] }));
    assertOneAttribute(changed, prefixes.length);
    assert.notEqual(changed.mutations[0].route.attrId, first.mutations[0].route.attrId);

    const mixed = harness.send(mixedUpdate());
    assert.equal(mixed.hashes, 2);
    assert.equal(mixed.mutations.length, 4);
    const groups = [1, 2].map(afi => mixed.records.filter(record => record.route.afi === afi));
    groups.forEach(group => {
        assert.equal(group.length, 2);
        assert.equal(group[0].route.getImmutableRouteAttr(), group[1].route.getImmutableRouteAttr());
    });
    assert.notEqual(groups[0][0].route.getImmutableRouteAttr(), groups[1][0].route.getImmutableRouteAttr());
    assert.equal(groups[0][0].route.nextHop, '192.0.2.1');
    assert.equal(groups[1][0].route.nextHop, '2001:db8::1');
    mixed.mutations.forEach(mutation =>
        assert.equal(
            JSON.parse(mutation.route.attrJson).nextHop,
            mutation.route.afi === 1 ? '192.0.2.1' : '2001:db8::1'
        )
    );

    const decorated = harness.send(builders.ipv4Update(prefixes.slice(0, 2)), {
        routeTlvs: [
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
                1,
                builders.u32(BmpConst.BMP_PATH_STATUS.BEST)
            ),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
                2,
                builders.u32(BmpConst.BMP_PATH_STATUS.PRIMARY)
            ),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.SEQUENCE_NUMBER, 1, builders.u32(101)),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.SEQUENCE_NUMBER, 2, builders.u32(202))
        ]
    });
    assertOneAttribute(decorated, 2);
    assert.equal(decorated.records[0].route.pathStatus, BmpConst.BMP_PATH_STATUS.BEST);
    assert.equal(decorated.records[1].route.pathStatus, BmpConst.BMP_PATH_STATUS.PRIMARY);
    assert.notEqual(decorated.records[0].route.routeTlvs, decorated.records[1].route.routeTlvs);
    assert.notEqual(decorated.mutations[0].route.routeJson, decorated.mutations[1].route.routeJson);

    const evpn = harness.send(
        builders.multiprotocolUpdate(25, 70, Buffer.concat([evpnNlri(10, 100), evpnNlri(11, 200)]), {
            nextHop: '192.0.2.1'
        })
    );
    assertOneAttribute(evpn, 2);
    assert.notEqual(evpn.mutations[0].route.id, evpn.mutations[1].route.id);
    assert.notEqual(evpn.records[0].route.labels, evpn.records[1].route.labels);
    assert.notEqual(evpn.mutations[0].route.routeJson, evpn.mutations[1].route.routeJson);
    const flowSpec = harness.send(
        builders.multiprotocolUpdate(1, 133, Buffer.from([5, 1, 24, 192, 0, 2, 5, 1, 24, 198, 51, 100]))
    );
    assertOneAttribute(flowSpec, 2);
    assert.notEqual(flowSpec.mutations[0].route.id, flowSpec.mutations[1].route.id);

    // Shared inline attributes are internal; public getters/setters remain
    // isolated snapshots/copy-on-write and invalidate any old attribute id.
    const [record, sibling] = first.records;
    const shared = sibling.route.getImmutableRouteAttr();
    const copy = sibling.route.getRouteAttr();
    copy.nextHop = '203.0.113.99';
    assert.equal(sibling.route.nextHop, '192.0.2.1');
    record.route.attrId = first.mutations[0].route.attrId;
    record.route.nextHop = '192.0.2.99';
    assert.equal(record.route.attrId, null);
    assert.equal(record.route.getImmutableRouteAttr(), null);
    assert.equal(sibling.route.getImmutableRouteAttr(), shared);
    assert.equal(sibling.route.nextHop, '192.0.2.1');
    const mutation = countAttributeHashes(() =>
        buildRouteUpsertMutation(
            harness.session,
            record.owner,
            record.route,
            record.route.afi,
            record.route.safi,
            kind === 'peer' ? record.args[2] : 'loc-rib',
            { kind, scopeState: 'ready' }
        )
    );
    assert.equal(mutation.count, 1);
    assert.notEqual(mutation.result.route.attrId, first.mutations[0].route.attrId);
}

// Keep the public two-argument API correct even when an external caller edits
// and reuses a parsed UPDATE object between calls.
const publicSession = makeHarness('peer').session;
const parsedPacket = parseBgpPacket(builders.ipv4Update(['203.0.113.0'], { nextHop: '192.0.2.1' }));
const publicRoute = new BmpBgpRoute(null, null);
publicSession.setRouteAttributes(publicRoute, parsedPacket);
assert.equal(publicRoute.nextHop, '192.0.2.1');
parsedPacket.pathAttributes.find(attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.NEXT_HOP).nextHop = '192.0.2.2';
publicSession.setRouteAttributes(publicRoute, parsedPacket);
assert.equal(publicRoute.nextHop, '192.0.2.2');
assert.throws(() => publicRoute.assignSharedRouteAttr({ nextHop: '192.0.2.1' }), /immutable/);
console.log('BMP ingest attribute reuse tests passed (64 NLRI -> 1 attribute hash, Peer + Loc-RIB)');
