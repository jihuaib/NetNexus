const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const BgpPeer = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpPeer.js'));
const BgpInstance = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpInstance.js'));
const BgpRoute = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpRoute.js'));
const BgpSession = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpSession.js'));
const BgpWorker = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpWorker.js'));
const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const { parseBgpPacket } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bgpPacketParser.js'));

const ROUTE_COUNT = 5000;
const IPV4_UNICAST_ROUTES_PER_FULL_PACKET = 808;
const IPV4_UNICAST_FULL_PACKET_LEN = 4091;
const QP_ROUTES_PER_FULL_PACKET = 402;
const QP_FULL_PACKET_LEN = 4089;
const QP_FIXED_DQPN = 7;
const SRV6_IPV6_PEER_SESSION_OVERRIDES = {
    localIp: '2001:db8::fe',
    peerIp: '2001:db8::1',
    localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS | BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING
};

function buildBgpMessageHeader(length, type) {
    const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
    header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
    header[BgpConst.BGP_MARKER_LEN + 2] = type;
    return header;
}

function buildRouteRefreshMessage(afi, safi) {
    return Buffer.concat([
        buildBgpMessageHeader(BgpConst.BGP_HEAD_LEN + 4, BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH),
        Buffer.from([(afi >> 8) & 0xff, afi & 0xff, 0x00, safi])
    ]);
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

function createPeer(instance, sentBuffers, addressFamilyOptions = {}, sessionOverrides = {}) {
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerAs: 65001,
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
        buildBgpMessageHeader,
        processCustomPkt: () => [],
        sendRoute: buffer => sentBuffers.push(Buffer.from(buffer)),
        ...sessionOverrides
    };

    const peer = new BgpPeer(session, instance, addressFamilyOptions);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    return peer;
}

function addIpv4UnicastRoute(instance, ip) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 32;
    instance.setRoute(BgpRoute.makeKey(route.ip, route.mask), route);
}

function addIpv4UnicastPathRoute(instance, ip, pathId, attr = {}) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 32;
    route.rd = '0:0';
    route.pathId = pathId;
    instance.setRoute(BgpRoute.makeUnicastKey(route.pathId, route.rd, route.ip, route.mask), route, attr);
}

function addQpRoute(instance, ip, nextHop) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 32;
    route.dqpn = QP_FIXED_DQPN;
    instance.setRoute(BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask), route, { nextHop });
}

function addIpv4LabelRoute(instance, ip, label) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 32;
    route.label = label;
    instance.setRoute(BgpRoute.makeKey(route.ip, route.mask), route);
}

function addIpv6Route(instance, ip, attr = {}) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 128;
    instance.setRoute(BgpRoute.makeKey(route.ip, route.mask), route, attr);
}

function addIpv6PathRoute(instance, ip, pathId, attr = {}) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 128;
    route.rd = '0:0';
    route.pathId = pathId;
    instance.setRoute(BgpRoute.makeUnicastKey(route.pathId, route.rd, route.ip, route.mask), route, attr);
}

function getMpReach(packet) {
    const attr = packet.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI);
    assert.ok(attr, 'MP_REACH_NLRI attribute must exist');
    assert.ok(attr.mpReach, 'MP_REACH_NLRI must be parsed');
    return attr.mpReach;
}

function getPrefixSid(packet) {
    const attr = packet.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID);
    assert.ok(attr, 'PREFIX_SID attribute must exist');
    assert.ok(attr.prefixSid, 'PREFIX_SID must be parsed');
    return attr.prefixSid;
}

function getMpUnreach(packet) {
    const attr = packet.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI);
    assert.ok(attr, 'MP_UNREACH_NLRI attribute must exist');
    assert.ok(attr.mpUnreach, 'MP_UNREACH_NLRI must be parsed');
    return attr.mpUnreach;
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

const ADD_PATH_PARSE_CONTEXT = {
    getAddPathReceiveInfo: () => ({ enabled: true }),
    isAddPathReceiveEnabled: () => true
};

const IPV4_ONLY_ADD_PATH_PARSE_CONTEXT = {
    getAddPathReceiveInfo: (afi, safi) => ({
        enabled: afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    }),
    isAddPathReceiveEnabled: (afi, safi) =>
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
};

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
    const session = new BgpSession(0, '192.0.2.1', new Map(), { sendEvent: () => {} });
    session.localAs = 65000;
    session.holdTime = 90;
    session.routerId = '192.0.2.254';
    session.localCapFlags = BgpConst.BGP_CAP_FLAGS.MULTIPROTOCOL_EXTENSIONS;
    session.localAddrFamilyFlags = BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_LABEL_UNICAST;

    const packet = parseBgpPacket(session.buildOpenMsg());
    assert.ok(
        packet.capabilities.some(
            cap =>
                cap.code === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS &&
                cap.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
                cap.safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
        ),
        'OPEN should advertise IPv4 labeled-unicast multiprotocol capability'
    );
}

{
    const session = new BgpSession(0, '192.0.2.1', new Map(), { sendEvent: () => {} });
    session.localAs = 65000;
    session.holdTime = 90;
    session.routerId = '192.0.2.254';
    session.localCapFlags = BgpConst.BGP_CAP_FLAGS.MULTIPROTOCOL_EXTENSIONS | BgpConst.BGP_CAP_FLAGS.ADD_PATH;
    session.localAddrFamilyFlags =
        BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_UNC | BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_UNC;
    session.setLocalAddPath(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE
    );
    session.setLocalAddPath(
        BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE
    );

    const packet = parseBgpPacket(session.buildOpenMsg());
    const addPathCap = packet.capabilities.find(cap => cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH);
    assert.ok(addPathCap, 'OPEN should advertise ADD-PATH only when locally enabled');
    assert.deepStrictEqual(
        addPathCap.addPaths,
        [
            {
                afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                sendReceive: BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE
            },
            {
                afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
                safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                sendReceive: BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE
            }
        ],
        'OPEN ADD-PATH capability should carry IPv4 and IPv6 unicast tuples'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const session = new BgpSession(0, '192.0.2.1', new Map(), { sendEvent: () => {} });
    const peer = new BgpPeer(session, instance);
    const afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
    const safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;

    assert.deepStrictEqual(
        {
            send: peer.getPeerInfo().addPathSendEnabled,
            receive: peer.getPeerInfo().addPathReceiveEnabled
        },
        { send: false, receive: false },
        'peer info should report ADD-PATH as not negotiated by default'
    );

    session.setLocalAddPath(afi, safi, BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE);
    session.setPeerAddPath(afi, safi, BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE);
    assert.deepStrictEqual(
        {
            send: peer.getPeerInfo().addPathSendEnabled,
            receive: peer.getPeerInfo().addPathReceiveEnabled
        },
        { send: true, receive: true },
        'peer info should report bidirectional ADD-PATH negotiation'
    );

    session.setPeerAddPath(afi, safi, BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY);
    assert.deepStrictEqual(
        {
            send: peer.getPeerInfo().addPathSendEnabled,
            receive: peer.getPeerInfo().addPathReceiveEnabled
        },
        { send: true, receive: false },
        'peer info should report ADD-PATH send-only negotiation'
    );

    session.setPeerAddPath(afi, safi, BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY);
    assert.deepStrictEqual(
        {
            send: peer.getPeerInfo().addPathSendEnabled,
            receive: peer.getPeerInfo().addPathReceiveEnabled
        },
        { send: false, receive: true },
        'peer info should report ADD-PATH receive-only negotiation'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const instanceMap = new Map([
        [BgpInstance.makeKey(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST), instance]
    ]);
    const session = new BgpSession(0, '192.0.2.1', instanceMap, { sendEvent: () => {} });
    let requesterSendCount = 0;
    let otherSendCount = 0;
    instance.peerMap.set('192.0.2.1', { sendRoute: () => requesterSendCount++ });
    instance.peerMap.set('192.0.2.2', { sendRoute: () => otherSendCount++ });

    session.recvMsg(buildRouteRefreshMessage(BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST));

    assert.strictEqual(requesterSendCount, 1, 'Route-Refresh should resend routes to the requesting peer');
    assert.strictEqual(otherSendCount, 0, 'Route-Refresh must not resend routes to other peers in the same AFI/SAFI');
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    instance.rt = '65000:100';
    instance.customAttr = 'origin incomplete';
    const worker = Object.create(BgpWorker.prototype);
    worker.bgpInstanceMap = new Map([
        [BgpInstance.makeKey(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST), instance]
    ]);
    const responses = [];
    const errors = [];
    worker.messageHandler = {
        sendSuccessResponse: (messageId, data, msg) => responses.push({ messageId, data, msg }),
        sendErrorResponse: (messageId, msg) => errors.push({ messageId, msg })
    };

    worker.importRoutes('import-route-without-page-rt', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        announce: false,
        routes: [
            {
                ip: '203.0.113.200',
                mask: 32,
                asPath: '65001'
            }
        ]
    });

    assert.deepStrictEqual(errors, [], 'importing ordinary route should not report errors');
    assert.strictEqual(responses.length, 1, 'importing ordinary route should report success');
    const importedRoute = instance.routeMap.get(BgpRoute.makeUnicastKey(0, '0:0', '203.0.113.200', 32));
    assert.ok(importedRoute, 'imported unicast route should use default RD and path-id');
    const importedRouteAttr = instance.getRouteAttr(importedRoute);
    assert.strictEqual(importedRouteAttr.asPath, '65001', 'imported route should keep MRT AS_PATH');
    assert.strictEqual(importedRouteAttr.rt, '', 'imported route attributes must not inherit page-level RT');
    assert.strictEqual(
        importedRouteAttr.customAttr,
        '',
        'imported route attributes must not inherit page-level custom attributes'
    );

    worker.getRouteDetail('import-route-detail-without-page-rt', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        route: {
            ip: '203.0.113.200',
            mask: 32,
            rd: '0:0',
            pathId: 0
        }
    });
    assert.strictEqual(responses.length, 2, 'route detail query should report success');
    assert.strictEqual(responses[1].data.rt, '', 'imported route detail must not inherit page-level RT');
    assert.strictEqual(
        responses[1].data.customAttr,
        '',
        'imported route detail must not inherit page-level custom attributes'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(instance, sentBuffers);

    addIpv4LabelRoute(instance, '10.10.0.1', 16000);
    addIpv4LabelRoute(instance, '10.10.0.2', 16001);

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'small IPv4 label route set should fit in one UPDATE');

    const packet = parseBgpPacket(sentBuffers[0]);
    const reach = getMpReach(packet);
    assert.strictEqual(reach.afi, BgpConst.BGP_AFI_TYPE.AFI_IPV4);
    assert.strictEqual(reach.safi, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST);
    assert.strictEqual(reach.nextHop, '192.0.2.254');
    assert.deepStrictEqual(
        reach.nlri.map(route => ({
            prefix: route.prefix,
            length: route.length,
            label: route.labels[0].label,
            bottom: route.labels[0].bottom
        })),
        [
            { prefix: '10.10.0.1', length: 32, label: 16000, bottom: true },
            { prefix: '10.10.0.2', length: 32, label: 16001, bottom: true }
        ],
        'IPv4 labeled-unicast MP_REACH should carry label stack and prefix'
    );

    const withdrawnBuffers = [];
    peer.session.sendRoute = buffer => withdrawnBuffers.push(Buffer.from(buffer));
    peer.withdrawRoute(Array.from(instance.routeMap.values()));
    assertPacketLengths(withdrawnBuffers);
    assert.strictEqual(withdrawnBuffers.length, 1, 'small IPv4 label withdraw set should fit in one UPDATE');

    const withdraw = getMpUnreach(parseBgpPacket(withdrawnBuffers[0]));
    assert.strictEqual(withdraw.afi, BgpConst.BGP_AFI_TYPE.AFI_IPV4);
    assert.strictEqual(withdraw.safi, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST);
    assert.deepStrictEqual(
        withdraw.withdrawnRoutes.map(route => ({ prefix: route.prefix, length: route.length })),
        [
            { prefix: '10.10.0.1', length: 32 },
            { prefix: '10.10.0.2', length: 32 }
        ],
        'IPv4 labeled-unicast MP_UNREACH should carry withdraw prefixes'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(instance, sentBuffers, { sendSrv6PrefixSid: true }, SRV6_IPV6_PEER_SESSION_OVERRIDES);

    addIpv6Route(instance, '2001:db8:100::1', {
        srv6Sid: '2001:db8:1::1',
        srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6
    });
    addIpv6Route(instance, '2001:db8:100::2', {
        srv6Sid: '2001:db8:1::1',
        srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6
    });

    assertAttrStoreSize(instance, 1);
    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(
        sentBuffers.length,
        1,
        'IPv6 SRv6 routes with the same SID should share one UPDATE for an IPv6 peer session'
    );

    const packet = parseBgpPacket(sentBuffers[0]);
    const reach = getMpReach(packet);
    const prefixSid = getPrefixSid(packet);
    assert.strictEqual(reach.afi, BgpConst.BGP_AFI_TYPE.AFI_IPV6);
    assert.strictEqual(reach.safi, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    assert.deepStrictEqual(
        reach.nlri.map(route => route.prefix),
        ['2001:db8:100::1', '2001:db8:100::2'],
        'IPv6 SRv6 MP_REACH should carry IPv6 prefixes'
    );
    assert.strictEqual(prefixSid.srv6Services.length, 1);
    assert.strictEqual(prefixSid.srv6Services[0].serviceType, 'l3');
    assert.strictEqual(prefixSid.srv6Services[0].sidInfos[0].sid, '2001:db8:1::1');
    assert.strictEqual(prefixSid.srv6Services[0].sidInfos[0].endpointBehaviorName, 'End.DT6');
    assert.ok(
        packet.pathAttributes.map(attr => attr.typeCode).includes(BgpConst.BGP_PATH_ATTR.PREFIX_SID),
        'IPv6 SRv6 route sent to an IPv6 peer session should carry Prefix-SID'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(instance, sentBuffers, { sendSrv6PrefixSid: true }, SRV6_IPV6_PEER_SESSION_OVERRIDES);

    addIpv6Route(instance, '2001:db8:200::1', {
        srv6Sid: '2001:db8:2::1',
        srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6
    });
    addIpv6Route(instance, '2001:db8:200::2', {
        srv6Sid: '2001:db8:2::2',
        srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6
    });

    assertAttrStoreSize(instance, 2);
    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 2, 'IPv6 SRv6 routes with different SIDs should use separate UPDATEs');

    const sids = sentBuffers
        .map(buffer => parseBgpPacket(buffer))
        .map(packet => getPrefixSid(packet).srv6Services[0].sidInfos[0].sid)
        .sort();
    assert.deepStrictEqual(sids, ['2001:db8:2::1', '2001:db8:2::2']);
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(instance, sentBuffers, { sendSrv6PrefixSid: false });

    addIpv6Route(instance, '2001:db8:300::1', {
        srv6Sid: '2001:db8:3::1',
        srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6
    });

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'IPv6 route should still be sent when peer SRv6 is disabled');
    const packet = parseBgpPacket(sentBuffers[0]);
    assert.ok(
        !packet.pathAttributes.some(item => item.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID),
        'peer without SRv6 enablement must not receive Prefix-SID'
    );
    assert.deepStrictEqual(
        getMpReach(packet).nlri.map(route => route.prefix),
        ['2001:db8:300::1'],
        'peer without SRv6 enablement should receive the IPv6 route itself'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(
        instance,
        sentBuffers,
        {},
        {
            localIp: '2001:db8::fe',
            peerIp: '2001:db8::1',
            localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS
        }
    );

    addIpv6Route(instance, '2001:db8:350::1');

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'IPv6 peer should receive IPv6-UNC without Extended Next Hop');
    const reach = getMpReach(parseBgpPacket(sentBuffers[0]));
    assert.strictEqual(reach.nextHop, '2001:db8::fe', 'IPv6-UNC over IPv6 peer should use IPv6 local next-hop');
    assert.deepStrictEqual(
        reach.nlri.map(route => route.prefix),
        ['2001:db8:350::1'],
        'IPv6-UNC over IPv6 peer should carry IPv6 NLRI'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(
        instance,
        sentBuffers,
        {},
        {
            localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS | BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING
        }
    );

    addIpv6Route(instance, '2001:db8:360::1');

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'IPv6-UNC should still be sent when Extended Next Hop is enabled');
    const reach = getMpReach(parseBgpPacket(sentBuffers[0]));
    assert.strictEqual(
        reach.nextHop,
        '::ffff:c000:2fe',
        'IPv6-UNC over IPv4 peer should use IPv4-mapped IPv6 next-hop even when Extended Next Hop is enabled'
    );
    assert.deepStrictEqual(
        reach.nlri.map(route => route.prefix),
        ['2001:db8:360::1'],
        'IPv6-UNC with Extended Next Hop enabled should still carry IPv6 NLRI'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const enabledBuffers = [];
    const disabledBuffers = [];
    const enabledPeer = createPeer(
        instance,
        enabledBuffers,
        { sendSrv6PrefixSid: true },
        SRV6_IPV6_PEER_SESSION_OVERRIDES
    );
    const disabledPeer = createPeer(
        instance,
        disabledBuffers,
        { sendSrv6PrefixSid: false },
        SRV6_IPV6_PEER_SESSION_OVERRIDES
    );

    addIpv6Route(instance, '2001:db8:400::1', {
        srv6Sid: '2001:db8:4::1',
        srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6
    });
    addIpv6Route(instance, '2001:db8:400::2', {
        srv6Sid: '2001:db8:4::2',
        srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6
    });

    assertAttrStoreSize(instance, 2);
    enabledPeer.sendRoute();
    disabledPeer.sendRoute();
    assertPacketLengths(enabledBuffers);
    assertPacketLengths(disabledBuffers);

    assert.strictEqual(enabledBuffers.length, 2, 'peer with SRv6 enabled should split routes by SID');
    assert.deepStrictEqual(
        enabledBuffers
            .map(buffer => parseBgpPacket(buffer))
            .map(packet => getPrefixSid(packet).srv6Services[0].sidInfos[0].sid)
            .sort(),
        ['2001:db8:4::1', '2001:db8:4::2'],
        'peer with SRv6 enabled should receive both Prefix-SID values'
    );

    assert.strictEqual(
        disabledBuffers.length,
        1,
        'peer with SRv6 disabled should merge routes that differ only by SID'
    );
    const disabledPacket = parseBgpPacket(disabledBuffers[0]);
    assert.ok(
        !disabledPacket.pathAttributes.some(item => item.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID),
        'peer with SRv6 disabled must not receive Prefix-SID'
    );
    assert.deepStrictEqual(
        getMpReach(disabledPacket).nlri.map(route => route.prefix),
        ['2001:db8:400::1', '2001:db8:400::2'],
        'peer with SRv6 disabled should receive both IPv6 routes in one UPDATE'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(instance, sentBuffers);

    addIpv4UnicastPathRoute(instance, '198.51.100.10', 11);
    addIpv4UnicastPathRoute(instance, '198.51.100.10', 12);

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'non ADD-PATH IPv4 peer should receive one ordinary path');
    const packet = parseBgpPacket(sentBuffers[0]);
    assert.deepStrictEqual(
        packet.nlri.map(route => ({ prefix: route.prefix, length: route.length, pathId: route.pathId })),
        [{ prefix: '198.51.100.10', length: 32, pathId: 0 }],
        'non ADD-PATH IPv4 UPDATE must not encode path identifiers'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(
        instance,
        sentBuffers,
        {},
        {
            isAddPathSendEnabled: (afi, safi) =>
                afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        }
    );

    addIpv4UnicastPathRoute(instance, '198.51.100.20', 21);
    addIpv4UnicastPathRoute(instance, '198.51.100.20', 22);

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'ADD-PATH IPv4 peer should receive both paths in one UPDATE');
    const packet = parseBgpPacket(sentBuffers[0], ADD_PATH_PARSE_CONTEXT);
    assert.deepStrictEqual(
        packet.nlri.map(route => ({ prefix: route.prefix, length: route.length, pathId: route.pathId })),
        [
            { prefix: '198.51.100.20', length: 32, pathId: 21 },
            { prefix: '198.51.100.20', length: 32, pathId: 22 }
        ],
        'ADD-PATH IPv4 UPDATE should keep path-id associated with each prefix'
    );
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const sentBuffers = [];
    const peer = createPeer(
        instance,
        sentBuffers,
        {},
        {
            isAddPathSendEnabled: (afi, safi) =>
                afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        }
    );

    addIpv6PathRoute(instance, '2001:db8:700::1', 31);
    addIpv6PathRoute(instance, '2001:db8:700::1', 32);

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'ADD-PATH IPv6 peer should receive both paths in one MP_REACH');
    const reach = getMpReach(parseBgpPacket(sentBuffers[0], ADD_PATH_PARSE_CONTEXT));
    assert.deepStrictEqual(
        reach.nlri.map(route => ({ prefix: route.prefix, length: route.length, pathId: route.pathId })),
        [
            { prefix: '2001:db8:700::1', length: 128, pathId: 31 },
            { prefix: '2001:db8:700::1', length: 128, pathId: 32 }
        ],
        'ADD-PATH IPv6 MP_REACH should keep path-id associated with each prefix'
    );
}

{
    const prefixCount = 1000;
    const pathCount = 10;
    const ipv4BaseIp = (198 << 24) + (51 << 16) + (110 << 8) + 1;
    const addPathSendEnabled = (afi, safi) =>
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
    const ipv4Instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const ipv6Instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const ipv4Buffers = [];
    const ipv6Buffers = [];
    const sessionOverrides = {
        isAddPathSendEnabled: addPathSendEnabled
    };
    const ipv4Peer = createPeer(ipv4Instance, ipv4Buffers, {}, sessionOverrides);
    const ipv6Peer = createPeer(ipv6Instance, ipv6Buffers, {}, sessionOverrides);

    for (let prefixIndex = 0; prefixIndex < prefixCount; prefixIndex++) {
        const ipv4Prefix = ipv4FromNumber(ipv4BaseIp + prefixIndex);
        const ipv6Prefix = `2001:db8:710::${(prefixIndex + 1).toString(16)}`;
        for (let pathId = 0; pathId < pathCount; pathId++) {
            addIpv4UnicastPathRoute(ipv4Instance, ipv4Prefix, pathId);
            addIpv6PathRoute(ipv6Instance, ipv6Prefix, pathId);
        }
    }

    assert.strictEqual(
        ipv4Instance.routeMap.size,
        prefixCount * pathCount,
        'IPv4 ADD-PATH test should generate all prefix/path-id routes'
    );
    assert.strictEqual(
        ipv6Instance.routeMap.size,
        prefixCount * pathCount,
        'IPv6 non-ADD-PATH test should still have generated path-id routes locally'
    );

    ipv4Peer.sendRoute();
    ipv6Peer.sendRoute();
    assertPacketLengths(ipv4Buffers);
    assertPacketLengths(ipv6Buffers);
    assert.ok(ipv4Buffers.length > 1, 'IPv4 ADD-PATH peer should split many IPv4 UPDATEs');
    assert.ok(ipv6Buffers.length > 1, 'IPv6 non-ADD-PATH peer should split many IPv6 UPDATEs');

    const ipv4Nlri = ipv4Buffers.flatMap(buffer => parseBgpPacket(buffer, IPV4_ONLY_ADD_PATH_PARSE_CONTEXT).nlri);
    assert.strictEqual(
        ipv4Nlri.length,
        prefixCount * pathCount,
        'IPv4 ADD-PATH enablement should send every generated prefix/path-id route'
    );
    ipv4Nlri.forEach((route, index) => {
        const prefixIndex = Math.floor(index / pathCount);
        const expectedPathId = index % pathCount;
        assert.deepStrictEqual(
            { prefix: route.prefix, length: route.length, pathId: route.pathId },
            { prefix: ipv4FromNumber(ipv4BaseIp + prefixIndex), length: 32, pathId: expectedPathId },
            'IPv4 ADD-PATH enablement should encode path identifiers without affecting order'
        );
    });

    const ipv6Nlri = ipv6Buffers.flatMap(
        buffer => getMpReach(parseBgpPacket(buffer, IPV4_ONLY_ADD_PATH_PARSE_CONTEXT)).nlri
    );
    assert.strictEqual(
        ipv6Nlri.length,
        prefixCount,
        'IPv6 routes generated with path IDs should send one ordinary NLRI per prefix when IPv6 ADD-PATH is disabled'
    );
    ipv6Nlri.forEach((route, index) => {
        assert.deepStrictEqual(
            { prefix: route.prefix, length: route.length, pathId: route.pathId },
            { prefix: `2001:db8:710::${(index + 1).toString(16)}`, length: 128, pathId: 0 },
            'IPv6 non-ADD-PATH send should not encode path identifiers'
        );
    });
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
