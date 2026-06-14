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

function makeQpRoute(instance, dqpn, ip, mask, nextHop) {
    const route = new BgpRoute(instance);
    route.dqpn = dqpn;
    route.ip = ip;
    route.mask = mask;
    route.nextHop = nextHop;
    return route;
}

function getMpReach(packet) {
    const attr = packet.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI);
    assert.ok(attr, 'MP_REACH_NLRI attribute must exist');
    assert.ok(attr.mpReach, 'MP_REACH_NLRI must be parsed');
    return attr.mpReach;
}

const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_QP);
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

const routes = [
    makeQpRoute(instance, 1, '10.0.0.1', 32, '2001:db8::1'),
    makeQpRoute(instance, 2, '10.0.0.2', 32, '2001:db8::1'),
    makeQpRoute(instance, 3, '10.0.0.3', 32, '2001:db8::2')
];

for (const route of routes) {
    instance.routeMap.set(BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask), route);
}

peer.sendRoute();

assert.strictEqual(sentBuffers.length, 2, 'QP routes with two BSIDs must be sent in two UPDATEs');

const firstReach = getMpReach(parseBgpPacket(sentBuffers[0]));
assert.strictEqual(firstReach.nextHop, '2001:db8::1', 'first UPDATE next hop should be first BSID');
assert.strictEqual(firstReach.nlri.length, 2, 'first UPDATE should contain only same-BSID NLRIs');
assert.deepStrictEqual(
    firstReach.nlri.map(route => route.dqpn),
    [1, 2],
    'first UPDATE should carry DQPN 1 and 2'
);

const secondReach = getMpReach(parseBgpPacket(sentBuffers[1]));
assert.strictEqual(secondReach.nextHop, '2001:db8::2', 'second UPDATE next hop should be second BSID');
assert.strictEqual(secondReach.nlri.length, 1, 'second UPDATE should contain the second-BSID NLRI');
assert.strictEqual(secondReach.nlri[0].dqpn, 3, 'second UPDATE should carry DQPN 3');

console.log('BGP QP BSID grouping tests passed');
