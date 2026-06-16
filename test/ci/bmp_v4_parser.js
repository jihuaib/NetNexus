const assert = require('assert');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');

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

function addPathCapability(mode, afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
    return Buffer.concat([Buffer.from([BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH, 4]), u16(afi), Buffer.from([safi, mode])]);
}

function bgpOpenForAf(
    routerId = '192.0.2.1',
    afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    addPathMode = null
) {
    const mpCapability = Buffer.concat([
        Buffer.from([BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS, 4]),
        u16(afi),
        Buffer.from([0, safi])
    ]);
    const capabilities = [mpCapability];
    if (addPathMode !== null) {
        capabilities.push(addPathCapability(addPathMode));
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

function bgpOpen(routerId = '192.0.2.1', addPathMode = null) {
    return bgpOpenForAf(routerId, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST, addPathMode);
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

function bgpUpdateMulti(prefixes = ['203.0.120.0', '203.0.121.0']) {
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.NEXT_HOP, ip('192.0.2.254'))
    ]);
    const nlris = Buffer.concat(prefixes.map(prefix => Buffer.concat([Buffer.from([24]), ip(prefix).subarray(0, 3)])));
    const body = Buffer.concat([u16(0), u16(attrs.length), attrs, nlris]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, body);
}

function evpnRaw24(value) {
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function evpnNlri(routeType, body) {
    return Buffer.concat([Buffer.from([routeType, body.length]), body]);
}

function bgpUpdateEvpnVxlan(vni = 10000) {
    const rd65000 = Buffer.from([0, 0, 0xfd, 0xe8, 0, 0, 0, 1]);
    const esi = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const evpnRoute = evpnNlri(
        2,
        Buffer.concat([
            rd65000,
            esi,
            u32(100),
            Buffer.from([48, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 32, 192, 0, 2, 10]),
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
    const body = Buffer.concat([u16(0), u16(attrs.length), attrs]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, body);
}

function bgpNotification() {
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.NOTIFICATION, Buffer.from([6, 3]));
}

function bgpUpdateAddPath(prefix = '203.0.113.0', pathId = 7) {
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.NEXT_HOP, ip('192.0.2.254'))
    ]);
    const nlri = Buffer.concat([u32(pathId), Buffer.from([24]), ip(prefix).subarray(0, 3)]);
    const body = Buffer.concat([u16(0), u16(attrs.length), attrs, nlri]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, body);
}

function bgpWithdrawAddPath(prefix = '203.0.113.0', pathId = 7) {
    const withdrawnRoutes = Buffer.concat([u32(pathId), Buffer.from([24]), ip(prefix).subarray(0, 3)]);
    return bgpPacket(
        BgpConst.BGP_PACKET_TYPE.UPDATE,
        Buffer.concat([u16(withdrawnRoutes.length), withdrawnRoutes, u16(0)])
    );
}

function bmpMessage(version, type, payload) {
    return Buffer.concat([
        Buffer.from([version]),
        u32(BmpConst.BMP_HEADER_LENGTH + payload.length),
        Buffer.from([type]),
        payload
    ]);
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

function peerUpPayload(flags = 0, options = {}) {
    return Buffer.concat([
        peerHeader(flags),
        Buffer.alloc(12),
        ip('192.0.2.254'),
        u16(179),
        u16(50000),
        bgpOpen('192.0.2.2', options.recvAddPathMode ?? null),
        bgpOpen('192.0.2.1', options.sendAddPathMode ?? null)
    ]);
}

function peerUpPayloadForAf(afi, safi, flags = 0) {
    return Buffer.concat([
        peerHeader(flags),
        Buffer.alloc(12),
        ip('192.0.2.254'),
        u16(179),
        u16(50000),
        bgpOpenForAf('192.0.2.2', afi, safi),
        bgpOpenForAf('192.0.2.1', afi, safi)
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

function groupValue(indexes) {
    return Buffer.concat(indexes.map(index => u16(index)));
}

function pathMarkingValue(status, reason = null) {
    if (reason === null || reason === undefined) {
        return u32(status);
    }

    return Buffer.concat([u32(status), u16(reason)]);
}

function makeSession(config = {}) {
    const events = [];
    const bmpWorker = {
        bmpSessionMap: new Map(),
        bmpConfigData: {
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
            ...config
        }
    };
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
    bmpWorker.bmpSessionMap.set(
        BmpSession.makeKey(session.localIp, session.localPort, session.remoteIp, session.remotePort),
        session
    );

    return { session, events };
}

function bytesFromDump(dump) {
    return Buffer.from(
        dump.split(/\n/).flatMap(line =>
            line
                .replace(/^\s*[0-9a-f]+\s+/i, '')
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .map(value => parseInt(value, 16))
        )
    );
}

function tcpPayloadFromEthernetFrame(frame) {
    const ipOffset = 14;
    const ipHeaderLength = (frame[ipOffset] & 0x0f) * 4;
    const tcpOffset = ipOffset + ipHeaderLength;
    const tcpHeaderLength = (frame[tcpOffset + 12] >> 4) * 4;
    return frame.subarray(tcpOffset + tcpHeaderLength);
}

function addLocRibRoute(session, afi, safi, prefix, mask) {
    const instanceKey = BmpBgpInstance.makeKey(BmpConst.BMP_PEER_TYPE.LOCAL_RIB, '0:0', afi, safi);
    let instance = session.bgpInstanceMap.get(instanceKey);
    if (!instance) {
        instance = new BmpBgpInstance(session);
        instance.afi = afi;
        instance.safi = safi;
        instance.instanceType = BmpConst.BMP_PEER_TYPE.LOCAL_RIB;
        instance.instanceFlags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED;
        instance.rawInstanceFlags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED;
        instance.instanceRd = '0:0';
        instance.instanceIp = '0.0.0.0';
        instance.instanceAs = 65000;
        instance.instanceRouterId = '192.0.2.1';
        instance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_UP;
        instance.vrfTableNames = ['global'];
        session.bgpInstanceMap.set(instanceKey, instance);
    }

    const route = new BmpBgpRoute(null, instance);
    route.afi = afi;
    route.safi = safi;
    route.ip = prefix;
    route.mask = mask;
    instance.bgpRoutes.set(BmpBgpRoute.makeKey(null, null, prefix, mask), route);
    return { instance, instanceKey };
}

function addBgpSessionRoute(session, afi, safi, prefix, mask, ribType = BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN) {
    const sessionKey = BmpBgpSession.makeKey(BmpConst.BMP_PEER_TYPE.GLOBAL, '0:0', '192.0.2.2', 65000);
    let bgpSession = session.bgpSessionMap.get(sessionKey);
    if (!bgpSession) {
        bgpSession = new BmpBgpSession(session);
        bgpSession.sessionType = BmpConst.BMP_PEER_TYPE.GLOBAL;
        bgpSession.sessionRd = '0:0';
        bgpSession.sessionIp = '192.0.2.2';
        bgpSession.sessionAs = 65000;
        session.bgpSessionMap.set(sessionKey, bgpSession);
    }

    const afKey = `${afi}|${safi}`;
    if (!bgpSession.bgpRoutes.has(afKey)) {
        bgpSession.bgpRoutes.set(afKey, new Map());
    }

    const ribTypeRouteMap = bgpSession.bgpRoutes.get(afKey);
    if (!ribTypeRouteMap.has(ribType)) {
        ribTypeRouteMap.set(ribType, new Map());
    }

    const route = new BmpBgpRoute(bgpSession, null);
    route.afi = afi;
    route.safi = safi;
    route.ip = prefix;
    route.mask = mask;
    const routeKey = BmpBgpRoute.makeKey(null, null, prefix, mask);
    ribTypeRouteMap.get(ribType).set(routeKey, route);

    return { bgpSession, sessionKey, afKey, ribType };
}

const { session, events } = makeSession();
session.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
session.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([peerHeader(), indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate())])
    )
);

const bgpSessionKey = BmpBgpSession.makeKey(BmpConst.BMP_PEER_TYPE.GLOBAL, '0:0', '192.0.2.2', 65000);
const bgpSession = session.bgpSessionMap.get(bgpSessionKey);
assert.ok(bgpSession, 'BMPv4 Peer Up should create a BGP session');

const routeMap = bgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
assert.equal(routeMap.size, 1);
const ipv4UnicastRoute = [...routeMap.values()][0];
assert.equal(ipv4UnicastRoute.ip, '203.0.113.0');
assert.equal(ipv4UnicastRoute.routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);
assert.equal(ipv4UnicastRoute.pathId, 0);
assert.equal(ipv4UnicastRoute.rd, '0:0');
assert.equal(ipv4UnicastRoute.getRouteKey(), '0|0:0|203.0.113.0|24');
assert.equal(routeMap.has(ipv4UnicastRoute.getRouteKey()), true);
assert.equal(ipv4UnicastRoute.getRouteListInfo().rd, '0:0');
assert.equal(ipv4UnicastRoute.getRouteListInfo().pathId, 0);
assert.equal(ipv4UnicastRoute.getRouteInfo().nlriDetail.rd, '0:0');
assert.equal(ipv4UnicastRoute.getRouteInfo().nlriDetail.pathId, 0);
assert.ok(events.some(event => event.type === BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE));

const { session: pathMarkingGroupSession } = makeSession();
pathMarkingGroupSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
pathMarkingGroupSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.GROUP, 0x800b, groupValue([1, 2])),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
                0x800b,
                pathMarkingValue(
                    BmpConst.BMP_PATH_STATUS.BEST | BmpConst.BMP_PATH_STATUS.PRIMARY,
                    BmpConst.BMP_PATH_STATUS_REASON.NOT_PREFERRED_ROUTER_ID
                )
            ),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                bgpUpdateMulti(['203.0.120.0', '203.0.121.0'])
            )
        ])
    )
);
const pathMarkingGroupBgpSession = pathMarkingGroupSession.bgpSessionMap.get(bgpSessionKey);
const pathMarkingGroupRouteMap = pathMarkingGroupBgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
const pathMarkingGroupRoutes = [...pathMarkingGroupRouteMap.values()];
assert.equal(pathMarkingGroupRoutes.length, 2);
pathMarkingGroupRoutes.forEach(route => {
    assert.equal(route.pathStatus, BmpConst.BMP_PATH_STATUS.BEST | BmpConst.BMP_PATH_STATUS.PRIMARY);
    assert.deepEqual(route.pathStatusNames, ['Best', 'Primary']);
    assert.equal(route.pathStatusText, 'Best, Primary');
    assert.equal(route.pathStatusReason, BmpConst.BMP_PATH_STATUS_REASON.NOT_PREFERRED_ROUTER_ID);
    assert.equal(route.pathStatusReasonName, 'Not preferred for router ID');
    assert.equal(route.pathStatusTlvs[0].rawIndex, 0x800b);
    assert.equal(route.pathStatusTlvs[0].group, true);
});
assert.ok(pathMarkingGroupRoutes[0].attrId, 'routes with parsed attributes should have attrId');
assert.equal(pathMarkingGroupRoutes[0].attrId, pathMarkingGroupRoutes[1].attrId);
assert.equal(pathMarkingGroupRoutes[0].getRouteInfo().attrRefCount, 2);

const { session: pathMarkingIndexSession } = makeSession();
pathMarkingIndexSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
pathMarkingIndexSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
                2,
                pathMarkingValue(BmpConst.BMP_PATH_STATUS.BACKUP)
            ),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                bgpUpdateMulti(['203.0.122.0', '203.0.123.0'])
            )
        ])
    )
);
const pathMarkingIndexBgpSession = pathMarkingIndexSession.bgpSessionMap.get(bgpSessionKey);
const pathMarkingIndexRouteMap = pathMarkingIndexBgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
const pathMarkingIndexRoutes = [...pathMarkingIndexRouteMap.values()];
const unmarkedRoute = pathMarkingIndexRoutes.find(route => route.ip === '203.0.122.0');
const markedRoute = pathMarkingIndexRoutes.find(route => route.ip === '203.0.123.0');
assert.equal(unmarkedRoute.pathStatus, null);
assert.equal(markedRoute.pathStatus, BmpConst.BMP_PATH_STATUS.BACKUP);
assert.equal(markedRoute.pathStatusText, 'Backup');

const { session: draft19PathMarkingSession } = makeSession({
    bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
});
draft19PathMarkingSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
draft19PathMarkingSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.PATH_MARKING,
                0,
                pathMarkingValue(BmpConst.BMP_PATH_STATUS.STALE)
            ),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.BGP_MESSAGE, 0, bgpUpdate('203.0.124.0'))
        ])
    )
);
const draft19PathMarkingBgpSession = draft19PathMarkingSession.bgpSessionMap.get(bgpSessionKey);
const draft19PathMarkingRoute = [
    ...draft19PathMarkingBgpSession.bgpRoutes
        .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
        .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN)
        .values()
][0];
assert.equal(draft19PathMarkingRoute.ip, '203.0.124.0');
assert.equal(draft19PathMarkingRoute.pathStatus, BmpConst.BMP_PATH_STATUS.STALE);
assert.equal(draft19PathMarkingRoute.pathStatusText, 'Stale');

const { session: evpnBmpSession } = makeSession();
evpnBmpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAf(BgpConst.BGP_AFI_TYPE.AFI_L2VPN, BgpConst.BGP_SAFI_TYPE.SAFI_EVPN)
    )
);
evpnBmpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateEvpnVxlan())
        ])
    )
);
const evpnBgpSession = evpnBmpSession.bgpSessionMap.get(bgpSessionKey);
const evpnRouteMap = evpnBgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_L2VPN}|${BgpConst.BGP_SAFI_TYPE.SAFI_EVPN}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
const evpnRoute = [...evpnRouteMap.values()][0];
assert.equal(evpnRoute.labels, 'VNI 10000');
assert.equal(evpnRoute.nlriDetail.encapsulationType, 'vni');
assert.equal(evpnRoute.nlriDetail.labels[0].raw24, 10000);
assert.equal(evpnRoute.nlriDetail.labels[0].mplsLabel, 625);
const evpnRouteInfo = evpnRoute.getRouteInfo();
assert.equal(Object.prototype.hasOwnProperty.call(evpnRouteInfo, 'summary'), false);
assert.equal(evpnRouteInfo.afi, BgpConst.BGP_AFI_TYPE.AFI_L2VPN);
assert.equal(evpnRouteInfo.safi, BgpConst.BGP_SAFI_TYPE.SAFI_EVPN);
assert.equal(evpnRouteInfo.nlriDetail.prefix, 'evpn:mac-ip:65000:1:tag=100:mac=aa:bb:cc:dd:ee:ff:ip=192.0.2.10');

const { session: staleRefreshSession } = makeSession();
staleRefreshSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
staleRefreshSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.130.0'))
        ])
    )
);
const staleRefreshBgpSession = staleRefreshSession.bgpSessionMap.get(bgpSessionKey);
const staleRefreshRouteMap = staleRefreshBgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
const staleRefreshRoute = [...staleRefreshRouteMap.values()][0];
assert.equal(staleRefreshRoute.routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);
staleRefreshSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
assert.equal(staleRefreshRoute.routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(staleRefreshRoute.staleReason, 'peer-up-refresh');
staleRefreshSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.130.0'))
        ])
    )
);
assert.equal(staleRefreshRouteMap.size, 1);
assert.equal([...staleRefreshRouteMap.values()][0].routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);

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
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB),
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

const { session: locRibPeerDownSession } = makeSession();
const ipv4LocRib = addLocRibRoute(
    locRibPeerDownSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '192.0.2.0',
    24
);
const ipv6LocRib = addLocRibRoute(
    locRibPeerDownSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '2001:db8::',
    64
);
locRibPeerDownSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB),
            Buffer.from([BmpConst.BMP_PEER_DOWN_REASON.PEER_DE_CONFIGURED]),
            tlv(BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME, Buffer.from('global'))
        ])
    )
);
assert.equal(locRibPeerDownSession.bgpInstanceMap.get(ipv4LocRib.instanceKey).bgpRoutes.size, 1);
assert.equal(locRibPeerDownSession.bgpInstanceMap.get(ipv6LocRib.instanceKey).bgpRoutes.size, 1);
assert.equal(
    [...locRibPeerDownSession.bgpInstanceMap.get(ipv4LocRib.instanceKey).bgpRoutes.values()][0].routeState,
    BmpConst.BMP_ROUTE_STATE.STALE
);
assert.equal(
    [...locRibPeerDownSession.bgpInstanceMap.get(ipv6LocRib.instanceKey).bgpRoutes.values()][0].routeState,
    BmpConst.BMP_ROUTE_STATE.STALE
);
locRibPeerDownSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED)
    )
);
assert.equal(locRibPeerDownSession.bgpInstanceMap.get(ipv4LocRib.instanceKey).bgpRoutes.size, 1);
assert.equal(locRibPeerDownSession.bgpInstanceMap.get(ipv6LocRib.instanceKey).bgpRoutes.size, 1);

const { session: peerUpRefreshSession } = makeSession();
const ipv4BgpRoute = addBgpSessionRoute(
    peerUpRefreshSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '203.0.113.0',
    24
);
const ipv6BgpRoute = addBgpSessionRoute(
    peerUpRefreshSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '2001:db8::',
    64
);
peerUpRefreshSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
const refreshedBgpSession = peerUpRefreshSession.bgpSessionMap.get(ipv4BgpRoute.sessionKey);
assert.equal(refreshedBgpSession.bgpRoutes.get(ipv4BgpRoute.afKey).get(ipv4BgpRoute.ribType).size, 1);
assert.equal(refreshedBgpSession.bgpRoutes.get(ipv6BgpRoute.afKey).get(ipv6BgpRoute.ribType).size, 1);
assert.equal(
    [...refreshedBgpSession.bgpRoutes.get(ipv4BgpRoute.afKey).get(ipv4BgpRoute.ribType).values()][0].routeState,
    BmpConst.BMP_ROUTE_STATE.STALE
);
assert.equal(
    [...refreshedBgpSession.bgpRoutes.get(ipv6BgpRoute.afKey).get(ipv6BgpRoute.ribType).values()][0].routeState,
    BmpConst.BMP_ROUTE_STATE.ACTIVE
);
peerUpRefreshSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.114.0'))
        ])
    )
);
assert.equal(refreshedBgpSession.bgpRoutes.get(ipv4BgpRoute.afKey).get(ipv4BgpRoute.ribType).size, 2);
assert.ok(
    [...refreshedBgpSession.bgpRoutes.get(ipv4BgpRoute.afKey).get(ipv4BgpRoute.ribType).values()].some(
        route => route.ip === '203.0.114.0' && route.routeState === BmpConst.BMP_ROUTE_STATE.ACTIVE
    )
);

const { session: peerDownMultiAfSession } = makeSession();
const peerDownIpv4Route = addBgpSessionRoute(
    peerDownMultiAfSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '203.0.120.0',
    24
);
const peerDownIpv6Route = addBgpSessionRoute(
    peerDownMultiAfSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '2001:db8:120::',
    64
);
peerDownIpv4Route.bgpSession.enabledAddressFamilies = [
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST },
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST }
];
peerDownMultiAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION,
        Buffer.concat([peerHeader(), Buffer.from([BmpConst.BMP_PEER_DOWN_REASON.PEER_DE_CONFIGURED])])
    )
);
assert.equal(
    peerDownIpv4Route.bgpSession.bgpRoutes.get(peerDownIpv4Route.afKey).get(peerDownIpv4Route.ribType).size,
    1
);
assert.equal(
    peerDownIpv6Route.bgpSession.bgpRoutes.get(peerDownIpv6Route.afKey).get(peerDownIpv6Route.ribType).size,
    1
);
assert.equal(
    [...peerDownIpv4Route.bgpSession.bgpRoutes.get(peerDownIpv4Route.afKey).get(peerDownIpv4Route.ribType).values()][0]
        .routeState,
    BmpConst.BMP_ROUTE_STATE.STALE
);
assert.equal(
    [...peerDownIpv6Route.bgpSession.bgpRoutes.get(peerDownIpv6Route.afKey).get(peerDownIpv6Route.ribType).values()][0]
        .routeState,
    BmpConst.BMP_ROUTE_STATE.STALE
);
peerDownMultiAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAf(BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
    )
);
assert.equal(
    peerDownIpv4Route.bgpSession.bgpRoutes.get(peerDownIpv4Route.afKey).get(peerDownIpv4Route.ribType).size,
    1
);
assert.equal(
    peerDownIpv6Route.bgpSession.bgpRoutes.get(peerDownIpv6Route.afKey).get(peerDownIpv6Route.ribType).size,
    1
);

const { session: peerDownNotificationMultiAfSession } = makeSession();
const peerDownNotificationIpv4Route = addBgpSessionRoute(
    peerDownNotificationMultiAfSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '203.0.121.0',
    24
);
const peerDownNotificationIpv6Route = addBgpSessionRoute(
    peerDownNotificationMultiAfSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '2001:db8:121::',
    64
);
peerDownNotificationIpv4Route.bgpSession.enabledAddressFamilies = [
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST }
];
peerDownNotificationMultiAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION,
        Buffer.concat([
            peerHeader(),
            Buffer.from([BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION]),
            bgpNotification()
        ])
    )
);
assert.equal(peerDownNotificationMultiAfSession.bgpSessionMap.has(peerDownNotificationIpv4Route.sessionKey), false);

const { session: addPathSession } = makeSession();
addPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayload(0, {
            recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
            sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        })
    )
);
addPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateAddPath('203.0.113.0', 77))
        ])
    )
);
const addPathBgpSession = addPathSession.bgpSessionMap.get(bgpSessionKey);
const addPathRouteMap = addPathBgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
assert.equal(addPathRouteMap.size, 1);
assert.equal([...addPathRouteMap.values()][0].pathId, 77);
assert.equal(
    addPathBgpSession.addPathReceiveMap.get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`),
    true
);
assert.equal(
    addPathBgpSession.addPathSendMap.get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`),
    false
);
addPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpWithdrawAddPath('203.0.113.0', 77))
        ])
    )
);
assert.equal(addPathRouteMap.size, 0);
addPathSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
addPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.114.0'))
        ])
    )
);
const addPathDisabledRouteMap = addPathBgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
assert.equal([...addPathDisabledRouteMap.values()][0].pathId, 0);
assert.equal(
    addPathBgpSession.addPathMap.has(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`),
    false
);

const { session: statelessAddPathSession } = makeSession();
statelessAddPathSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
statelessAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.STATELESS_PARSING,
                0,
                addPathCapability(BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE)
            ),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateAddPath('203.0.115.0', 88))
        ])
    )
);
statelessAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.116.0'))
        ])
    )
);
const statelessBgpSession = statelessAddPathSession.bgpSessionMap.get(bgpSessionKey);
const statelessRouteMap = statelessBgpSession.bgpRoutes
    .get(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`)
    .get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
const statelessRoutes = [...statelessRouteMap.values()];
assert.ok(statelessRoutes.some(route => route.ip === '203.0.115.0' && route.pathId === 88));
assert.ok(statelessRoutes.some(route => route.ip === '203.0.116.0' && route.pathId === 0));
assert.equal(
    statelessBgpSession.addPathMap.has(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`),
    false
);

const { session: statsTypeSession, events: statsTypeEvents } = makeSession();
statsTypeSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT,
        Buffer.concat([
            peerHeader(),
            tlv(
                BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS,
                Buffer.concat([
                    u32(2),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT),
                    u16(4),
                    u32(15),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_OUT),
                    u16(11),
                    u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
                    Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST]),
                    Buffer.from('0000000000000017', 'hex')
                ])
            )
        ])
    )
);
const statsTypeEvent = statsTypeEvents.find(event => event.type === BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT);
assert.equal(statsTypeEvent.payload.data.statistics[0].typeName, 'Post-Policy Adj-RIB-Out 中的路由数');
assert.equal(statsTypeEvent.payload.data.statistics[1].typeName, '每 AFI/SAFI Post-Policy Adj-RIB-Out 中的路由数');
assert.equal(statsTypeEvent.payload.data.statistics[1].afi, BgpConst.BGP_AFI_TYPE.AFI_IPV4);
assert.equal(statsTypeEvent.payload.data.statistics[1].safi, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);

const huaweiDraft19Frame = bytesFromDump(`
0000   00 50 56 c0 00 03 fa a9 61 f7 00 10 08 00 45 00
0010   01 98 00 04 00 00 ff 06 70 fc c0 a8 64 0b c0 a8
0020   64 03 c7 43 06 fe d4 92 51 8b c2 62 00 e7 50 18
0030   f0 00 c7 2f 00 00 04 00 00 00 a4 03 03 80 00 00
0040   00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0050   00 00 00 00 00 00 00 00 00 64 c0 a8 64 0b 6a 19
0060   f7 fe 00 06 74 58 00 00 00 00 00 00 00 00 00 00
0070   00 00 00 00 00 00 00 00 00 00 ff ff ff ff ff ff
0080   ff ff ff ff ff ff ff ff ff ff 00 2b 01 04 00 64
0090   00 b4 c0 a8 64 0b 0e 02 0c 41 04 00 00 00 64 01
00a0   04 00 01 00 01 ff ff ff ff ff ff ff ff ff ff ff
00b0   ff ff ff ff ff 00 2b 01 04 00 64 00 b4 c0 a8 64
00c0   0b 0e 02 0c 41 04 00 00 00 64 01 04 00 01 00 01
00d0   00 03 00 06 67 6c 6f 62 61 6c 04 00 00 00 73 00
00e0   03 80 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00f0   00 00 00 00 00 00 00 00 00 00 00 00 00 64 c0 a8
0100   64 0b 6a 19 f7 5d 00 06 7a 74 00 03 00 06 00 00
0110   67 6c 6f 62 61 6c 00 04 00 31 00 00 ff ff ff ff
0120   ff ff ff ff ff ff ff ff ff ff ff ff 00 31 02 00
0130   00 00 15 40 01 01 02 40 02 00 40 03 04 00 00 00
0140   00 80 04 04 00 00 00 00 20 02 01 01 01 04 00 00
0150   00 59 00 03 80 00 00 00 00 00 00 00 00 00 00 00
0160   00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0170   64 c0 a8 64 0b 6a 19 f7 fe 00 06 7a bf 00 03 00
0180   06 00 00 67 6c 6f 62 61 6c 00 04 00 17 00 00 ff
0190   ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff 00
01a0   17 02 00 00 00 00
`);

const huaweiDraft20Session = makeSession();
huaweiDraft20Session.session.recvMsg(tcpPayloadFromEthernetFrame(huaweiDraft19Frame));
const huaweiDraft20Instance = huaweiDraft20Session.session.bgpInstanceMap.get(locRibPeerUpInstanceKey);
assert.equal(
    huaweiDraft20Instance ? huaweiDraft20Instance.bgpRoutes.size : 0,
    0,
    'draft-20 mode should not auto-detect Huawei draft-19 Route Monitoring TLVs'
);

const { session: huaweiSession, events: huaweiEvents } = makeSession({
    bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
});
huaweiSession.recvMsg(tcpPayloadFromEthernetFrame(huaweiDraft19Frame));
const huaweiLocRibInstance = huaweiSession.bgpInstanceMap.get(locRibPeerUpInstanceKey);
assert.ok(huaweiLocRibInstance, 'Huawei BMPv4 draft-19 Loc-RIB messages should create a Loc-RIB instance');
assert.deepEqual(huaweiLocRibInstance.vrfTableNames, ['global']);
const huaweiRoutes = [...huaweiLocRibInstance.bgpRoutes.values()];
assert.equal(huaweiRoutes.length, 1);
assert.equal(huaweiRoutes[0].ip, '2.1.1.1');
assert.ok(huaweiEvents.some(event => event.type === BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE));

const { session: draft19StatsSession, events: draft19StatsEvents } = makeSession({
    bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
});
draft19StatsSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT,
        Buffer.concat([peerHeader(), u32(1), u16(BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN), u16(4), u32(456)])
    )
);
const draft19StatsEvent = draft19StatsEvents.find(event => event.type === BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT);
assert.ok(draft19StatsEvent, 'draft-19 mode should parse BMPv4 raw statistics records');
assert.equal(draft19StatsEvent.payload.data.statistics[0].value, 456);

console.log('BMPv4 parser tests passed');
