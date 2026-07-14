const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BmpConst = require('../../electron/const/bmpConst');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const {
    buildScope,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const AFI_IPV4 = 1;
const AFI_IPV6 = 2;
const SAFI = 1;
const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-epoch-aging-'));
const store = new BmpPersistenceStore({ dbPath: path.join(tempDir, 'bmp.sqlite3') }).open();
let batchSequence = 0;

function apply(...mutations) {
    batchSequence += 1;
    return store.applyBatch({
        batchId: `epoch-aging-${batchSequence}`,
        createdAtMs: Date.now(),
        mutations
    });
}

function makeRoute(owner, afi, prefix, mask) {
    const route = new BmpBgpRoute(
        owner instanceof BmpBgpSession ? owner : null,
        owner instanceof BmpBgpInstance ? owner : null
    );
    Object.assign(route, {
        afi,
        safi: SAFI,
        ribType: owner instanceof BmpBgpInstance ? 'loc-rib' : RIB_TYPE,
        ip: prefix,
        mask,
        pathId: 0,
        rd: owner instanceof BmpBgpInstance ? owner.instanceRd : owner.sessionRd,
        nlriDetail: { prefix, length: mask, pathId: 0, rd: '0:0' }
    });
    route.assignRouteAttr({ origin: 'IGP', nextHop: afi === AFI_IPV4 ? '192.0.2.1' : '2001:db8::1' });
    route.markActive(owner.getRibEpoch(afi, SAFI, RIB_TYPE));
    return route;
}

try {
    const bmpSession = {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 50000,
        sysName: 'epoch-aging-router',
        bmpVersion: BmpConst.BMP_VERSION.V4,
        getBmpV4TlvDraft: () => BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20
    };
    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, {
        sessionType: BmpConst.BMP_PEER_TYPE.GLOBAL,
        sessionRd: '0:0',
        sessionRdRaw: 'raw:0000000000000000',
        sessionIp: '198.51.100.1',
        sessionAs: 64512
    });
    owner.ensureRouteScope(AFI_IPV4, SAFI, RIB_TYPE);

    const routeA = makeRoute(owner, AFI_IPV4, '203.0.113.0', 24);
    const routeB = makeRoute(owner, AFI_IPV4, '203.0.114.0', 24);
    const initialScope = buildScopeMutation(bmpSession, owner, AFI_IPV4, SAFI, RIB_TYPE, 'scope_open', {
        kind: 'peer',
        state: 'ready'
    });
    apply(
        initialScope,
        buildRouteUpsertMutation(bmpSession, owner, routeA, AFI_IPV4, SAFI, RIB_TYPE, {
            kind: 'peer',
            scopeState: 'ready'
        }),
        buildRouteUpsertMutation(bmpSession, owner, routeB, AFI_IPV4, SAFI, RIB_TYPE, {
            kind: 'peer',
            scopeState: 'ready'
        })
    );

    const scopeId = buildScope(bmpSession, owner, AFI_IPV4, SAFI, RIB_TYPE, { kind: 'peer' }).id;
    assert.deepEqual(store.queryScopeSummary({ scopeId }), {
        active: 2,
        stale: 0,
        total: 2,
        scopes: [
            {
                scopeId,
                sourceId: initialScope.source.id,
                connectionId: initialScope.connection.id,
                ownerKey: initialScope.scope.ownerKey,
                scopeKind: 'peer',
                afi: AFI_IPV4,
                safi: SAFI,
                ribType: String(RIB_TYPE),
                scopeState: 'ready',
                currentEpoch: 0,
                eorEpoch: null,
                staleReason: null,
                active: 2,
                stale: 0,
                total: 2
            }
        ]
    });

    owner.setRouteSummary(AFI_IPV4, SAFI, RIB_TYPE, { active: 2, stale: 0, total: 2 });
    const stale = owner.markRoutesStale(AFI_IPV4, SAFI, [RIB_TYPE], 'peer-up-refresh')[0];
    assert.deepEqual(stale, { afi: AFI_IPV4, safi: SAFI, ribType: RIB_TYPE, staleEpoch: 1, changed: 2 });
    apply(
        buildScopeMutation(bmpSession, owner, AFI_IPV4, SAFI, RIB_TYPE, 'scope_open', {
            kind: 'peer',
            state: 'syncing',
            reason: 'peer-up-refresh'
        })
    );
    assert.deepEqual(
        store.queryRoutes({ scopeId, routeState: 'all', pageSize: 10 }).list.map(route => route.routeState),
        ['stale', 'stale']
    );

    routeA.markActive(owner.getRibEpoch(AFI_IPV4, SAFI, RIB_TYPE));
    apply(
        buildRouteUpsertMutation(bmpSession, owner, routeA, AFI_IPV4, SAFI, RIB_TYPE, {
            kind: 'peer',
            scopeState: 'syncing'
        }),
        buildScopeMutation(bmpSession, owner, AFI_IPV4, SAFI, RIB_TYPE, 'scope_eor', {
            kind: 'peer',
            state: 'ready'
        })
    );
    const refreshed = store.queryRoutes({ scopeId, routeState: 'all', pageSize: 10 }).list;
    assert.equal(refreshed.find(route => route.ip === routeA.ip).routeState, 'active');
    assert.equal(refreshed.find(route => route.ip === routeB.ip).routeState, 'stale');
    assert.deepEqual(store.queryScopeSummary({ scopeId }).scopes[0], {
        ...store.queryScopeSummary({ scopeId }).scopes[0],
        scopeState: 'ready',
        currentEpoch: 1,
        eorEpoch: 1,
        active: 1,
        stale: 1,
        total: 2
    });

    const purged = store.purgeStaleRoutes({ scopeId, reason: 'eor-cleanup' });
    assert.equal(purged.purged, 1);
    assert.equal(purged.routes[0].ip, routeB.ip);
    assert.equal(purged.deltas[0].classification, 'purge');
    assert.deepEqual(store.queryScopeSummary({ scopeId }), {
        active: 1,
        stale: 0,
        total: 1,
        scopes: [
            {
                ...store.queryScopeSummary({ scopeId }).scopes[0],
                active: 1,
                stale: 0,
                total: 1
            }
        ]
    });

    const instance = new BmpBgpInstance(bmpSession);
    Object.assign(instance, {
        afi: AFI_IPV6,
        safi: SAFI,
        instanceType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        instanceRd: '0:0',
        instanceRdRaw: 'raw:0000000000000000',
        instanceIp: '0.0.0.0',
        instanceAs: 64512
    });
    const instanceRoute = makeRoute(instance, AFI_IPV6, '2001:db8::', 64);
    apply(
        buildScopeMutation(bmpSession, instance, AFI_IPV6, SAFI, 'loc-rib', 'scope_open', {
            kind: 'loc-rib',
            state: 'ready'
        }),
        buildRouteUpsertMutation(bmpSession, instance, instanceRoute, AFI_IPV6, SAFI, 'loc-rib', {
            kind: 'loc-rib',
            scopeState: 'ready'
        })
    );
    instance.setRouteSummary({ active: 1, stale: 0, total: 1 });
    assert.deepEqual(instance.markRoutesStale('loc-rib-peer-down'), { staleEpoch: 1, changed: 1 });
    apply(
        buildScopeMutation(bmpSession, instance, AFI_IPV6, SAFI, 'loc-rib', 'scope_stale', {
            kind: 'loc-rib',
            state: 'stale',
            reason: 'loc-rib-peer-down'
        })
    );
    const instanceScopeId = buildScope(bmpSession, instance, AFI_IPV6, SAFI, 'loc-rib', {
        kind: 'loc-rib'
    }).id;
    const persistedInstanceRoute = store.queryRoutes({ scopeId: instanceScopeId, routeState: 'all' }).list[0];
    assert.equal(persistedInstanceRoute.routeState, 'stale');
    assert.equal(persistedInstanceRoute.staleReason, 'loc-rib-peer-down');

    console.log('BMP SQLite epoch aging tests passed');
} finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
