const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BmpConst = require('../../electron/const/bmpConst');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-assurance-worker-'));
const store = new BmpPersistenceStore({ dbPath: path.join(tempDir, 'bmp.sqlite3') }).open();
const responses = [];
const persistenceQueries = [];

const bmpSession = {
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.1',
    remotePort: 50000,
    sysName: 'cache-router',
    sysDesc: 'Route Assurance SQLite worker cache test',
    bmpVersion: 4,
    getBmpV4TlvDraft: () => 20
};
const owner = new BmpBgpSession(bmpSession);
Object.assign(owner, {
    sessionType: BmpConst.BMP_PEER_TYPE.GLOBAL,
    sessionRd: '0:0',
    sessionIp: '198.51.100.1',
    sessionAs: 65001,
    vrfTableNames: ['worker-cache']
});

function makeRoute(prefix, pathId) {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        rd: '0:0',
        ip: prefix,
        mask: 24,
        pathId,
        nlriDetail: { prefix, length: 24, pathId, rd: '0:0' }
    });
    route.assignRouteAttr({
        origin: 'IGP',
        asPath: '65001',
        nextHop: '192.0.2.254',
        localPref: 100,
        med: 0,
        communities: []
    });
    route.setRouteTlvs([{ name: 'VRF/Table Name', value: 'worker-cache' }]);
    route.markActive(owner.getRibEpoch(1, 1, BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN));
    return route;
}

function applyBatch(batchId, mutations) {
    return store.applyBatch({ batchId, createdAtMs: Date.now(), mutations });
}

const preRouteA = makeRoute('203.0.113.0', 1);
const preRouteB = makeRoute('203.0.114.0', 2);
applyBatch('seed-pre-in', [
    buildConnectionMutation(bmpSession, 'connection_open'),
    buildScopeMutation(bmpSession, owner, 1, 1, BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, 'scope_open', {
        kind: 'peer',
        state: 'syncing'
    }),
    buildRouteUpsertMutation(bmpSession, owner, preRouteA, 1, 1, BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, {
        kind: 'peer',
        scopeState: 'syncing'
    }),
    buildRouteUpsertMutation(bmpSession, owner, preRouteB, 1, 1, BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, {
        kind: 'peer',
        scopeState: 'syncing'
    })
]);

const worker = Object.create(BmpWorker.prototype);
Object.assign(worker, {
    bmpSessionMap: new Map(),
    persistenceFailure: null,
    persistenceReader: null,
    routeAssuranceService: new BmpRouteAssuranceService(),
    routeAssuranceFilters: {},
    routeAssuranceRebuildTimer: null,
    // Rebuilds are debounced until the writer is quiet; keep the wait short here.
    routeAssuranceRebuildQuietMs: 10,
    persistence: {
        async fence() {},
        async queryRoutes(query) {
            persistenceQueries.push({ ...query });
            // Force small real-SQLite pages so cursor traversal is observable.
            return store.queryRoutes({ ...query, pageSize: Math.min(1, Number(query.pageSize) || 1) });
        }
    },
    messageHandler: {
        sendSuccessResponse(messageId, data, msg) {
            responses.push({ messageId, data, msg });
        },
        sendErrorResponse(messageId, msg) {
            throw new Error(`${messageId}: ${msg}`);
        }
    }
});

async function waitForRouteAssuranceRebuild() {
    await new Promise(resolve => setTimeout(resolve, 30));
    if (worker.routeAssuranceService.bootstrapPromise) {
        await worker.routeAssuranceService.bootstrapPromise;
    }
}

async function verifyWorkerCache() {
    await worker.getRouteAssurance('first', { page: 1, pageSize: 25 });
    assert.equal(responses[0].data.summary.categoryCounts['inbound-gap'], 2);
    assert.equal(responses[0].data.summary.cacheHit, true);
    assert.equal(worker.routeAssuranceService.getStatus().dataMode, 'persisted');
    assert.equal(persistenceQueries.length, 2, 'initial bootstrap must consume both SQLite cursor pages');
    assert.equal(persistenceQueries[0].cursor, null);
    assert.ok(persistenceQueries[1].cursor);

    await worker.getRouteAssurance('second', { page: 1, pageSize: 25 });
    assert.equal(responses[1].data.summary.cacheHit, true);
    assert.equal(persistenceQueries.length, 2, 'same analysis query must reuse the persisted snapshot');

    const postRoute = makeRoute('203.0.113.0', 1);
    const committedPostIn = applyBatch('commit-post-in', [
        buildScopeMutation(bmpSession, owner, 1, 1, BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, 'scope_open', {
            kind: 'peer',
            state: 'syncing'
        }),
        buildRouteUpsertMutation(bmpSession, owner, postRoute, 1, 1, BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, {
            kind: 'peer',
            scopeState: 'syncing'
        })
    ]);
    assert.equal(committedPostIn.deltas.length, 1);
    const revisionBeforeDelta = worker.routeAssuranceService.getStats().dataRevision;
    worker.handleCommittedPersistenceResult(committedPostIn);
    assert.equal(worker.routeAssuranceService.getStats().dataRevision, revisionBeforeDelta + 1);

    await worker.getRouteAssurance('after-committed-delta', { page: 1, pageSize: 25 });
    assert.equal(responses[2].data.summary.categoryCounts['inbound-gap'], 1);
    assert.equal(responses[2].data.summary.categoryCounts['not-selected'], 1);
    assert.equal(persistenceQueries.length, 2, 'committed route delta must update the cache without rescanning SQLite');

    applyBatch('post-in-scope-stale', [
        buildScopeMutation(bmpSession, owner, 1, 1, BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, 'scope_stale', {
            kind: 'peer',
            state: 'stale',
            reason: 'ci-scope-stale'
        })
    ]);
    const revisionBeforeScopeChange = worker.routeAssuranceService.getStats().dataRevision;
    worker.invalidateRouteAssurance('persistence-scope_stale');
    assert.equal(worker.routeAssuranceService.state, 'dirty');
    assert.equal(worker.routeAssuranceService.getStats().dataRevision, revisionBeforeScopeChange + 1);
    await waitForRouteAssuranceRebuild();
    assert.equal(worker.routeAssuranceService.state, 'ready');
    assert.equal(persistenceQueries.length, 4, 'scope-wide state change must rebuild from current SQLite rows');

    await worker.getRouteAssurance('after-scope-rebuild', { page: 1, pageSize: 25 });
    assert.equal(responses[3].data.summary.categoryCounts['inbound-gap'], 2);
    assert.equal(responses[3].data.summary.categoryCounts['not-selected'], 0);
    assert.equal(responses[3].data.summary.cacheHit, true);
}

verifyWorkerCache()
    .then(() => console.log('BMP Route Assurance SQLite worker cache integration tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        store.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
