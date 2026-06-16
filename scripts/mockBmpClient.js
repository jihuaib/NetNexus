#!/usr/bin/env node

const net = require('net');
const BmpConst = require('../electron/const/bmpConst');
const BgpConst = require('../electron/const/bgpConst');

const DEFAULT_OPTIONS = {
    host: '127.0.0.1',
    port: 1790,
    routes: 25,
    interval: 30,
    once: false
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
    const capabilities = [
        capability(
            BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
            Buffer.concat([u16(afi), Buffer.from([0, safi])])
        ),
        capability(BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH, Buffer.alloc(0)),
        capability(BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS, u32(65000))
    ];

    if (addPathMode !== null) {
        capabilities.push(addPathCapability(addPathMode, afi, safi));
    }

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

function evpnRaw24(value) {
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function evpnNlri(routeType, body) {
    return Buffer.concat([Buffer.from([routeType, body.length]), body]);
}

function evpnVxlanUpdate(vni = 10000, sequence = 1) {
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
    const mpReachValue = Buffer.concat([
        u16(BgpConst.BGP_AFI_TYPE.AFI_L2VPN),
        Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_EVPN, 4]),
        ip('10.0.0.1'),
        Buffer.from([0]),
        evpnRoute
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
    peerAddress = '192.0.2.2',
    peerAs = 65000,
    routerId = '192.0.2.1',
    timestamp = Math.floor(Date.now() / 1000),
    timestampMs = 0
} = {}) {
    const address = peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB ? Buffer.alloc(4) : ip(peerAddress);
    return Buffer.concat([
        Buffer.from([peerType, flags]),
        Buffer.alloc(BgpConst.BGP_RD_LEN),
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
    peerAddress = '192.0.2.2',
    peerAs = 65000,
    routerId = '192.0.2.1',
    localAddress = '192.0.2.254',
    localPort = 179,
    remotePort = 50000,
    afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    recvAddPathMode = null,
    sendAddPathMode = null
} = {}) {
    return Buffer.concat([
        peerHeader({ flags, peerAddress, peerAs, routerId }),
        Buffer.alloc(12),
        ip(localAddress),
        u16(localPort),
        u16(remotePort),
        bgpOpenForAf({ routerId: peerAddress, afi, safi, addPathMode: recvAddPathMode }),
        bgpOpenForAf({ routerId, afi, safi, addPathMode: sendAddPathMode })
    ]);
}

function locRibPeerUpPayload(flags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED) {
    return Buffer.concat([
        peerHeader({ flags, peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB }),
        Buffer.alloc(16),
        u16(0),
        u16(0),
        bgpOpenForAf(),
        bgpOpenForAf(),
        tlv(BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME, Buffer.from('global'))
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
    const evpnPeer = {
        peerAddress: '192.0.2.4',
        peerAs: 65002,
        routerId: '192.0.2.4'
    };
    const locRibPeer = {
        flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
        peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB
    };

    const ipv4Prefixes = makePrefixes(options.routes, 10);
    const addPathPrefixes = makePrefixes(Math.max(5, Math.min(10, options.routes)), 20);
    const locRibPrefixes = makePrefixes(Math.max(8, Math.min(25, options.routes)), 30);

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
            { type: BmpConst.BMP_STATS_TYPE.NUM_LOC_RIB, value: locRibPrefixes.length },
            {
                type: BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB,
                afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                value: locRibPrefixes.length
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

async function sendScenario(socket, messages, interval) {
    for (const message of messages) {
        socket.write(message.data);
        console.log(`sent ${message.name} (${message.data.length} bytes)`);
        if (interval > 0) {
            await delay(interval);
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
    await sendScenario(socket, messages, options.interval);

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
        if (stopping) {
            process.exit(0);
        }
    });

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
