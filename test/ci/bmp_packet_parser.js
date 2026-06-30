const assert = require('assert');
const registry = require('../../electron/pktParser/packetParserRegistry');
const { parseBmpPacket: parseBmpTreePacket } = require('../../electron/pktParser/bmpPacketParser');
const { parseBmpPacket, getBmpPacketSummary } = require('../../electron/utils/bmpPacketParser');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function ip(ipAddress) {
    return Buffer.from(ipAddress.split('.').map(part => parseInt(part, 10)));
}

function rd(asn = 0, assigned = 0) {
    return Buffer.concat([u16(BgpConst.RD_TYPE.AS2), u16(asn), u32(assigned)]);
}

function bmpMessage(type, payload) {
    return Buffer.concat([
        Buffer.from([BmpConst.BMP_VERSION.V4]),
        u32(BmpConst.BMP_HEADER_LENGTH + payload.length),
        Buffer.from([type]),
        payload
    ]);
}

function tlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}

function indexedTlv(type, index, value) {
    return Buffer.concat([u16(type), u16(value.length), u16(index), value]);
}

function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE) {
    if (value.length > 255) {
        return Buffer.concat([
            Buffer.from([flags | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH, typeCode]),
            u16(value.length),
            value
        ]);
    }
    return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
}

function bgpPacket(type, body = Buffer.alloc(0)) {
    return Buffer.concat([
        Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
        u16(BgpConst.BGP_HEAD_LEN + body.length),
        Buffer.from([type]),
        body
    ]);
}

function bgpOpen() {
    const capability = Buffer.concat([
        Buffer.from([BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS, 4]),
        u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
        Buffer.from([0, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST])
    ]);
    const optionalParam = Buffer.concat([
        Buffer.from([BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE, capability.length]),
        capability
    ]);
    return bgpPacket(
        BgpConst.BGP_PACKET_TYPE.OPEN,
        Buffer.concat([
            Buffer.from([BgpConst.BGP_VERSION]),
            u16(65000),
            u16(90),
            ip('192.0.2.1'),
            Buffer.from([optionalParam.length]),
            optionalParam
        ])
    );
}

function bgpKeepalive() {
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.KEEPALIVE);
}

function updatePacket(withdrawnRoutes, attrs, nlri = Buffer.alloc(0)) {
    const withdrawnRoutesBuffer = Buffer.concat(withdrawnRoutes);
    const attrBuffer = Buffer.concat(attrs);
    return bgpPacket(
        BgpConst.BGP_PACKET_TYPE.UPDATE,
        Buffer.concat([
            u16(withdrawnRoutesBuffer.length),
            withdrawnRoutesBuffer,
            u16(attrBuffer.length),
            attrBuffer,
            nlri
        ])
    );
}

function ipv4Prefix(prefixLength, ipAddress) {
    return Buffer.concat([Buffer.from([prefixLength]), ip(ipAddress).subarray(0, Math.ceil(prefixLength / 8))]);
}

function bgpUpdate() {
    return updatePacket(
        [ipv4Prefix(24, '198.51.100.0')],
        [
            pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.AS_PATH,
                Buffer.concat([Buffer.from([BgpConst.BGP_AS_PATH_TYPE.AS_SEQUENCE, 1]), u32(65000)])
            ),
            pathAttr(BgpConst.BGP_PATH_ATTR.NEXT_HOP, ip('192.0.2.254'))
        ],
        ipv4Prefix(24, '203.0.113.0')
    );
}

function peerHeader(options = {}) {
    const peerType = options.peerType ?? BmpConst.BMP_PEER_TYPE.GLOBAL;
    const flags = options.flags ?? 0;
    return Buffer.concat([
        Buffer.from([peerType, flags]),
        options.rd || rd(0, 0),
        Buffer.alloc(12),
        peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB ? Buffer.alloc(4) : ip(options.peerAddress || '192.0.2.2'),
        u32(options.peerAs || 65000),
        ip(options.routerId || '192.0.2.1'),
        u32(10),
        u32(20)
    ]);
}

function tcpSegment(payload, sourcePort = 1790, destPort = 50000) {
    const header = Buffer.alloc(20);
    header.writeUInt16BE(sourcePort, 0);
    header.writeUInt16BE(destPort, 2);
    header[12] = 0x50;
    header[13] = 0x18;
    header.writeUInt16BE(4096, 14);
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

const initiation = bmpMessage(
    BmpConst.BMP_MSG_TYPE.INITIATION,
    Buffer.concat([
        tlv(BmpConst.BMP_INITIATION_TLV_TYPE.SYS_NAME, Buffer.from('ci-bmp')),
        tlv(BmpConst.BMP_INITIATION_TLV_TYPE.SYS_DESC, Buffer.from('BMP parser CI'))
    ])
);
const parsedInitiation = parseBmpPacket(initiation);
assert.equal(parsedInitiation.valid, true, parsedInitiation.error);
assert.equal(parsedInitiation.typeName, 'INITIATION');
assert.equal(parsedInitiation.payload.tlvs[0].valueText, 'ci-bmp');
assert.ok(getBmpPacketSummary(parsedInitiation).includes('ci-bmp'), 'BMP summary should include initiation TLVs');

const peerUp = bmpMessage(
    BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
    Buffer.concat([
        peerHeader(),
        Buffer.alloc(12),
        ip('192.0.2.254'),
        u16(179),
        u16(50000),
        bgpOpen(),
        bgpOpen(),
        tlv(BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME, Buffer.from('global'))
    ])
);
const parsedPeerUp = parseBmpPacket(peerUp);
assert.equal(parsedPeerUp.valid, true, parsedPeerUp.error);
assert.equal(parsedPeerUp.payload.localAddress, '192.0.2.254');
assert.equal(parsedPeerUp.payload.receivedOpen.valid, true);
const peerUpSummary = getBmpPacketSummary(parsedPeerUp);
assert.ok(peerUpSummary.includes('Received OPEN'), 'BMP summary should include BGP OPEN detail');
assert.ok(
    parsedPeerUp.payload.receivedOpen.parsed.capabilities.length > 0,
    'BMP parser should keep parsed BGP OPEN capabilities'
);
assert.ok(!peerUpSummary.includes('Parsed BGP:'), 'BMP summary should not include full parsed BGP OPEN object');

const routeMonitoring = bmpMessage(
    BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
    Buffer.concat([
        peerHeader(),
        indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('global')),
        indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate())
    ])
);
const parsedRouteMonitoring = parseBmpPacket(routeMonitoring);
assert.equal(parsedRouteMonitoring.valid, true, parsedRouteMonitoring.error);
const bgpMessageTlv = parsedRouteMonitoring.payload.tlvs.find(
    tlvItem => tlvItem.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE
);
assert.ok(
    bgpMessageTlv.decoded.bgpHeader.valid,
    'BMP Route Monitoring BGP Message TLV should keep embedded BGP header detail'
);
assert.equal(
    bgpMessageTlv.decoded.bgpHeader.type,
    BgpConst.BGP_PACKET_TYPE.UPDATE,
    'BMP Route Monitoring BGP Message TLV should identify embedded BGP UPDATE type'
);
assert.equal(
    bgpMessageTlv.decoded.bgp,
    undefined,
    'BMP Route Monitoring entry log parser should not deep-parse UPDATE without Peer Up context'
);
const routeMonitoringSummary = getBmpPacketSummary(parsedRouteMonitoring);
assert.ok(routeMonitoringSummary.includes('BGP UPDATE Message'));
assert.ok(routeMonitoringSummary.includes('header only'), 'BMP Route Monitoring summary should be header-only');
assert.ok(
    !routeMonitoringSummary.includes('Parsed BGP:'),
    'BMP summary should not include full parsed BGP UPDATE object'
);
assert.ok(
    !routeMonitoringSummary.includes('Path Attributes:'),
    'BMP summary should not include context-free UPDATE attributes'
);
assert.ok(
    !routeMonitoringSummary.includes('Withdrawn Routes:'),
    'BMP summary should not include context-free UPDATE NLRI'
);
assert.ok(!routeMonitoringSummary.includes('Route Changes:'), 'BMP summary should not include route changes');
assert.ok(!routeMonitoringSummary.includes('announce IPv4/Unicast 203.0.113.0/24'));
assert.ok(!routeMonitoringSummary.includes('withdraw IPv4/Unicast 198.51.100.0/24'));

const keepaliveRouteMonitoring = bmpMessage(
    BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
    Buffer.concat([peerHeader(), indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpKeepalive())])
);
assert.ok(getBmpPacketSummary(parseBmpPacket(keepaliveRouteMonitoring)).includes('BGP KEEPALIVE Message'));

const tree = {
    name: `Packet ${routeMonitoring.length} bytes`,
    offset: 0,
    length: routeMonitoring.length,
    value: '',
    children: []
};
const treeResult = parseBmpTreePacket(routeMonitoring, tree, 0);
assert.equal(treeResult.valid, true, treeResult.error);
assert.ok(
    findNode(tree, node => node.name === 'BMP Packet'),
    'BMP tree node should be present'
);
assert.ok(
    findNode(tree, node => node.name === 'Per-Peer Header'),
    'BMP peer header tree node should be present'
);
assert.ok(
    findNode(tree, node => node.name === 'BGP Packet'),
    'BMP tree should expand embedded BGP message'
);
assert.ok(
    findNode(tree, node => node.name === 'Withdrawn Routes'),
    'BMP tree should expand withdrawn routes'
);
assert.ok(
    findNode(tree, node => node.name === 'Prefix' && node.value === '203.0.113.0'),
    'BMP tree should expand UPDATE NLRI routes'
);

registry.registerParser('bmp', 1790, parseBmpTreePacket, true);
try {
    const tcpTree = {
        name: 'TCP Segment',
        offset: 0,
        length: 0,
        value: '',
        children: []
    };
    const tcpResult = registry.parse('tcp', 6, tcpTree, tcpSegment(routeMonitoring));
    assert.equal(tcpResult.valid, true, tcpResult.error);
    assert.ok(
        findNode(tcpTree, node => node.name === 'BMP Packet'),
        'TCP parser should recurse into BMP parser by port'
    );
} finally {
    registry.unregisterParser('bmp', 1790);
}

console.log('BMP packet parser tests passed');
