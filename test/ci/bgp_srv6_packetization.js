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
const BgpSession = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpSession.js'));
const { getAfiAndSafi } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bgpUtils.js'));

const INCREMENTAL_SRV6_ROUTE_COUNT = 128;
const FIXED_SRV6_ROUTE_COUNT = 500;
const ADD_PATH_SRV6_ROUTE_COUNT = 1000;
const ADD_PATH_SRV6_PATH_COUNT = 10;
const ADD_PATH_IPV4_32_NLRI_LEN = 9;
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

function createAddPathSrv6Peer(instance, sentBuffers) {
    const session = {
        localIp: '2001:db8::fe',
        localAs: 65000,
        peerIp: '2001:db8::1',
        peerAs: 65001,
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP,
        localCapFlags:
            BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS |
            BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING |
            BgpConst.BGP_CAP_FLAGS.ADD_PATH,
        buildBgpMessageHeader,
        processCustomPkt: () => [],
        sendRoute: buffer => sentBuffers.push(Buffer.from(buffer)),
        isAddPathSendEnabled: (afi, safi) =>
            afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
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

    worker.messageHandler.sendSuccessResponse = (messageId, data, msg) => {
        responses.push({ messageId, data, msg });
    };
    worker.messageHandler.sendErrorResponse = (messageId, msg, data) => {
        errors.push({ messageId, msg, data });
    };

    const instance = addWorkerInstance(worker, addressFamily);
    return { worker, instance, responses, errors };
}

function addWorkerInstance(worker, addressFamily) {
    const { afi, safi } = getAfiAndSafi(addressFamily);
    const instance = new BgpInstance(0, afi, safi);
    worker.bgpInstanceMap.set(BgpInstance.makeKey(0, afi, safi), instance);
    return instance;
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

function ipv4FromNumber(value) {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
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

const ADD_PATH_PARSE_CONTEXT = {
    getAddPathReceiveInfo: (afi, safi) => ({
        enabled: afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    }),
    isAddPathReceiveEnabled: (afi, safi) =>
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
};

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
                rd: '0:0',
                pathId: 0,
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
                rd: '0:0',
                pathId: 0,
                srv6Sid: '2001:db8:502::2',
                srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
            }
        ],
        'IPv4-UNC route generation should store incremental SRv6 SID attributes'
    );
}

{
    const { worker, instance, responses, errors } = makeWorkerWithInstance(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    const baseIp = (10 << 24) + (70 << 16) + 1;

    worker.generateRoutes('generate-ipv4-add-path-srv6-increment', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: ipv4FromNumber(baseIp),
        mask: 32,
        count: ADD_PATH_SRV6_ROUTE_COUNT,
        addPathEnabled: true,
        addPathCount: ADD_PATH_SRV6_PATH_COUNT,
        srv6Enabled: true,
        srv6SidMode: BgpConst.BGP_SRV6_SID_MODE.INCREMENT,
        srv6Sid: '2001:db8:710::1',
        srv6SidStep: 1,
        srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
    });

    assert.deepStrictEqual(errors, [], 'IPv4-UNC ADD-PATH SRv6 generation should not report errors');
    assert.strictEqual(responses.length, 1, 'IPv4-UNC ADD-PATH SRv6 generation should report success');
    assert.strictEqual(
        instance.routeMap.size,
        ADD_PATH_SRV6_ROUTE_COUNT * ADD_PATH_SRV6_PATH_COUNT,
        'ADD-PATH SRv6 generation should create addPathCount routes for each prefix'
    );
    assert.strictEqual(
        instance.attrStore.attrMap.size,
        ADD_PATH_SRV6_ROUTE_COUNT * ADD_PATH_SRV6_PATH_COUNT,
        'incremental SRv6 SID with ADD-PATH should keep one attribute per generated path'
    );

    const sentBuffers = [];
    const peer = createAddPathSrv6Peer(instance, sentBuffers);
    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.strictEqual(
        sentBuffers.length,
        ADD_PATH_SRV6_ROUTE_COUNT * ADD_PATH_SRV6_PATH_COUNT,
        'incremental SRv6 SID with ADD-PATH should send one UPDATE per generated path'
    );

    const seenPaths = new Set();
    sentBuffers.forEach((buffer, index) => {
        const packet = parseBgpPacket(buffer, ADD_PATH_PARSE_CONTEXT);
        const reach = getMpReach(packet);
        const prefixIndex = Math.floor(index / ADD_PATH_SRV6_PATH_COUNT);
        const expectedPathId = index % ADD_PATH_SRV6_PATH_COUNT;
        const expectedPrefix = ipv4FromNumber(baseIp + prefixIndex);
        const expectedSid = `2001:db8:710::${(index + 1).toString(16)}`;

        assert.strictEqual(reach.nlri.length, 1, 'each ADD-PATH SRv6 UPDATE should carry one NLRI');
        assert.strictEqual(reach.nlri[0].prefix, expectedPrefix, 'ADD-PATH SRv6 prefix order should be preserved');
        assert.strictEqual(
            reach.nlri[0].pathId,
            expectedPathId,
            'ADD-PATH SRv6 path-id should stay associated with its prefix'
        );
        assert.strictEqual(getPacketSrv6Sid(packet), expectedSid, 'ADD-PATH SRv6 SID should increment per path');
        seenPaths.add(`${reach.nlri[0].prefix}|${reach.nlri[0].pathId}`);
    });
    assert.strictEqual(
        seenPaths.size,
        ADD_PATH_SRV6_ROUTE_COUNT * ADD_PATH_SRV6_PATH_COUNT,
        'ADD-PATH SRv6 packetization should send every generated prefix/path-id pair exactly once'
    );
}

{
    const { worker, instance, responses, errors } = makeWorkerWithInstance(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    const baseIp = (10 << 24) + (71 << 16) + 1;
    const fixedSid = '2001:db8:720::1';
    const totalGeneratedPaths = ADD_PATH_SRV6_ROUTE_COUNT * ADD_PATH_SRV6_PATH_COUNT;

    worker.generateRoutes('generate-ipv4-add-path-srv6-fixed', {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: ipv4FromNumber(baseIp),
        mask: 32,
        count: ADD_PATH_SRV6_ROUTE_COUNT,
        addPathEnabled: true,
        addPathCount: ADD_PATH_SRV6_PATH_COUNT,
        srv6Enabled: true,
        srv6SidMode: BgpConst.BGP_SRV6_SID_MODE.FIXED,
        srv6Sid: fixedSid,
        srv6EndpointBehavior: IPV4_SRV6_ENDPOINT_BEHAVIOR
    });

    assert.deepStrictEqual(errors, [], 'IPv4-UNC ADD-PATH fixed SRv6 generation should not report errors');
    assert.strictEqual(responses.length, 1, 'IPv4-UNC ADD-PATH fixed SRv6 generation should report success');
    assert.strictEqual(
        instance.routeMap.size,
        totalGeneratedPaths,
        'fixed SRv6 ADD-PATH generation should create addPathCount routes for each prefix'
    );
    assert.strictEqual(
        instance.attrStore.attrMap.size,
        1,
        'fixed SRv6 ADD-PATH routes should share one outbound attribute group'
    );

    const sentBuffers = [];
    const peer = createAddPathSrv6Peer(instance, sentBuffers);
    peer.sendRoute();
    assertPacketLengths(sentBuffers);
    assert.ok(sentBuffers.length > 1, 'fixed SRv6 ADD-PATH routes should be split by 4096-byte UPDATE limit');

    let routeOffset = 0;
    const parsedPacketSummaries = sentBuffers.map((buffer, packetIndex) => {
        const packet = parseBgpPacket(buffer, ADD_PATH_PARSE_CONTEXT);
        const reach = getMpReach(packet);
        const sid = getPacketSrv6Sid(packet);
        assert.strictEqual(sid, fixedSid, 'fixed SRv6 ADD-PATH UPDATE should carry the shared SID');
        assert.ok(reach.nlri.length > 0, 'fixed SRv6 ADD-PATH UPDATE should carry at least one NLRI');

        reach.nlri.forEach((route, routeIndex) => {
            const globalIndex = routeOffset + routeIndex;
            const prefixIndex = Math.floor(globalIndex / ADD_PATH_SRV6_PATH_COUNT);
            const expectedPathId = globalIndex % ADD_PATH_SRV6_PATH_COUNT;
            assert.strictEqual(
                route.prefix,
                ipv4FromNumber(baseIp + prefixIndex),
                'fixed SRv6 ADD-PATH prefix order should be preserved across packets'
            );
            assert.strictEqual(
                route.pathId,
                expectedPathId,
                'fixed SRv6 ADD-PATH path-id should stay associated with its prefix'
            );
        });

        const firstRoute = reach.nlri[0];
        const lastRoute = reach.nlri[reach.nlri.length - 1];
        const summary = {
            packet: packetIndex + 1,
            length: buffer.length,
            nlriCount: reach.nlri.length,
            first: `${firstRoute.prefix}|${firstRoute.pathId}`,
            last: `${lastRoute.prefix}|${lastRoute.pathId}`,
            srv6Sid: sid
        };

        routeOffset += reach.nlri.length;
        return summary;
    });

    assert.strictEqual(routeOffset, totalGeneratedPaths, 'fixed SRv6 ADD-PATH should send all generated paths');
    parsedPacketSummaries.forEach((summary, index) => {
        if (index < parsedPacketSummaries.length - 1) {
            assert.ok(
                summary.length + ADD_PATH_IPV4_32_NLRI_LEN >= BgpConst.BGP_MAX_PKT_SIZE,
                'full fixed SRv6 ADD-PATH UPDATE should not have room for another /32 ADD-PATH NLRI'
            );
        }
    });
    assert.ok(
        parsedPacketSummaries[parsedPacketSummaries.length - 1].nlriCount < parsedPacketSummaries[0].nlriCount,
        'fixed SRv6 ADD-PATH packetization should leave a tail UPDATE after full packets'
    );

    console.log('[BGP SRv6 ADD-PATH fixed packet parse]', JSON.stringify(parsedPacketSummaries, null, 2));
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
    const { worker, errors } = makeWorkerWithInstance(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    addWorkerInstance(worker, BgpConst.BGP_ADDR_FAMILY.IPV6_UNC);
    setWorkerBgpBaseConfig(worker);

    worker.configIpv6Peer('config-ipv6-peer-add-path-per-family', {
        peerIpv6: '2001:db8::2',
        peerIpv6As: 65001,
        holdTimeIpv6: 180,
        openCapIpv6: [BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS, BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH],
        addressFamilyIpv6: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, BgpConst.BGP_ADDR_FAMILY.IPV6_UNC],
        addressFamilyConfig: {
            [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]: {
                sendAddPath: true
            },
            [BgpConst.BGP_ADDR_FAMILY.IPV6_UNC]: {
                sendAddPath: false
            }
        },
        roleIpv6: '',
        openCapCustomIpv6: ''
    });

    const session = worker.bgpSessionMap.get(BgpSession.makeKey(0, '2001:db8::2'));
    const ipv4AddPathKey = BgpSession.makeAfiSafiKey(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    );
    const ipv6AddPathKey = BgpSession.makeAfiSafiKey(
        BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    );

    assert.deepStrictEqual(errors, [], 'IPv6 peer ADD-PATH config should not report errors');
    assert.ok(session, 'IPv6 peer ADD-PATH config should create a session');
    assert.strictEqual(session.localAddPathMap.has(ipv4AddPathKey), true, 'IPv4-UNC ADD-PATH should be enabled');
    assert.strictEqual(session.localAddPathMap.has(ipv6AddPathKey), false, 'IPv6-UNC ADD-PATH should remain disabled');
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
