const assert = require('assert');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const { getAddrFamilyType } = require('../../electron/utils/bgpUtils');
const RouteUpdateAggregator = require('../../electron/utils/routeUpdateAggregator');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpSession = require('../../electron/worker/bmp/bmpSession');

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

console.log('BMP incremental event tests passed');
