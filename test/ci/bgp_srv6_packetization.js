const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const BgpPeer = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpPeer.js'));
const BgpInstance = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpInstance.js'));
const BgpRoute = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpRoute.js'));
const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const { parseBgpPacket } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bgpPacketParser.js'));
const WorkerMessageHandler = require(
    path.join(__dirname, '..', '..', 'electron', 'worker', 'core', 'workerMessageHandler.js')
);

WorkerMessageHandler.prototype.init = function initForUnitTest() {};

const BgpWorker = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpWorker.js'));
const { getAfiAndSafi } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bgpUtils.js'));

const INCREMENTAL_SRV6_ROUTE_COUNT = 128;
const FIXED_SRV6_ROUTE_COUNT = 500;
const IPV6_SRV6_FIXED_ROUTES_PER_FULL_PACKET = 234;
const IPV6_SRV6_FIXED_FULL_PACKET_LEN = 4087;
const IPV6_128_NLRI_LEN = 17;
const IPV4_SRV6_ENDPOINT_BEHAVIOR = BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT4;
const IPV6_SRV6_ENDPOINT_BEHAVIOR = BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6;

function buildBgpMessageHeader(length, type) {
    const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
    header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
    header[BgpConst.BGP_MARKER_LEN + 2] = type;
    return header;
}

function createSrv6Peer(instance, sentBuffers) {
    const session = {
        localIp: '2001:db8::fe',
        localAs: 65000,
        peerIp: '2001:db8::1',
        peerAs: 65001,
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS | BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING,
        buildBgpMessageHeader,
        processCustomPkt: () => [],
        sendRoute: buffer => sentBuffers.push(Buffer.from(buffer))
    };

    const peer = new BgpPeer(session, instance, { sendSrv6PrefixSid: true });
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    return peer;
}

function createIpv4PeerWithSrv6Option(instance, sentBuffers) {
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

    const peer = new BgpPeer(session, instance, { sendSrv6PrefixSid: true });
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    return peer;
}

function createIpv6UnicastInstance() {
    return new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
}

function createIpv4UnicastInstance() {
    return new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
}

function createIpv4LabelUnicastInstance() {
    return new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST);
}

function makeWorkerWithInstance(addressFamily) {
    const worker = new BgpWorker();
    const responses = [];
    const errors = [];
    const { afi, safi } = getAfiAndSafi(addressFamily);
    const instance = new BgpInstance(0, afi, safi);

    worker.messageHandler.sendSuccessResponse = (messageId, data, msg) => {
        responses.push({ messageId, data, msg });
    };
    worker.messageHandler.sendErrorResponse = (messageId, msg, data) => {
        errors.push({ messageId, msg, data });
    };
    worker.bgpInstanceMap.set(BgpInstance.makeKey(0, afi, safi), instance);

    return { worker, instance, responses, errors };
}

function setWorkerBgpBaseConfig(worker) {
    worker.bgpConfigData = {
        localAs: 65000,
        routerId: '192.0.2.254'
    };
}

function ipv6Address(block, index) {
    return `2001:db8:${block}::${(index + 1).toString(16)}`;
}

function addIpv4Route(instance, routeIp, attr = {}) {
    const route = new BgpRoute(instance);
    route.ip = routeIp;
    route.mask = 32;
    instance.setRoute(BgpRoute.makeKey(route.ip, route.mask), route, attr);
}

function addIpv4LabelRoute(instance, routeIp, label, attr = {}) {
    const route = new BgpRoute(instance);
    route.ip = routeIp;
    route.mask = 32;
    route.label = label;
    instance.setRoute(BgpRoute.makeKey(route.ip, route.mask), route, attr);
}

function addSrv6Route(instance, routeIp, srv6Sid, endpointBehavior = IPV6_SRV6_ENDPOINT_BEHAVIOR) {
    const route = new BgpRoute(instance);
    route.ip = routeIp;
    route.mask = 128;
    instance.setRoute(BgpRoute.makeKey(route.ip, route.mask), route, {
        srv6Sid,
        srv6EndpointBehavior: endpointBehavior
    });
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

function getPacketSrv6Sid(packet) {
    return getPrefixSid(packet).srv6Services[0].sidInfos[0].sid;
}

function hasPrefixSid(packet) {
    return packet.pathAttributes.some(item => item.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID);
}

function assertPacketLengths(buffers) {
    buffers.forEach(buffer => {
        assert.ok(buffer.length <= BgpConst.BGP_MAX_PKT_SIZE, `UPDATE length ${buffer.length} exceeds max packet size`);
    });
}

{
    const { worker, instance, responses, errors } = makeWorkerWithInstance(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);

    worker.generateRoutes('generate-ipv4-srv6', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '198.51.100.1',
        mask: 32,
        count: 2,
        srv6Enabled: true,
        srv6SidMode: BgpConst.BGP_SRV6_SID_MODE.INCREMENT,
        srv6Sid: '2001:db8:502::1',
        srv6SidStep: 1,
        srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
    });

    assert.deepStrictEqual(errors, [], 'IPv4-UNC SRv6 generation should not report errors');
    assert.strictEqual(responses.length, 1, 'IPv4-UNC SRv6 generation should report success');
    assert.deepStrictEqual(
        Array.from(instance.routeMap.values()).map(route => route.getRouteInfo(instance.getRouteAttr(route))),
        [
            {
                asPath: '',
                med: 0,
                localPref: 100,
                communities: [],
                nextHop: '',
                origin: null,
                customAttr: '',
                rt: '',
                addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
                ip: '198.51.100.1',
                mask: 32,
                srv6Sid: '2001:db8:502::1',
                srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
            },
            {
                asPath: '',
                med: 0,
                localPref: 100,
                communities: [],
                nextHop: '',
                origin: null,
                customAttr: '',
                rt: '',
                addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
                ip: '198.51.100.2',
                mask: 32,
                srv6Sid: '2001:db8:502::2',
                srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
            }
        ],
        'IPv4-UNC route generation should store incremental SRv6 SID attributes'
    );
}

{
    const { worker, instance, errors } = makeWorkerWithInstance(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    setWorkerBgpBaseConfig(worker);

    worker.configIpv4Peer('config-ipv4-peer-no-srv6', {
        peerIp: '192.0.2.1',
        peerAs: 65001,
        holdTime: 180,
        openCap: [BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS],
        addressFamily: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC],
        addressFamilyConfig: {
            [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]: {
                sendSrv6PrefixSid: true
            }
        },
        role: '',
        openCapCustom: ''
    });

    assert.deepStrictEqual(errors, [], 'IPv4 peer config should not report errors');
    assert.strictEqual(
        instance.peerMap.get('192.0.2.1').addressFamilyOptions.sendSrv6PrefixSid,
        false,
        'IPv4 peer config must not enable SRv6 Prefix-SID'
    );
}

{
    const { worker, instance, errors } = makeWorkerWithInstance(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    setWorkerBgpBaseConfig(worker);

    worker.configIpv6Peer('config-ipv6-peer-srv6', {
        peerIpv6: '2001:db8::1',
        peerIpv6As: 65001,
        holdTimeIpv6: 180,
        openCapIpv6: [BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS],
        addressFamilyIpv6: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC],
        addressFamilyConfig: {
            [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]: {
                sendSrv6PrefixSid: true
            }
        },
        roleIpv6: '',
        openCapCustomIpv6: ''
    });

    assert.deepStrictEqual(errors, [], 'IPv6 peer config should not report errors');
    assert.strictEqual(
        instance.peerMap.get('2001:db8::1').addressFamilyOptions.sendSrv6PrefixSid,
        true,
        'IPv6 peer config should enable SRv6 Prefix-SID for IPv4-UNC'
    );
}

{
    const { worker, instance, responses, errors } = makeWorkerWithInstance(BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST);

    worker.generateRoutes('generate-ipv4-label-no-srv6', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST,
        prefix: '198.51.101.1',
        mask: 32,
        count: 1,
        labelMode: BgpConst.BGP_LABEL_MODE.FIXED,
        labelStart: 16000,
        srv6Enabled: true,
        srv6SidMode: BgpConst.BGP_SRV6_SID_MODE.FIXED,
        srv6Sid: '2001:db8:503::1',
        srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
    });

    assert.deepStrictEqual(errors, [], 'IPv4 Label generation should not report errors');
    assert.strictEqual(responses.length, 1, 'IPv4 Label generation should report success');

    const [routeInfo] = Array.from(instance.routeMap.values()).map(route =>
        route.getRouteInfo(instance.getRouteAttr(route))
    );
    assert.strictEqual(routeInfo.label, 16000, 'IPv4 Label generation should keep MPLS label');
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(routeInfo, 'srv6Sid'),
        false,
        'IPv4 Label generation must ignore SRv6 SID fields'
    );
}

{
    const instance = createIpv4UnicastInstance();
    const sentBuffers = [];
    const peer = createSrv6Peer(instance, sentBuffers);

    addIpv4Route(instance, '203.0.113.1', {
        srv6Sid: '2001:db8:500::1',
        srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
    });

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'IPv4-UNC SRv6 route should fit in one UPDATE');

    const packet = parseBgpPacket(sentBuffers[0]);
    const reach = getMpReach(packet);
    const prefixSid = getPrefixSid(packet);
    assert.deepStrictEqual(
        reach.nlri.map(route => route.prefix),
        ['203.0.113.1'],
        'IPv4-UNC SRv6 UPDATE should carry IPv4 NLRI'
    );
    assert.strictEqual(prefixSid.srv6Services[0].serviceType, 'l3');
    assert.strictEqual(prefixSid.srv6Services[0].sidInfos[0].sid, '2001:db8:500::1');
    assert.strictEqual(prefixSid.srv6Services[0].sidInfos[0].endpointBehaviorName, 'End.DT4');
}

{
    const instance = createIpv4UnicastInstance();
    const sentBuffers = [];
    const peer = createIpv4PeerWithSrv6Option(instance, sentBuffers);

    addIpv4Route(instance, '203.0.113.2', {
        srv6Sid: '2001:db8:504::1',
        srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
    });

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'IPv4 peer should still receive the IPv4 route itself');

    const packet = parseBgpPacket(sentBuffers[0]);
    assert.strictEqual(hasPrefixSid(packet), false, 'IPv4 peer must not receive SRv6 Prefix-SID');
    assert.deepStrictEqual(
        packet.nlri.map(route => route.prefix),
        ['203.0.113.2'],
        'IPv4 peer UPDATE should carry IPv4 NLRI without SRv6'
    );
}

{
    const instance = createIpv4LabelUnicastInstance();
    const sentBuffers = [];
    const peer = createSrv6Peer(instance, sentBuffers);

    addIpv4LabelRoute(instance, '203.0.114.1', 16000, {
        srv6Sid: '2001:db8:501::1',
        srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
    });

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(sentBuffers.length, 1, 'IPv4 Label route should fit in one UPDATE');

    const packet = parseBgpPacket(sentBuffers[0]);
    assert.strictEqual(hasPrefixSid(packet), false, 'IPv4 Label UPDATE must not carry SRv6 Prefix-SID');
    const reach = getMpReach(packet);
    assert.deepStrictEqual(
        reach.nlri.map(route => ({
            prefix: route.prefix,
            label: route.labels[0].label
        })),
        [{ prefix: '203.0.114.1', label: 16000 }],
        'IPv4 Label UPDATE should keep MPLS label NLRI only'
    );
}

{
    const instance = createIpv6UnicastInstance();
    const sentBuffers = [];
    const peer = createSrv6Peer(instance, sentBuffers);

    for (let index = 0; index < INCREMENTAL_SRV6_ROUTE_COUNT; index++) {
        addSrv6Route(instance, ipv6Address('510', index), ipv6Address('610', index));
    }

    assert.strictEqual(
        instance.attrStore.attrMap.size,
        INCREMENTAL_SRV6_ROUTE_COUNT,
        'incremental SRv6 SID routes should have one stored attribute per SID'
    );

    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(
        sentBuffers.length,
        INCREMENTAL_SRV6_ROUTE_COUNT,
        'incremental SRv6 SID should send one UPDATE packet per route'
    );

    sentBuffers.forEach((buffer, index) => {
        const packet = parseBgpPacket(buffer);
        const reach = getMpReach(packet);
        assert.strictEqual(reach.nlri.length, 1, 'incremental SRv6 SID UPDATE should carry one route');
        assert.strictEqual(reach.nlri[0].prefix, ipv6Address('510', index));
        assert.strictEqual(getPacketSrv6Sid(packet), ipv6Address('610', index));
    });
}

{
    const instance = createIpv6UnicastInstance();
    const sentBuffers = [];
    const peer = createSrv6Peer(instance, sentBuffers);
    const fixedSid = '2001:db8:620::1';

    for (let index = 0; index < FIXED_SRV6_ROUTE_COUNT; index++) {
        addSrv6Route(instance, ipv6Address('520', index), fixedSid);
    }

    assert.strictEqual(instance.attrStore.attrMap.size, 1, 'fixed SRv6 SID routes should share one stored attribute');

    peer.sendRoute();
    assertPacketLengths(sentBuffers);

    const packets = sentBuffers.map(buffer => parseBgpPacket(buffer));
    const counts = packets.map(packet => getMpReach(packet).nlri.length);
    assert.deepStrictEqual(
        counts,
        expectedPacketCounts(FIXED_SRV6_ROUTE_COUNT, IPV6_SRV6_FIXED_ROUTES_PER_FULL_PACKET),
        'fixed SRv6 SID routes should be packed to full 4096-byte UPDATEs before the tail packet'
    );

    sentBuffers.forEach((buffer, index) => {
        const packet = packets[index];
        assert.strictEqual(getPacketSrv6Sid(packet), fixedSid, 'fixed SRv6 SID UPDATE should carry the shared SID');
        if (counts[index] === IPV6_SRV6_FIXED_ROUTES_PER_FULL_PACKET) {
            assert.strictEqual(
                buffer.length,
                IPV6_SRV6_FIXED_FULL_PACKET_LEN,
                'full fixed SRv6 SID UPDATE length should match the 4096-byte packing boundary'
            );
            assert.ok(
                buffer.length + IPV6_128_NLRI_LEN > BgpConst.BGP_MAX_PKT_SIZE,
                'full fixed SRv6 SID UPDATE must not have room for another /128 NLRI'
            );
        }
    });

    assert.strictEqual(
        counts.reduce((sum, count) => sum + count, 0),
        FIXED_SRV6_ROUTE_COUNT,
        'all fixed SRv6 SID routes should be present after parsing sent UPDATEs'
    );
}

console.log('BGP SRv6 packetization tests passed');
