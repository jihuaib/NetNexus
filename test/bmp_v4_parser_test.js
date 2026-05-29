const assert = require('assert');
const BmpConst = require('../electron/const/bmpConst');
const BgpConst = require('../electron/const/bgpConst');
const BmpSession = require('../electron/worker/bmpSession');
const BmpBgpSession = require('../electron/worker/bmpBgpSession');
const BmpBgpInstance = require('../electron/worker/bmpBgpInstance');

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
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

function bgpOpen(routerId = '192.0.2.1') {
    const mpCapability = Buffer.concat([
        Buffer.from([BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS, 4]),
        u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
        Buffer.from([0, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST])
    ]);
    const optionalParam = Buffer.concat([Buffer.from([BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE, mpCapability.length]), mpCapability]);
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
    return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
}

function bgpUpdate(prefix = '203.0.113.0') {
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.NEXT_HOP, ip('192.0.2.254'))
    ]);
    const nlri = Buffer.concat([Buffer.from([24]), ip(prefix).subarray(0, 3)]);
    const body = Buffer.concat([u16(0), u16(attrs.length), attrs, nlri]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, body);
}

function bmpMessage(version, type, payload) {
    return Buffer.concat([Buffer.from([version]), u32(BmpConst.BMP_HEADER_LENGTH + payload.length), Buffer.from([type]), payload]);
}

function peerHeader(flags = 0, peerType = BmpConst.BMP_PEER_TYPE.GLOBAL) {
    return Buffer.concat([
        Buffer.from([peerType, flags]),
        Buffer.alloc(BgpConst.BGP_RD_LEN),
        Buffer.alloc(12),
        peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB ? Buffer.alloc(4) : ip('192.0.2.2'),
        u32(65000),
        ip('192.0.2.1'),
        u32(0),
        u32(0)
    ]);
}

function peerUpPayload(flags = 0) {
    return Buffer.concat([
        peerHeader(flags),
        Buffer.alloc(12),
        ip('192.0.2.254'),
        u16(179),
        u16(50000),
        bgpOpen('192.0.2.2'),
        bgpOpen('192.0.2.1')
    ]);
}

function locRibPeerUpPayload(flags = 0) {
    return Buffer.concat([
        peerHeader(flags, BmpConst.BMP_PEER_TYPE.LOCAL_RIB),
        Buffer.alloc(16),
        u16(0),
        u16(0),
        bgpOpen('192.0.2.1'),
        bgpOpen('192.0.2.1'),
        tlv(BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME, Buffer.from('global'))
    ]);
}

function indexedTlv(type, index, value) {
    return Buffer.concat([u16(type), u16(value.length), u16(index), value]);
}

function tlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}

function makeSession() {
    const events = [];
    const bmpWorker = { bmpSessionMap: new Map() };
    const session = new BmpSession(
        {
            sendEvent(type, payload) {
                events.push({ type, payload });
            }
        },
        bmpWorker
    );

    session.localIp = '127.0.0.1';
    session.localPort = 1790;
    session.remoteIp = '127.0.0.2';
    session.remotePort = 50000;
    bmpWorker.bmpSessionMap.set(BmpSession.makeKey(session.localIp, session.localPort, session.remoteIp, session.remotePort), session);

    return { session, events };
}

const { session, events } = makeSession();
session.processMessage(bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload()));
session.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate())
        ])
    )
);

const bgpSessionKey = BmpBgpSession.makeKey(BmpConst.BMP_PEER_TYPE.GLOBAL, '0:0', '192.0.2.2', 65000);
const bgpSession = session.bgpSessionMap.get(bgpSessionKey);
assert.ok(bgpSession, 'BMPv4 Peer Up should create a BGP session');

const routeMap = bgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
assert.equal(routeMap.size, 1);
assert.equal([...routeMap.values()][0].ip, '203.0.113.0');
assert.ok(events.some(event => event.type === BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE));

session.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT,
        Buffer.concat([
            peerHeader(),
            tlv(
                BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS,
                Buffer.concat([u32(1), u16(BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN), u16(4), u32(123)])
            )
        ])
    )
);

const statsEvent = events.find(event => event.type === BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT);
assert.ok(statsEvent, 'BMPv4 Stats TLV should emit a statistics report');
assert.equal(statsEvent.payload.data.statistics.length, 1);
assert.equal(statsEvent.payload.data.statistics[0].type, BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN);
assert.equal(statsEvent.payload.data.statistics[0].value, 123);

session.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED)
    )
);

const locRibPeerUpInstanceKey = BmpBgpInstance.makeKey(
    BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
    '0:0',
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
);
const locRibPeerUpInstance = session.bgpInstanceMap.get(locRibPeerUpInstanceKey);
assert.ok(locRibPeerUpInstance, 'BMPv4 Loc-RIB Peer Up should create a Loc-RIB instance');
assert.equal(locRibPeerUpInstance.instanceIp, '0.0.0.0');
assert.equal(locRibPeerUpInstance.localIp, '0.0.0.0');
assert.equal(locRibPeerUpInstance.localPort, 0);
assert.equal(locRibPeerUpInstance.remotePort, 0);

session.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('global')),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('198.51.100.0'))
        ])
    )
);

const locRibInstanceKey = BmpBgpInstance.makeKey(
    BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
    '0:0',
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
);
const locRibInstance = session.bgpInstanceMap.get(locRibInstanceKey);
assert.ok(locRibInstance, 'BMPv4 Loc-RIB Route Monitoring should create a Loc-RIB instance');
assert.equal(locRibInstance.instanceFlags, BmpConst.BMP_LOC_RIB_FLAGS.FILTERED);
assert.deepEqual(locRibInstance.vrfTableNames, ['global']);
assert.equal([...locRibInstance.bgpRoutes.values()][0].ip, '198.51.100.0');

session.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB),
            tlv(
                BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS,
                Buffer.concat([
                    u32(1),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PREFIXES_TREATED_AS_WITHDRAW),
                    u16(11),
                    u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
                    Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST]),
                    Buffer.from('0000000000000007', 'hex')
                ])
            )
        ])
    )
);

const locRibStatsEvent = events
    .filter(event => event.type === BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT)
    .find(event => event.payload.data.instance);
assert.ok(locRibStatsEvent, 'BMPv4 Loc-RIB Stats TLV should emit an instance statistics report');
assert.equal(locRibStatsEvent.payload.data.statistics[0].afi, BgpConst.BGP_AFI_TYPE.AFI_IPV4);
assert.equal(locRibStatsEvent.payload.data.statistics[0].safi, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
assert.equal(locRibStatsEvent.payload.data.statistics[0].value, 7);

console.log('BMPv4 parser tests passed');
