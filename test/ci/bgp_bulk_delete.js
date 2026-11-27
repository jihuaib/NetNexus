const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { getAfiAndSafi } = require('../../electron/utils/bgp/bgpUtils');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');

const configuredAttr = { attributePolicy: 'configured', configuredAttributes: [] };

function fixture(addressFamily = BgpConst.BGP_ADDR_FAMILY.IPV6_QP) {
    const { afi, safi } = getAfiAndSafi(addressFamily);
    const store = new BgpRouteSqliteStore().open();
    const instance = new BgpInstance(0, afi, safi, store);
    const worker = new BgpWorker();
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    const sent = [];
    const responses = [];
    const errors = [];
    let resetCount = 0;
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
        isAddPathSendEnabled: () => false,
        resetSession() {
            resetCount += 1;
        },
        buildBgpMessageHeader(length, packetType) {
            const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
            header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
            header[BgpConst.BGP_MARKER_LEN + 2] = packetType;
            return header;
        },
        sendRoute(buffer) {
            sent.push(Buffer.from(buffer));
            return null;
        }
    };
    const peer = new BgpPeer(session, instance);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    instance.peerMap.set(session.peerIp, peer);
    worker.messageHandler.sendSuccessResponse = (id, data) => responses.push({ id, data });
    worker.messageHandler.sendErrorResponse = (id, message) => errors.push({ id, message });
    return {
        addressFamily,
        store,
        instance,
        worker,
        peer,
        session,
        sent,
        responses,
        errors,
        get resetCount() {
            return resetCount;
        },
        replace(groupId, routes) {
            return store.replaceRouteGroup(groupId, {
                groupName: groupId,
                addressFamily,
                instanceKey: instance.instanceKey,
                routes
            });
        },
        withdrawn() {
            return sent.flatMap(buffer => {
                assert.ok(buffer.length <= BgpConst.BGP_MAX_PKT_SIZE);
                const packet = parseBgpPacket(buffer, { asnSize: 4 });
                assert.ok(packet.valid, packet.error);
                const mp = packet.pathAttributes.find(attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI);
                return mp?.mpUnreach.withdrawnRoutes || packet.withdrawnRoutes || [];
            });
        }
    };
}

function* qpRoutes(count, start = 1) {
    for (let index = 0; index < count; index += 1) {
        yield {
            route: {
                ip: `2001:db8::${(start + index).toString(16)}`,
                mask: 128,
                dqpn: index === count - 1 ? null : 1,
                mpNextHop: null
            },
            attr: configuredAttr
        };
    }
}

function trackRelease(store, method) {
    const original = store[method].bind(store);
    const state = { calls: [], released: 0 };
    store[method] = (...args) => {
        state.calls.push(args);
        const result = original(...args);
        const release = result.release;
        result.release = () => {
            state.released += 1;
            release?.();
        };
        return result;
    };
    return state;
}

async function main() {
    let f = fixture();
    try {
        f.replace('offline-group', qpRoutes(2051));
        f.peer.peerState = BgpConst.BGP_PEER_STATE.IDLE;
        f.instance.hydrateRoute = () => assert.fail('offline deletion must not hydrate stored routes');
        f.instance.routeMap.queryPage = () => assert.fail('bulk deletion must not query and delete route pages');
        const groupState = trackRelease(f.store, 'withdrawRouteGroup');
        await f.worker.withdrawRouteGroup('offline-group', { groupId: 'offline-group' });
        assert.deepEqual(groupState.calls[0][1], { includeRoutes: false });
        assert.equal(groupState.released, 1);
        assert.deepEqual(f.responses.at(-1).data, { deleted: 2051 });
        assert.equal(f.store.getRouteCount(f.instance.instanceKey), 0);

        f.replace('offline-all', qpRoutes(2051));
        const allState = trackRelease(f.store, 'withdrawInstanceRoutes');
        await f.worker.deleteAllRoutesByFamily('offline-all', { addressFamily: f.addressFamily });
        assert.equal(allState.calls[0][1].includeRoutes, false);
        assert.equal(allState.released, 1);
        assert.equal(f.responses.at(-1).data.deleted, 2051);
        assert.equal(f.store.listRouteGroups().length, 0);
        assert.equal(f.store.getStatus().attributes, 0);
        assert.equal(f.sent.length, 0);
    } finally {
        f.store.close();
    }

    f = fixture();
    try {
        f.replace('backpressure', qpRoutes(4101));
        const state = trackRelease(f.store, 'withdrawInstanceRoutes');
        const originalHydrate = f.instance.hydrateRoute.bind(f.instance);
        let hydrated = 0;
        f.instance.hydrateRoute = row => {
            hydrated += 1;
            return originalHydrate(row);
        };
        f.instance.routeMap.queryPage = () => assert.fail('bulk deletion must use one database mutation');
        let releaseDrain;
        const drain = new Promise(resolve => {
            releaseDrain = resolve;
        });
        f.session.sendRoute = buffer => {
            assert.equal(f.instance.routeMap.size, 0, 'the entire deletion commits before its first withdrawal');
            f.sent.push(Buffer.from(buffer));
            return f.sent.length === 1 ? drain : null;
        };
        const pending = f.worker.deleteAllRoutesByFamily('online-all', { addressFamily: f.addressFamily });
        assert.equal(hydrated, 2000, 'socket backpressure bounds snapshot hydration to one batch');
        assert.equal(state.released, 0, 'the snapshot stays available while socket output is blocked');
        assert.equal(f.responses.length, 0);
        assert.throws(() => f.worker.assertRouteMutationsAvailable());
        releaseDrain();
        await pending;
        assert.equal(state.calls.length, 1);
        assert.equal(state.calls[0][1].snapshot, true);
        assert.equal(state.released, 1);
        assert.equal(hydrated, 4101);
        assert.equal(f.withdrawn().length, 4101);
        assert.equal(f.withdrawn().filter(route => route.dqpn === null || route.dqpn === undefined).length, 1);
        assert.equal(f.responses.at(-1).data.deleted, 4101);
        assert.equal(f.errors.length, 0);
        assert.equal(f.resetCount, 0, 'sequential batches do not request a session reset');
        assert.equal(f.worker.bulkRouteMutation, null);
        assert.equal(f.store.getStatus().attributes, 0);
    } finally {
        f.store.close();
    }

    f = fixture();
    try {
        f.replace('failure', qpRoutes(3));
        const state = trackRelease(f.store, 'withdrawRouteGroup');
        f.instance.withdrawRoute = () => {
            throw new Error('injected withdrawal failure');
        };
        await assert.rejects(
            f.worker.withdrawRouteGroup('failure', { groupId: 'failure' }),
            /injected withdrawal failure/
        );
        assert.equal(state.released, 1, 'a failed sender still releases the deletion snapshot');
        assert.equal(f.instance.routeMap.size, 0);
        assert.equal(f.worker.pendingRouteGroupMutations, 0);
        f.replace('all-failure', qpRoutes(3));
        const allState = trackRelease(f.store, 'withdrawInstanceRoutes');
        await f.worker.deleteAllRoutesByFamily('all-failure', { addressFamily: f.addressFamily });
        assert.equal(allState.released, 1);
        assert.match(f.errors.at(-1).message, /injected withdrawal failure/);
        assert.equal(f.responses.length, 0);
        assert.equal(f.worker.bulkRouteMutation, null, 'a failed bulk sender releases the mutation lock');
    } finally {
        f.store.close();
    }

    f = fixture(BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN);
    try {
        const entry = route => ({ route: { rd: '65000:1', ...route }, attr: configuredAttr });
        f.replace('mixed-types', [
            entry({ routeType: 1, originatingRouterIp: '192.0.2.8' }),
            entry({ routeType: 2, sourceAs: 0 })
        ]);
        await f.worker.deleteAllRoutesByFamily('one-type', { addressFamily: f.addressFamily, routeType: 2 });
        assert.equal(f.instance.routeMap.size, 1);
        assert.equal(f.store.listRouteGroups()[0].routeCount, 1, 'partial deletion updates the owning group count');
        assert.equal(f.store.getRouteGroupRoutes('mixed-types')[0].routeType, 1);
        assert.equal(f.withdrawn().length, 1);
        assert.equal(
            f.withdrawn()[0].rawNlri.slice(16),
            '00000000',
            'snapshot policy preserves an explicit zero Source AS'
        );
        await f.worker.deleteAllRoutesByFamily('remaining-type', { addressFamily: f.addressFamily, routeType: 1 });
        assert.equal(f.store.listRouteGroups().length, 0);
        assert.equal(f.store.getStatus().attributes, 0);
        assert.equal(f.errors.length, 0);
    } finally {
        f.store.close();
    }

    f = fixture(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    try {
        f.store.upsertRoutes(
            f.instance.instanceKey,
            [0, 1].map(pathId => ({
                route: { ip: '198.51.100.1', mask: 32, rd: '0:0', pathId },
                attr: configuredAttr
            }))
        );
        const removed = Array.from(f.instance.routeMap.values())[0];
        const snapshot = {
            ...f.store.getRoute(f.instance.instanceKey, removed.routeKey),
            instanceKey: f.instance.instanceKey
        };
        f.instance.deleteRouteBatch([removed.routeKey]);
        await f.worker.withdrawStoredGroupRoutes([snapshot]);
        assert.equal(f.sent.length, 0, 'a surviving path suppresses withdrawal for a peer without ADD-PATH');
    } finally {
        f.store.close();
    }
    console.log('BGP bulk deletion tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
