const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpClientPersistenceStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const { getClientDatabasePath } = require('../../electron/worker/bmp/bmpClientPersistencePaths');
const {
    buildConnectionMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation,
    buildScopeMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const ROUTES_PER_CLIENT = 260;
const BASE_TIME = Date.now() - 10000;

function makeContext(index) {
    const bmpSession = {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 50000 + index,
        sysName: `store-edge-client-${index}`,
        persistenceConnectionId: `edge-connection-${index}`,
        persistenceConnectionGeneration: 100 + index,
        persistenceOpenedAtMs: BASE_TIME
    };
    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65001 });
    return { bmpSession, owner };
}

function makeRoute(owner, index, nextHop = '192.0.2.1') {
    const prefix = `10.${index >> 8}.${index & 255}.0`;
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        ribType: 2,
        ip: prefix,
        mask: 24,
        pathId: 0,
        rd: '0:0',
        nlriDetail: { prefix, length: 24, pathId: 0, rd: '0:0' }
    });
    route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop });
    route.markActive(0);
    return route;
}

function announce(context, route, eventAtMs) {
    return buildRouteUpsertMutation(context.bmpSession, context.owner, route, 1, 1, 2, {
        kind: 'peer',
        scopeState: 'ready',
        isNewRoute: true,
        eventAtMs
    });
}

function seed(context, count, clientIndex, timeStride = 3) {
    const mutations = [
        buildConnectionMutation(context.bmpSession, 'connection_open', { eventAtMs: BASE_TIME - 1 }),
        buildScopeMutation(context.bmpSession, context.owner, 1, 1, 2, 'scope_open', {
            kind: 'peer',
            state: 'syncing',
            eventAtMs: BASE_TIME - 1
        })
    ];
    for (let index = 0; index < count; index += 1) {
        mutations.push(
            announce(context, makeRoute(context.owner, index), BASE_TIME + index * timeStride + clientIndex)
        );
    }
    mutations.push(
        buildScopeMutation(context.bmpSession, context.owner, 1, 1, 2, 'scope_eor', {
            kind: 'peer',
            state: 'ready',
            eventAtMs: BASE_TIME + count * timeStride + clientIndex
        })
    );
    return mutations;
}

function identity(route) {
    return `${route.persistentScopeId}|${route.persistentRouteId}`;
}

function scanCursor(store, query, expectedTotal) {
    const routes = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
        const result = store.queryRoutes({ ...query, pageSize: 257, cursor });
        assert.equal(result.total, expectedTotal);
        routes.push(...result.list);
        cursor = result.nextCursor;
        if (!cursor) break;
    }
    assert.equal(cursor, null);
    assert.equal(routes.length, expectedTotal);
    assert.equal(
        new Set(routes.map(identity)).size,
        expectedTotal,
        'cursor must neither duplicate nor skip routes across inner chunks'
    );
    return routes;
}

function testLruAndCursors(dbPath) {
    const store = new BmpClientPersistenceStore({ dbPath, maxOpenDatabases: 2 }).open();
    try {
        const sources = [];
        const contexts = new Map();
        const scopes = new Map();
        for (let index = 0; index < 3; index += 1) {
            const context = makeContext(index);
            const mutations = seed(context, ROUTES_PER_CLIENT, index);
            sources.push(mutations[0].source.id);
            contexts.set(mutations[0].source.id, context);
            scopes.set(mutations[0].source.id, mutations[1].scope.id);
            store.applyBatch({ batchId: `edge-seed-${index}`, mutations, createdAtMs: BASE_TIME });
            assert.ok(store.stores.size <= 2, 'the open database cache must stay bounded');
        }
        const firstSeen = store.queryRoutes({ orderBy: 'firstSeen', routeState: 'active', pageSize: 1000 });
        assert.equal(firstSeen.total, 3 * ROUTES_PER_CLIENT);
        assert.equal(
            firstSeen.list.length,
            3 * ROUTES_PER_CLIENT,
            'firstSeen merge must reacquire each evicted database when reaching its second 256-row chunk'
        );
        assert.equal(new Set(firstSeen.list.map(identity)).size, 3 * ROUTES_PER_CLIENT);
        const times = firstSeen.list.map(route => Date.parse(route.firstSeenAt));
        assert.ok(times.every(Number.isFinite));
        assert.deepEqual(
            times,
            times.slice().sort((left, right) => left - right),
            'firstSeen pages must have global time order across Clients'
        );
        const secondPage = store.queryRoutes({ orderBy: 'firstSeen', routeState: 'active', pageSize: 257, page: 2 });
        assert.deepEqual(secondPage.list.map(identity), firstSeen.list.slice(257, 514).map(identity));
        scanCursor(store, { routeState: 'active' }, 3 * ROUTES_PER_CLIENT);
        for (const sourceId of sources) scanCursor(store, { sourceId, routeState: 'active' }, ROUTES_PER_CLIENT);
        assert.ok(store.stores.size <= 2);
        assert.equal(
            store.queryScopeSummary({}).active,
            3 * ROUTES_PER_CLIENT,
            'LRU reopen within one writer lifetime must not mark live connections as interrupted'
        );
        testCursorWithdrawAndScope(store, contexts, scopes);
    } finally {
        store.close();
    }
}

function testCursorWithdrawAndScope(store, contexts, scopes) {
    const baseline = store.queryRoutes({ routeState: 'active', pageSize: 4 }).list;
    const firstPage = store.queryRoutes({ routeState: 'active', pageSize: 2 });
    const removed = firstPage.list[0];
    const context = contexts.get(removed.persistentSourceId);
    const withdrawn = buildRouteWithdrawMutation(context.bmpSession, context.owner, removed.nlriDetail, null, 1, 1, 2, {
        kind: 'peer'
    });
    store.applyBatch({ batchId: 'cursor-prior-row-withdrawn', mutations: [withdrawn], createdAtMs: Date.now() });
    const resumed = store.queryRoutes({ routeState: 'active', pageSize: 2, cursor: firstPage.nextCursor });
    assert.deepEqual(
        resumed.list.map(identity),
        baseline.slice(2, 4).map(identity),
        'withdrawing an already-read route must not shift an aggregate cursor and skip an unread route'
    );
    const missing = store.queryRouteScope({ sourceId: '0'.repeat(64), routeQuery: {}, summaryQuery: {} });
    assert.equal(missing.routes.total, 0, 'a missing explicit Client must never fall back to the aggregate RIB');
    assert.deepEqual(missing.routes.list, []);
    assert.equal(missing.summary.total, 0);
    const [sourceA, sourceB] = Array.from(contexts.keys());
    const foreignScope = store.queryRouteScope({
        sourceId: sourceA,
        routeQuery: { scopeId: scopes.get(sourceB), routeState: 'all' },
        summaryQuery: { scopeId: scopes.get(sourceB) }
    });
    assert.equal(foreignScope.routes.total, 0);
    assert.equal(foreignScope.summary.total, 0);
    assert.throws(
        () => store.queryRouteScope({ sourceId: sourceA, routeQuery: { sourceId: sourceB }, summaryQuery: {} }),
        /source|client/i
    );
    assert.throws(
        () => store.queryRouteScope({ routeQuery: { sourceId: sourceA }, summaryQuery: { sourceId: sourceB } }),
        /source|client/i
    );
}

function testDefaultCacheEviction(dbPath) {
    const store = new BmpClientPersistenceStore({ dbPath }).open();
    try {
        const count = 37;
        for (let index = 0; index < count; index += 1) {
            store.applyBatch({
                batchId: `default-lru-seed-${index}`,
                mutations: seed(makeContext(index + 100), 257, index, count),
                createdAtMs: BASE_TIME
            });
            assert.ok(store.stores.size <= 32);
        }
        const first = store.queryRoutes({ orderBy: 'firstSeen', routeState: 'active', pageSize: 5000 });
        const second = store.queryRoutes({ orderBy: 'firstSeen', routeState: 'active', pageSize: 5000, page: 2 });
        const routes = [...first.list, ...second.list];
        assert.equal(first.total, count * 257);
        assert.equal(second.total, count * 257);
        assert.equal(
            routes.length,
            count * 257,
            '37 Clients must merge all second chunks despite the default 32-database cache limit'
        );
        assert.equal(new Set(routes.map(identity)).size, count * 257);
        const times = routes.map(route => Date.parse(route.firstSeenAt));
        assert.deepEqual(
            times,
            times.slice().sort((left, right) => left - right)
        );
        assert.ok(store.stores.size <= 32);
        assert.equal(store.queryScopeSummary({}).active, count * 257);
    } finally {
        store.close();
    }
}

function testPartialCommitRetry(dbPath) {
    const store = new BmpClientPersistenceStore({ dbPath }).open();
    try {
        const contextA = makeContext(10);
        const contextB = makeContext(11);
        const mutationsA = seed(contextA, 1, 0);
        const mutationsB = seed(contextB, 1, 1);
        const sourceA = mutationsA[0].source.id;
        const sourceB = mutationsB[0].source.id;
        const clientB = store.getStore(sourceB, true);
        const applyB = clientB.applyBatch.bind(clientB);
        let fail = true;
        clientB.applyBatch = batch => {
            if (fail) {
                fail = false;
                throw new Error('synthetic second-client transaction failure');
            }
            return applyB(batch);
        };
        const batch = {
            batchId: 'partial-commit-retry',
            mutations: [...mutationsA, ...mutationsB],
            createdAtMs: BASE_TIME
        };
        assert.throws(() => store.applyBatch(batch), /second-client transaction failure/);
        assert.equal(store.queryRoutes({ sourceId: sourceA, routeState: 'all' }).total, 1);
        assert.equal(store.queryRoutes({ sourceId: sourceB, routeState: 'all' }).total, 0);
        const retried = store.applyBatch(batch);
        assert.equal(retried.duplicate, false);
        assert.equal(retried.applied, mutationsB.length);
        assert.equal(
            retried.requiresProjectionRebuild,
            true,
            'a retry cannot recreate deltas of an already-committed Client, so consumers must rebuild their projection'
        );
        assert.equal(retried.deltas.length, 1);
        assert.equal(retried.deltas[0].sourceId, sourceB);
        assert.equal(store.queryRoutes({ routeState: 'all' }).total, 2);
        assert.equal(store.applyBatch(batch).duplicate, true);

        fail = true;
        const noDeltas = {
            batchId: 'partial-commit-without-deltas',
            includeDeltas: false,
            createdAtMs: BASE_TIME + 1000,
            mutations: [
                announce(contextA, makeRoute(contextA.owner, 0, '192.0.2.2'), BASE_TIME + 1000),
                announce(contextB, makeRoute(contextB.owner, 0, '192.0.2.2'), BASE_TIME + 1000)
            ]
        };
        assert.throws(() => store.applyBatch(noDeltas), /second-client transaction failure/);
        const noDeltasRetry = store.applyBatch(noDeltas);
        assert.equal(noDeltasRetry.applied, 1);
        assert.equal(
            noDeltasRetry.requiresProjectionRebuild,
            undefined,
            'no-delta batches must not request an unused projection rebuild'
        );
        assert.equal(Object.hasOwn(noDeltasRetry, 'deltas'), false);
        assert.equal(store.queryRoutes({ routeState: 'all' }).total, 2);
    } finally {
        store.close();
    }
}

function testMisplacedDatabaseRejection(dbPath) {
    const contextA = makeContext(300);
    const mutationsA = seed(contextA, 1, 0);
    const sourceA = mutationsA[0].source.id;
    const sourceB = buildConnectionMutation(makeContext(301).bmpSession, 'connection_open').source.id;
    assert.notEqual(sourceA, sourceB);
    const misplacedPath = getClientDatabasePath(dbPath, sourceB);
    fs.mkdirSync(path.dirname(misplacedPath), { recursive: true });
    const original = new BmpPersistenceStore({ dbPath: misplacedPath }).open();
    try {
        original.applyBatch({ batchId: 'misplaced-source-a-in-b-file', mutations: mutationsA, createdAtMs: BASE_TIME });
    } finally {
        original.close();
    }
    const readState = () => {
        const db = new Database(misplacedPath, { readonly: true, fileMustExist: true });
        try {
            return {
                sources: db.prepare('SELECT * FROM bmp_sources ORDER BY source_pk').all(),
                connections: db.prepare('SELECT * FROM bmp_connections ORDER BY connection_pk').all(),
                scopes: db.prepare('SELECT * FROM bmp_rib_scopes ORDER BY scope_pk').all(),
                routes: db.prepare('SELECT COUNT(*) AS count FROM bmp_current_route_refs').get().count
            };
        } finally {
            db.close();
        }
    };
    const before = readState();
    assert.equal(before.sources[0].source_id, sourceA);
    assert.equal(before.connections[0].connection_state, 'open');
    assert.equal(before.scopes[0].scope_state, 'ready');
    const writer = new BmpClientPersistenceStore({ dbPath });
    try {
        assert.throws(
            () => writer.open(),
            /another source|source.*match|client/i,
            'a writer must reject a Client database whose filename belongs to another source before recovery mutates it'
        );
    } finally {
        writer.close();
    }
    assert.deepEqual(
        readState(),
        before,
        'rejected writer startup must not close original connections or mark original scopes stale'
    );
    const reader = new BmpClientPersistenceStore({ dbPath, readOnly: true }).open();
    try {
        assert.throws(
            () => reader.queryTopology(),
            /another source|source.*match|client/i,
            'read-only discovery must reject a misplaced Client file as well'
        );
    } finally {
        reader.close();
    }
    assert.deepEqual(readState(), before);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-client-store-edges-'));
try {
    testLruAndCursors(path.join(tempDir, 'lru.sqlite3'));
    testDefaultCacheEviction(path.join(tempDir, 'default-lru.sqlite3'));
    testPartialCommitRetry(path.join(tempDir, 'retry.sqlite3'));
    testMisplacedDatabaseRejection(path.join(tempDir, 'misplaced.sqlite3'));
    console.log(
        'BMP Client store edge tests passed: bounded LRU, cursor boundaries, firstSeen merge, partial-commit retry and misplaced database rejection'
    );
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
