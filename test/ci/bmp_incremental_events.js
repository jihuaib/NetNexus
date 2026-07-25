const assert = require('assert');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const { getAddrFamilyType } = require('../../electron/utils/bgpUtils');
const RouteUpdateAggregator = require('../../electron/utils/routeUpdateAggregator');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpSession = require('../../electron/worker/bmp/bmpSession');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

const emitted = [];
const routeUpdates = [];
const instanceRouteUpdates = [];
const messageHandler = {
    sendEvent(type, payload) {
        emitted.push({ type, payload });
    }
};
const bmpWorker = {
    bmpConfigData: {},
    enqueueRouteUpdateEvent(update) {
        routeUpdates.push(update);
    },
    enqueueInstanceRouteUpdateEvent(update) {
        instanceRouteUpdates.push(update);
    }
};

const bmpSession = new BmpSession(messageHandler, bmpWorker);
bmpSession.localIp = '127.0.0.1';
bmpSession.localPort = 11019;
bmpSession.remoteIp = '192.0.2.10';
bmpSession.remotePort = 49152;
bmpSession.sysName = 'incremental-router';

const discoveredPeer = new BmpBgpSession(bmpSession);
discoveredPeer.sessionType = BmpConst.BMP_PEER_TYPE.GLOBAL;
discoveredPeer.sessionRd = '0:0';
discoveredPeer.sessionIp = '192.0.2.1';
discoveredPeer.sessionAs = 65000;
bmpSession.ensureBgpSessionRouteScope(
    discoveredPeer,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
);
const discoveredPeerEvent = emitted.pop();
assert.equal(discoveredPeerEvent.type, BmpConst.BMP_EVT_TYPES.SESSION_UPDATE);
assert.equal(discoveredPeerEvent.payload.data.session.routeScopes.length, 1);
assert.ok(discoveredPeerEvent.payload.data.session.routeScopes[0].persistentScopeId);

const peer = new BmpBgpSession(bmpSession);
peer.sessionType = BmpConst.BMP_PEER_TYPE.GLOBAL;
peer.sessionRd = '0:0';
peer.sessionIp = '192.0.2.2';
peer.sessionAs = 65000;
peer.sessionState = BmpConst.BMP_SESSION_STATE.PEER_UP;
peer.enabledAddressFamilies = [{ afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST }];
peer.ribTypes = [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN];
peer.ensureRouteScope(
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
);

assert.equal(bmpSession.sendSessionUpdateEvent(peer), true);
const sessionEvent = emitted.pop();
assert.equal(sessionEvent.type, BmpConst.BMP_EVT_TYPES.SESSION_UPDATE);
assert.equal(sessionEvent.payload.data.client.persistentSourceId, sessionEvent.payload.data.session.persistentSourceId);
assert.ok(sessionEvent.payload.data.session.persistentOwnerKey);
assert.equal(sessionEvent.payload.data.session.routeScopes.length, 1);
assert.ok(sessionEvent.payload.data.session.routeScopes[0].persistentScopeId);

bmpSession.sendRouteUpdateEvent(
    BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
    peer,
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST),
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
    2
);
assert.equal(routeUpdates.length, 1);
assert.equal(routeUpdates[0].persistentSourceId, sessionEvent.payload.data.client.persistentSourceId);
assert.equal(routeUpdates[0].persistentOwnerKey, sessionEvent.payload.data.session.persistentOwnerKey);
assert.equal(routeUpdates[0].persistentScopeId, sessionEvent.payload.data.session.routeScopes[0].persistentScopeId);
assert.equal(routeUpdates[0].session.persistentScopeId, routeUpdates[0].persistentScopeId);

const instance = new BmpBgpInstance(bmpSession);
instance.instanceType = BmpConst.BMP_PEER_TYPE.LOCAL_RIB;
instance.instanceRd = '0:0';
instance.instanceIp = '0.0.0.0';
instance.instanceAs = 0;
instance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_UP;
instance.afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
instance.safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
instance.enabledAddressFamilies = [{ afi: instance.afi, safi: instance.safi }];

assert.equal(bmpSession.sendInstanceUpdateEvent(instance), true);
const instanceEvent = emitted.pop();
assert.equal(instanceEvent.type, BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE);
assert.ok(instanceEvent.payload.data.instance.persistentOwnerKey);
assert.ok(instanceEvent.payload.data.instance.persistentScopeId);

bmpSession.sendInstanceRouteUpdateEvent(
    BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
    instance,
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST),
    1
);
assert.equal(instanceRouteUpdates.length, 1);
assert.equal(instanceRouteUpdates[0].persistentScopeId, instanceEvent.payload.data.instance.persistentScopeId);

const discoveredInstance = bmpSession.getOrCreateLocRibInstance(
    {
        peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        peerFlags: 0,
        peerRd: '65000:100',
        peerRdRaw: null,
        peerAddress: '0.0.0.0',
        peerAs: 0,
        peerRouterId: '192.0.2.10',
        peerTimestamp: 1,
        peerTimestampMicroseconds: 0,
        peerTimestampMs: 1000
    },
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
);
const discoveredInstanceEvent = emitted.pop();
assert.equal(discoveredInstanceEvent.type, BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE);
assert.equal(
    discoveredInstanceEvent.payload.data.instance.addrFamilyType,
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
);
assert.equal(
    discoveredInstanceEvent.payload.data.instance.persistentScopeId,
    bmpSession.getInstanceUpdateEventInfo(discoveredInstance).persistentScopeId
);

const aggregator = new RouteUpdateAggregator();
aggregator.enqueueRouteUpdate({
    ...routeUpdates[0],
    type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
    changedCount: 2,
    client: { ...routeUpdates[0].client, remotePort: 50000 }
});
aggregator.enqueueRouteUpdate({
    ...routeUpdates[0],
    type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
    changedCount: 1,
    reason: 'reconnect-refresh-timeout',
    projectionReset: true,
    client: { ...routeUpdates[0].client, remotePort: 50001 }
});
aggregator.enqueueRouteUpdate({
    ...routeUpdates[0],
    persistentScopeId: 'another-scope',
    scopeId: 'another-scope',
    session: { ...routeUpdates[0].session, persistentScopeId: 'another-scope', scopeId: 'another-scope' }
});

const aggregatedRoutes = aggregator.flushRouteUpdates();
assert.equal(aggregatedRoutes.length, 2, 'stable scope IDs must drive aggregation across reconnect ports');
const primaryScopeUpdate = aggregatedRoutes.find(update => update.scopeId === routeUpdates[0].scopeId);
assert.equal(primaryScopeUpdate.changedCount, 3);
assert.deepEqual(primaryScopeUpdate.types, [
    BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
    BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE
]);
assert.equal(primaryScopeUpdate.reason, 'reconnect-refresh-timeout');
assert.equal(primaryScopeUpdate.projectionReset, true);

aggregator.enqueueInstanceRouteUpdate({
    ...instanceRouteUpdates[0],
    changedCount: 1,
    client: { ...instanceRouteUpdates[0].client, remotePort: 50000 }
});
aggregator.enqueueInstanceRouteUpdate({
    ...instanceRouteUpdates[0],
    type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
    changedCount: 2,
    client: { ...instanceRouteUpdates[0].client, remotePort: 50001 }
});
const aggregatedInstanceRoutes = aggregator.flushInstanceRouteUpdates();
assert.equal(aggregatedInstanceRoutes.length, 1);
assert.equal(aggregatedInstanceRoutes[0].changedCount, 3);
assert.deepEqual(aggregatedInstanceRoutes[0].types, [
    BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
    BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE
]);

const flushedEvents = [];
const worker = Object.create(BmpWorker.prototype);
worker.bmpConfigData = {};
assert.equal(worker.getPersistenceRefreshTimeoutMs(), 30 * 60 * 1000);
const instanceFlushUpdates = [
    ...aggregatedInstanceRoutes,
    {
        ...aggregatedInstanceRoutes[0],
        persistentScopeId: 'another-instance-scope',
        scopeId: 'another-instance-scope',
        instance: {
            ...aggregatedInstanceRoutes[0].instance,
            persistentScopeId: 'another-instance-scope',
            scopeId: 'another-instance-scope'
        }
    }
];
worker.routeUpdateFlushTimer = null;
worker.routeUpdateAggregator = {
    flushRouteUpdates: () => aggregatedRoutes,
    flushInstanceRouteUpdates: () => instanceFlushUpdates
};
worker.messageHandler = {
    sendEvent(type, payload) {
        flushedEvents.push({ type, payload });
    }
};

worker.flushRouteUpdateEvents();

assert.equal(flushedEvents.length, 2, 'one worker flush must emit at most one event per route update kind');
assert.equal(flushedEvents[0].type, BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE);
assert.deepEqual(flushedEvents[0].payload, {
    data: { batch: true, updates: aggregatedRoutes }
});
assert.equal(flushedEvents[1].type, BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE);
assert.deepEqual(flushedEvents[1].payload, {
    data: { batch: true, updates: instanceFlushUpdates }
});

(async () => {
    const purgeQueries = [];
    const committedResults = [];
    const purgeUpdates = [];
    const purgeResults = [
        {
            purged: 2,
            hasMore: true,
            deltas: [
                {
                    sourceId: 'source-a',
                    ownerKey: 'peer-a',
                    scopeId: 'scope-a',
                    scopeKind: 'peer',
                    afi: 1,
                    safi: 1,
                    ribType: 'pre-adj-rib-in'
                },
                {
                    sourceId: 'source-a',
                    ownerKey: 'peer-a',
                    scopeId: 'scope-a',
                    scopeKind: 'peer',
                    afi: 1,
                    safi: 1,
                    ribType: 'pre-adj-rib-in'
                }
            ]
        },
        {
            purged: 1,
            hasMore: false,
            deltas: [
                {
                    sourceId: 'source-a',
                    ownerKey: 'peer-a',
                    scopeId: 'scope-a',
                    scopeKind: 'peer',
                    afi: 1,
                    safi: 1,
                    ribType: 'pre-adj-rib-in'
                }
            ]
        },
        {
            purged: 1,
            hasMore: false,
            deltas: [
                {
                    sourceId: 'source-a',
                    ownerKey: 'peer-a',
                    scopeId: 'scope-b',
                    scopeKind: 'peer',
                    afi: 2,
                    safi: 1,
                    ribType: 'pre-adj-rib-in'
                }
            ]
        }
    ];
    const purgeWorker = Object.create(BmpWorker.prototype);
    purgeWorker.persistence = {
        async purgeStaleRoutes(query) {
            purgeQueries.push(query);
            return purgeResults.shift();
        }
    };
    purgeWorker.handleCommittedPersistenceResult = result => committedResults.push(result);
    purgeWorker.emitPersistenceSweepRouteUpdates = scopes => purgeUpdates.push(scopes);

    const notificationPurge = await purgeWorker.purgeNotificationPeerRoutes({
        sourceId: 'source-a',
        ownerKey: 'peer-a',
        scopeKind: 'peer',
        scopes: [
            {
                scopeId: 'scope-a',
                afi: 1,
                safi: 1,
                ribType: 'pre-adj-rib-in',
                ribEpochBefore: 3
            },
            {
                scopeId: 'scope-b',
                afi: 2,
                safi: 1,
                ribType: 'pre-adj-rib-in',
                ribEpochBefore: 7
            }
        ],
        reason: 'peer-down-notification:1'
    });
    assert.equal(notificationPurge.purged, 4);
    assert.deepEqual(purgeQueries, [
        {
            sourceId: 'source-a',
            ownerKey: 'peer-a',
            scopeKind: 'peer',
            scopeId: 'scope-a',
            afi: 1,
            safi: 1,
            ribType: 'pre-adj-rib-in',
            ribEpochBefore: 3,
            routeLimit: 20000,
            reason: 'peer-down-notification:1'
        },
        {
            sourceId: 'source-a',
            ownerKey: 'peer-a',
            scopeKind: 'peer',
            scopeId: 'scope-a',
            afi: 1,
            safi: 1,
            ribType: 'pre-adj-rib-in',
            ribEpochBefore: 3,
            routeLimit: 20000,
            reason: 'peer-down-notification:1'
        },
        {
            sourceId: 'source-a',
            ownerKey: 'peer-a',
            scopeKind: 'peer',
            scopeId: 'scope-b',
            afi: 2,
            safi: 1,
            ribType: 'pre-adj-rib-in',
            ribEpochBefore: 7,
            routeLimit: 20000,
            reason: 'peer-down-notification:1'
        }
    ]);
    assert.equal(committedResults.length, 3);
    assert.equal(purgeUpdates.length, 1);
    assert.deepEqual(
        purgeUpdates[0].map(scope => [scope.scopeId, scope.deletedRoutes]),
        [
            ['scope-a', 3],
            ['scope-b', 1]
        ]
    );

    console.log('BMP incremental event tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
