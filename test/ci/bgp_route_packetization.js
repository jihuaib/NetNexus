const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const BgpPeer = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpPeer.js'));
const BgpInstance = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpInstance.js'));
const BgpRoute = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpRoute.js'));
const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const { parseBgpPacket } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bgpPacketParser.js'));

const ROUTE_COUNT = 5000;
const IPV4_UNICAST_ROUTES_PER_FULL_PACKET = 808;
const IPV4_UNICAST_FULL_PACKET_LEN = 4091;
const QP_ROUTES_PER_FULL_PACKET = 402;
const QP_FULL_PACKET_LEN = 4089;
const QP_FIXED_DQPN = 7;

function buildBgpMessageHeader(length, type) {
    const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
    header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
    header[BgpConst.BGP_MARKER_LEN + 2] = type;
    return header;
}

function ipv4FromNumber(value) {
    return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function expectedPacketCounts(total, perFullPacket) {
    const counts = [];
    let rest = total;
    while (rest > 0) {
        const count = Math.min(rest, perFullPacket);
        counts.push(count);
        rest -= count;
    }
    return counts;
}

function createPeer(instance, sentBuffers) {
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerAs: 65001,
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
        buildBgpMessageHeader,
        processCustomPkt: () => [],
        sendRoute: buffer => sentBuffers.push(Buffer.from(buffer))
    };

    const peer = new BgpPeer(session, instance);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    return peer;
}

function addIpv4UnicastRoute(instance, ip) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 32;
    instance.setRoute(BgpRoute.makeKey(route.ip, route.mask), route);
}

function addQpRoute(instance, ip, nextHop) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 32;
    route.dqpn = QP_FIXED_DQPN;
    instance.setRoute(BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask), route, { nextHop });
}

function getMpReach(packet) {
    const attr = packet.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI);
    assert.ok(attr, 'MP_REACH_NLRI attribute must exist');
    assert.ok(attr.mpReach, 'MP_REACH_NLRI must be parsed');
    return attr.mpReach;
}

function assertPacketLengths(buffers) {
    for (const buffer of buffers) {
        assert.ok(buffer.length <= BgpConst.BGP_MAX_PKT_SIZE, `UPDATE length ${buffer.length} exceeds max packet size`);
    }
}

function assertAttrStoreSize(instance, expectedSize) {
    assert.strictEqual(instance.attrStore.attrMap.size, expectedSize, 'attr store entry count should match groups');
    assert.strictEqual(instance.attrRouteIndex.size, expectedSize, 'attr route index group count should match attrs');
}

function assertPathAttrTypes(packet, expectedTypes) {
    assert.deepStrictEqual(
        packet.pathAttributes.map(attr => attr.typeCode),
        expectedTypes,
        'path attribute sequence should match expected encoding'
    );
}

function assertFullPacketLengths(buffers, counts, fullCount, fullLength) {
    counts.forEach((count, index) => {
        if (count === fullCount) {
            assert.strictEqual(buffers[index].length, fullLength, 'full UPDATE should be packed to expected length');
        }
    });
}

function assertMultiplePacketPacking(buffers, counts, fullCount, label) {
    assert.ok(buffers.length > 1, `${label} should be split into multiple UPDATE packets`);
    assert.ok(
        counts.filter(count => count === fullCount).length > 1,
        `${label} should produce more than one full UPDATE packet`
    );
    assert.ok(
        counts[counts.length - 1] < fullCount,
        `${label} should keep the remaining routes in a tail UPDATE packet`
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(instance, sentBuffers);
    const baseIp = (10 << 24) + 1;

    for (let index = 0; index < ROUTE_COUNT; index++) {
        addIpv4UnicastRoute(instance, ipv4FromNumber(baseIp + index));
    }

    assertAttrStoreSize(instance, 1);
    peer.sendRoute();
    assertPacketLengths(sentBuffers);

    const packets = sentBuffers.map(buffer => parseBgpPacket(buffer));
    const counts = packets.map(packet => packet.nlri.length);
    assert.deepStrictEqual(
        counts,
        expectedPacketCounts(ROUTE_COUNT, IPV4_UNICAST_ROUTES_PER_FULL_PACKET),
        'continuous IPv4 routes should be packed to full UPDATEs before the tail packet'
    );
    assert.strictEqual(
        counts.reduce((sum, count) => sum + count, 0),
        ROUTE_COUNT,
        'all continuous IPv4 routes should be present after parsing sent UPDATEs'
    );
    assertMultiplePacketPacking(sentBuffers, counts, IPV4_UNICAST_ROUTES_PER_FULL_PACKET, 'continuous IPv4 routes');

    for (const packet of packets) {
        assertPathAttrTypes(packet, [
            BgpConst.BGP_PATH_ATTR.ORIGIN,
            BgpConst.BGP_PATH_ATTR.AS_PATH,
            BgpConst.BGP_PATH_ATTR.NEXT_HOP,
            BgpConst.BGP_PATH_ATTR.MED,
            BgpConst.BGP_PATH_ATTR.LOCAL_PREF
        ]);
    }
    assertFullPacketLengths(sentBuffers, counts, IPV4_UNICAST_ROUTES_PER_FULL_PACKET, IPV4_UNICAST_FULL_PACKET_LEN);
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_QP);
    const sentBuffers = [];
    const peer = createPeer(instance, sentBuffers);
    const nextHop = '2001:db8::100';
    const baseIp = (10 << 24) + (64 << 16) + 1;

    for (let index = 0; index < ROUTE_COUNT; index++) {
        addQpRoute(instance, ipv4FromNumber(baseIp + index), nextHop);
    }

    assertAttrStoreSize(instance, 1);
    peer.sendRoute();
    assertPacketLengths(sentBuffers);

    const packets = sentBuffers.map(buffer => parseBgpPacket(buffer));
    const reaches = packets.map(getMpReach);
    const counts = reaches.map(reach => reach.nlri.length);
    assert.deepStrictEqual(
        counts,
        expectedPacketCounts(ROUTE_COUNT, QP_ROUTES_PER_FULL_PACKET),
        'continuous QP routes with the same BSID should be packed to full UPDATEs before the tail packet'
    );
    assert.strictEqual(
        counts.reduce((sum, count) => sum + count, 0),
        ROUTE_COUNT,
        'all continuous QP routes should be present after parsing sent UPDATEs'
    );
    assertMultiplePacketPacking(sentBuffers, counts, QP_ROUTES_PER_FULL_PACKET, 'continuous QP routes');

    packets.forEach((packet, index) => {
        assertPathAttrTypes(packet, [
            BgpConst.BGP_PATH_ATTR.ORIGIN,
            BgpConst.BGP_PATH_ATTR.AS_PATH,
            BgpConst.BGP_PATH_ATTR.MED,
            BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
            BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI
        ]);
        assert.strictEqual(reaches[index].nextHop, nextHop, 'QP MP_REACH next-hop should match the route attribute');
    });
    assertFullPacketLengths(sentBuffers, counts, QP_ROUTES_PER_FULL_PACKET, QP_FULL_PACKET_LEN);
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_QP);
    const sentBuffers = [];
    const peer = createPeer(instance, sentBuffers);
    const nextHopA = '2001:db8::a';
    const nextHopB = '2001:db8::b';
    const baseIp = (10 << 24) + (128 << 16) + 1;

    for (let index = 0; index < ROUTE_COUNT; index++) {
        addQpRoute(instance, ipv4FromNumber(baseIp + index), index % 2 === 0 ? nextHopA : nextHopB);
    }

    assertAttrStoreSize(instance, 2);
    peer.sendRoute();
    assertPacketLengths(sentBuffers);

    const parsedByNextHop = new Map();
    for (const buffer of sentBuffers) {
        const packet = parseBgpPacket(buffer);
        const reach = getMpReach(packet);
        assertPathAttrTypes(packet, [
            BgpConst.BGP_PATH_ATTR.ORIGIN,
            BgpConst.BGP_PATH_ATTR.AS_PATH,
            BgpConst.BGP_PATH_ATTR.MED,
            BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
            BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI
        ]);
        if (!parsedByNextHop.has(reach.nextHop)) {
            parsedByNextHop.set(reach.nextHop, { counts: [], lengths: [] });
        }
        parsedByNextHop.get(reach.nextHop).counts.push(reach.nlri.length);
        parsedByNextHop.get(reach.nextHop).lengths.push(buffer.length);
    }

    const expectedGroupCounts = expectedPacketCounts(ROUTE_COUNT / 2, QP_ROUTES_PER_FULL_PACKET);
    assert.deepStrictEqual(
        parsedByNextHop.get(nextHopA)?.counts,
        expectedGroupCounts,
        'interleaved QP routes with nextHop A should be regrouped and packed independently'
    );
    assert.deepStrictEqual(
        parsedByNextHop.get(nextHopB)?.counts,
        expectedGroupCounts,
        'interleaved QP routes with nextHop B should be regrouped and packed independently'
    );
    assert.strictEqual(
        [...parsedByNextHop.values()].reduce((sum, group) => sum + group.counts.reduce((a, b) => a + b, 0), 0),
        ROUTE_COUNT,
        'all interleaved QP routes should be present after parsing sent UPDATEs'
    );

    for (const group of parsedByNextHop.values()) {
        assertMultiplePacketPacking(
            new Array(group.lengths.length),
            group.counts,
            QP_ROUTES_PER_FULL_PACKET,
            'interleaved QP routes in one attr group'
        );
        group.counts.forEach((count, index) => {
            if (count === QP_ROUTES_PER_FULL_PACKET) {
                assert.strictEqual(
                    group.lengths[index],
                    QP_FULL_PACKET_LEN,
                    'full interleaved QP UPDATE length should match'
                );
            }
        });
    }
}

console.log('BGP route packetization tests passed');
