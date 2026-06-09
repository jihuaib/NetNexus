const assert = require('assert');
const registry = require('../../electron/pktParser/packetParserRegistry');
const { parseBgpPacket } = require('../../electron/pktParser/bgpPacketParser');
const BgpConst = require('../../electron/const/bgpConst');

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function bgpPacket(type, body = Buffer.alloc(0)) {
    return Buffer.concat([
        Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
        u16(BgpConst.BGP_HEAD_LEN + body.length),
        Buffer.from([type]),
        body
    ]);
}

function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL) {
    if (value.length > 255) {
        return Buffer.concat([Buffer.from([flags | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH, typeCode]), u16(value.length), value]);
    }
    return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
}

function updatePacket(attrs = [], nlri = Buffer.alloc(0)) {
    const attrBuffer = Buffer.concat(attrs);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrBuffer.length), attrBuffer, nlri]));
}

function capability(code, value = Buffer.alloc(0)) {
    return Buffer.concat([Buffer.from([code, value.length]), value]);
}

function openPacket(capabilities) {
    const capabilityBuffer = Buffer.concat(capabilities);
    const optionalParams = Buffer.concat([Buffer.from([BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE, capabilityBuffer.length]), capabilityBuffer]);
    return bgpPacket(
        BgpConst.BGP_PACKET_TYPE.OPEN,
        Buffer.concat([
            Buffer.from([BgpConst.BGP_VERSION]),
            u16(65000),
            u16(90),
            Buffer.from([1, 1, 1, 1]),
            Buffer.from([optionalParams.length]),
            optionalParams
        ])
    );
}

function tcpSegment(payload, sourcePort = BgpConst.BGP_DEFAULT_PORT, destPort = 50000) {
    const header = Buffer.alloc(20);
    header.writeUInt16BE(sourcePort, 0);
    header.writeUInt16BE(destPort, 2);
    header[12] = 0x50;
    header[13] = 0x18;
    header.writeUInt16BE(4096, 14);
    return Buffer.concat([header, payload]);
}

function udpDatagram(payload, sourcePort = 12345, destPort = 53) {
    const header = Buffer.alloc(8);
    header.writeUInt16BE(sourcePort, 0);
    header.writeUInt16BE(destPort, 2);
    header.writeUInt16BE(8 + payload.length, 4);
    return Buffer.concat([header, payload]);
}

function walk(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children || []) {
        const result = walk(child, predicate);
        if (result) return result;
    }
    return null;
}

function findNode(tree, predicate) {
    return walk(tree, predicate);
}

function parseAtOffset(packet, offset = 0) {
    const tree = {
        name: `Packet ${packet.length} bytes`,
        offset: 0,
        length: packet.length,
        value: '',
        children: []
    };
    const result = parseBgpPacket(packet, tree, offset);
    assert.equal(result.valid, true, result.error);
    return tree;
}

const emptyUpdate = updatePacket();
const wrappedUpdate = Buffer.concat([Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]), emptyUpdate, Buffer.from([0xee, 0xff])]);
const wrappedTree = parseAtOffset(wrappedUpdate, 4);
const wrappedBgpNode = findNode(wrappedTree, node => node.name === 'BGP Packet');
assert.ok(wrappedBgpNode, 'BGP tree node should be present');
assert.equal(wrappedBgpNode.length, emptyUpdate.length, 'BGP tree length should use BGP message length, not outer buffer length');
assert.equal(findNode(wrappedBgpNode, node => node.name === 'NLRI'), null, 'Trailing outer bytes must not become BGP NLRI');

registry.registerParser('bgp', BgpConst.BGP_DEFAULT_PORT, parseBgpPacket, true);
try {
    const tcpTree = {
        name: 'TCP Segment',
        offset: 0,
        length: 0,
        value: '',
        children: []
    };
    const tcpResult = registry.parse(
        'tcp',
        6,
        tcpTree,
        tcpSegment(Buffer.concat([emptyUpdate, Buffer.from([0xde, 0xad])]))
    );
    assert.equal(tcpResult.valid, true, tcpResult.error);
    const tcpBgpNode = findNode(tcpTree, node => node.name === 'BGP Packet');
    assert.ok(tcpBgpNode, 'TCP parser should recurse into BGP tree parser by port');
    assert.equal(tcpBgpNode.length, emptyUpdate.length);
    assert.equal(findNode(tcpBgpNode, node => node.name === 'NLRI'), null, 'Trailing TCP bytes must not become BGP NLRI');
} finally {
    registry.unregisterParser('bgp', BgpConst.BGP_DEFAULT_PORT);
}

const udpTree = {
    name: 'UDP Datagram',
    offset: 0,
    length: 0,
    value: '',
    children: []
};
const udpResult = registry.parse('udp', 17, udpTree, udpDatagram(Buffer.from([0x12, 0x34, 0x00, 0x00])));
assert.equal(udpResult.valid, true, udpResult.error);
assert.ok(findNode(udpTree, node => node.name === 'UDP Header'), 'UDP parser should parse transport header');

const extNextHopCap = capability(
    BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING,
    Buffer.concat([u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4), u16(BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST), u16(BgpConst.IP_TYPE.IPV6)])
);
const addPathCap = capability(
    BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH,
    Buffer.concat([u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4), Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST, BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE])])
);
const openTree = parseAtOffset(openPacket([extNextHopCap, addPathCap]));
assert.ok(findNode(openTree, node => node.name === 'Next Hop Tuple 1'), 'Extended Next Hop capability should expand in tree');
assert.ok(findNode(openTree, node => node.name === 'ADD-PATH Tuple 1'), 'ADD-PATH capability should expand in tree');

const extCommunityAttr = pathAttr(
    BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
    Buffer.from([0x00, 0x02, 0xfd, 0xe8, 0x00, 0x00, 0x00, 0x64]),
    BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
);
const pmsiAttr = pathAttr(
    BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL,
    Buffer.concat([Buffer.from([0x00, 0x06]), Buffer.from([0x00, 0x00, 0x00]), Buffer.from([192, 0, 2, 1])]),
    BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
);
const tunnelEncapAttr = pathAttr(
    BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION,
    Buffer.concat([u16(8), u16(0)]),
    BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
);
const otcAttr = pathAttr(
    BgpConst.BGP_PATH_ATTR.PATH_OTC,
    u32(65000),
    BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
);
const attrTree = parseAtOffset(updatePacket([extCommunityAttr, pmsiAttr, tunnelEncapAttr, otcAttr]));
assert.ok(findNode(attrTree, node => node.name === 'Extended Communities'), 'EXTENDED_COMMUNITIES should expand in tree');
assert.ok(findNode(attrTree, node => node.name === 'PMSI Tunnel'), 'PMSI_TUNNEL should expand in tree');
assert.ok(findNode(attrTree, node => node.name === 'Tunnel Encapsulation'), 'TUNNEL_ENCAPSULATION should expand in tree');
assert.ok(findNode(attrTree, node => node.name === 'Only-To-Customer AS'), 'OTC should expand in tree');

console.log('BGP packet tree parser tests passed');
