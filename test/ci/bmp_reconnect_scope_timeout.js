const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

function makeContext(connectionId, generation, openedAtMs) {
    const bmpSession = {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 55000 + generation,
        sysName: 'reconnect-timeout-router',
        sysDesc: 'reconnect timeout regression',
        bmpVersion: 4,
        persistenceConnectionId: connectionId,
        persistenceConnectionGeneration: generation,
        persistenceOpenedAtMs: openedAtMs,
        getBmpV4TlvDraft: () => 20
    };
    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, {
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: '198.51.100.1',
        sessionAs: 65001,
        vrfTableNames: ['global']
    });
    return { bmpSession, owner };
}

function makeRoute(owner) {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        ribType: 2,
        pathId: 1,
        rd: '0:0',
        ip: '203.0.113.0',
        mask: 24,
        nlriDetail: { prefix: '203.0.113.0', length: 24, pathId: 1, rd: '0:0' }
    });
    route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' });
    route.markActive(owner.getRibEpoch(1, 1, 2));
    return route;
}

function batch(batchId, mutations, createdAtMs) {
    return { batchId, createdAtMs, mutations };
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-reconnect-scope-timeout-'));
const store = new BmpPersistenceStore({ dbPath: path.join(tempDir, 'bmp.sqlite3') });

try {
    const previousOpenedAtMs = Date.now() - 20000;
    const replacementOpenedAtMs = previousOpenedAtMs + 10000;
    const previous = makeContext('previous-connection', 100, previousOpenedAtMs);
    const route = makeRoute(previous.owner);
    const initialScope = buildScopeMutation(previous.bmpSession, previous.owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'syncing',
        eventAtMs: previousOpenedAtMs
    });

    store.open();
    store.applyBatch(
        batch(
            'initial-ready-rib',
            [
                buildConnectionMutation(previous.bmpSession, 'connection_open', {
                    eventAtMs: previousOpenedAtMs
                }),
                initialScope,
                buildRouteUpsertMutation(previous.bmpSession, previous.owner, route, 1, 1, 2, {
                    kind: 'peer',
                    scopeState: 'syncing',
                    isNewRoute: true,
                    eventAtMs: previousOpenedAtMs
                }),
                buildScopeMutation(previous.bmpSession, previous.owner, 1, 1, 2, 'scope_eor', {
                    kind: 'peer',
                    state: 'ready',
                    eventAtMs: previousOpenedAtMs + 1
                }),
                buildConnectionMutation(previous.bmpSession, 'connection_close', {
                    eventAtMs: previousOpenedAtMs + 2,
                    reason: 'bmp-session-close'
                })
            ],
            previousOpenedAtMs
        )
    );

    let routes = store.queryRoutes({ routeState: 'all' });
    assert.equal(routes.total, 1);
    assert.equal(routes.list[0].routeState, 'stale');
    assert.equal(routes.list[0].scopeState, 'down');

    const replacement = makeContext('replacement-connection', 200, replacementOpenedAtMs);
    store.applyBatch(
        batch(
            'initiation-only-reconnect',
            [
                buildConnectionMutation(replacement.bmpSession, 'connection_open', {
                    eventAtMs: replacementOpenedAtMs
                })
            ],
            replacementOpenedAtMs
        )
    );

    const concurrent = makeContext('concurrent-connection', 150, replacementOpenedAtMs + 100);
    store.applyBatch(
        batch(
            'concurrent-source-connection',
            [
                buildConnectionMutation(concurrent.bmpSession, 'connection_open', {
                    eventAtMs: replacementOpenedAtMs + 100
                })
            ],
            replacementOpenedAtMs + 100
        )
    );

    const protectedByConcurrentConnection = store.sweep({
        staleBeforeMs: 0,
        refreshTimeoutBeforeMs: replacementOpenedAtMs + 10000,
        eventsBeforeMs: 0
    });
    assert.equal(protectedByConcurrentConnection.routes, 0);
    assert.equal(protectedByConcurrentConnection.reconnectTimeoutScopes, 0);
    assert.equal(
        store.queryRoutes({ routeState: 'all' }).total,
        1,
        'ambiguous same-source concurrent feeds must not purge each other'
    );
    store.applyBatch(
        batch(
            'close-concurrent-source-connection',
            [
                buildConnectionMutation(concurrent.bmpSession, 'connection_close', {
                    eventAtMs: replacementOpenedAtMs + 200,
                    reason: 'bmp-session-close'
                })
            ],
            replacementOpenedAtMs + 200
        )
    );

    const topologyBeforeTimeout = store.queryTopology();
    assert.equal(topologyBeforeTimeout.clients[0].isOnline, true, 'the BMP source itself is online');
    assert.equal(topologyBeforeTimeout.clients[0].sessions[0].isOnline, false, 'a peer without PU stays offline');

    const beforeTimeout = store.sweep({
        staleBeforeMs: 0,
        refreshTimeoutBeforeMs: replacementOpenedAtMs - 1,
        eventsBeforeMs: 0
    });
    assert.equal(beforeTimeout.routes, 0);
    assert.equal(beforeTimeout.reconnectTimeoutScopes, 0);
    assert.equal(beforeTimeout.nextRefreshStartedMs, replacementOpenedAtMs);
    assert.equal(store.queryRoutes({ routeState: 'all' }).total, 1);

    const afterTimeout = store.sweep({
        staleBeforeMs: 0,
        refreshTimeoutBeforeMs: replacementOpenedAtMs,
        eventsBeforeMs: 0
    });
    assert.equal(afterTimeout.routes, 1);
    assert.equal(afterTimeout.reconnectTimeoutScopes, 1);
    assert.equal(afterTimeout.affectedScopes.length, 1);
    assert.equal(afterTimeout.affectedScopes[0].scopeId, initialScope.scope.id);
    assert.equal(afterTimeout.affectedScopes[0].reason, 'reconnect-refresh-timeout');
    assert.equal(afterTimeout.nextRefreshStartedMs, null);
    assert.equal(store.queryRoutes({ routeState: 'all' }).total, 0);

    const topologyAfterTimeout = store.queryTopology();
    const timedOutScope = topologyAfterTimeout.scopes.find(scope => scope.scopeId === initialScope.scope.id);
    assert.equal(timedOutScope.scopeState, 'down');
    assert.equal(timedOutScope.staleReason, 'reconnect-refresh-timeout');
    assert.equal(timedOutScope.connectionId, 'previous-connection');
    assert.equal(timedOutScope.isOnline, false);

    console.log('BMP reconnect scope timeout tests passed');
} finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
