const assert = require('assert');
const { parseBgpPacket, getBgpPacketSummary } = require('../../electron/utils/bgpPacketParser');
const BgpConst = require('../../electron/const/bgpConst');
const { getAddrFamilyType, getAfiAndSafi } = require('../../electron/utils/bgpUtils');
const BmpSession = require('../../electron/worker/bmp/bmpSession');

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u24(value) {
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL) {
    if (value.length > 255) {
        return Buffer.concat([
            Buffer.from([flags | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH, typeCode]),
            u16(value.length),
            value
        ]);
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

function parseUpdateWithMpReach(afi, safi, nextHop, nlri, extraAttrs = []) {
    const value = Buffer.concat([u16(afi), Buffer.from([safi, nextHop.length]), nextHop, Buffer.from([0]), nlri]);
    return parseBgpPacket(updatePacket([pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, value), ...extraAttrs]));
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

function evpnRaw24(value) {
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function encapsulationExtCommunity(tunnelType) {
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
        Buffer.concat([Buffer.from([0x03, 0x0c, 0, 0, 0, 0]), u16(tunnelType)]),
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
}

function tunnelEncapsulationAttr(tunnelType) {
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION,
        Buffer.concat([u16(tunnelType), u16(0)]),
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
}

function pmsiTunnelAttr(tunnelType, raw24, tunnelIdentifier = Buffer.alloc(0)) {
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL,
        Buffer.concat([Buffer.from([0, tunnelType]), evpnRaw24(raw24), tunnelIdentifier]),
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
}

function prefixSidAttr(labelIndex, srgbStart, srgbRange) {
    const labelIndexTlv = Buffer.concat([Buffer.from([1]), u16(7), Buffer.from([0]), u16(0), u32(labelIndex)]);
    const originatorSrgbTlv = Buffer.concat([Buffer.from([3]), u16(8), u16(0), u24(srgbStart), u24(srgbRange)]);
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.PREFIX_SID,
        Buffer.concat([labelIndexTlv, originatorSrgbTlv]),
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
}

function srv6ServicePrefixSidAttr(serviceTlvType, sidHex, endpointBehavior) {
    const sidStructureSubSubTlv = Buffer.concat([Buffer.from([1]), u16(6), Buffer.from([48, 16, 16, 0, 0, 0])]);
    const sidInformationValue = Buffer.concat([
        Buffer.from([0]),
        Buffer.from(sidHex, 'hex'),
        Buffer.from([0]), // Flags (1 byte)
        u16(endpointBehavior), // Endpoint Behavior (2 bytes)
        Buffer.from([0]), // Reserved (1 byte)
        sidStructureSubSubTlv
    ]);
    const sidInformationSubTlv = Buffer.concat([
        Buffer.from([1]),
        u16(sidInformationValue.length),
        sidInformationValue
    ]);
    const serviceTlvValue = Buffer.concat([Buffer.from([0]), sidInformationSubTlv]);
    const serviceTlv = Buffer.concat([Buffer.from([serviceTlvType]), u16(serviceTlvValue.length), serviceTlvValue]);
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.PREFIX_SID,
        serviceTlv,
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
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

function evpnIpField(...octets) {
    return Buffer.from([octets.length * 8, ...octets]);
}

const rd65000 = Buffer.from([0, 0, 0xfd, 0xe8, 0, 0, 0, 1]);
const esi = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const multicastSource = evpnIpField(192, 0, 2, 1);
const multicastGroup = evpnIpField(239, 1, 1, 1);
const originatorRouter = evpnIpField(10, 0, 0, 1);

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
assert.equal(
    getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_BGP_LS, BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN),
    BgpConst.BGP_ADDR_FAMILY.LINK_STATE_VPN
);
assert.deepEqual(getAfiAndSafi(BgpConst.BGP_ADDR_FAMILY.LINK_STATE), {
    afi: BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
    safi: BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS
});
assert.deepEqual(getAfiAndSafi(BgpConst.BGP_ADDR_FAMILY.LINK_STATE_VPN), {
    afi: BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
    safi: BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN
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

const prefixSidPacket = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
    Buffer.from([1, 1, 1, 1]),
    Buffer.concat([Buffer.from([48]), labelEntry(101), Buffer.from([192, 0, 2])]),
    [prefixSidAttr(2001, 16000, 8000)]
);
const prefixSidAttrParsed = prefixSidPacket.pathAttributes.find(
    attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID
);
assert.equal(prefixSidPacket.valid, true);
assert.ok(prefixSidAttrParsed);
assert.equal(prefixSidAttrParsed.prefixSid.labelIndex.labelIndex, 2001);
assert.equal(prefixSidAttrParsed.prefixSid.originatorSrgb.ranges[0].start, 16000);
assert.equal(prefixSidAttrParsed.prefixSid.originatorSrgb.ranges[0].range, 8000);
assert.equal(prefixSidAttrParsed.prefixSid.formatted, 'Label-Index 2001, SRGB 16000+8000');
assert.ok(getBgpPacketSummary(prefixSidPacket).includes('PREFIX_SID: Label-Index 2001, SRGB 16000+8000'));
const prefixSidBmpRoute = {};
new BmpSession({ sendEvent() {} }, {}).setRouteAttributes(prefixSidBmpRoute, prefixSidPacket);
assert.equal(prefixSidBmpRoute.prefixSid, 'Label-Index 2001, SRGB 16000+8000');

const srv6PrefixSidPacket = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    Buffer.from([1, 1, 1, 1]),
    Buffer.concat([Buffer.from([24]), Buffer.from([203, 0, 113])]),
    [srv6ServicePrefixSidAttr(5, '20010db8000000000000000000000001', 19)]
);
const srv6PrefixSidAttrParsed = srv6PrefixSidPacket.pathAttributes.find(
    attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID
);
const srv6Service = srv6PrefixSidAttrParsed.prefixSid.srv6Services[0];
const srv6SidInfo = srv6Service.sidInfos[0];
assert.equal(srv6PrefixSidPacket.valid, true);
assert.equal(srv6Service.serviceType, 'l3');
assert.equal(srv6SidInfo.sid, '2001:db8::1');
assert.equal(srv6SidInfo.endpointBehavior, 19);
assert.equal(srv6SidInfo.endpointBehaviorName, 'End.DT4');
assert.equal(srv6SidInfo.sidStructure.locatorBlockLength, 48);
assert.equal(srv6SidInfo.sidStructure.locatorNodeLength, 16);
assert.equal(srv6SidInfo.sidStructure.functionLength, 16);
assert.equal(srv6PrefixSidAttrParsed.prefixSid.formatted, 'SRv6 L3 2001:db8::1 End.DT4');
assert.ok(getBgpPacketSummary(srv6PrefixSidPacket).includes('PREFIX_SID: SRv6 L3 2001:db8::1 End.DT4'));

const srv6VpnPrefixSidPacket = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    Buffer.from([1, 1, 1, 1]),
    Buffer.concat([Buffer.from([24]), Buffer.from([203, 0, 113])]),
    [srv6ServicePrefixSidAttr(4, '20010db8000000000000000000000001', 19)]
);
const srv6VpnPrefixSidAttrParsed = srv6VpnPrefixSidPacket.pathAttributes.find(
    attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID
);
const srv6VpnService = srv6VpnPrefixSidAttrParsed.prefixSid.srv6Services[0];
const srv6VpnSidInfo = srv6VpnService.sidInfos[0];
assert.equal(srv6VpnPrefixSidPacket.valid, true);
assert.equal(srv6VpnService.serviceType, 'vpn');
assert.equal(srv6VpnSidInfo.sid, '2001:db8::1');
assert.equal(srv6VpnSidInfo.endpointBehavior, 19);
assert.equal(srv6VpnSidInfo.endpointBehaviorName, 'End.DT4');
assert.equal(srv6VpnPrefixSidAttrParsed.prefixSid.formatted, 'SRv6 VPN 2001:db8::1 End.DT4');
assert.ok(getBgpPacketSummary(srv6VpnPrefixSidPacket).includes('PREFIX_SID: SRv6 VPN 2001:db8::1 End.DT4'));

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
const invalidLabeledUnicastSummary = getBgpPacketSummary(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
        Buffer.from([1, 1, 1, 1]),
        Buffer.concat([Buffer.from([48]), labelEntry(100, false), Buffer.from([192, 0, 2])])
    )
);
assert.ok(invalidLabeledUnicastSummary.includes('Labels 100'));
assert.ok(invalidLabeledUnicastSummary.includes('bottom-of-stack'));
assert.ok(invalidLabeledUnicastSummary.includes('Raw'));

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
    Buffer.concat([Buffer.from([112]), labelEntry(100), rd65000, Buffer.from([203, 0, 113])])
);
const vpnv4Route = firstReachRoute(vpnv4Packet);
assert.equal(vpnv4Packet.pathAttributes[0].mpReach.nextHop, '192.0.2.254');
assert.equal(vpnv4Route.prefix, '203.0.113.0');
assert.equal(vpnv4Route.displayPrefix, undefined);
assert.equal(vpnv4Route.rd, '65000:1');
assert.equal(vpnv4Route.labels[0].label, 100);
assert.equal(vpnv4Route.labels[0].bottom, true);
const vpnv4BmpRoute = {};
new BmpSession({ sendEvent() {} }, {}).setRouteNlri(
    vpnv4BmpRoute,
    vpnv4Route,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_VPN
);
assert.equal(vpnv4BmpRoute.ip, '203.0.113.0');
assert.equal(vpnv4BmpRoute.rd, '65000:1');
assert.equal(vpnv4BmpRoute.labels, '100(BOS)');

const vpnv4Withdrawal = firstUnreachRoute(
    parseUpdateWithMpUnreach(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_VPN,
        Buffer.concat([Buffer.from([112, 0x80, 0, 0]), rd65000, Buffer.from([203, 0, 113])])
    )
);
assert.equal(vpnv4Withdrawal.valid, true);
assert.equal(vpnv4Withdrawal.prefix, '203.0.113.0');
assert.equal(vpnv4Withdrawal.rd, '65000:1');
assert.equal(vpnv4Withdrawal.compatibilityField, '800000');
assert.equal(vpnv4Withdrawal.labels, undefined);

const vpnv6Packet = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_VPN,
    Buffer.concat([
        rd65000,
        Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        rd65000,
        Buffer.from([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    ]),
    Buffer.concat([Buffer.from([120]), labelEntry(101), rd65000, Buffer.from([0x20, 0x01, 0x0d, 0xb8])])
);
const vpnv6Route = firstReachRoute(vpnv6Packet);
assert.equal(vpnv6Packet.pathAttributes[0].mpReach.nextHop, '2001:db8::1, fe80::1');
assert.equal(vpnv6Route.prefix, '2001:db8::');
assert.equal(vpnv6Route.displayPrefix, undefined);
assert.equal(vpnv6Route.rd, '65000:1');
assert.equal(vpnv6Route.labels[0].label, 101);
const vpnv6BmpRoute = {};
new BmpSession({ sendEvent() {} }, {}).setRouteNlri(
    vpnv6BmpRoute,
    vpnv6Route,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_VPN
);
assert.equal(vpnv6BmpRoute.ip, '2001:db8::');
assert.equal(vpnv6BmpRoute.rd, '65000:1');
assert.equal(vpnv6BmpRoute.labels, '101(BOS)');

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
assert.equal(evpnMacIp.labels[0].mplsLabel, 200);
assert.equal(evpnMacIp.labels[0].raw24, 3201);
assert.equal(evpnMacIp.labels[0].vni, 3201);
assert.equal(evpnMacIp.labels[0].type, 'unknown');
assert.equal(evpnMacIp.labels[0].display, 'MPLS 200(BOS)/VNI 3201');
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
assert.equal(evpnBmpRoute.labels, 'MPLS 200(BOS)/VNI 3201');
assert.equal(evpnBmpRoute.nlriDetail.macAddress, 'aa:bb:cc:dd:ee:ff');
assert.equal(evpnBmpRoute.nlriDetail.ethernetTagId, 100);

const evpnVxlanMacIpPacket = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
    BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
    Buffer.alloc(0),
    evpnNlri(
        2,
        Buffer.concat([
            rd65000,
            esi,
            u32(100),
            Buffer.from([48, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 32, 192, 0, 2, 11]),
            evpnRaw24(10000)
        ])
    ),
    [encapsulationExtCommunity(8)]
);
const evpnVxlanExtCommunity = evpnVxlanMacIpPacket.pathAttributes
    .find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES)
    .extCommunities.find(community => community.encapsulation);
assert.equal(evpnVxlanExtCommunity.encapsulation.tunnelTypeName, 'VXLAN');
const evpnVxlanMacIp = firstReachRoute(evpnVxlanMacIpPacket);
assert.equal(evpnVxlanMacIp.encapsulationType, 'vni');
assert.equal(evpnVxlanMacIp.labels[0].raw24, 10000);
assert.equal(evpnVxlanMacIp.labels[0].mplsLabel, 625);
assert.equal(evpnVxlanMacIp.labels[0].vni, 10000);
assert.equal(evpnVxlanMacIp.labels[0].type, 'vni');
assert.equal(evpnVxlanMacIp.labels[0].display, 'VNI 10000');
const evpnVxlanBmpRoute = {};
new BmpSession({ sendEvent() {} }, {}).setRouteNlri(
    evpnVxlanBmpRoute,
    evpnVxlanMacIp,
    BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
    BgpConst.BGP_SAFI_TYPE.SAFI_EVPN
);
assert.equal(evpnVxlanBmpRoute.labels, 'VNI 10000');

const evpnMplsTunnelAttrRoute = firstReachRoute(
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
                Buffer.from([48, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x22, 32, 192, 0, 2, 12]),
                labelEntry(201)
            ])
        ),
        [tunnelEncapsulationAttr(10)]
    )
);
assert.equal(evpnMplsTunnelAttrRoute.encapsulationType, 'mpls');
assert.equal(evpnMplsTunnelAttrRoute.labels[0].label, 201);
assert.equal(evpnMplsTunnelAttrRoute.labels[0].raw24, 3217);
assert.equal(evpnMplsTunnelAttrRoute.labels[0].type, 'mpls');
assert.equal(evpnMplsTunnelAttrRoute.labels[0].display, 'MPLS 201(BOS)');

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

const evpnVxlanImetPacket = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
    BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
    Buffer.alloc(0),
    evpnNlri(3, Buffer.concat([rd65000, u32(100), Buffer.from([32, 10, 0, 0, 3])])),
    [encapsulationExtCommunity(8), pmsiTunnelAttr(6, 10000, Buffer.from([10, 0, 0, 3]))]
);
const evpnVxlanImet = firstReachRoute(evpnVxlanImetPacket);
const pmsiAttr = evpnVxlanImetPacket.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL);
assert.equal(pmsiAttr.pmsiTunnel.tunnelTypeName, 'Ingress Replication');
assert.equal(pmsiAttr.pmsiTunnel.label.display, 'VNI 10000');
assert.equal(evpnVxlanImet.encapsulationType, 'vni');
assert.equal(evpnVxlanImet.pmsiTunnel.label.raw24, 10000);
assert.equal(evpnVxlanImet.labels[0].display, 'VNI 10000');

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

const evpnIpPrefixPacket = parseUpdateWithMpReach(
    BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
    BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
    Buffer.alloc(0),
    evpnNlri(
        5,
        Buffer.concat([rd65000, esi, u32(100), Buffer.from([24, 203, 0, 113, 0, 192, 0, 2, 1]), labelEntry(300)])
    )
);
const evpnIpPrefix = firstReachRoute(evpnIpPrefixPacket);
assert.equal(evpnIpPrefix.valid, true);
assert.equal(evpnIpPrefix.ipPrefix, '203.0.113.0');
assert.equal(evpnIpPrefix.length, 24);
assert.equal(evpnIpPrefix.nlriLength, 34);
assert.equal(evpnIpPrefix.gatewayIp, '192.0.2.1');
assert.equal(evpnIpPrefix.labels[0].label, 300);
assert.ok(evpnIpPrefix.prefix.includes('evpn:ip-prefix:65000:1:tag=100:203.0.113.0/24'));
assert.ok(
    getBgpPacketSummary(evpnIpPrefixPacket).includes('evpn:ip-prefix:65000:1:tag=100:203.0.113.0/24:gw=192.0.2.1/34')
);

const evpnSelectiveMulticast = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(
            6,
            Buffer.concat([rd65000, u32(100), multicastSource, multicastGroup, originatorRouter, Buffer.from([0x03])])
        )
    )
);
assert.equal(evpnSelectiveMulticast.valid, true);
assert.equal(evpnSelectiveMulticast.routeTypeName, 'Selective Multicast Ethernet Tag');
assert.equal(evpnSelectiveMulticast.ethernetTagId, 100);
assert.equal(evpnSelectiveMulticast.sourceAddress, '192.0.2.1');
assert.equal(evpnSelectiveMulticast.groupAddress, '239.1.1.1');
assert.equal(evpnSelectiveMulticast.originatorRouterIp, '10.0.0.1');
assert.equal(evpnSelectiveMulticast.flags, 0x03);
assert.ok(evpnSelectiveMulticast.prefix.includes('evpn:smet:65000:1'));

const evpnMembershipSync = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(
            7,
            Buffer.concat([
                rd65000,
                esi,
                u32(100),
                multicastSource,
                multicastGroup,
                originatorRouter,
                Buffer.from([0x02])
            ])
        )
    )
);
assert.equal(evpnMembershipSync.valid, true);
assert.equal(evpnMembershipSync.routeTypeName, 'Multicast Membership Report Synch');
assert.equal(evpnMembershipSync.esi, '00:01:02:03:04:05:06:07:08:09');
assert.equal(evpnMembershipSync.groupAddress, '239.1.1.1');
assert.equal(evpnMembershipSync.flags, 0x02);
assert.ok(evpnMembershipSync.prefix.includes('evpn:membership-sync:65000:1'));

const evpnLeaveSync = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(
            8,
            Buffer.concat([
                rd65000,
                esi,
                u32(100),
                multicastSource,
                multicastGroup,
                originatorRouter,
                u32(0),
                Buffer.from([10, 0x01])
            ])
        )
    )
);
assert.equal(evpnLeaveSync.valid, true);
assert.equal(evpnLeaveSync.routeTypeName, 'Multicast Leave Synch');
assert.equal(evpnLeaveSync.maximumResponseTime, 10);
assert.equal(evpnLeaveSync.flags, 0x01);
assert.ok(evpnLeaveSync.prefix.includes('evpn:leave-sync:65000:1'));

const evpnPerRegionIpmsi = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(9, Buffer.concat([rd65000, u32(100), Buffer.from('0102030405060708', 'hex')]))
    )
);
assert.equal(evpnPerRegionIpmsi.valid, true);
assert.equal(evpnPerRegionIpmsi.routeTypeName, 'Per-Region I-PMSI A-D');
assert.equal(evpnPerRegionIpmsi.regionId, '01:02:03:04:05:06:07:08');
assert.equal(evpnPerRegionIpmsi.regionIdHex, '0102030405060708');
assert.ok(evpnPerRegionIpmsi.prefix.includes('evpn:per-region-ipmsi:65000:1'));

const evpnSPmsiBody = Buffer.concat([rd65000, u32(100), multicastSource, multicastGroup, originatorRouter]);
const evpnSPmsi = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(10, evpnSPmsiBody)
    )
);
assert.equal(evpnSPmsi.valid, true);
assert.equal(evpnSPmsi.routeTypeName, 'S-PMSI A-D');
assert.equal(evpnSPmsi.sourceAddress, '192.0.2.1');
assert.equal(evpnSPmsi.groupAddress, '239.1.1.1');
assert.ok(evpnSPmsi.prefix.includes('evpn:spmsi:65000:1'));

const evpnLeafAd = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(11, Buffer.concat([evpnNlri(10, evpnSPmsiBody), evpnIpField(10, 0, 0, 2)]))
    )
);
assert.equal(evpnLeafAd.valid, true);
assert.equal(evpnLeafAd.routeTypeName, 'Leaf A-D');
assert.equal(evpnLeafAd.rd, '65000:1');
assert.equal(evpnLeafAd.routeKeyRouteType, 10);
assert.equal(evpnLeafAd.routeKeyRouteTypeName, 'S-PMSI A-D');
assert.equal(evpnLeafAd.routeKeyRoute.prefix, evpnSPmsi.prefix);
assert.equal(evpnLeafAd.originatorRouterIp, '10.0.0.2');
assert.ok(evpnLeafAd.prefix.includes('evpn:leaf-ad:key=evpn:spmsi:65000:1'));

const unknownEvpnType = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        Buffer.alloc(0),
        evpnNlri(99, Buffer.from([1, 2, 3]))
    )
);
assert.equal(unknownEvpnType.prefix, '010203');
assert.equal(unknownEvpnType.rd, null);
assert.equal(unknownEvpnType.routeTypeName, 'Unknown (99)');
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

const bgpLsVpnPrefix = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
        BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN,
        Buffer.alloc(0),
        bgpLsNlri(3, Buffer.concat([rd65000, bgpLsBody(3, [nodeDescriptor, ipv4Reachability])]))
    )
);
assert.equal(bgpLsVpnPrefix.valid, true);
assert.equal(bgpLsVpnPrefix.prefix, 'bgp-ls-vpn:IPv4 Prefix:203.0.113.0/24');
assert.equal(bgpLsVpnPrefix.rd, '65000:1');
assert.equal(bgpLsVpnPrefix.vpn, true);
assert.equal(bgpLsVpnPrefix.length, 24);
const bgpLsVpnBmpRoute = {};
new BmpSession({ sendEvent() {} }, {}).setRouteNlri(
    bgpLsVpnBmpRoute,
    bgpLsVpnPrefix,
    BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
    BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN
);
assert.equal(bgpLsVpnBmpRoute.ip, 'bgp-ls-vpn:IPv4 Prefix:203.0.113.0/24');
assert.equal(bgpLsVpnBmpRoute.rd, '65000:1');
assert.equal(bgpLsVpnBmpRoute.safi, BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN);

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

const bgpLsVpnLink = firstReachRoute(
    parseUpdateWithMpReach(
        BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
        BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN,
        Buffer.alloc(0),
        bgpLsNlri(2, Buffer.concat([rd65000, bgpLsBody(3, linkDescriptors)]))
    )
);
assert.equal(bgpLsVpnLink.valid, true);
assert.equal(bgpLsVpnLink.prefix, 'bgp-ls-vpn:Link:10.0.0.1->10.0.0.2');
assert.equal(bgpLsVpnLink.rd, '65000:1');

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
