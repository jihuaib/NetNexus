const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { canonicalizeBmpRouteAttr } = require('../../electron/worker/bmp/bmpRouteAttrStore');
const { reconstructLegacyAsPath } = require('../../electron/utils/bgp/bgpAsPath');
const { parseBmpPacket, getBmpPacketSummary } = require('../../electron/utils/bmp/bmpPacketParser');
const { builders: b } = require('../../scripts/mockBmpClient');

function harness(locRib = false, families = null) {
    const mutations = [],
        events = [],
        updates = [];
    const session = new BmpSession(
        { sendEvent: (...args) => events.push(args) },
        {
            bmpConfigData: { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 },
            persistence: {},
            enqueuePersistenceMutation(mutation) {
                mutations.push(mutation);
                return true;
            },
            handlePersistenceFailure(error) {
                throw error;
            },
            invalidateRouteAssurance() {},
            requestPersistenceSweep() {},
            enqueueRouteUpdateEvent: update => updates.push(update),
            enqueueInstanceRouteUpdateEvent: update => updates.push(update)
        }
    );
    Object.assign(session, { remoteIp: '192.0.2.10', remotePort: 50000, localIp: '127.0.0.1', localPort: 1790 });
    session.processMessage(b.initiationMessage({ sysName: 'protocol-review-fixture' }));
    const payload = locRib ? b.locRibPeerUpPayload : b.peerUpPayload;
    const up = options => b.bmpMessage(3, payload(options), 4);
    session.processMessage(up(families ? { recvAddressFamilies: families, sendAddressFamilies: families } : {}));
    const header = payload().subarray(0, 42);
    const owner = () => [...(locRib ? session.bgpInstanceMap : session.bgpSessionMap).values()][0];
    const clear = () => {
        mutations.length = 0;
        events.length = 0;
        updates.length = 0;
    };
    clear();
    return { session, mutations, events, updates, header, owner, up, clear };
}

// Diagnostic rejection must survive the parsed common header's valid flag.
for (const hex of ['030000000604', '040000000504', '040000001004']) {
    const result = parseBmpPacket(Buffer.from(hex, 'hex'));
    assert.equal(result.valid, false);
    assert.match(getBmpPacketSummary(result), /^Invalid BMP packet:/);
}

for (const locRib of [false, true]) {
    const h = harness(locRib);
    const invalidDownBodies = [
        Buffer.alloc(0), // Missing reason.
        Buffer.from([0]), // Reserved reason.
        Buffer.from([2]), // Missing FSM event code.
        Buffer.from([2, 0]), // Partial FSM event code.
        Buffer.concat([Buffer.from([1]), Buffer.alloc(18, 255)]), // Partial Notification.
        Buffer.concat([Buffer.from([4]), Buffer.from([0])]) // Truncated v4 TLV / v3 trailing byte.
    ];
    for (const version of [3, 4]) {
        for (const body of invalidDownBodies) {
            h.session.processMessage(b.bmpMessage(2, Buffer.concat([h.header, body]), version));
            assert.equal(h.owner()[locRib ? 'instanceState' : 'sessionState'], BmpConst.BMP_SESSION_STATE.PEER_UP);
            assert.equal(h.mutations.length, 0, 'invalid Peer Down must not persist a state transition');
            assert.equal(h.events.length, 0);
            assert.equal(h.updates.length, 0);
        }
    }
    h.session.processMessage(b.bmpMessage(2, Buffer.concat([h.header, Buffer.from([4])]), 4));
    assert.equal(h.owner()[locRib ? 'instanceState' : 'sessionState'], BmpConst.BMP_SESSION_STATE.PEER_DOWN);
    assert.ok(h.mutations.some(mutation => mutation.eventType === 'scope_stale'));

    const stats = harness(locRib);
    const map = locRib ? stats.session.bgpInstanceStatisticsReportMap : stats.session.bgpStatisticsReportMap;
    const records = Buffer.concat([b.u32(1), b.u16(0), b.u16(4), b.u32(7)]);
    const tlv = value => Buffer.concat([b.u16(BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS), b.u16(value.length), value]);
    for (const version of [3, 4]) {
        const send = value =>
            stats.session.processMessage(
                b.bmpMessage(1, Buffer.concat([stats.header, version === 4 ? tlv(value) : value]), version)
            );
        send(records);
        const validReports = [...map.values()];
        assert.equal(validReports[0].statistics[0].value, 7);
        stats.clear();
        for (const invalid of [
            Buffer.alloc(0),
            records.subarray(0, 3),
            records.subarray(0, records.length - 1),
            Buffer.concat([records, Buffer.from([0])])
        ]) {
            send(invalid);
            assert.deepEqual([...map.values()], validReports, 'invalid statistics must preserve the previous report');
            assert.equal(stats.mutations.length, 0);
            assert.equal(stats.events.length, 0);
        }
        send(Buffer.concat([b.u32(1), b.u16(0x7ffe), b.u16(3), Buffer.from([1, 2, 3])]));
        assert.equal([...map.values()][0].statistics[0].type, 0x7ffe);
        assert.equal(
            [...map.values()][0].statistics[0].valueHex,
            '010203',
            'complete unknown statistics retain raw bytes'
        );
        send(b.u32(0));
        assert.equal([...map.values()][0].statistics.length, 0, 'a complete zero-count report is valid');
        stats.clear();
    }
}

const families = [
    { afi: 1, safi: 1, addPathMode: 3 },
    { afi: 2, safi: 1, addPathMode: 3 }
];
const multi = harness(true, families);
const instances = [...multi.session.bgpInstanceMap.values()];
const ipv4 = instances.find(instance => instance.afi === 1),
    ipv6 = instances.find(instance => instance.afi === 2);
assert.notEqual(ipv4.recvAddPathMap, ipv6.recvAddPathMap);
assert.notEqual(ipv4.sendAddPathMap, ipv6.sendAddPathMap);
multi.session.processMessage(
    multi.up({ recvAddressFamilies: families.slice(0, 1), sendAddressFamilies: families.slice(0, 1) })
);
assert.equal(ipv6.recvAddPathMap.get('2|1'), 3);
assert.equal(ipv6.sendAddPathMap.get('2|1'), 3);
assert.equal(ipv6.isAddPathReceiveEnabled(2, 1), true);

const { BGP_AS_PATH_TYPE: T } = BgpConst;
const seg = (type, ...asNumbers) => ({ type, asNumbers });
assert.deepEqual(reconstructLegacyAsPath([seg(T.AS_SEQUENCE, 65000, 23456)], [seg(T.AS_SEQUENCE, 70000)]), [
    seg(T.AS_SEQUENCE, 65000),
    seg(T.AS_SEQUENCE, 70000)
]);
assert.deepEqual(
    reconstructLegacyAsPath([seg(T.AS_SET, 65000, 65001), seg(T.AS_SEQUENCE, 23456)], [seg(T.AS_SEQUENCE, 70000)]),
    [seg(T.AS_SET, 65000, 65001), seg(T.AS_SEQUENCE, 70000)]
);
const confed = seg(T.AS_CONFED_SEQUENCE, 64512);
assert.deepEqual(reconstructLegacyAsPath([confed, seg(T.AS_SEQUENCE, 23456)], [seg(T.AS_SEQUENCE, 70000)]), [
    confed,
    seg(T.AS_SEQUENCE, 70000)
]);
assert.deepEqual(
    reconstructLegacyAsPath([seg(T.AS_SEQUENCE, 23456)], [seg(T.AS_SEQUENCE, 70000, 80000)]),
    [seg(T.AS_SEQUENCE, 23456)],
    'longer AS4_PATH is ignored'
);
assert.deepEqual(
    reconstructLegacyAsPath([seg(T.AS_SEQUENCE, 23456)], [confed, seg(T.AS_SEQUENCE, 70000)]),
    [seg(T.AS_SEQUENCE, 70000)],
    'AS4 confederation segments are discarded'
);

const attr = (code, value, flags = 0x40) => Buffer.concat([Buffer.from([flags, code, value.length]), value]);
function as4Update(asnSize, aggregator = null) {
    const number = asnSize === 2 ? b.u16 : b.u32;
    const attrs = Buffer.concat([
        attr(1, Buffer.from([0])),
        attr(2, Buffer.concat([Buffer.from([2, 2]), number(65000), number(23456)])),
        attr(17, Buffer.concat([Buffer.from([2, 1]), b.u32(70000)]), 0xc0),
        attr(3, b.ip('192.0.2.254')),
        ...(aggregator === null
            ? []
            : [
                  attr(7, Buffer.concat([b.u16(aggregator), b.ip('192.0.2.1')]), 0xc0),
                  attr(18, Buffer.concat([b.u32(70000), b.ip('192.0.2.1')]), 0xc0)
              ])
    ]);
    const body = Buffer.concat([b.u16(0), b.u16(attrs.length), attrs, Buffer.from([24, 203, 0, 113])]);
    return Buffer.concat([Buffer.alloc(16, 255), b.u16(19 + body.length), Buffer.from([2]), body]);
}
const as4 = harness();
for (const [width, aggregator, expected] of [
    [2, null, '65000 70000'],
    [4, null, '65000 23456'],
    [2, 65000, '65000 23456'],
    [2, 23456, '65000 70000']
]) {
    for (const version of [3, 4]) {
        as4.clear();
        const flags = width === 2 ? 0x20 : 0;
        const packet = as4Update(width, aggregator);
        as4.session.processMessage(
            version === 4
                ? b.routeMonitoringMessage({ flags }, packet)
                : b.bmpMessage(0, Buffer.concat([b.peerUpPayload({ flags }).subarray(0, 42), packet]), 3)
        );
        const mutation = as4.mutations.find(item => item.route);
        assert.ok(mutation, 'valid legacy UPDATE must reach persistence');
        const attrs = JSON.parse(mutation.route.attrJson);
        assert.equal(attrs.asPath, expected);
        assert.equal(attrs.wireAsPath, '65000 23456');
        assert.equal(attrs.as4Path, '70000');
    }
}
assert.equal(
    Object.hasOwn(canonicalizeBmpRouteAttr({ asPath: '65000' }), 'as4Path'),
    false,
    'ordinary UPDATE attribute DTO/hash is unchanged'
);

if (process.versions.electron) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-as4-review-'));
    const store = new Store({ dbPath: path.join(directory, 'client.sqlite3') });
    try {
        store.open();
        store.applyBatch({ batchId: 'legacy-as4', createdAtMs: Date.now(), mutations: as4.mutations });
        const route = store.queryRoutes({ scopeId: as4.mutations.find(item => item.route).scope.id, pageSize: 10 })
            .list[0];
        assert.equal(route.asPath, '65000 70000');
        assert.equal(route.wireAsPath, '65000 23456');
        assert.equal(route.as4Path, '70000', 'AS4_PATH survives SQLite roundtrip and detail projection');
    } finally {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

console.log(
    'BMP protocol review regressions passed (malformed lifecycle/statistics, independent AF maps, parser rejection, legacy AS4 paths)'
);
