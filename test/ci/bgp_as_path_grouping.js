const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const BgpPeer = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpPeer.js'));
const BgpInstance = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpInstance.js'));
const BgpRoute = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpRoute.js'));
const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const { parseBgpPacket } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bgpPacketParser.js'));

function buildBgpMessageHeader(length, type) {
    const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
    header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
    header[BgpConst.BGP_MARKER_LEN + 2] = type;
    return header;
}

function addRoute(instance, ip, asPath) {
    const route = new BgpRoute(instance);
    route.ip = ip;
    route.mask = 32;
    instance.setRoute(BgpRoute.makeKey(route.ip, route.mask), route, { asPath });
}

function getParsedAsPath(packet) {
    const attribute = packet.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.AS_PATH);
    assert.ok(attribute, 'UPDATE must contain AS_PATH');
    return attribute.segments.flatMap(segment => segment.asNumbers);
}

const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
const sentBuffers = [];
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

// 相同 AS_PATH 故意交错插入，验证分组依据是属性而不是相邻顺序。
addRoute(instance, '10.0.0.1', '64512 64513');
addRoute(instance, '10.0.0.2', '64520');
addRoute(instance, '10.0.0.3', '64512 64513');
addRoute(instance, '10.0.0.4', '64512 64513');

const groups = peer.getOutboundRouteGroups();
assert.strictEqual(groups.length, 2, 'different AS_PATH values must form different outbound groups');
assert.deepStrictEqual(
    groups.map(group => group.length),
    [3, 1],
    'interleaved routes with the same AS_PATH must be collected into one group'
);

peer.sendRoute();
assert.strictEqual(sentBuffers.length, 2, 'two AS_PATH groups must be encoded as two UPDATE packets');

const packets = sentBuffers.map(buffer => parseBgpPacket(buffer));
assert.ok(
    packets.every(packet => packet.valid),
    'all grouped UPDATE packets must parse successfully'
);
assert.deepStrictEqual(getParsedAsPath(packets[0]), [64512, 64513]);
assert.deepStrictEqual(
    packets[0].nlri.map(route => route.prefix),
    ['10.0.0.1', '10.0.0.3', '10.0.0.4'],
    'same-AS_PATH routes must be packed into the same UPDATE'
);
assert.deepStrictEqual(getParsedAsPath(packets[1]), [64520]);
assert.deepStrictEqual(
    packets[1].nlri.map(route => route.prefix),
    ['10.0.0.2'],
    'the different-AS_PATH route must be isolated in its own UPDATE'
);

console.log('BGP AS Path grouping and packetization tests passed');
