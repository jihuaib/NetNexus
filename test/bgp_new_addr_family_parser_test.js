const assert = require('assert');
const { parseBgpPacket } = require('../electron/utils/bgpPacketParser');
const BgpConst = require('../electron/const/bgpConst');
const { getAddrFamilyType, getAfiAndSafi } = require('../electron/utils/bgpUtils');
const BmpSession = require('../electron/worker/bmpSession');

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL) {
    if (value.length > 255) {
        return Buffer.concat([Buffer.from([flags | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH, typeCode]), u16(value.length), value]);
    }
    return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
}

function updatePacket(attrs, nlri = Buffer.alloc(0)) {
    const attrBuffer = Buffer.concat(attrs);
    const body = Buffer.concat([u16(0), u16(attrBuffer.length), attrBuffer, nlri]);
    return Buffer.concat([
        Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
        u16(BgpConst.BGP_HEAD_LEN + body.length),
        Buffer.from([BgpConst.BGP_PACKET_TYPE.UPDATE]),
        body
    ]);
}

function parseUpdateWithMpReach(afi, safi, nextHop, nlri) {
    const value = Buffer.concat([u16(afi), Buffer.from([safi, nextHop.length]), nextHop, Buffer.from([0]), nlri]);
    return parseBgpPacket(updatePacket([pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, value)]));
}

function parseUpdateWithMpUnreach(afi, safi, nlri) {
    const value = Buffer.concat([u16(afi), Buffer.from([safi]), nlri]);
    return parseBgpPacket(updatePacket([pathAttr(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI, value)]));
}

function firstReachRoute(packet, expectedPacketValid = true) {
    assert.equal(packet.valid, expectedPacketValid);
    const attr = packet.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI);
    assert.ok(attr, 'MP_REACH_NLRI attribute must exist');
    assert.equal(attr.mpReach.nlri.length, 1);
    return attr.mpReach.nlri[0];
}

function firstUnreachRoute(packet) {
    assert.equal(packet.valid, true);
    const attr = packet.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI);
    assert.ok(attr, 'MP_UNREACH_NLRI attribute must exist');
    assert.equal(attr.mpUnreach.withdrawnRoutes.length, 1);
    return attr.mpUnreach.withdrawnRoutes[0];
}

function labelEntry(label, bottom = true) {
    const value = (label << 4) | (bottom ? 1 : 0);
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function tlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}

function bgpLsNlri(type, body) {
    return Buffer.concat([u16(type), u16(body.length), body]);
}

function bgpLsBody(protocolId, tlvs) {
    return Buffer.concat([Buffer.from([protocolId]), Buffer.from('0000000000000001', 'hex'), ...tlvs]);
}

function evpnNlri(routeType, body) {
    return Buffer.concat([Buffer.from([routeType, body.length]), body]);
}

const rd65000 = Buffer.from([0, 0, 0xfd, 0xe8, 0, 0, 0, 1]);
const esi = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

assert.equal(
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC),
    BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC
);
assert.equal(
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC),
    BgpConst.BGP_ADDR_FAMILY.IPV6_FLOWSPEC
);
assert.equal(
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST),
    BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST
);
assert.equal(
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST),
    BgpConst.BGP_ADDR_FAMILY.IPV6_LABEL_UNICAST
);
assert.equal(
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_BGP_LS, BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS),
    BgpConst.BGP_ADDR_FAMILY.LINK_STATE
);
assert.deepEqual(getAfiAndSafi(BgpConst.BGP_ADDR_FAMILY.LINK_STATE), {
    afi: BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
    safi: BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS
});
assert.equal(getAfiAndSafi(BgpConst.BGP_ADDR_FAMILY.IPV4_QP).safi, 241);
assert.equal(getAfiAndSafi(BgpConst.BGP_ADDR_FAMILY.IPV6_QP).safi, 241);

const ipv4FlowSpecNlri = Buffer.from([9, 1, 32, 192, 0, 2, 1, 12, 0x80, 0x05]);
const ipv4FlowSpec = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
        Buffer.alloc(0),
        ipv4FlowSpecNlri
    )
);
assert.equal(ipv4FlowSpec.valid, true);
assert.equal(ipv4FlowSpec.length, 9);
assert.ok(ipv4FlowSpec.prefix.includes('dst=192.0.2.1/32'));
assert.ok(ipv4FlowSpec.prefix.includes('fragment any 5'));

const ipv6FlowSpecExample1 = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
        Buffer.alloc(0),
        Buffer.from([18, 1, 32, 0, 32, 1, 13, 184, 2, 104, 64, 18, 52, 86, 120, 154, 3, 129, 6])
    )
);
assert.equal(ipv6FlowSpecExample1.valid, true);
assert.ok(ipv6FlowSpecExample1.prefix.includes('dst=2001:db8::/32'));
assert.ok(ipv6FlowSpecExample1.prefix.includes('src=::1234:5678:9a00:0/104 offset 64'));
assert.ok(ipv6FlowSpecExample1.prefix.includes('proto = 6'));

const ipv6FlowSpecExample2 = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
        Buffer.alloc(0),
        Buffer.from([15, 1, 32, 0, 32, 1, 13, 184, 2, 104, 65, 36, 104, 172, 241, 52])
    )
);
assert.equal(ipv6FlowSpecExample2.valid, true);
assert.ok(ipv6FlowSpecExample2.prefix.includes('src=::1234:5678:9a00:0/104 offset 65'));

const duplicatedFlowSpecType = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
        Buffer.alloc(0),
        Buffer.from([10, 1, 24, 10, 0, 0, 1, 24, 10, 0, 1])
    ),
    false
);
assert.equal(duplicatedFlowSpecType.valid, false);
assert.ok(duplicatedFlowSpecType.errors.some(error => error.includes('strict increasing order')));

const ipv4UnsupportedFlowSpecType = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
        Buffer.alloc(0),
        Buffer.from([3, 13, 0x81, 0])
    ),
    false
);
assert.equal(ipv4UnsupportedFlowSpecType.valid, false);
assert.ok(ipv4UnsupportedFlowSpecType.errors.some(error => error.includes('Unknown FlowSpec component type: 13')));

const ipv4LabeledUnicast = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
        Buffer.from([1, 1, 1, 1]),
        Buffer.concat([Buffer.from([48]), labelEntry(100), Buffer.from([192, 0, 2])])
    )
);
assert.equal(ipv4LabeledUnicast.valid, true);
assert.equal(ipv4LabeledUnicast.prefix, '192.0.2.0');
assert.equal(ipv4LabeledUnicast.length, 24);
assert.equal(ipv4LabeledUnicast.labels[0].label, 100);
assert.equal(ipv4LabeledUnicast.labels[0].bottom, true);

const ipv6LabeledUnicast = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
        Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        Buffer.concat([Buffer.from([56]), labelEntry(100), Buffer.from([0x20, 0x01, 0x0d, 0xb8])])
    )
);
assert.equal(ipv6LabeledUnicast.valid, true);
assert.equal(ipv6LabeledUnicast.prefix, '2001:db8::');
assert.equal(ipv6LabeledUnicast.length, 32);
assert.equal(ipv6LabeledUnicast.labels[0].label, 100);

const invalidLabeledUnicast = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
        Buffer.from([1, 1, 1, 1]),
        Buffer.concat([Buffer.from([48]), labelEntry(100, false), Buffer.from([192, 0, 2])])
    ),
    false
);
assert.equal(invalidLabeledUnicast.valid, false);
assert.ok(invalidLabeledUnicast.errors.some(error => error.includes('bottom-of-stack')));

const labeledWithdrawal = firstUnreachRoute(
    parseUpdateWithMpUnreach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
        Buffer.concat([Buffer.from([48, 0, 0, 0]), Buffer.from([192, 0, 2])])
    )
);
assert.equal(labeledWithdrawal.valid, true);
assert.equal(labeledWithdrawal.prefix, '192.0.2.0');
assert.equal(labeledWithdrawal.length, 24);
assert.equal(labeledWithdrawal.compatibilityField, '000000');

const vpnv4Packet = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_VPN,
    Buffer.concat([rd65000, Buffer.from([192, 0, 2, 254])]),
    Buffer.concat([Buffer.from([112]), labelEntry(0), rd65000, Buffer.from([203, 0, 113])])
);
const vpnv4Route = firstReachRoute(vpnv4Packet);
assert.equal(vpnv4Packet.pathAttributes[0].mpReach.nextHop, '192.0.2.254');
assert.equal(vpnv4Route.prefix, '203.0.113.0');
assert.equal(vpnv4Route.displayPrefix, '65000:1:203.0.113.0');
const vpnv4BmpRoute = {};
new BmpSession({ sendEvent() {} }, {}).setRouteNlri(
    vpnv4BmpRoute,
    vpnv4Route,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_VPN
);
assert.equal(vpnv4BmpRoute.ip, '65000:1:203.0.113.0');

const vpnv6Packet = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_VPN,
    Buffer.concat([
        rd65000,
        Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        rd65000,
        Buffer.from([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    ]),
    Buffer.concat([Buffer.from([120]), labelEntry(0), rd65000, Buffer.from([0x20, 0x01, 0x0d, 0xb8])])
);
const vpnv6Route = firstReachRoute(vpnv6Packet);
assert.equal(vpnv6Packet.pathAttributes[0].mpReach.nextHop, '2001:db8::1, fe80::1');
assert.equal(vpnv6Route.prefix, '2001:db8::');
assert.equal(vpnv6Route.displayPrefix, '65000:1:2001:db8::');

const evpnEthernetAdPacket = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
    BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
    Buffer.from([10, 0, 0, 1]),
    evpnNlri(1, Buffer.concat([rd65000, esi, u32(100), labelEntry(100)]))
);
const evpnEthernetAd = firstReachRoute(evpnEthernetAdPacket);
assert.equal(evpnEthernetAdPacket.pathAttributes[0].mpReach.nextHop, '10.0.0.1');
assert.equal(evpnEthernetAd.valid, true);
assert.equal(evpnEthernetAd.rd, '65000:1');
assert.equal(evpnEthernetAd.ethernetTagId, 100);
assert.equal(evpnEthernetAd.labels[0].label, 100);
assert.ok(evpnEthernetAd.prefix.includes('evpn:ad:65000:1'));

const evpnMacIp = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(
            2,
            Buffer.concat([
                rd65000,
                esi,
                u32(100),
                Buffer.from([48, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 32, 192, 0, 2, 10]),
                labelEntry(200)
            ])
        )
    )
);
assert.equal(evpnMacIp.valid, true);
assert.equal(evpnMacIp.macAddress, 'aa:bb:cc:dd:ee:ff');
assert.equal(evpnMacIp.ipAddress, '192.0.2.10');
assert.equal(evpnMacIp.labels[0].label, 200);
assert.ok(evpnMacIp.prefix.includes('mac=aa:bb:cc:dd:ee:ff:ip=192.0.2.10'));
const evpnBmpRoute = {};
new BmpSession({ sendEvent() {} }, {}).setRouteNlri(
    evpnBmpRoute,
    evpnMacIp,
    BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
    BgpConst.BGP_SAFI_TYPE.SAFI_EVPN
);
assert.equal(evpnBmpRoute.afi, BgpConst.BGP_AFI_TYPE.AFI_L2VPN);
assert.equal(evpnBmpRoute.safi, BgpConst.BGP_SAFI_TYPE.SAFI_EVPN);
assert.equal(evpnBmpRoute.nlriDetail.macAddress, 'aa:bb:cc:dd:ee:ff');
assert.equal(evpnBmpRoute.nlriDetail.ethernetTagId, 100);

const evpnInclusiveMulticast = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(3, Buffer.concat([rd65000, u32(100), Buffer.from([32, 10, 0, 0, 1])]))
    )
);
assert.equal(evpnInclusiveMulticast.valid, true);
assert.equal(evpnInclusiveMulticast.originatingRouterIp, '10.0.0.1');
assert.ok(evpnInclusiveMulticast.prefix.includes('evpn:imet:65000:1'));

const evpnEthernetSegment = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(4, Buffer.concat([rd65000, esi, Buffer.from([32, 10, 0, 0, 2])]))
    )
);
assert.equal(evpnEthernetSegment.valid, true);
assert.equal(evpnEthernetSegment.originatingRouterIp, '10.0.0.2');
assert.ok(evpnEthernetSegment.prefix.includes('evpn:es:65000:1'));

const evpnIpPrefix = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(
            5,
            Buffer.concat([
                rd65000,
                esi,
                u32(100),
                Buffer.from([24, 203, 0, 113, 0, 192, 0, 2, 1]),
                labelEntry(300)
            ])
        )
    )
);
assert.equal(evpnIpPrefix.valid, true);
assert.equal(evpnIpPrefix.ipPrefix, '203.0.113.0');
assert.equal(evpnIpPrefix.length, 24);
assert.equal(evpnIpPrefix.gatewayIp, '192.0.2.1');
assert.equal(evpnIpPrefix.labels[0].label, 300);
assert.ok(evpnIpPrefix.prefix.includes('evpn:ip-prefix:65000:1:tag=100:203.0.113.0/24'));

const unknownEvpnType = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(9, Buffer.from([1, 2, 3]))
    )
);
assert.equal(unknownEvpnType.prefix, '010203');
assert.equal(unknownEvpnType.rd, null);
assert.equal(unknownEvpnType.rawNlri, '010203');

const nodeDescriptor = tlv(256, tlv(512, Buffer.from([0, 0, 0xfd, 0xe8])));
const ipv4Reachability = tlv(265, Buffer.from([24, 203, 0, 113]));
const bgpLsPrefix = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
        BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS,
        Buffer.alloc(0),
        bgpLsNlri(3, bgpLsBody(3, [nodeDescriptor, ipv4Reachability]))
    )
);
assert.equal(bgpLsPrefix.valid, true);
assert.equal(bgpLsPrefix.prefix, 'bgp-ls:IPv4 Prefix:203.0.113.0/24');
assert.equal(bgpLsPrefix.length, 24);

const remoteNodeDescriptor = tlv(257, tlv(512, Buffer.from([0, 0, 0xfd, 0xe8])));
const linkDescriptors = [
    nodeDescriptor,
    remoteNodeDescriptor,
    tlv(259, Buffer.from([10, 0, 0, 1])),
    tlv(260, Buffer.from([10, 0, 0, 2]))
];
const bgpLsLink = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
        BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS,
        Buffer.alloc(0),
        bgpLsNlri(2, bgpLsBody(3, linkDescriptors))
    )
);
assert.equal(bgpLsLink.valid, true);
assert.equal(bgpLsLink.prefix, 'bgp-ls:Link:10.0.0.1->10.0.0.2');

const unknownBgpLsType = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
        BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS,
        Buffer.alloc(0),
        bgpLsNlri(999, Buffer.from([0xaa, 0xbb]))
    )
);
assert.equal(unknownBgpLsType.valid, true);
assert.equal(unknownBgpLsType.prefix, 'bgp-ls:type-999:0xaabb');

const unorderedBgpLs = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
        BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS,
        Buffer.alloc(0),
        bgpLsNlri(2, bgpLsBody(3, [tlv(259, Buffer.from([10, 0, 0, 1])), nodeDescriptor]))
    ),
    false
);
assert.equal(unorderedBgpLs.valid, false);
assert.ok(unorderedBgpLs.errors.some(error => error.includes('canonical order')));

console.log('bgp new address family parser tests passed');
