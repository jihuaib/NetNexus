const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { freezeCanonicalAttr, isImmutableCanonicalAttr } = require('../../electron/worker/bgp/bgpPathAttrStore');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-attribute-encoding-'));
const store = new BgpRouteSqliteStore(path.join(directory, 'routes.sqlite'));
const instance = new BgpInstance(0, 2, 241, store);
const worker = new BgpWorker();
worker.routeStore = store;
worker.bgpInstanceMap.set(instance.instanceKey, instance);
worker.messageHandler.sendSuccessResponse = () => {};
const packets = [];
const session = {
    localIp: '192.0.2.254',
    localAs: 65000,
    peerIp: '192.0.2.1',
    peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
    localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
    isAddPathSendEnabled: () => false,
    processCustomPkt: value => Buffer.from(value, 'hex'),
    buildBgpMessageHeader(length, type) {
        const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
        header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
        header[BgpConst.BGP_MARKER_LEN + 2] = type;
        return header;
    },
    sendRoute: buffer => packets.push(Buffer.from(buffer))
};
const peer = new BgpPeer(session, instance);
peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
instance.peerMap.set(session.peerIp, peer);

async function main() {
    const configured = {
        attributePolicy: 'configured',
        configuredAttributes: ['asPath', 'med'],
        pathAttributes: [
            { type: 'asPath', value: '64512' },
            { type: 'med', value: 10 },
            { type: 'med', value: 20 }
        ]
    };
    const route = { _routeAttr: configured, ip: '2001:db8::1', mask: 128, dqpn: 1, mpNextHop: '2001:db8::2' };
    let encoded = 0;
    const encode = peer.buildConfiguredPathAttribute;
    peer.buildConfiguredPathAttribute = function counted(entry) {
        encoded += 1;
        return encode.call(this, entry);
    };
    const first = peer.buildRoutePathAttributes(route);
    assert.equal(encoded, 3);
    assert.deepEqual(peer.buildRoutePathAttributes(route), first);
    assert.equal(encoded, 3, 'identical descriptors reuse the encoded bytes');
    peer.buildRoutePathAttributes(route).fill(0);
    assert.deepEqual(peer.buildRoutePathAttributes(route), first, 'callers cannot mutate cached bytes');
    configured.pathAttributes[1].value = 11;
    const changed = peer.buildRoutePathAttributes(route);
    assert.notDeepEqual(changed, first, 'in-place descriptor edits must invalidate the cache');
    assert.equal(encoded, 6);
    session.localAs = 65001;
    assert.notDeepEqual(peer.buildRoutePathAttributes(route), changed, 'AS prepending follows current session values');
    assert.equal(encoded, 9);
    session.localCapFlags = 0;
    assert.notDeepEqual(peer.buildRoutePathAttributes(route), changed, 'ASN width follows current capabilities');
    session.localCapFlags = BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS;

    for (let value = 0; value < 100; value += 1) {
        configured.pathAttributes[1].value = value;
        peer.buildRoutePathAttributes(route);
    }
    assert.ok(peer.configuredAttributeEncodingCache.size <= 64, 'variable attributes keep memory bounded');

    const immutable = freezeCanonicalAttr(configured);
    assert.ok(isImmutableCanonicalAttr(immutable));
    assert.ok(Object.isFrozen(immutable.pathAttributes));
    assert.ok(immutable.pathAttributes.every(Object.isFrozen));
    assert.equal(freezeCanonicalAttr(immutable), immutable);
    const callerValue = { nested: { value: 1 } };
    const nestedSnapshot = freezeCanonicalAttr({
        attributePolicy: 'configured',
        pathAttributes: [{ type: 'custom', value: callerValue }]
    });
    callerValue.nested.value = 2;
    assert.equal(nestedSnapshot.pathAttributes[0].value.nested.value, 1, 'freezing never retains caller-owned objects');
    assert.equal(Object.isFrozen(callerValue.nested), false);
    const stored = { ...route, routeAttr: immutable };
    assert.equal(instance.hydrateRoute(stored)._routeAttr, immutable, 'explicit immutable snapshots can be shared');
    const mutable = instance.hydrateRoute({ ...route, routeAttr: configured })._routeAttr;
    assert.notEqual(mutable, configured, 'ordinary reads still receive independent mutable attributes');
    configured.pathAttributes[1].value = 101;
    assert.notEqual(mutable.pathAttributes[1].value, 101);
    assert.notEqual(immutable.pathAttributes[1].value, 101);
    const immutableRoute = { ...route, _routeAttr: immutable };
    assert.deepEqual(
        peer.getOutboundRouteAttrGroupKey(immutableRoute),
        peer.getOutboundRouteAttrGroupKey({ ...route, _routeAttr: JSON.parse(JSON.stringify(immutable)) }),
        'immutable grouping uses the same canonical key as ordinary attributes'
    );
    const originalGroupKey = peer.getOutboundRouteAttrGroupKey(immutableRoute);
    immutableRoute.mpNextHop = '2001:db8::3';
    assert.notEqual(
        peer.getOutboundRouteAttrGroupKey(immutableRoute),
        originalGroupKey,
        'NLRI next hop remains dynamic'
    );
    const nextHop = peer.getIpv6NlriNextHopBytes('2001:db8::2');
    peer.getIpv6NlriNextHopBytes('2001:db8::2').fill(0);
    assert.deepEqual(
        peer.getIpv6NlriNextHopBytes('2001:db8::2'),
        nextHop,
        'next-hop callers cannot mutate cached bytes'
    );

    const config = {
        groupId: 'encoding-cache',
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV6_QP,
        prefix: '2001:db8::1',
        mask: 128,
        count: 32,
        attributeRules: [
            { type: 'asPath', value: '64512' },
            { type: 'med', value: 10 },
            { type: 'med', value: 20 }
        ],
        nlriRules: [
            { type: 'dqpn', mode: 'increment', start: 1, step: 1 },
            { type: 'bsid', value: '2001:db8::2' }
        ]
    };
    await worker.generateQpRoutes('generate', config);
    const parse = buffer => {
        const packet = parseBgpPacket(buffer, { asnSize: 4 });
        assert.ok(packet.valid, packet.error);
        assert.deepEqual(
            packet.pathAttributes
                .filter(attribute => attribute.typeCode === BgpConst.BGP_PATH_ATTR.MED)
                .map(a => a.value),
            [Buffer.from([0, 0, 0, 10]), Buffer.from([0, 0, 0, 20])],
            'repeated attributes retain their configured order'
        );
        return packet.pathAttributes.find(attribute => attribute.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI)
            .mpReach.nlri;
    };
    assert.equal(packets.flatMap(parse).length, 32);
    packets.length = 0;
    await worker.generateQpRoutes('regenerate', config);
    assert.equal(packets.flatMap(parse).length, 32, 'unchanged regeneration still announces the complete group');

    const snapshot = store.getRouteGroupRoutes(config.groupId);
    packets.length = 0;
    const buildNlri = peer.buildQpNlri;
    peer.buildQpNlri = function failLater(candidate) {
        if (candidate.dqpn === 17) throw new Error('invalid later NLRI');
        return buildNlri.call(this, candidate);
    };
    await assert.rejects(worker.generateQpRoutes('invalid-nlri', config));
    assert.deepEqual(store.getRouteGroupRoutes(config.groupId), snapshot, 'every NLRI remains validated atomically');
    assert.equal(packets.length, 0);
    peer.buildQpNlri = buildNlri;
    await assert.rejects(
        worker.generateQpRoutes('oversize', {
            ...config,
            attributeRules: [{ type: 'custom', value: '00'.repeat(4096) }]
        })
    );
    assert.deepEqual(
        store.getRouteGroupRoutes(config.groupId),
        snapshot,
        'oversized attributes preserve the old group'
    );
    assert.equal(packets.length, 0);
    console.log('BGP configured attribute encoding cache tests passed');
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
