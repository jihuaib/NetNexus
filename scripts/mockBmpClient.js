#!/usr/bin/env node

const net = require('net');
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

function ipv4Nlri(prefix, pathId = null) {
    const nlri = Buffer.concat([Buffer.from([24]), ip(prefix).subarray(0, 3)]);
    if (pathId === null || pathId === undefined) {
        return nlri;
    }
    return Buffer.concat([u32(pathId), nlri]);
}

function ipv4Update(
    prefixes,
    { nextHop = '192.0.2.254', asns = [65000, 65100], addPath = false, pathIdStart = 1000 } = {}
) {
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        asPathAttr(asns),
        pathAttr(BgpConst.BGP_PATH_ATTR.NEXT_HOP, ip(nextHop)),
        pathAttr(BgpConst.BGP_PATH_ATTR.LOCAL_PREF, u32(100), BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE)
    ]);
    const nlris = Buffer.concat(
        prefixes.map((prefix, index) => ipv4Nlri(prefix, addPath ? pathIdStart + index : null))
    );
    const body = Buffer.concat([u16(0), u16(attrs.length), attrs, nlris]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, body);
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
            tlv(BmpConst.BMP_INITIATION_TLV_TYPE.SYS_NAME, Buffer.from('mock-bmp-router')),
            tlv(BmpConst.BMP_INITIATION_TLV_TYPE.SYS_DESC, Buffer.from('NetNexus local BMP mock data'))
        ])
    );
}

function routeMonitoringMessage(peer, bgpMessage, { pathStatus = null, vrfName = null } = {}) {
    const tlvs = [];
    if (vrfName) {
        tlvs.push(indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from(vrfName)));
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
    const unicastAddPathAndLabelFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
        },
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
        }
    ];
    const unicastReceiveAddPathAndLabelFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        },
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
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
    const evpnAddPathFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
        }
    ];
    const evpnReceiveAddPathFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
            addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        }
    ];

    const ipv4Prefixes = makePrefixes(options.routes, 10);
    const addPathPrefixes = makePrefixes(Math.max(5, Math.min(10, options.routes)), 20);
    const locRibPrefixes = makePrefixes(Math.max(8, Math.min(25, options.routes)), 30);
    const ribInIsolationPublicPrefix = '203.0.118.0';
    const ribInIsolationPrivatePrefix = '10.200.0.0';
    const ribInLabelUnicastPlainPrefix = '10.201.1.0';
    const ribInLabelUnicastLabeledPrefix = '10.201.2.0';
    const ribInLabelUnicastNoLabelPrefix = '10.201.0.0';
    const locRibIsolationPublicPrefix = '198.51.101.0';
    const locRibIsolationPrivatePrefix = '10.100.0.0';
    const locRibLabelUnicastPlainPrefix = '10.102.1.0';
    const locRibLabelUnicastLabeledPrefix = '10.102.2.0';
    const locRibLabelUnicastNoLabelPrefix = '10.102.0.0';
    const publicLocRibRouteCount = locRibPrefixes.length + 1;

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
                    recvAddressFamilies: unicastAddPathAndLabelFamilies,
                    sendAddressFamilies: unicastReceiveAddPathAndLabelFamilies,
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
            name: 'peer-up-loc-rib-evpn-add-path-default-rd',
            data: bmpMessage(
                BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                locRibPeerUpPayload({
                    vrfName: 'global-evpn',
                    recvAddressFamilies: evpnAddPathFamilies,
                    sendAddressFamilies: evpnReceiveAddPathFamilies
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
                    recvAddressFamilies: unicastAddPathAndLabelFamilies,
                    sendAddressFamilies: unicastReceiveAddPathAndLabelFamilies
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
