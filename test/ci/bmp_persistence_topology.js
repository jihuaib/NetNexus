const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-topology-'));
const dbPath = path.join(tempDir, 'bmp.sqlite3');

function makeRoute(owner, afi, prefix) {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi,
        safi: 1,
        ribType: owner instanceof BmpBgpInstance ? 'loc-rib' : 2,
        pathId: 0,
        rd: '0:0',
        ip: prefix,
        mask: afi === 1 ? 24 : 64,
        nlriDetail: {
            prefix,
            length: afi === 1 ? 24 : 64,
            pathId: 0,
            rd: '0:0'
        }
    });
    route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: afi === 1 ? '192.0.2.1' : '2001:db8::1' });
    route.markActive(0);
    return route;
}

function makeBatch(batchId, mutations) {
    return { batchId, createdAtMs: Date.now(), mutations };
}

async function main() {
    let store;
    let client;
    try {
        const bmpSession = {
            localIp: '127.0.0.1',
            localPort: 11019,
            remoteIp: '192.0.2.40',
            remotePort: 57000,
            sysName: 'topology-router',
            sysDesc: 'persisted topology fixture',
            bmpVersion: 4,
            getBmpV4TlvDraft: () => 20
        };
        const peer = new BmpBgpSession(bmpSession);
        Object.assign(peer, {
            sessionType: 0,
            sessionRd: '0:0',
            sessionIp: '198.51.100.40',
            sessionAs: 65001,
            vrfTableNames: ['blue']
        });
        const instance = new BmpBgpInstance(bmpSession);
        Object.assign(instance, {
            afi: 1,
            safi: 1,
            instanceType: 3,
            instanceRd: '0:0',
            instanceIp: '198.51.100.40',
            instanceAs: 65001,
            vrfTableNames: ['global']
        });

        const connectionOpen = buildConnectionMutation(bmpSession, 'connection_open');
        const peerV4Open = buildScopeMutation(bmpSession, peer, 1, 1, 2, 'scope_open', {
            kind: 'peer',
            state: 'ready'
        });
        const peerV6Open = buildScopeMutation(bmpSession, peer, 2, 1, 2, 'scope_open', {
            kind: 'peer',
            state: 'ready'
        });
        const peerRoute = buildRouteUpsertMutation(bmpSession, peer, makeRoute(peer, 1, '203.0.113.0'), 1, 1, 2, {
            kind: 'peer',
            state: 'ready',
            scopeState: 'ready',
            isNewRoute: true
        });
        const instanceOpen = buildScopeMutation(bmpSession, instance, 1, 1, 'loc-rib', 'scope_open', {
            kind: 'loc-rib',
            state: 'ready'
        });
        const instanceRoute = buildRouteUpsertMutation(
            bmpSession,
            instance,
            makeRoute(instance, 1, '10.0.0.0'),
            1,
            1,
            'loc-rib',
            {
                kind: 'loc-rib',
                state: 'ready',
                scopeState: 'ready',
                isNewRoute: true
            }
        );

        store = new BmpPersistenceStore({ dbPath }).open();
        store.applyBatch(
            makeBatch('topology-live', [connectionOpen, peerV4Open, peerV6Open, peerRoute, instanceOpen, instanceRoute])
        );

        const live = store.queryTopology();
        assert.deepEqual(
            {
                sources: live.sourceCount,
                sessions: live.sessionCount,
                instances: live.instanceCount,
                scopes: live.scopeCount,
                summary: live.routeSummary
            },
            {
                sources: 1,
                sessions: 1,
                instances: 1,
                scopes: 3,
                summary: { active: 2, stale: 0, total: 2 }
            }
        );
        const liveClient = live.clients[0];
        assert.equal(liveClient.persistentSourceId, connectionOpen.source.id);
        assert.equal(liveClient.connectionId, connectionOpen.connection.id);
        assert.equal(liveClient.connectionState, 'open');
        assert.equal(liveClient.isOnline, true);
        assert.equal(liveClient.localIp, bmpSession.localIp);
        assert.equal(liveClient.remotePort, bmpSession.remotePort);
        assert.equal(liveClient.bmpVersion, 4);
        assert.equal(liveClient.sessions.length, 1);
        assert.equal(liveClient.instances.length, 1);

        const persistedSession = liveClient.sessions[0];
        assert.equal(persistedSession.ownerKey, peerV4Open.scope.ownerKey);
        assert.equal(persistedSession.sessionIp, peer.sessionIp);
        assert.equal(persistedSession.sessionAs, peer.sessionAs);
        assert.equal(persistedSession.routeScopes.length, 2);
        assert.deepEqual(
            new Set(persistedSession.routeScopes.map(scope => scope.scopeId)),
            new Set([peerV4Open.scope.id, peerV6Open.scope.id])
        );
        assert.deepEqual(persistedSession.routeSummary, { active: 1, stale: 0, total: 1 });

        const persistedInstance = liveClient.instances[0];
        assert.equal(persistedInstance.ownerKey, instanceOpen.scope.ownerKey);
        assert.equal(persistedInstance.scopeId, instanceOpen.scope.id);
        assert.equal(persistedInstance.routeScopes[0].scopeId, instanceOpen.scope.id);
        assert.deepEqual(persistedInstance.routeSummary, { active: 1, stale: 0, total: 1 });
        assert.equal(store.queryTopology({ sourceId: connectionOpen.source.id }).clients.length, 1);
        assert.equal(store.queryTopology({ sourceId: 'missing-source' }).clients.length, 0);

        // Simulate a collector crash: close SQLite without a BMP connection_close event.
        // Opening a new writer recovers that interrupted connection and marks its scopes down.
        store.close();
        store = new BmpPersistenceStore({ dbPath }).open();
        const recovered = store.queryTopology();
        const recoveredClient = recovered.clients[0];
        assert.equal(recoveredClient.persistentSourceId, liveClient.persistentSourceId);
        assert.equal(recoveredClient.connectionId, liveClient.connectionId);
        assert.equal(recoveredClient.connectionState, 'closed');
        assert.equal(recoveredClient.isOnline, false);
        assert.deepEqual(recovered.routeSummary, { active: 0, stale: 2, total: 2 });
        assert.equal(recoveredClient.sessions[0].isOnline, false);
        assert.equal(recoveredClient.instances[0].isOnline, false);
        assert.equal(
            recovered.scopes.every(scope => scope.scopeState === 'down' && scope.staleReason === 'collector-restart'),
            true
        );
        assert.deepEqual(
            new Set(recovered.scopes.map(scope => scope.scopeId)),
            new Set(live.scopes.map(scope => scope.scopeId)),
            'restart must preserve stable scope identities'
        );

        const reconnectBmpSession = {
            localIp: bmpSession.localIp,
            localPort: bmpSession.localPort,
            remoteIp: bmpSession.remoteIp,
            remotePort: 57001,
            sysName: bmpSession.sysName,
            sysDesc: bmpSession.sysDesc,
            bmpVersion: bmpSession.bmpVersion,
            getBmpV4TlvDraft: bmpSession.getBmpV4TlvDraft
        };
        const reconnectPeer = new BmpBgpSession(reconnectBmpSession);
        Object.assign(reconnectPeer, {
            sessionType: peer.sessionType,
            sessionRd: peer.sessionRd,
            sessionIp: peer.sessionIp,
            sessionAs: peer.sessionAs,
            vrfTableNames: ['blue']
        });
        const reconnectInstance = new BmpBgpInstance(reconnectBmpSession);
        Object.assign(reconnectInstance, {
            afi: instance.afi,
            safi: instance.safi,
            instanceType: instance.instanceType,
            instanceRd: instance.instanceRd,
            instanceIp: instance.instanceIp,
            instanceAs: instance.instanceAs,
            vrfTableNames: ['global']
        });
        const reconnectOpen = buildConnectionMutation(reconnectBmpSession, 'connection_open');
        const reconnectPeerV4 = buildScopeMutation(reconnectBmpSession, reconnectPeer, 1, 1, 2, 'scope_open', {
            kind: 'peer',
            state: 'ready'
        });
        const reconnectPeerV6 = buildScopeMutation(reconnectBmpSession, reconnectPeer, 2, 1, 2, 'scope_open', {
            kind: 'peer',
            state: 'ready'
        });
        const reconnectPeerRoute = buildRouteUpsertMutation(
            reconnectBmpSession,
            reconnectPeer,
            makeRoute(reconnectPeer, 1, '203.0.113.0'),
            1,
            1,
            2,
            { kind: 'peer', state: 'ready', scopeState: 'ready', isNewRoute: false }
        );
        const reconnectInstanceOpen = buildScopeMutation(
            reconnectBmpSession,
            reconnectInstance,
            1,
            1,
            'loc-rib',
            'scope_open',
            { kind: 'loc-rib', state: 'ready' }
        );
        const reconnectInstanceRoute = buildRouteUpsertMutation(
            reconnectBmpSession,
            reconnectInstance,
            makeRoute(reconnectInstance, 1, '10.0.0.0'),
            1,
            1,
            'loc-rib',
            { kind: 'loc-rib', state: 'ready', scopeState: 'ready', isNewRoute: false }
        );
        store.applyBatch(
            makeBatch('topology-reconnect', [
                reconnectOpen,
                reconnectPeerV4,
                reconnectPeerV6,
                reconnectPeerRoute,
                reconnectInstanceOpen,
                reconnectInstanceRoute
            ])
        );
        const reconnected = store.queryTopology();
        assert.equal(reconnected.sourceCount, 1, 'a reconnect must not duplicate the persisted client');
        assert.equal(reconnected.sessionCount, 1, 'a reconnect must not duplicate the persisted peer');
        assert.equal(reconnected.instanceCount, 1, 'a reconnect must not duplicate the persisted instance');
        assert.equal(reconnected.clients[0].connectionId, reconnectOpen.connection.id);
        assert.equal(reconnected.clients[0].remotePort, reconnectBmpSession.remotePort);
        assert.equal(reconnected.clients[0].isOnline, true);
        assert.deepEqual(reconnected.routeSummary, { active: 2, stale: 0, total: 2 });
        assert.deepEqual(
            new Set(reconnected.scopes.map(scope => scope.scopeId)),
            new Set(live.scopes.map(scope => scope.scopeId)),
            'a reconnect must reuse stable scope identities'
        );

        store.close();
        store = new BmpPersistenceStore({ dbPath }).open();
        assert.equal(store.queryTopology().clients[0].isOnline, false);
        store.close();
        store = null;

        client = new BmpPersistenceClient({ dbPath, readOnly: true });
        await client.open();
        const fromWorker = await client.queryTopology({ sourceId: connectionOpen.source.id });
        assert.equal(fromWorker.clients.length, 1);
        assert.equal(fromWorker.clients[0].sessions[0].routeScopes[0].persistentScopeId.length, 64);
        assert.equal(fromWorker.clients[0].instances[0].persistentScopeId, instanceOpen.scope.id);
        assert.equal(fromWorker.clients[0].isOnline, false);
        await client.close();
        client = null;

        console.log('BMP persisted topology snapshot tests passed');
    } finally {
        await client?.close({ suppressErrors: true }).catch(() => {});
        store?.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
