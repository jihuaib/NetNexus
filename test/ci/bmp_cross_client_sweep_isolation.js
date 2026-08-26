const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const {
    buildConnectionMutation,
    buildRouteUpsertMutation,
    buildScopeMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

function makeContext({ sysName, connectionId, generation, openedAtMs, remotePort }) {
    const bmpSession = {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '127.0.0.1',
        remotePort,
        sysName,
        sysDesc: `${sysName} persistence isolation`,
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
        sessionRdRaw: 'raw:0000000000000000',
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
        pathId: 0,
        rd: '0:0',
        ip: '203.0.113.0',
        mask: 24,
        nlriDetail: { prefix: '203.0.113.0', length: 24, pathId: 0, rd: '0:0' }
    });
    route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' });
    route.markActive(owner.getRibEpoch(1, 1, 2));
    return route;
}

function batch(batchId, mutations, createdAtMs) {
    return { batchId, mutations, createdAtMs };
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-cross-client-sweep-'));
const store = new BmpPersistenceStore({ dbPath: path.join(tempDir, 'bmp.sqlite3') }).open();

try {
    const oldAtMs = Date.now() - 48 * 60 * 60 * 1000;
    const clientA = makeContext({
        sysName: 'persistent-client-a',
        connectionId: 'client-a-old-connection',
        generation: 100,
        openedAtMs: oldAtMs,
        remotePort: 50001
    });
    const routeA = makeRoute(clientA.owner);
    const clientAOpen = buildConnectionMutation(clientA.bmpSession, 'connection_open', { eventAtMs: oldAtMs });
    const clientAScope = buildScopeMutation(clientA.bmpSession, clientA.owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'ready',
        eventAtMs: oldAtMs
    });
    store.applyBatch(
        batch(
            'seed-client-a',
            [
                clientAOpen,
                clientAScope,
                buildRouteUpsertMutation(clientA.bmpSession, clientA.owner, routeA, 1, 1, 2, {
                    kind: 'peer',
                    scopeState: 'ready',
                    isNewRoute: true,
                    eventAtMs: oldAtMs
                }),
                buildConnectionMutation(clientA.bmpSession, 'connection_close', {
                    eventAtMs: oldAtMs + 1,
                    reason: 'bmp-session-close'
                })
            ],
            oldAtMs
        )
    );

    const sourceA = clientAOpen.source.id;
    assert.equal(store.queryRoutes({ sourceId: sourceA, routeState: 'all' }).total, 1);

    const clientB = makeContext({
        sysName: 'new-client-b',
        connectionId: 'client-b-connection',
        generation: 200,
        openedAtMs: Date.now(),
        remotePort: 50002
    });
    const clientBOpen = buildConnectionMutation(clientB.bmpSession, 'connection_open');
    const clientBScope = buildScopeMutation(clientB.bmpSession, clientB.owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'ready'
    });
    store.applyBatch(
        batch(
            'connect-client-b',
            [
                clientBOpen,
                clientBScope,
                buildRouteUpsertMutation(clientB.bmpSession, clientB.owner, makeRoute(clientB.owner), 1, 1, 2, {
                    kind: 'peer',
                    scopeState: 'ready',
                    isNewRoute: true
                })
            ],
            Date.now()
        )
    );
    const sourceB = clientBOpen.source.id;
    assert.notEqual(sourceB, sourceA, 'different Client identities must have different source IDs');
    assert.equal(store.queryRoutes({ sourceId: sourceB, routeState: 'all' }).total, 1);

    const maintenanceSweep = store.sweep({
        mode: 'maintenance',
        staleBeforeMs: Date.now(),
        refreshTimeoutBeforeMs: 0,
        eventsBeforeMs: 0
    });
    assert.equal(maintenanceSweep.routes, 0, 'maintenance must not expire persisted current routes by default');
    assert.equal(store.queryRoutes({ sourceId: sourceA, routeState: 'all' }).total, 1);
    assert.equal(store.queryRoutes({ sourceId: sourceB, routeState: 'all' }).total, 1);

    // Make Client A immediately eligible for authoritative same-Client EOR
    // cleanup before Client B asks for its lifecycle sweep. Without the source
    // predicate, the B sweep below would physically delete A's old route.
    const replacementA = makeContext({
        sysName: 'persistent-client-a',
        connectionId: 'client-a-replacement-connection',
        generation: 300,
        openedAtMs: Date.now(),
        remotePort: 50003
    });
    const replacementConnectionOpen = buildConnectionMutation(replacementA.bmpSession, 'connection_open');
    const replacementOpen = buildScopeMutation(replacementA.bmpSession, replacementA.owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'syncing'
    });
    const replacementEor = buildScopeMutation(replacementA.bmpSession, replacementA.owner, 1, 1, 2, 'scope_eor', {
        kind: 'peer',
        state: 'ready'
    });
    assert.equal(replacementOpen.source.id, sourceA, 'same Client reconnect must retain its source ID');
    store.applyBatch(
        batch(
            'client-a-authoritative-empty-refresh',
            [replacementConnectionOpen, replacementOpen, replacementEor],
            Date.now()
        )
    );

    const clientBSweep = store.sweep({
        mode: 'lifecycle',
        sourceId: sourceB,
        staleBeforeMs: Date.now(),
        refreshTimeoutBeforeMs: Date.now(),
        eventsBeforeMs: Date.now()
    });
    assert.equal(clientBSweep.routes, 0, 'Client B lifecycle sweep must not delete Client A routes');
    assert.equal(store.queryRoutes({ sourceId: sourceA, routeState: 'all' }).total, 1);
    assert.equal(store.queryRoutes({ sourceId: sourceB, routeState: 'all' }).total, 1);
    const clientACleanup = store.sweep({
        mode: 'lifecycle',
        sourceId: sourceA,
        staleBeforeMs: 0,
        refreshTimeoutBeforeMs: 0,
        eventsBeforeMs: 0
    });
    assert.equal(clientACleanup.routes, 1, 'same Client EOR cleanup must remain authoritative');
    assert.equal(store.queryRoutes({ sourceId: sourceA, routeState: 'all' }).total, 0);
    assert.equal(store.queryRoutes({ sourceId: sourceB, routeState: 'all' }).total, 1);

    const requestedSources = [];
    const session = new BmpSession(
        {},
        {
            requestPersistenceSweep(sourceId) {
                requestedSources.push(sourceId);
                return true;
            }
        }
    );
    session.persistenceSourceKey = { keyHex: sourceB };
    assert.equal(session.requestPersistenceSweep(), true);
    assert.deepEqual(requestedSources, [sourceB]);

    console.log('BMP cross-Client persistence sweep isolation tests passed');
} finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
