const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const { builders } = require('../../scripts/mockBmpClient');

// Independent wire fixture: one label, RD 65000:1, and 2001:db8:100:9::/64.
const nlri = Buffer.from('9803e8010000fde80000000120010db801000009', 'hex');
const mappedNextHop = Buffer.from('000000000000000000000000000000000000ffffc0a8e401', 'hex');
const nativeNextHop = Buffer.from('000000000000000020010db8000000000000000000000001', 'hex');
const linkLocalNextHop = Buffer.from('0000000000000000fe800000000000000000000000000001', 'hex');
const fixtures = [
    [mappedNextHop, '::ffff:192.168.228.1'],
    [nativeNextHop, '2001:db8::1'],
    [Buffer.concat([mappedNextHop, linkLocalNextHop]), '::ffff:192.168.228.1, fe80::1']
];

function assertProjectedNextHop(store, kind, expected) {
    const query = { afi: 2, safi: 128, scopeKind: kind };
    const result = store.queryRoutes(query);
    assert.equal(result.total, 1);
    assert.equal(result.list[0].ip, '2001:db8:100:9::');
    assert.equal(result.list[0].mask, 64);
    assert.equal(result.list[0].rd, '65000:1');
    assert.equal(result.list[0].nextHop, expected, `${kind}: list must display the expected next hop`);
    for (const lean of [true, false]) {
        const streamed = [];
        store.streamRouteAssuranceRows({ ...query, lean }, chunk => streamed.push(...chunk));
        assert.equal(streamed.length, 1);
        assert.equal(streamed[0].nextHop, expected, `${kind}: lean=${lean} must display the same next hop`);
    }
    return result.list[0];
}

function verifyReceivedNextHop(kind, dbPath) {
    const mutations = [];
    const failures = [];
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
            enqueueRouteUpdateEvent() {},
            enqueueInstanceRouteUpdateEvent() {},
            invalidateRouteAssurance() {},
            requestPersistenceSweep() {}
        }
    );
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '192.0.2.10',
        remotePort: 55000
    });
    const addressFamilies = [{ afi: 2, safi: 128 }];
    const peer =
        kind === 'loc-rib'
            ? { peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB, flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED }
            : {};
    session.processMessage(builders.initiationMessage({ sysName: `vpnv6-next-hop-${kind}` }));
    session.processMessage(
        builders.bmpMessage(
            BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
            (kind === 'loc-rib' ? builders.locRibPeerUpPayload : builders.peerUpPayload)({
                recvAddressFamilies: addressFamilies,
                sendAddressFamilies: addressFamilies
            })
        )
    );
    const store = new BmpPersistenceStore({ dbPath }).open();
    try {
        fixtures.forEach(([nextHop, expected], index) => {
            const before = mutations.length;
            session.processMessage(
                builders.routeMonitoringMessage(peer, builders.multiprotocolUpdate(2, 128, nlri, { nextHop }))
            );
            assert.deepEqual(failures, []);
            const upserts = mutations
                .slice(before)
                .filter(mutation => mutation.eventType === 'upsert' && mutation.route);
            assert.equal(upserts.length, 1, `${kind}: one VPNv6 route must be received`);
            assert.equal(JSON.parse(upserts[0].route.attrJson).nextHop, expected);
            store.applyBatch({ batchId: `vpnv6-next-hop-${kind}-${index}`, mutations: mutations.splice(0) });
            assertProjectedNextHop(store, kind, expected);
        });

        // Simulate attributes written by an older parser. Reading and reopening
        // must improve mapped display without rewriting persisted attributes.
        const attrId = store.queryRoutes({ afi: 2, safi: 128, scopeKind: kind }).list[0].attrId;
        const attr = JSON.parse(
            store.db.prepare('SELECT attr_json FROM bmp_route_attributes WHERE attr_id = ?').get(attrId).attr_json
        );
        for (const [stored, expected] of [
            ['::ffff:c0a8:e401', '::ffff:192.168.228.1'],
            ['::ffff:c0a8:e401, fe80::1', '::ffff:192.168.228.1, fe80::1'],
            ['2001:0DB8::1', '2001:0DB8::1'],
            ['2001:db8::ffff', '2001:db8::ffff'],
            ['192.168.228.1', '192.168.228.1'],
            ['invalid::ffff', 'invalid::ffff']
        ]) {
            const attrJson = JSON.stringify({ ...attr, nextHop: stored });
            store.db.prepare('UPDATE bmp_route_attributes SET attr_json = ? WHERE attr_id = ?').run(attrJson, attrId);
            store.close();
            store.open();
            assertProjectedNextHop(store, kind, expected);
            assert.equal(
                store.db.prepare('SELECT attr_json FROM bmp_route_attributes WHERE attr_id = ?').get(attrId).attr_json,
                attrJson,
                'display formatting must not rewrite stored attributes'
            );
        }
    } finally {
        store.close();
    }
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmp-vpnv6-next-hop-'));
try {
    for (const kind of ['peer', 'loc-rib']) {
        verifyReceivedNextHop(kind, path.join(directory, `${kind}.sqlite3`));
    }
    console.log('BMP VPNv6 mapped next-hop receive and persistence tests passed');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
