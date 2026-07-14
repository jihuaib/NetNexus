const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { buildScenario, parseArgs } = require('../../scripts/mockBmpClient');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-mock-loc-rib-'));
const store = new BmpPersistenceStore({ dbPath: path.join(tempDir, 'bmp.sqlite3') }).open();
const persistenceFailures = [];
let batchSequence = 0;

try {
    const bmpWorker = {
        bmpSessionMap: new Map(),
        bmpConfigData: {
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20
        },
        persistence: store,
        enqueuePersistenceMutation(mutation) {
            batchSequence += 1;
            store.applyBatch({
                batchId: `mock-loc-rib-${batchSequence}`,
                createdAtMs: Date.now(),
                mutations: [mutation]
            });
            return true;
        },
        handlePersistenceFailure(error) {
            persistenceFailures.push(error);
        },
        enqueueRouteUpdateEvent() {},
        enqueueInstanceRouteUpdateEvent() {},
        invalidateRouteAssurance() {},
        requestPersistenceSweep() {}
    };
    const session = new BmpSession({ sendEvent() {} }, bmpWorker);
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '127.0.0.2',
        remotePort: 50000
    });

    const options = parseArgs(['--routes', '1', '--interval', '0', '--no-dump-packets']);
    buildScenario(options).forEach(message => session.processMessage(message.data));
    assert.deepEqual(persistenceFailures, []);

    const defaultIpv4Instance = Array.from(session.bgpInstanceMap.values()).find(
        instance =>
            instance.instanceType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB &&
            instance.instanceRd === '0:0' &&
            Number(instance.afi) === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            Number(instance.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    );
    assert.ok(defaultIpv4Instance, 'mock scenario should create the default-RD IPv4 Loc-RIB instance');
    assert.equal(
        defaultIpv4Instance.enabledAddressFamilies.some(
            family =>
                Number(family.afi) === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
                Number(family.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ),
        true,
        'the later default-RD EVPN Peer Up must retain IPv4 unicast in its full AF snapshot'
    );
    assert.equal(
        defaultIpv4Instance.enabledAddressFamilies.some(
            family =>
                Number(family.afi) === BgpConst.BGP_AFI_TYPE.AFI_L2VPN &&
                Number(family.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN
        ),
        true,
        'the full default-RD Loc-RIB snapshot must also advertise EVPN'
    );

    const scopeId = session.getPersistenceScopeId(
        defaultIpv4Instance,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        'loc-rib',
        'loc-rib'
    );
    const expectedRouteCount = Math.max(8, Math.min(25, options.routes)) + 2;
    const summary = store.queryScopeSummary({ scopeId });
    assert.equal(summary.scopes.length, 1);
    assert.equal(summary.scopes[0].scopeState, 'ready');
    assert.equal(summary.scopes[0].eorEpoch, summary.scopes[0].currentEpoch);
    assert.equal(summary.scopes[0].staleReason, null);
    assert.deepEqual(
        { active: summary.active, stale: summary.stale, total: summary.total },
        { active: expectedRouteCount, stale: 0, total: expectedRouteCount }
    );

    const routes = store.queryRoutes({ scopeId, routeState: 'all', pageSize: 5000 });
    assert.equal(routes.total, expectedRouteCount);
    assert.equal(
        routes.list.every(route => route.routeState === BmpConst.BMP_ROUTE_STATE.ACTIVE),
        true,
        'default-RD IPv4 Loc-RIB routes produced by the real mock scenario must remain active'
    );
    assert.equal(
        routes.list.every(
            route =>
                route.ribEpoch === summary.scopes[0].currentEpoch &&
                route.persistentConnectionId === summary.scopes[0].connectionId
        ),
        true,
        'the completed scope must not expose routes from an older epoch or connection'
    );
    assert.ok(routes.list.some(route => route.ip === '10.30.0.0'));
    assert.ok(routes.list.some(route => route.ip === '198.51.101.0'));
    assert.ok(routes.list.some(route => route.ip === '198.51.102.0'));

    const staleRemovalEvents = store
        .queryEvents({ scopeId, pageSize: 5000 })
        .list.filter(event => event.reason === 'peer-up-af-removed');
    assert.equal(staleRemovalEvents.length, 0);

    console.log(
        `BMP mock Loc-RIB lifecycle regression passed: active=${summary.active}, stale=${summary.stale}, scope=${summary.scopes[0].scopeState}`
    );
} finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
