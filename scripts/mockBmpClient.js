#!/usr/bin/env node

const net = require('net');
const ipaddr = require('ipaddr.js');
const BmpConst = require('../electron/const/bmpConst');
const BgpConst = require('../electron/const/bgpConst');

const DEFAULT_OPTIONS = {
    host: '127.0.0.1',
    port: 1790,
    routes: 25,
    interval: 30,
    once: false,
    dumpPackets: true
};

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(value));
    return buffer;
}

function ip(ipAddress) {
    return Buffer.from(ipAddress.split('.').map(part => parseInt(part, 10)));
}

function ipBytes(ipAddress) {
    return Buffer.from(ipaddr.parse(ipAddress).toByteArray());
}

function rd(asn = 0, assigned = 0) {
    return Buffer.concat([u16(BgpConst.RD_TYPE.AS2), u16(asn), u32(assigned)]);
}

function bgpPacket(type, body) {
    return Buffer.concat([
        Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
        u16(BgpConst.BGP_HEAD_LEN + body.length),
        Buffer.from([type]),
        body
    ]);
}

function capability(code, value) {
    return Buffer.concat([Buffer.from([code, value.length]), value]);
}

function addPathCapability(mode, afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
    return capability(BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH, Buffer.concat([u16(afi), Buffer.from([safi, mode])]));
}

function bgpOpenForAf({
    routerId = '192.0.2.1',
    afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    addPathMode = null
} = {}) {
    return bgpOpenForAddressFamilies({
        routerId,
        addressFamilies: [{ afi, safi, addPathMode }]
    });
}

function bgpOpenForAddressFamilies({
    routerId = '192.0.2.1',
    addressFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            addPathMode: null
        }
    ]
} = {}) {
    const capabilities = [];
    addressFamilies.forEach(({ afi, safi, addPathMode = null }) => {
        capabilities.push(
            capability(
                BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
                Buffer.concat([u16(afi), Buffer.from([0, safi])])
            )
        );
        if (addPathMode !== null) {
            capabilities.push(addPathCapability(addPathMode, afi, safi));
        }
    });
    capabilities.push(
        capability(BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH, Buffer.alloc(0)),
        capability(BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS, u32(65000))
    );

    const capabilityValue = Buffer.concat(capabilities);
    const optionalParam = Buffer.concat([
        Buffer.from([BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE, capabilityValue.length]),
        capabilityValue
    ]);
    const body = Buffer.concat([
        Buffer.from([BgpConst.BGP_VERSION]),
        u16(65000),
        u16(90),
        ip(routerId),
        Buffer.from([optionalParam.length]),
        optionalParam
    ]);

    return bgpPacket(BgpConst.BGP_PACKET_TYPE.OPEN, body);
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

function asPathAttr(asns = [65000, 65100]) {
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.AS_PATH,
        Buffer.concat([
            Buffer.from([BgpConst.BGP_AS_PATH_TYPE.AS_SEQUENCE, asns.length]),
            Buffer.concat(asns.map(asn => u16(asn)))
        ])
    );
}

function standardCommunitiesAttr(communities = []) {
    const value = Buffer.concat(
        communities.map(community => {
            const [asn, assigned] = String(community).split(':').map(Number);
            if (
                !Number.isInteger(asn) ||
                asn < 0 ||
                asn > 0xffff ||
                !Number.isInteger(assigned) ||
                assigned < 0 ||
                assigned > 0xffff
            ) {
                throw new Error(`Invalid standard BGP community: ${community}`);
            }
            return Buffer.concat([u16(asn), u16(assigned)]);
        })
    );
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.COMMUNITY,
        value,
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
}

function ipv4Nlri(prefix, pathId = null) {
    const nlri = Buffer.concat([Buffer.from([24]), ip(prefix).subarray(0, 3)]);
    if (pathId === null || pathId === undefined) {
        return nlri;
    }
    return Buffer.concat([u32(pathId), nlri]);
}

function ipv4Update(
    prefixes,
    {
        nextHop = '192.0.2.254',
        asns = [65000, 65100],
        localPref = 100,
        communities = [],
        addPath = false,
        pathIdStart = 1000
    } = {}
) {
    const attrList = [
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        asPathAttr(asns),
        pathAttr(BgpConst.BGP_PATH_ATTR.NEXT_HOP, ip(nextHop)),
        pathAttr(BgpConst.BGP_PATH_ATTR.LOCAL_PREF, u32(localPref), BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE)
    ];
    if (communities.length > 0) {
        attrList.push(standardCommunitiesAttr(communities));
    }
    const attrs = Buffer.concat(attrList);
    const nlris = Buffer.concat(
        prefixes.map((prefix, index) => ipv4Nlri(prefix, addPath ? pathIdStart + index : null))
    );
    const body = Buffer.concat([u16(0), u16(attrs.length), attrs, nlris]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, body);
}

function endOfRibUpdate(afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
    if (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
        return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(0)]));
    }

    const mpUnreach = pathAttr(
        BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI,
        Buffer.concat([u16(afi), Buffer.from([safi])]),
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL
    );
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(mpUnreach.length), mpUnreach]));
}

function labeledUnicastNlri(prefix, label = 300, pathId = null) {
    const rawLabel = (label << 4) | 1;
    const labelBytes = Buffer.from([(rawLabel >> 16) & 0xff, (rawLabel >> 8) & 0xff, rawLabel & 0xff]);
    const nlri = Buffer.concat([Buffer.from([48]), labelBytes, ip(prefix).subarray(0, 3)]);
    if (pathId === null || pathId === undefined) {
        return nlri;
    }
    return Buffer.concat([u32(pathId), nlri]);
}

function labeledUnicastNlriWithoutLabel(prefix, { prefixLength = 16, pathId = null } = {}) {
    const nlri = Buffer.concat([Buffer.from([prefixLength]), ip(prefix).subarray(0, Math.ceil(prefixLength / 8))]);
    if (pathId === null || pathId === undefined) {
        return nlri;
    }
    return Buffer.concat([u32(pathId), nlri]);
}

function labeledUnicastUpdate(prefix, { nextHop = '192.0.2.251', label = 300, pathId = null } = {}) {
    const mpReachValue = Buffer.concat([
        u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
        Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST, 4]),
        ip(nextHop),
        Buffer.from([0]),
        labeledUnicastNlri(prefix, label, pathId)
    ]);
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL)
    ]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrs.length), attrs]));
}

function labeledUnicastNoLabelUpdate(prefix, { nextHop = '192.0.2.251', pathId = null, prefixLength = 16 } = {}) {
    const mpReachValue = Buffer.concat([
        u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
        Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST, 4]),
        ip(nextHop),
        Buffer.from([0]),
        labeledUnicastNlriWithoutLabel(prefix, { prefixLength, pathId })
    ]);
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL)
    ]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrs.length), attrs]));
}

function ipv4MappedIpv6(ipAddress) {
    return Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), ip(ipAddress)]);
}

function ipv6LabeledUnicastNlri(prefix, { label = 400, pathId = null, prefixLength = 64 } = {}) {
    const rawLabel = (label << 4) | 1;
    const labelBytes = Buffer.from([(rawLabel >> 16) & 0xff, (rawLabel >> 8) & 0xff, rawLabel & 0xff]);
    const prefixBytes = ipBytes(prefix).subarray(0, Math.ceil(prefixLength / 8));
    const nlri = Buffer.concat([Buffer.from([24 + prefixLength]), labelBytes, prefixBytes]);
    if (pathId === null || pathId === undefined) {
        return nlri;
    }
    return Buffer.concat([u32(pathId), nlri]);
}

function sixPeLabeledUnicastUpdate(
    prefix,
    { nextHop = '192.0.2.250', label = 400, pathId = null, prefixLength = 64 } = {}
) {
    const nextHopBytes = ipv4MappedIpv6(nextHop);
    const mpReachValue = Buffer.concat([
        u16(BgpConst.BGP_AFI_TYPE.AFI_IPV6),
        Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST, nextHopBytes.length]),
        nextHopBytes,
        Buffer.from([0]),
        ipv6LabeledUnicastNlri(prefix, { label, pathId, prefixLength })
    ]);
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL)
    ]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrs.length), attrs]));
}

function bgpLsTlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}

function bgpLsNodeDescriptor(type, asn, routerId) {
    return bgpLsTlv(type, Buffer.concat([bgpLsTlv(512, u32(asn)), bgpLsTlv(515, ip(routerId))]));
}

function bgpLsLinkUpdate() {
    const nlriBody = Buffer.concat([
        Buffer.from([3]),
        u32(0),
        u32(20001),
        bgpLsNodeDescriptor(256, 65009, '10.100.0.1'),
        bgpLsNodeDescriptor(257, 65109, '10.200.0.1'),
        bgpLsTlv(259, ip('10.10.0.1')),
        bgpLsTlv(260, ip('10.10.0.2'))
    ]);
    const nlri = Buffer.concat([u16(2), u16(nlriBody.length), nlriBody]);
    const mpReachValue = Buffer.concat([
        u16(BgpConst.BGP_AFI_TYPE.AFI_BGP_LS),
        Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS, 0, 0]),
        nlri
    ]);
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL)
    ]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrs.length), attrs]));
}

function evpnRaw24(value) {
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function evpnNlri(routeType, body) {
    return Buffer.concat([Buffer.from([routeType, body.length]), body]);
}

function evpnVxlanUpdate(vni = 10000, sequence = 1, options = {}) {
    if (typeof sequence === 'object' && sequence !== null) {
        options = sequence;
        sequence = 1;
    }
    const { pathId = null } = options;
    const rd65000 = Buffer.from([0, 0, 0xfd, 0xe8, 0, 0, 0, sequence]);
    const esi = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, sequence & 0xff]);
    const mac = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, sequence & 0xff]);
    const host = Buffer.from([192, 0, 2, 10 + sequence]);
    const evpnRoute = evpnNlri(
        2,
        Buffer.concat([
            rd65000,
            esi,
            u32(100 + sequence),
            Buffer.concat([Buffer.from([48]), mac, Buffer.from([32]), host]),
            evpnRaw24(vni)
        ])
    );
    const nlri = pathId === null || pathId === undefined ? evpnRoute : Buffer.concat([u32(pathId), evpnRoute]);
    const mpReachValue = Buffer.concat([
        u16(BgpConst.BGP_AFI_TYPE.AFI_L2VPN),
        Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_EVPN, 4]),
        ip('10.0.0.1'),
        Buffer.from([0]),
        nlri
    ]);
    const vxlanEncapsulationCommunity = Buffer.concat([Buffer.from([0x03, 0x0c, 0, 0, 0, 0]), u16(8)]);
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL),
        pathAttr(
            BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
            vxlanEncapsulationCommunity,
            BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
        )
    ]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrs.length), attrs]));
}

function bmpMessage(type, payload, version = BmpConst.BMP_VERSION.V4) {
    return Buffer.concat([
        Buffer.from([version]),
        u32(BmpConst.BMP_HEADER_LENGTH + payload.length),
        Buffer.from([type]),
        payload
    ]);
}

function peerHeader({
    flags = 0,
    peerType = BmpConst.BMP_PEER_TYPE.GLOBAL,
    rd: peerRd = Buffer.alloc(BgpConst.BGP_RD_LEN),
    peerAddress = '192.0.2.2',
    peerAs = 65000,
    routerId = '192.0.2.1',
    timestamp = Math.floor(Date.now() / 1000),
    timestampMs = 0
} = {}) {
    const address = peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB ? Buffer.alloc(4) : ip(peerAddress);
    return Buffer.concat([
        Buffer.from([peerType, flags]),
        peerRd,
        Buffer.alloc(12),
        address,
        u32(peerAs),
        ip(routerId),
        u32(timestamp),
        u32(timestampMs)
    ]);
}

function peerUpPayload({
    flags = 0,
    peerType = BmpConst.BMP_PEER_TYPE.GLOBAL,
    rd: peerRd = Buffer.alloc(BgpConst.BGP_RD_LEN),
    peerAddress = '192.0.2.2',
    peerAs = 65000,
    routerId = '192.0.2.1',
    localAddress = '192.0.2.254',
    localPort = 179,
    remotePort = 50000,
    afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    recvAddPathMode = null,
    sendAddPathMode = null,
    recvAddressFamilies = null,
    sendAddressFamilies = null,
    vrfName = null
} = {}) {
    const tlvs = [];
    if (vrfName) {
        tlvs.push(tlv(BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME, Buffer.from(vrfName)));
    }

    return Buffer.concat([
        peerHeader({ flags, peerType, rd: peerRd, peerAddress, peerAs, routerId }),
        Buffer.alloc(12),
        ip(localAddress),
        u16(localPort),
        u16(remotePort),
        Array.isArray(recvAddressFamilies)
            ? bgpOpenForAddressFamilies({ routerId: peerAddress, addressFamilies: recvAddressFamilies })
            : bgpOpenForAf({ routerId: peerAddress, afi, safi, addPathMode: recvAddPathMode }),
        Array.isArray(sendAddressFamilies)
            ? bgpOpenForAddressFamilies({ routerId, addressFamilies: sendAddressFamilies })
            : bgpOpenForAf({ routerId, afi, safi, addPathMode: sendAddPathMode }),
        ...tlvs
    ]);
}

function locRibPeerUpPayload({
    flags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
    rd: peerRd = Buffer.alloc(BgpConst.BGP_RD_LEN),
    vrfName = 'global',
    recvAddPathMode = null,
    sendAddPathMode = null,
    recvAddressFamilies = null,
    sendAddressFamilies = null
} = {}) {
    return Buffer.concat([
        peerHeader({ flags, peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB, rd: peerRd }),
        Buffer.alloc(16),
        u16(0),
        u16(0),
        Array.isArray(recvAddressFamilies)
            ? bgpOpenForAddressFamilies({ addressFamilies: recvAddressFamilies })
            : bgpOpenForAf({ addPathMode: recvAddPathMode }),
        Array.isArray(sendAddressFamilies)
            ? bgpOpenForAddressFamilies({ addressFamilies: sendAddressFamilies })
            : bgpOpenForAf({ addPathMode: sendAddPathMode }),
        tlv(BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME, Buffer.from(vrfName))
    ]);
}

function tlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}

function indexedTlv(type, index, value) {
    return Buffer.concat([u16(type), u16(value.length), u16(index), value]);
}

function groupValue(indexes) {
    return Buffer.concat(indexes.map(index => u16(index)));
}

function statelessParsingValue() {
    return Buffer.concat([
        addPathCapability(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST),
        capability(BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS, u32(65000))
    ]);
}

function pathMarkingValue(status, reason = null) {
    if (reason === null || reason === undefined) {
        return u32(status);
    }

    return Buffer.concat([u32(status), u16(reason)]);
}

function statsRecords(records) {
    return Buffer.concat([
        u32(records.length),
        ...records.map(record => {
            let value;
            if (record.afi !== undefined && record.safi !== undefined) {
                value = Buffer.concat([u16(record.afi), Buffer.from([record.safi]), u64(record.value)]);
            } else {
                value = u32(record.value);
            }
            return Buffer.concat([u16(record.type), u16(value.length), value]);
        })
    ]);
}

function initiationMessage() {
    return bmpMessage(
        BmpConst.BMP_MSG_TYPE.INITIATION,
        Buffer.concat([
            tlv(BmpConst.BMP_INITIATION_TLV_TYPE.SYS_NAME, Buffer.from('demo-bmp-router')),
            tlv(BmpConst.BMP_INITIATION_TLV_TYPE.SYS_DESC, Buffer.from('NetNexus local BMP demo data'))
        ])
    );
}

function routeMonitoringAllSupportedTlvs({
    sequenceNumber = 1,
    timestampSeconds = 1719811200,
    timestampMicroseconds = 123456,
    extendedFlags = 0,
    vrfName = 'global',
    groupIndex = 0x8001,
    pathStatus = BmpConst.BMP_PATH_STATUS.BEST | BmpConst.BMP_PATH_STATUS.PRIMARY,
    pathReason = BmpConst.BMP_PATH_STATUS_REASON.NOT_PREFERRED_ROUTER_ID
} = {}) {
    return [
        indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.SEQUENCE_NUMBER, 0, u32(sequenceNumber)),
        indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS, 0, Buffer.from([extendedFlags])),
        indexedTlv(
            BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.TIMESTAMP,
            0,
            Buffer.concat([u32(timestampSeconds), u32(timestampMicroseconds)])
        ),
        indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.GROUP, groupIndex, groupValue([1])),
        indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from(vrfName)),
        indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.STATELESS_PARSING, 0, statelessParsingValue()),
        indexedTlv(
            BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
            groupIndex,
            pathMarkingValue(pathStatus, pathReason)
        )
    ];
}

function routeMonitoringMessage(
    peer,
    bgpMessage,
    { pathStatus = null, vrfName = null, extendedFlags = null, routeTlvs = [] } = {}
) {
    const tlvs = [];
    if (vrfName) {
        tlvs.push(indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from(vrfName)));
    }
    if (extendedFlags !== null && extendedFlags !== undefined) {
        tlvs.push(indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS, 0, Buffer.from([extendedFlags])));
    }
    if (Array.isArray(routeTlvs)) {
        tlvs.push(...routeTlvs);
    }
    tlvs.push(indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpMessage));
    if (pathStatus) {
        tlvs.push(
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
                0,
                pathMarkingValue(pathStatus.status, pathStatus.reason)
            )
        );
    }

    return bmpMessage(BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING, Buffer.concat([peerHeader(peer), ...tlvs]));
}

function statisticsReportMessage(peer, records) {
    return bmpMessage(
        BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT,
        Buffer.concat([peerHeader(peer), tlv(BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS, statsRecords(records))])
    );
}

function makePrefixes(count, secondOctet = 0) {
    return Array.from({ length: count }, (_, index) => {
        const third = Math.floor(index / 250);
        const fourthBase = index % 250;
        return `10.${secondOctet + third}.${fourthBase}.0`;
    });
}

function formatPacketHex(buffer, bytesPerLine = 16) {
    const lines = [];
    for (let offset = 0; offset < buffer.length; offset += bytesPerLine) {
        const line = Array.from(buffer.subarray(offset, offset + bytesPerLine), byte =>
            byte.toString(16).padStart(2, '0').toUpperCase()
        ).join(' ');
        lines.push(line);
    }
    return lines.join('\n');
}

function parseArgs(argv) {
    const options = { ...DEFAULT_OPTIONS };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--host') {
            options.host = argv[++index] || options.host;
        } else if (arg === '--port') {
            options.port = Number(argv[++index] || options.port);
        } else if (arg === '--routes') {
            options.routes = Number(argv[++index] || options.routes);
        } else if (arg === '--interval') {
            options.interval = Number(argv[++index] || options.interval);
        } else if (arg === '--once') {
            options.once = true;
        } else if (arg === '--dump-packets') {
            options.dumpPackets = true;
        } else if (arg === '--no-dump-packets') {
            options.dumpPackets = false;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
        throw new Error(`Invalid --port: ${options.port}`);
    }
    if (!Number.isInteger(options.routes) || options.routes <= 0) {
        throw new Error(`Invalid --routes: ${options.routes}`);
    }
    if (!Number.isInteger(options.interval) || options.interval < 0) {
        throw new Error(`Invalid --interval: ${options.interval}`);
    }

    return options;
}

function printHelp() {
    console.log(`Usage: npm run mock:bmp -- [options]

Options:
  --host <ip>        BMP server host, default ${DEFAULT_OPTIONS.host}
  --port <port>      BMP server port, default ${DEFAULT_OPTIONS.port}
  --routes <count>   IPv4 route count, default ${DEFAULT_OPTIONS.routes}
  --interval <ms>    Delay between message batches, default ${DEFAULT_OPTIONS.interval}
  --once             Send data once and close the TCP connection
  --dump-packets     Print each sent BMP packet as copyable hex bytes, default on
  --no-dump-packets  Do not print packet hex bytes
  -h, --help         Show this help
`);
}

function buildScenario(options) {
    const ipv4Peer = {
        peerAddress: '192.0.2.2',
        peerAs: 65000,
        routerId: '192.0.2.1'
    };
    const addPathPeer = {
        peerAddress: '192.0.2.3',
        peerAs: 65001,
        routerId: '192.0.2.3'
    };
    const extendedFlagsRibOutPeer = {
        peerAddress: '192.0.2.8',
        peerAs: 65006,
        routerId: '192.0.2.8'
    };
    const sixPePeer = {
        peerAddress: '192.0.2.9',
        peerAs: 65007,
        routerId: '192.0.2.9'
    };
    const routeLensRd = rd(65000, 120);
    const routeLensIngressPeer = {
        peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
        rd: routeLensRd,
        peerAddress: '192.0.2.10',
        peerAs: 65008,
        routerId: '192.0.2.10'
    };
    const routeLensEgressPeer = {
        peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
        rd: routeLensRd,
        peerAddress: '192.0.2.12',
        peerAs: 65010,
        routerId: '192.0.2.12'
    };
    const routeAssuranceEgressPeer = {
        peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
        rd: routeLensRd,
        peerAddress: '192.0.2.13',
        peerAs: 65011,
        routerId: '192.0.2.13'
    };
    const routeLensLocRibPeer = {
        flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
        peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        rd: routeLensRd
    };
    const bgpLsPeer = {
        peerAddress: '192.0.2.11',
        peerAs: 65009,
        routerId: '192.0.2.11'
    };
    const privateRibInRd = rd(65000, 200);
    const privateRibInPeer = {
        peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
        rd: privateRibInRd,
        peerAddress: '192.0.2.5',
        peerAs: 65003,
        routerId: '192.0.2.5'
    };
    const privateLabelRibInRd = rd(65000, 201);
    const privateLabelRibInPeer = {
        peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
        rd: privateLabelRibInRd,
        peerAddress: '192.0.2.6',
        peerAs: 65004,
        routerId: '192.0.2.6'
    };
    const privateLabelRibInErrorRd = rd(65000, 202);
    const privateLabelRibInErrorPeer = {
        peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
        rd: privateLabelRibInErrorRd,
        peerAddress: '192.0.2.7',
        peerAs: 65005,
        routerId: '192.0.2.7'
    };
    const evpnPeer = {
        peerAddress: '192.0.2.4',
        peerAs: 65002,
        routerId: '192.0.2.4'
    };
    const locRibPeer = {
        flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
        peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB
    };
    const privateLocRibRd = rd(65000, 100);
    const privateLocRibPeer = {
        flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
        peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        rd: privateLocRibRd
    };
    const privateLabelLocRibRd = rd(65000, 102);
    const privateLabelLocRibPeer = {
        flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
        peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        rd: privateLabelLocRibRd
    };
    const privateLabelLocRibErrorRd = rd(65000, 103);
    const privateLabelLocRibErrorPeer = {
        flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
        peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        rd: privateLabelLocRibErrorRd
    };
    const privateEvpnLocRibRd = rd(65000, 200);
    const privateEvpnLocRibPeer = {
        flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
        peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        rd: privateEvpnLocRibRd
    };
    const unicastAddPathOnlyFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
        }
    ];
    const unicastReceiveAddPathOnlyFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        }
    ];
    const labelAddPathAndUnicastNoAddPathFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        },
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
        }
    ];
    const labelReceiveAddPathAndUnicastNoAddPathFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        },
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        }
    ];
    // A Peer Up is a complete capability snapshot for one Loc-RIB RD. Keep
    // IPv4 unicast in the default-RD snapshot when adding EVPN, otherwise the
    // collector correctly treats the omitted IPv4 AF as removed/stale.
    const defaultLocRibEvpnAddPathFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        },
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
        }
    ];
    const defaultLocRibEvpnReceiveAddPathFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        },
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        }
    ];
    const sixPeFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
        }
    ];
    const bgpLsFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS
        }
    ];

    const ipv4Prefixes = makePrefixes(options.routes, 10);
    const addPathPrefixes = makePrefixes(Math.max(5, Math.min(10, options.routes)), 20);
    const locRibPrefixes = makePrefixes(Math.max(8, Math.min(25, options.routes)), 30);
    const ribInIsolationPublicPrefix = '203.0.118.0';
    const ribInPostPolicyExtendedFlagsPrefix = '203.0.126.0';
    const ribInAllTlvsPrefix = '203.0.128.0';
    const ribOutPostPolicyExtendedFlagsPrefix = '203.0.127.0';
    const routeLensLifecyclePrefix = '203.0.120.0';
    const routeAssuranceInboundGapPrefix = '203.0.121.0';
    const routeAssuranceNotSelectedPrefix = '203.0.122.0';
    const routeAssuranceNotExportedPrefix = '203.0.123.0';
    const routeAssuranceOutboundGapPrefix = '203.0.124.0';
    const routeAssuranceMultiEgressPrefix = '203.0.125.0';
    const ribInIsolationPrivatePrefix = '10.200.0.0';
    const ribInLabelUnicastPlainPrefix = '10.201.1.0';
    const ribInLabelUnicastLabeledPrefix = '10.201.2.0';
    const ribInLabelUnicastNoLabelPrefix = '10.201.0.0';
    const locRibIsolationPublicPrefix = '198.51.101.0';
    const locRibAllTlvsPrefix = '198.51.102.0';
    const locRibIsolationPrivatePrefix = '10.100.0.0';
    const locRibLabelUnicastPlainPrefix = '10.102.1.0';
    const locRibLabelUnicastLabeledPrefix = '10.102.2.0';
    const locRibLabelUnicastNoLabelPrefix = '10.102.0.0';
    const publicLocRibRouteCount = locRibPrefixes.length + 2;

    const messages = [
        { name: 'initiation', data: initiationMessage() },
        {
            name: 'peer-up-ipv4',
            data: bmpMessage(BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload(ipv4Peer))
        }
    ];

    ipv4Prefixes.forEach((prefix, index) => {
        messages.push({
            name: `ipv4-route-${index + 1}`,
            data: routeMonitoringMessage(ipv4Peer, ipv4Update([prefix]), {
                pathStatus:
                    index === 0
                        ? {
                              status: BmpConst.BMP_PATH_STATUS.BEST | BmpConst.BMP_PATH_STATUS.PRIMARY,
                              reason: BmpConst.BMP_PATH_STATUS_REASON.NOT_PREFERRED_ROUTER_ID
                          }
                        : null
            })
        });
    });

    messages.push(
        {
            name: 'statistics-ipv4',
            data: statisticsReportMessage(ipv4Peer, [
                { type: BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN, value: ipv4Prefixes.length },
                {
                    type: BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_ADJ_RIB_IN,
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                    value: ipv4Prefixes.length
                }
            ])
        },
        {
            name: 'peer-up-extended-flags-rib-out',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...extendedFlagsRibOutPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                })
            )
        },
        {
            name: 'extended-flags-rib-out-route',
            data: routeMonitoringMessage(
                {
                    ...extendedFlagsRibOutPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS | BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT
                },
                ipv4Update(['203.0.119.0'], {
                    nextHop: '192.0.2.248',
                    asns: [65006, 65106]
                }),
                { extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT }
            )
        },
        {
            name: 'extended-flags-post-policy-rib-out-route',
            data: routeMonitoringMessage(
                {
                    ...extendedFlagsRibOutPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([ribOutPostPolicyExtendedFlagsPrefix], {
                    nextHop: '192.0.2.248',
                    asns: [65006, 65106]
                }),
                {
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT | BmpConst.BMP_SESSION_FLAGS.POST_POLICY
                }
            )
        },
        {
            name: 'peer-up-route-lens-lifecycle',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...routeLensIngressPeer,
                    localAddress: '192.0.2.210',
                    vrfName: 'route-lens-lab'
                })
            )
        },
        {
            name: 'route-lens-lifecycle-pre-in',
            data: routeMonitoringMessage(
                routeLensIngressPeer,
                ipv4Update([routeLensLifecyclePrefix], {
                    nextHop: '192.0.2.210',
                    asns: [65008, 65108],
                    localPref: 100,
                    communities: ['65000:100', '65000:120']
                }),
                { vrfName: 'route-lens-lab' }
            )
        },
        {
            name: 'route-lens-lifecycle-post-in',
            data: routeMonitoringMessage(
                {
                    ...routeLensIngressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([routeLensLifecyclePrefix], {
                    nextHop: '192.0.2.210',
                    asns: [65008, 65108],
                    localPref: 220,
                    communities: ['65000:120', '65000:220']
                }),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY
                }
            )
        },
        {
            name: 'route-assurance-inbound-filtered-pre-in',
            data: routeMonitoringMessage(
                routeLensIngressPeer,
                ipv4Update([routeAssuranceInboundGapPrefix], {
                    nextHop: '192.0.2.210',
                    asns: [65008, 65108],
                    localPref: 100,
                    communities: ['65000:121']
                }),
                {
                    vrfName: 'route-lens-lab',
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.FILTERED_IN_INBOUND_POLICY
                    }
                }
            )
        },
        {
            name: 'route-assurance-pre-in-candidates',
            data: routeMonitoringMessage(
                routeLensIngressPeer,
                ipv4Update(
                    [
                        routeAssuranceNotSelectedPrefix,
                        routeAssuranceNotExportedPrefix,
                        routeAssuranceOutboundGapPrefix,
                        routeAssuranceMultiEgressPrefix
                    ],
                    {
                        nextHop: '192.0.2.210',
                        asns: [65008, 65108],
                        localPref: 100,
                        communities: ['65000:120']
                    }
                ),
                { vrfName: 'route-lens-lab' }
            )
        },
        {
            name: 'route-assurance-post-in-candidates',
            data: routeMonitoringMessage(
                {
                    ...routeLensIngressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update(
                    [
                        routeAssuranceNotSelectedPrefix,
                        routeAssuranceNotExportedPrefix,
                        routeAssuranceOutboundGapPrefix,
                        routeAssuranceMultiEgressPrefix
                    ],
                    {
                        nextHop: '192.0.2.210',
                        asns: [65008, 65108],
                        localPref: 220,
                        communities: ['65000:120', '65000:220']
                    }
                ),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY
                }
            )
        },
        {
            name: 'peer-up-route-lens-egress',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...routeLensEgressPeer,
                    localAddress: '192.0.2.212',
                    vrfName: 'route-lens-lab'
                })
            )
        },
        {
            name: 'peer-up-route-assurance-egress',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...routeAssuranceEgressPeer,
                    localAddress: '192.0.2.213',
                    vrfName: 'route-lens-lab'
                })
            )
        },
        {
            name: 'route-lens-lifecycle-pre-out',
            data: routeMonitoringMessage(
                {
                    ...routeLensEgressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([routeLensLifecyclePrefix], {
                    nextHop: '192.0.2.210',
                    asns: [65008, 65108],
                    localPref: 220,
                    communities: ['65000:120', '65000:220']
                }),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT
                }
            )
        },
        {
            name: 'route-lens-lifecycle-post-out',
            data: routeMonitoringMessage(
                {
                    ...routeLensEgressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([routeLensLifecyclePrefix], {
                    nextHop: '192.0.2.1',
                    asns: [65000, 65008, 65108],
                    localPref: 220,
                    communities: ['65000:220', '65000:999']
                }),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT | BmpConst.BMP_SESSION_FLAGS.POST_POLICY
                }
            )
        },
        {
            name: 'route-assurance-outbound-filtered-pre-out',
            data: routeMonitoringMessage(
                {
                    ...routeLensEgressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([routeAssuranceOutboundGapPrefix], {
                    nextHop: '192.0.2.210',
                    asns: [65008, 65108],
                    localPref: 220,
                    communities: ['65000:124']
                }),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT,
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.FILTERED_IN_OUTBOUND_POLICY
                    }
                }
            )
        },
        {
            name: 'route-assurance-multi-egress-a-pre-out',
            data: routeMonitoringMessage(
                {
                    ...routeLensEgressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([routeAssuranceMultiEgressPrefix], {
                    nextHop: '192.0.2.210',
                    asns: [65008, 65108],
                    localPref: 220,
                    communities: ['65000:125']
                }),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT
                }
            )
        },
        {
            name: 'route-assurance-multi-egress-a-post-out',
            data: routeMonitoringMessage(
                {
                    ...routeLensEgressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([routeAssuranceMultiEgressPrefix], {
                    nextHop: '192.0.2.1',
                    asns: [65000, 65008, 65108],
                    localPref: 220,
                    communities: ['65000:125', '65000:901']
                }),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT | BmpConst.BMP_SESSION_FLAGS.POST_POLICY
                }
            )
        },
        {
            name: 'route-assurance-multi-egress-b-pre-out',
            data: routeMonitoringMessage(
                {
                    ...routeAssuranceEgressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([routeAssuranceMultiEgressPrefix], {
                    nextHop: '192.0.2.210',
                    asns: [65008, 65108],
                    localPref: 220,
                    communities: ['65000:125']
                }),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT
                }
            )
        },
        {
            name: 'route-assurance-multi-egress-b-post-out',
            data: routeMonitoringMessage(
                {
                    ...routeAssuranceEgressPeer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([routeAssuranceMultiEgressPrefix], {
                    nextHop: '192.0.2.2',
                    asns: [65000, 65008, 65108],
                    localPref: 220,
                    communities: ['65000:125', '65000:902']
                }),
                {
                    vrfName: 'route-lens-lab',
                    extendedFlags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT | BmpConst.BMP_SESSION_FLAGS.POST_POLICY
                }
            )
        },
        {
            name: 'peer-up-6pe-ipv6-label',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...sixPePeer,
                    recvAddressFamilies: sixPeFamilies,
                    sendAddressFamilies: sixPeFamilies,
                    vrfName: '6pe'
                })
            )
        },
        {
            name: '6pe-ipv6-label-route',
            data: routeMonitoringMessage(
                sixPePeer,
                sixPeLabeledUnicastUpdate('2001:db8:60::', {
                    nextHop: '192.0.2.250',
                    label: 401
                }),
                {
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'peer-up-bgp-ls',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...bgpLsPeer,
                    localAddress: '192.0.2.211',
                    recvAddressFamilies: bgpLsFamilies,
                    sendAddressFamilies: bgpLsFamilies,
                    vrfName: 'link-state'
                })
            )
        },
        {
            name: 'bgp-ls-link-route',
            data: routeMonitoringMessage(bgpLsPeer, bgpLsLinkUpdate(), { vrfName: 'link-state' })
        },
        {
            name: 'peer-up-add-path',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...addPathPeer,
                    recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
                    sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
                })
            )
        },
        {
            name: 'add-path-routes',
            data: routeMonitoringMessage(
                addPathPeer,
                ipv4Update([addPathPrefixes[0]], {
                    nextHop: '192.0.2.253',
                    asns: [65001, 65101],
                    addPath: true
                }),
                {
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BACKUP
                    }
                }
            )
        },
        ...addPathPrefixes.slice(1).map((prefix, index) => ({
            name: `add-path-route-${index + 2}`,
            data: routeMonitoringMessage(
                addPathPeer,
                ipv4Update([prefix], {
                    nextHop: '192.0.2.253',
                    asns: [65001, 65101],
                    addPath: true,
                    pathIdStart: 1001 + index
                })
            )
        })),
        {
            name: 'peer-up-private-rib-in-add-path',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...privateRibInPeer,
                    recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
                    sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY,
                    vrfName: 'vrf-blue'
                })
            )
        },
        {
            name: 'private-rib-in-add-path-route',
            data: routeMonitoringMessage(
                privateRibInPeer,
                ipv4Update([ribInIsolationPrivatePrefix], {
                    nextHop: '192.0.2.251',
                    asns: [65003, 65103],
                    addPath: true,
                    pathIdStart: 66
                }),
                {
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'public-rib-in-no-add-path-after-private',
            data: routeMonitoringMessage(
                ipv4Peer,
                ipv4Update([ribInIsolationPublicPrefix], {
                    nextHop: '192.0.2.254',
                    asns: [65000, 65100]
                })
            )
        },
        {
            name: 'public-rib-in-pre-policy-extended-flags-route',
            data: routeMonitoringMessage(
                ipv4Peer,
                ipv4Update([ribInPostPolicyExtendedFlagsPrefix], {
                    nextHop: '192.0.2.254',
                    asns: [65000, 65100]
                })
            )
        },
        {
            name: 'public-rib-in-post-policy-extended-flags-route',
            data: routeMonitoringMessage(
                {
                    ...ipv4Peer,
                    flags: BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS
                },
                ipv4Update([ribInPostPolicyExtendedFlagsPrefix], {
                    nextHop: '192.0.2.254',
                    asns: [65000, 65100]
                }),
                { extendedFlags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY }
            )
        },
        {
            name: 'public-rib-in-all-supported-tlvs-route',
            data: routeMonitoringMessage(
                ipv4Peer,
                ipv4Update([ribInAllTlvsPrefix], {
                    nextHop: '192.0.2.254',
                    asns: [65000, 65100]
                }),
                {
                    routeTlvs: routeMonitoringAllSupportedTlvs({
                        sequenceNumber: 9001,
                        vrfName: 'global',
                        extendedFlags: 0
                    })
                }
            )
        },
        {
            name: 'statistics-private-rib-in-add-path',
            data: statisticsReportMessage(privateRibInPeer, [
                { type: BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN, value: 1 },
                {
                    type: BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_ADJ_RIB_IN,
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                    value: 1
                }
            ])
        },
        {
            name: 'peer-up-private-rib-in-label-add-path-warning',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...privateLabelRibInPeer,
                    recvAddressFamilies: unicastAddPathOnlyFamilies,
                    sendAddressFamilies: unicastReceiveAddPathOnlyFamilies,
                    vrfName: 'vrf-label'
                })
            )
        },
        {
            name: 'private-rib-in-label-peer-unicast-add-path-route',
            data: routeMonitoringMessage(
                privateLabelRibInPeer,
                ipv4Update([ribInLabelUnicastPlainPrefix], {
                    nextHop: '192.0.2.250',
                    asns: [65004, 65104],
                    addPath: true,
                    pathIdStart: 68
                }),
                {
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'private-rib-in-label-peer-labeled-add-path-warning-route',
            data: routeMonitoringMessage(
                privateLabelRibInPeer,
                labeledUnicastUpdate(ribInLabelUnicastLabeledPrefix, {
                    nextHop: '192.0.2.250',
                    label: 301,
                    pathId: 69
                }),
                {
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'peer-up-private-rib-in-label-add-path-error',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...privateLabelRibInErrorPeer,
                    recvAddressFamilies: labelAddPathAndUnicastNoAddPathFamilies,
                    sendAddressFamilies: labelReceiveAddPathAndUnicastNoAddPathFamilies,
                    vrfName: 'vrf-label-error'
                })
            )
        },
        {
            name: 'private-rib-in-label-peer-exact-no-label-error-route',
            data: routeMonitoringMessage(
                privateLabelRibInErrorPeer,
                labeledUnicastNoLabelUpdate(ribInLabelUnicastNoLabelPrefix, {
                    nextHop: '192.0.2.249',
                    pathId: 76
                }),
                {
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'peer-up-evpn',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                peerUpPayload({
                    ...evpnPeer,
                    localAddress: '192.0.2.252',
                    afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN
                })
            )
        },
        {
            name: 'evpn-route-1',
            data: routeMonitoringMessage(evpnPeer, evpnVxlanUpdate(10000, 1))
        },
        {
            name: 'evpn-route-2',
            data: routeMonitoringMessage(evpnPeer, evpnVxlanUpdate(10001, 2))
        },
        {
            name: 'peer-up-loc-rib',
            data: bmpMessage(BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, locRibPeerUpPayload())
        },
        {
            name: 'peer-up-route-lens-lifecycle-loc-rib',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                locRibPeerUpPayload({
                    rd: routeLensRd,
                    vrfName: 'route-lens-lab'
                })
            )
        },
        {
            name: 'route-lens-lifecycle-loc-rib',
            data: routeMonitoringMessage(
                routeLensLocRibPeer,
                ipv4Update([routeLensLifecyclePrefix], {
                    nextHop: '192.0.2.210',
                    asns: [65008, 65108],
                    localPref: 220,
                    communities: ['65000:120', '65000:220']
                }),
                {
                    vrfName: 'route-lens-lab',
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.BEST | BmpConst.BMP_PATH_STATUS.PRIMARY
                    }
                }
            )
        },
        {
            name: 'route-assurance-selected-loc-rib-routes',
            data: routeMonitoringMessage(
                routeLensLocRibPeer,
                ipv4Update(
                    [routeAssuranceNotExportedPrefix, routeAssuranceOutboundGapPrefix, routeAssuranceMultiEgressPrefix],
                    {
                        nextHop: '192.0.2.210',
                        asns: [65008, 65108],
                        localPref: 220,
                        communities: ['65000:120', '65000:220']
                    }
                ),
                {
                    vrfName: 'route-lens-lab',
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.BEST | BmpConst.BMP_PATH_STATUS.PRIMARY
                    }
                }
            )
        },
        {
            name: 'peer-up-loc-rib-evpn-add-path-default-rd',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                locRibPeerUpPayload({
                    vrfName: 'global-evpn',
                    recvAddressFamilies: defaultLocRibEvpnAddPathFamilies,
                    sendAddressFamilies: defaultLocRibEvpnReceiveAddPathFamilies
                })
            )
        },
        {
            name: 'private-loc-rib-evpn-default-rd-add-path-warning-route',
            data: routeMonitoringMessage(privateEvpnLocRibPeer, evpnVxlanUpdate(10002, 3, { pathId: 88 }), {
                vrfName: 'vrf-evpn-blue',
                pathStatus: {
                    status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                }
            })
        },
        {
            name: 'peer-up-private-loc-rib-add-path',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                locRibPeerUpPayload({
                    rd: privateLocRibRd,
                    vrfName: 'vrf-blue',
                    recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
                    sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
                })
            )
        },
        {
            name: 'private-loc-rib-add-path-route',
            data: routeMonitoringMessage(
                privateLocRibPeer,
                ipv4Update([locRibIsolationPrivatePrefix], {
                    nextHop: '0.0.0.0',
                    asns: [65000],
                    addPath: true,
                    pathIdStart: 55
                }),
                {
                    vrfName: 'vrf-blue',
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'peer-up-private-loc-rib-label-add-path-warning',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                locRibPeerUpPayload({
                    rd: privateLabelLocRibRd,
                    vrfName: 'vrf-label',
                    recvAddressFamilies: unicastAddPathOnlyFamilies,
                    sendAddressFamilies: unicastReceiveAddPathOnlyFamilies
                })
            )
        },
        {
            name: 'private-loc-rib-label-peer-unicast-add-path-route',
            data: routeMonitoringMessage(
                privateLabelLocRibPeer,
                ipv4Update([locRibLabelUnicastPlainPrefix], {
                    nextHop: '0.0.0.0',
                    asns: [65000],
                    addPath: true,
                    pathIdStart: 70
                }),
                {
                    vrfName: 'vrf-label',
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'private-loc-rib-label-peer-labeled-add-path-warning-route',
            data: routeMonitoringMessage(
                privateLabelLocRibPeer,
                labeledUnicastUpdate(locRibLabelUnicastLabeledPrefix, {
                    nextHop: '0.0.0.0',
                    label: 302,
                    pathId: 71
                }),
                {
                    vrfName: 'vrf-label',
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'peer-up-private-loc-rib-label-add-path-error',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                locRibPeerUpPayload({
                    rd: privateLabelLocRibErrorRd,
                    vrfName: 'vrf-label-error',
                    recvAddressFamilies: labelAddPathAndUnicastNoAddPathFamilies,
                    sendAddressFamilies: labelReceiveAddPathAndUnicastNoAddPathFamilies
                })
            )
        },
        {
            name: 'private-loc-rib-label-peer-exact-no-label-error-route',
            data: routeMonitoringMessage(
                privateLabelLocRibErrorPeer,
                labeledUnicastNoLabelUpdate(locRibLabelUnicastNoLabelPrefix, {
                    nextHop: '0.0.0.0',
                    pathId: 77
                }),
                {
                    vrfName: 'vrf-label-error',
                    pathStatus: {
                        status: BmpConst.BMP_PATH_STATUS.ADD_PATH | BmpConst.BMP_PATH_STATUS.BEST
                    }
                }
            )
        },
        {
            name: 'public-loc-rib-no-add-path-after-private',
            data: routeMonitoringMessage(
                locRibPeer,
                ipv4Update([locRibIsolationPublicPrefix], {
                    nextHop: '0.0.0.0',
                    asns: [65000]
                }),
                { vrfName: 'global' }
            )
        },
        {
            name: 'public-loc-rib-all-supported-tlvs-route',
            data: routeMonitoringMessage(
                locRibPeer,
                ipv4Update([locRibAllTlvsPrefix], {
                    nextHop: '0.0.0.0',
                    asns: [65000]
                }),
                {
                    routeTlvs: routeMonitoringAllSupportedTlvs({
                        sequenceNumber: 9101,
                        vrfName: 'global',
                        extendedFlags: 0
                    })
                }
            )
        }
    );

    locRibPrefixes.forEach((prefix, index) => {
        messages.push({
            name: `loc-rib-route-${index + 1}`,
            data: routeMonitoringMessage(
                locRibPeer,
                ipv4Update([prefix], {
                    nextHop: '0.0.0.0',
                    asns: [65000]
                }),
                { vrfName: 'global' }
            )
        });
    });

    messages.push({
        name: 'statistics-loc-rib',
        data: statisticsReportMessage(locRibPeer, [
            { type: BmpConst.BMP_STATS_TYPE.NUM_LOC_RIB, value: publicLocRibRouteCount },
            {
                type: BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB,
                afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                value: publicLocRibRouteCount
            }
        ])
    });

    messages.push({
        name: 'statistics-private-loc-rib-add-path',
        data: statisticsReportMessage(privateLocRibPeer, [
            { type: BmpConst.BMP_STATS_TYPE.NUM_LOC_RIB, value: 1 },
            {
                type: BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB,
                afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                value: 1
            }
        ])
    });

    // Finish every Loc-RIB AF populated by the scenario. Peer Up starts a new
    // epoch in syncing state; EOR makes the completed snapshot authoritative.
    messages.push(
        {
            name: 'eor-loc-rib-default-ipv4-unicast',
            data: routeMonitoringMessage(locRibPeer, endOfRibUpdate(), { vrfName: 'global' })
        },
        {
            name: 'eor-loc-rib-route-lens-ipv4-unicast',
            data: routeMonitoringMessage(routeLensLocRibPeer, endOfRibUpdate(), { vrfName: 'route-lens-lab' })
        },
        {
            name: 'eor-loc-rib-private-ipv4-unicast',
            data: routeMonitoringMessage(privateLocRibPeer, endOfRibUpdate(), { vrfName: 'vrf-blue' })
        },
        {
            name: 'eor-loc-rib-private-label-peer-ipv4-unicast',
            data: routeMonitoringMessage(privateLabelLocRibPeer, endOfRibUpdate(), { vrfName: 'vrf-label' })
        },
        {
            name: 'eor-loc-rib-private-label-peer-labeled-unicast',
            data: routeMonitoringMessage(
                privateLabelLocRibPeer,
                endOfRibUpdate(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST),
                { vrfName: 'vrf-label' }
            )
        },
        {
            name: 'eor-loc-rib-private-label-error-ipv4-unicast',
            data: routeMonitoringMessage(privateLabelLocRibErrorPeer, endOfRibUpdate(), {
                vrfName: 'vrf-label-error'
            })
        },
        {
            name: 'eor-loc-rib-private-label-error-labeled-unicast',
            data: routeMonitoringMessage(
                privateLabelLocRibErrorPeer,
                endOfRibUpdate(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST),
                { vrfName: 'vrf-label-error' }
            )
        },
        {
            name: 'eor-loc-rib-default-evpn',
            data: routeMonitoringMessage(
                locRibPeer,
                endOfRibUpdate(BgpConst.BGP_AFI_TYPE.AFI_L2VPN, BgpConst.BGP_SAFI_TYPE.SAFI_EVPN),
                { vrfName: 'global-evpn' }
            )
        },
        {
            name: 'eor-loc-rib-private-evpn',
            data: routeMonitoringMessage(
                privateEvpnLocRibPeer,
                endOfRibUpdate(BgpConst.BGP_AFI_TYPE.AFI_L2VPN, BgpConst.BGP_SAFI_TYPE.SAFI_EVPN),
                { vrfName: 'vrf-evpn-blue' }
            )
        }
    );

    return messages;
}

function delay(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

async function sendScenario(socket, messages, options) {
    for (const message of messages) {
        socket.write(message.data);
        console.log(`sent ${message.name} (${message.data.length} bytes)`);
        if (options.dumpPackets) {
            console.log(formatPacketHex(message.data));
        }
        if (options.interval > 0) {
            await delay(options.interval);
        }
    }
}

async function run() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    const messages = buildScenario(options);
    const socket = net.createConnection({ host: options.host, port: options.port });
    socket.setNoDelay(true);

    socket.on('error', error => {
        console.error(`BMP mock connection error: ${error.message}`);
        process.exitCode = 1;
    });

    socket.on('close', hadError => {
        if (hadError) {
            return;
        }
        console.log('BMP mock connection closed');
    });

    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });

    console.log(`connected to BMP server ${options.host}:${options.port}`);
    await sendScenario(socket, messages, options);

    if (options.once) {
        socket.end();
        return;
    }

    console.log('mock data sent; keeping BMP TCP connection open, press Ctrl+C to stop');
    let stopping = false;
    const stopGracefully = () => {
        if (stopping) {
            return;
        }
        stopping = true;
        if (socket.destroyed) {
            process.exit(0);
            return;
        }
        socket.end();
        setTimeout(() => process.exit(0), 1000).unref();
    };

    socket.once('close', () => {
        process.exit(0);
    });

    if (process.stdin && process.stdin.readable) {
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => {
            if (/\b(disconnect|quit|exit)\b/u.test(chunk)) {
                stopGracefully();
            }
        });
    }

    process.on('SIGINT', stopGracefully);
    process.on('SIGTERM', stopGracefully);
}

if (require.main === module) {
    run().catch(error => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = {
    buildScenario,
    parseArgs
};
