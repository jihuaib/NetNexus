const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ipaddr = require('ipaddr.js');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const { buildScope, buildRouteUpsertMutation } = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { decodeExtendedPeerFlagsValue } = require('../../electron/utils/bmpUtils');

const persistenceTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-v4-parser-'));
const persistenceStores = new Set();
let persistenceBatchSequence = 0;

process.on('exit', () => {
    persistenceStores.forEach(store => store.close());
    fs.rmSync(persistenceTempDir, { recursive: true, force: true });
});

const LABEL_UNICAST_ADD_PATH_INFERRED_WARNING =
    'label-unicast ADD-PATH is inferred from same-AFI unicast capability; Peer Up did not advertise ADD-PATH for label-unicast';
const LOC_RIB_DEFAULT_RD_ADD_PATH_INFERRED_WARNING =
    'Loc-RIB ADD-PATH is inferred from RD 0:0 for the same AFI/SAFI; Peer Up did not advertise ADD-PATH for this RD';

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
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

function addPathCapability(mode, afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
    return Buffer.concat([Buffer.from([BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH, 4]), u16(afi), Buffer.from([safi, mode])]);
}

function bgpOpenForAf(
    routerId = '192.0.2.1',
    afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    addPathMode = null
) {
    return bgpOpenForAddressFamilies(routerId, [{ afi, safi, addPathMode }]);
}

function bgpOpenForAddressFamilies(
    routerId = '192.0.2.1',
    addressFamilies = [
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            addPathMode: null
        }
    ]
) {
    const capabilities = [];
    addressFamilies.forEach(({ afi, safi, addPathMode = null }) => {
        capabilities.push(
            Buffer.concat([
                Buffer.from([BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS, 4]),
                u16(afi),
                Buffer.from([0, safi])
            ])
        );
        if (addPathMode !== null) {
            capabilities.push(addPathCapability(addPathMode, afi, safi));
        }
    });

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

function bgpUpdateWithOriginValidationState(prefix = '203.0.250.0') {
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.NEXT_HOP, ip('192.0.2.254')),
        pathAttr(
            BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
            Buffer.from('4300000000000001', 'hex'),
            BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
        )
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

function bgpUpdateEvpnVxlan(vni = 10000, { pathId = null } = {}) {
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

function peerHeader(flags = 0, peerType = BmpConst.BMP_PEER_TYPE.GLOBAL, options = {}) {
    return Buffer.concat([
        Buffer.from([peerType, flags]),
        options.rd || Buffer.alloc(BgpConst.BGP_RD_LEN),
        Buffer.alloc(12),
        peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB ? Buffer.alloc(4) : ip(options.peerAddress || '192.0.2.2'),
        u32(options.peerAs || 65000),
        ip(options.routerId || '192.0.2.1'),
        u32(0),
        u32(0)
    ]);
}

function peerUpPayload(flags = 0, options = {}) {
    const tlvs = [];
    if (options.vrfName) {
        tlvs.push(tlv(BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME, Buffer.from(options.vrfName)));
    }

    return Buffer.concat([
        peerHeader(flags, options.peerType || BmpConst.BMP_PEER_TYPE.GLOBAL, options),
        Buffer.alloc(12),
        ip('192.0.2.254'),
        u16(179),
        u16(50000),
        bgpOpen('192.0.2.2', options.recvAddPathMode ?? null),
        bgpOpen('192.0.2.1', options.sendAddPathMode ?? null),
        ...tlvs
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

function peerUpPayloadForAddressFamilies(flags = 0, options = {}) {
    return Buffer.concat([
        peerHeader(flags, options.peerType || BmpConst.BMP_PEER_TYPE.GLOBAL, options),
        Buffer.alloc(12),
        ip(options.localAddress || '192.0.2.254'),
        u16(options.localPort || 179),
        u16(options.remotePort || 50000),
        bgpOpenForAddressFamilies(options.peerAddress || '192.0.2.2', options.recvAddressFamilies),
        bgpOpenForAddressFamilies(options.routerId || '192.0.2.1', options.sendAddressFamilies)
    ]);
}

function locRibPeerUpPayload(flags = 0, options = {}) {
    return Buffer.concat([
        peerHeader(flags, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, options),
        Buffer.alloc(16),
        u16(0),
        u16(0),
        Array.isArray(options.recvAddressFamilies)
            ? bgpOpenForAddressFamilies('192.0.2.1', options.recvAddressFamilies)
            : bgpOpen('192.0.2.1', options.recvAddPathMode ?? null),
        Array.isArray(options.sendAddressFamilies)
            ? bgpOpenForAddressFamilies('192.0.2.1', options.sendAddressFamilies)
            : bgpOpen('192.0.2.1', options.sendAddPathMode ?? null),
        tlv(BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME, Buffer.from(options.vrfTableName || 'global'))
    ]);
}

function indexedTlv(type, index, value) {
    return Buffer.concat([u16(type), u16(value.length), u16(index), value]);
}

function enterpriseIndexedTlv(type, index, enterpriseNumber, value) {
    const rawValue = Buffer.concat([u32(enterpriseNumber), value]);
    return Buffer.concat([u16(type | 0x8000), u16(rawValue.length), u16(index), rawValue]);
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
    const store = new BmpPersistenceStore({
        dbPath: path.join(persistenceTempDir, `session-${persistenceStores.size + 1}.sqlite3`)
    }).open();
    persistenceStores.add(store);
    const bmpWorker = {
        bmpSessionMap: new Map(),
        bmpConfigData: {
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
            ...config
        },
        persistence: store,
        enqueuePersistenceMutation(mutation) {
            persistenceBatchSequence += 1;
            store.applyBatch({
                batchId: `bmp-v4-parser-${persistenceBatchSequence}`,
                createdAtMs: Date.now(),
                mutations: [mutation]
            });
            return true;
        },
        requestNotificationPeerRoutePurge(query) {
            let purged = 0;
            for (const scope of query.scopes || []) {
                let hasMore = true;
                while (hasMore) {
                    const result = store.purgeStaleRoutes({
                        sourceId: query.sourceId,
                        ownerKey: query.ownerKey,
                        scopeKind: query.scopeKind,
                        ...scope,
                        ribType: String(scope.ribType),
                        routeLimit: 20000,
                        reason: query.reason
                    });
                    purged += Number(result.purged || 0);
                    hasMore = result.hasMore === true && Number(result.purged || 0) > 0;
                }
            }
            return { purged };
        },
        requestPersistenceSweep() {},
        enqueueRouteUpdateEvent(update) {
            events.push({ type: BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, payload: { data: update } });
        },
        enqueueInstanceRouteUpdateEvent(update) {
            events.push({ type: BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE, payload: { data: update } });
        },
        invalidateRouteAssurance() {}
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

    session.__persistenceStore = store;
    return { session, events, store };
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

assert.equal(BmpBgpRoute.makeParseStatus(), BmpConst.BMP_ROUTE_PARSE_STATUS.OK);
assert.equal(BmpBgpRoute.makeParseStatus(true, [], ['warning']), BmpConst.BMP_ROUTE_PARSE_STATUS.WARNING);
assert.equal(BmpBgpRoute.makeParseStatus(true, [], true), BmpConst.BMP_ROUTE_PARSE_STATUS.WARNING);
assert.equal(BmpBgpRoute.makeParseStatus(false, ['invalid']), BmpConst.BMP_ROUTE_PARSE_STATUS.ERROR);
assert.equal(
    BmpBgpRoute.makeParseStatus(false, ['invalid'], ['warning']),
    BmpConst.BMP_ROUTE_PARSE_STATUS.ERROR | BmpConst.BMP_ROUTE_PARSE_STATUS.WARNING
);
assert.equal(decodeExtendedPeerFlagsValue(Buffer.from([BmpConst.BMP_SESSION_FLAGS.POST_POLICY, 0])), 0x40);
assert.equal(decodeExtendedPeerFlagsValue(Buffer.from([0, BmpConst.BMP_SESSION_FLAGS.POST_POLICY])), 0x40);
assert.equal(decodeExtendedPeerFlagsValue(Buffer.from([0, 0, BmpConst.BMP_SESSION_FLAGS.POST_POLICY])), 0x40);
assert.equal(decodeExtendedPeerFlagsValue(Buffer.from([0, 0, 0, BmpConst.BMP_SESSION_FLAGS.POST_POLICY])), 0x40);
assert.equal(decodeExtendedPeerFlagsValue(Buffer.from([0, 0, 0, 0, BmpConst.BMP_SESSION_FLAGS.POST_POLICY])), 0);

function hasRouteParseStatus(parseStatus, flag) {
    return (parseStatus & flag) !== 0;
}

function hasStatelessAddPathCompatibilityWarning(route) {
    return (
        Array.isArray(route?.nlriDetail?.warnings) &&
        route.nlriDetail.warnings.some(warning => warning.includes('BMP Stateless Parsing TLV advertised ADD-PATH'))
    );
}

function hydratePersistedRoute(route) {
    return Object.assign(route, {
        getRouteKey: () => route.routeKey,
        getRouteInfo: () => route,
        getRouteListInfo: () => route
    });
}

function queryScopeRoutes(session, owner, afi, safi, ribType, kind = 'peer', routeState = 'all') {
    const scope = buildScope(session, owner, afi, safi, ribType, { kind });
    return session.__persistenceStore
        .queryRoutes({ scopeId: scope.id, routeState, pageSize: 5000 })
        .list.map(hydratePersistedRoute);
}

function queryBgpRoutes(session, owner, afi, safi, ribType, routeState = 'all') {
    return queryScopeRoutes(session, owner, afi, safi, ribType, 'peer', routeState);
}

function queryLocRibRoutes(session, instance, routeState = 'all') {
    return queryScopeRoutes(session, instance, instance.afi, instance.safi, 'loc-rib', 'loc-rib', routeState);
}

function persistSeedRoute(session, owner, route, afi, safi, ribType, kind) {
    const mutation = buildRouteUpsertMutation(session, owner, route, afi, safi, ribType, {
        kind,
        state: 'ready',
        scopeState: 'ready'
    });
    session.bmpWorker.enqueuePersistenceMutation(mutation);
}

function addLocRibRoute(session, afi, safi, prefix, mask) {
    const rdRaw = 'raw:0000000000000000';
    const instanceKey = BmpBgpInstance.makeKey(BmpConst.BMP_PEER_TYPE.LOCAL_RIB, '0:0', afi, safi, rdRaw);
    let instance = session.bgpInstanceMap.get(instanceKey);
    if (!instance) {
        instance = new BmpBgpInstance(session);
        instance.afi = afi;
        instance.safi = safi;
        instance.instanceType = BmpConst.BMP_PEER_TYPE.LOCAL_RIB;
        instance.instanceFlags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED;
        instance.rawInstanceFlags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED;
        instance.instanceRd = '0:0';
        instance.instanceRdRaw = rdRaw;
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
    route.ribType = 'loc-rib';
    route.ip = prefix;
    route.mask = mask;
    route.rd = instance.instanceRd;
    route.pathId = 0;
    route.nlriDetail = { prefix, length: mask, rd: route.rd, pathId: 0 };
    route.markActive(instance.getRibEpoch());
    persistSeedRoute(session, instance, route, afi, safi, 'loc-rib', 'loc-rib');
    return { instance, instanceKey };
}

function addBgpSessionRoute(session, afi, safi, prefix, mask, ribType = BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN) {
    const rdRaw = 'raw:0000000000000000';
    const sessionKey = BmpBgpSession.makeKey(BmpConst.BMP_PEER_TYPE.GLOBAL, '0:0', '192.0.2.2', 65000, rdRaw);
    let bgpSession = session.bgpSessionMap.get(sessionKey);
    if (!bgpSession) {
        bgpSession = new BmpBgpSession(session);
        bgpSession.sessionType = BmpConst.BMP_PEER_TYPE.GLOBAL;
        bgpSession.sessionRd = '0:0';
        bgpSession.sessionRdRaw = rdRaw;
        bgpSession.sessionIp = '192.0.2.2';
        bgpSession.sessionAs = 65000;
        session.bgpSessionMap.set(sessionKey, bgpSession);
    }

    const route = new BmpBgpRoute(bgpSession, null);
    route.afi = afi;
    route.safi = safi;
    route.ribType = ribType;
    route.ip = prefix;
    route.mask = mask;
    route.rd = bgpSession.sessionRd;
    route.pathId = 0;
    route.nlriDetail = { prefix, length: mask, rd: route.rd, pathId: 0 };
    route.markActive(bgpSession.getRibEpoch(afi, safi, ribType));
    bgpSession.ensureRouteScope(afi, safi, ribType);
    persistSeedRoute(session, bgpSession, route, afi, safi, ribType, 'peer');

    return { bgpSession, sessionKey, afKey: `${afi}|${safi}`, ribType };
}

const { session, events } = makeSession();
[
    { flags: 0, ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN },
    { flags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY, ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN },
    { flags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT, ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT },
    {
        flags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY | BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
    }
].forEach(({ flags, ribType }) => {
    assert.deepEqual(session.getRibTypesByFlags(flags), [ribType]);
    assert.deepEqual(
        session.getRibTypesByFlags(flags | BmpConst.BMP_SESSION_FLAGS.AS_PATH),
        [ribType],
        'the AS_PATH encoding flag must not change the RIB stage selected by the policy and direction flags'
    );
});
session.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
const rejectedRouteMutations = [];
const enqueuePersistenceMutation = session.bmpWorker.enqueuePersistenceMutation;
session.bmpWorker.enqueuePersistenceMutation = mutation => rejectedRouteMutations.push(mutation);
const incompleteUpdate = Buffer.concat([
    Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
    u16(BgpConst.BGP_HEAD_LEN + 4),
    Buffer.from([BgpConst.BGP_PACKET_TYPE.UPDATE])
]);
[incompleteUpdate, bgpPacket(BgpConst.BGP_PACKET_TYPE.KEEPALIVE, Buffer.alloc(0))].forEach(packet => {
    session.processMessage(
        bmpMessage(
            BmpConst.BMP_VERSION.V4,
            BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
            Buffer.concat([peerHeader(), indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, packet)])
        )
    );
});
assert.equal(
    rejectedRouteMutations.length,
    0,
    'invalid or non-UPDATE BGP messages must not advance EOR or mutate route persistence'
);
session.bmpWorker.enqueuePersistenceMutation = enqueuePersistenceMutation;
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

const ipv4UnicastRoutes = queryBgpRoutes(
    session,
    bgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(ipv4UnicastRoutes.length, 1);
const ipv4UnicastRoute = ipv4UnicastRoutes[0];
assert.equal(ipv4UnicastRoute.ip, '203.0.113.0');
assert.equal(ipv4UnicastRoute.routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);
assert.equal(ipv4UnicastRoute.pathId, 0);
assert.equal(ipv4UnicastRoute.rd, '0:0');
assert.equal(ipv4UnicastRoute.getRouteKey(), '0|0:0|203.0.113.0|24');
assert.equal(
    ipv4UnicastRoutes.some(route => route.routeKey === ipv4UnicastRoute.getRouteKey()),
    true
);
assert.equal(ipv4UnicastRoute.getRouteListInfo().rd, '0:0');
assert.equal(ipv4UnicastRoute.getRouteListInfo().pathId, 0);
assert.equal(ipv4UnicastRoute.getRouteInfo().nlriDetail.rd, '0:0');
assert.equal(ipv4UnicastRoute.getRouteInfo().nlriDetail.pathId, 0);
assert.ok(events.some(event => event.type === BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE));

const eventCountBeforeSessionEor = events.length;
session.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(0)]))
            )
        ])
    )
);
const sessionEorEvents = events
    .slice(eventCountBeforeSessionEor)
    .filter(event => event.type === BmpConst.BMP_EVT_TYPES.SESSION_UPDATE);
assert.equal(sessionEorEvents.length, 1, 'one Session EOR message must emit one topology update');
assert.ok(
    sessionEorEvents[0].payload?.data?.session?.routeScopes?.some(scope => scope.scopeState === 'ready'),
    'a Session EOR must emit a ready SESSION_UPDATE topology event'
);

const { session: bmp3RibInPolicySession } = makeSession();
bmp3RibInPolicySession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V3, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
bmp3RibInPolicySession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V3,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([peerHeader(), bgpUpdate('203.0.115.0')])
    )
);
bmp3RibInPolicySession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V3,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([peerHeader(BmpConst.BMP_SESSION_FLAGS.POST_POLICY), bgpUpdate('203.0.116.0')])
    )
);
const bmp3RibInPolicyBgpSession = bmp3RibInPolicySession.bgpSessionMap.get(bgpSessionKey);
const bmp3PrePolicyRoutes = queryBgpRoutes(
    bmp3RibInPolicySession,
    bmp3RibInPolicyBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const bmp3PostPolicyRoutes = queryBgpRoutes(
    bmp3RibInPolicySession,
    bmp3RibInPolicyBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
);
assert.ok(
    bmp3PrePolicyRoutes.some(route => route.ip === '203.0.115.0'),
    'BMPv3 Route Monitoring without post-policy flag should store pre-policy Adj-RIB-In routes'
);
assert.ok(
    !bmp3PrePolicyRoutes.some(route => route.ip === '203.0.116.0'),
    'BMPv3 Route Monitoring with post-policy flag should not be copied into pre-policy Adj-RIB-In'
);
assert.ok(
    bmp3PostPolicyRoutes.some(route => route.ip === '203.0.116.0'),
    'BMPv3 Route Monitoring with post-policy flag should store post-policy Adj-RIB-In routes'
);

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
const pathMarkingGroupRoutes = queryBgpRoutes(
    pathMarkingGroupSession,
    pathMarkingGroupBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(pathMarkingGroupRoutes.length, 2);
pathMarkingGroupRoutes.forEach(route => {
    assert.equal(route.pathStatus, BmpConst.BMP_PATH_STATUS.BEST | BmpConst.BMP_PATH_STATUS.PRIMARY);
    assert.deepEqual(route.pathStatusNames, ['Best', 'Primary']);
    assert.equal(route.pathStatusText, 'Best, Primary');
    assert.equal(route.pathStatusReason, BmpConst.BMP_PATH_STATUS_REASON.NOT_PREFERRED_ROUTER_ID);
    assert.equal(route.pathStatusReasonName, 'Not preferred for router ID');
    const routePathMarkingTlv = route
        .getRouteInfo()
        .routeTlvs.find(tlv => tlv.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING);
    assert.equal(routePathMarkingTlv.rawIndex, 0x800b);
    assert.equal(routePathMarkingTlv.group, true);
});
assert.ok(pathMarkingGroupRoutes[0].attrId, 'routes with parsed attributes should have attrId');
assert.equal(pathMarkingGroupRoutes[0].attrId, pathMarkingGroupRoutes[1].attrId);
assert.equal(
    Object.prototype.hasOwnProperty.call(pathMarkingGroupRoutes[0].getRouteInfo(), 'attrRefCount'),
    false,
    'SQLite attribute deduplication must not recreate the in-memory attribute reference counter'
);

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
const pathMarkingIndexRoutes = queryBgpRoutes(
    pathMarkingIndexSession,
    pathMarkingIndexBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const unmarkedRoute = pathMarkingIndexRoutes.find(route => route.ip === '203.0.122.0');
const markedRoute = pathMarkingIndexRoutes.find(route => route.ip === '203.0.123.0');
assert.equal(unmarkedRoute.pathStatus, null);
assert.equal(markedRoute.pathStatus, BmpConst.BMP_PATH_STATUS.BACKUP);
assert.equal(markedRoute.pathStatusText, 'Backup');
assert.equal(markedRoute.getRouteListInfo().routeTlvCount, 1);
assert.equal(markedRoute.getRouteInfo().routeTlvs[0].type, BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING);
assert.equal(markedRoute.getRouteInfo().routeTlvs[0].appliedNlriIndex, 2);
assert.equal(unmarkedRoute.getRouteInfo().routeTlvCount, 0);

const { session: enterpriseRouteTlvSession } = makeSession();
enterpriseRouteTlvSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
enterpriseRouteTlvSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            enterpriseIndexedTlv(1234, 2, 64512, Buffer.from('enterprise-route-tlv')),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                bgpUpdateMulti(['203.0.128.0', '203.0.129.0'])
            )
        ])
    )
);
const enterpriseRouteTlvBgpSession = enterpriseRouteTlvSession.bgpSessionMap.get(bgpSessionKey);
const enterpriseRouteTlvRoutes = queryBgpRoutes(
    enterpriseRouteTlvSession,
    enterpriseRouteTlvBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const enterpriseRouteTlvFirstRoute = enterpriseRouteTlvRoutes.find(route => route.ip === '203.0.128.0');
const enterpriseRouteTlvSecondRouteInfo = enterpriseRouteTlvRoutes
    .find(route => route.ip === '203.0.129.0')
    .getRouteInfo();
assert.equal(enterpriseRouteTlvFirstRoute.getRouteInfo().routeTlvCount, 0);
assert.equal(enterpriseRouteTlvSecondRouteInfo.routeTlvCount, 1);
assert.deepEqual(enterpriseRouteTlvSecondRouteInfo.routeTlvs[0], {
    type: 1234,
    rawType: 0x8000 | 1234,
    length: 24,
    enterprise: true,
    enterpriseNumber: 64512,
    valueHex: Buffer.from('enterprise-route-tlv').toString('hex'),
    rawValueHex: Buffer.concat([u32(64512), Buffer.from('enterprise-route-tlv')]).toString('hex'),
    index: 2,
    rawIndex: 2,
    group: false,
    appliedNlriIndex: 2
});

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
const draft19PathMarkingRoute = queryBgpRoutes(
    draft19PathMarkingSession,
    draft19PathMarkingBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
)[0];
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
const evpnRoute = queryBgpRoutes(
    evpnBmpSession,
    evpnBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
    BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
)[0];
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
let staleRefreshRoutes = queryBgpRoutes(
    staleRefreshSession,
    staleRefreshBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const staleRefreshRoute = staleRefreshRoutes[0];
assert.equal(staleRefreshRoute.routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);
staleRefreshSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
staleRefreshRoutes = queryBgpRoutes(
    staleRefreshSession,
    staleRefreshBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(staleRefreshRoutes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(staleRefreshRoutes[0].staleReason, 'refresh-pending');
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
staleRefreshRoutes = queryBgpRoutes(
    staleRefreshSession,
    staleRefreshBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(staleRefreshRoutes.length, 1);
assert.equal(staleRefreshRoutes[0].routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);

const { session: splitPeerUpSession } = makeSession();
splitPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayload(0, {
            recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
            sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        })
    )
);
splitPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateAddPath('203.0.131.0', 131))
        ])
    )
);
const splitPeerUpBgpSession = Array.from(splitPeerUpSession.bgpSessionMap.values())[0];
const splitPeerUpIpv4Epoch = splitPeerUpBgpSession.getRibEpoch(
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const splitPeerUpIpv4AddPathKey = `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`;
let splitPeerUpIpv4Routes = queryBgpRoutes(
    splitPeerUpSession,
    splitPeerUpBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(splitPeerUpIpv4Routes.length, 1);
assert.equal(splitPeerUpIpv4Routes[0].routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);
assert.equal(splitPeerUpIpv4Routes[0].pathId, 131);

splitPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAf(BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
    )
);
const splitPeerUpBgpSessionAfterIpv6 = Array.from(splitPeerUpSession.bgpSessionMap.values())[0];
assert.strictEqual(
    splitPeerUpBgpSessionAfterIpv6,
    splitPeerUpBgpSession,
    'split Peer Up messages must update the same BGP session owner'
);
splitPeerUpIpv4Routes = queryBgpRoutes(
    splitPeerUpSession,
    splitPeerUpBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(splitPeerUpIpv4Routes.length, 1);
assert.equal(
    splitPeerUpIpv4Routes[0].routeState,
    BmpConst.BMP_ROUTE_STATE.ACTIVE,
    'an IPv6-only Peer Up must not make existing IPv4 routes stale'
);
assert.equal(splitPeerUpIpv4Routes[0].pathId, 131);
assert.equal(
    splitPeerUpBgpSession.getRibEpoch(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
    ),
    splitPeerUpIpv4Epoch,
    'an IPv6-only Peer Up must not advance the IPv4 RIB epoch'
);
assert.equal(splitPeerUpBgpSession.addPathReceiveMap.get(splitPeerUpIpv4AddPathKey), true);
assert.equal(splitPeerUpBgpSession.recvAddPathMap.has(splitPeerUpIpv4AddPathKey), true);
const expectedSplitPeerUpAfKeys = [
    `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`,
    `${BgpConst.BGP_AFI_TYPE.AFI_IPV6}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`
].sort();
['enabledAddressFamilies', 'recvAddressFamilies', 'sendAddressFamilies'].forEach(field => {
    assert.deepEqual(
        splitPeerUpBgpSession[field].map(family => `${family.afi}|${family.safi}`).sort(),
        expectedSplitPeerUpAfKeys,
        `split Peer Up messages must merge ${field}`
    );
});
splitPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAddressFamilies(0, {
            recvAddressFamilies: [],
            sendAddressFamilies: []
        })
    )
);
splitPeerUpIpv4Routes = queryBgpRoutes(
    splitPeerUpSession,
    splitPeerUpBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(
    splitPeerUpIpv4Routes[0].routeState,
    BmpConst.BMP_ROUTE_STATE.STALE,
    'a repeated IPv4 Peer Up must refresh the IPv4 scope'
);
assert.ok(
    splitPeerUpBgpSession.getRibEpoch(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
    ) > splitPeerUpIpv4Epoch
);
['recvAddPathMap', 'sendAddPathMap', 'addPathReceiveMap', 'addPathSendMap', 'addPathMap'].forEach(field => {
    assert.equal(
        splitPeerUpBgpSession[field].has(splitPeerUpIpv4AddPathKey),
        false,
        `a repeated IPv4 Peer Up without ADD-PATH must clear ${field} only for IPv4`
    );
});
['enabledAddressFamilies', 'recvAddressFamilies', 'sendAddressFamilies'].forEach(field => {
    assert.deepEqual(
        splitPeerUpBgpSession[field].map(family => `${family.afi}|${family.safi}`).sort(),
        expectedSplitPeerUpAfKeys,
        `refreshing IPv4 must retain the accumulated IPv6 ${field}`
    );
});
splitPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.132.0'))
        ])
    )
);
splitPeerUpIpv4Routes = queryBgpRoutes(
    splitPeerUpSession,
    splitPeerUpBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.ok(
    splitPeerUpIpv4Routes.some(route => route.ip === '203.0.132.0' && route.pathId === 0),
    'the first UPDATE after disabling ADD-PATH must persist a normal path ID'
);

const { session: splitLocRibPeerUpSession } = makeSession();
splitLocRibPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
            sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        })
    )
);
const splitLocRibIpv4 = addLocRibRoute(
    splitLocRibPeerUpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '198.51.103.0',
    24
);
const splitLocRibIpv4Epoch = splitLocRibIpv4.instance.getRibEpoch();
const splitLocRibIpv4AddPathKey = `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`;
assert.equal(splitLocRibIpv4.instance.isAddPath, true);
assert.equal(splitLocRibIpv4.instance.addPathReceiveMap.get(splitLocRibIpv4AddPathKey), true);
const splitLocRibIpv6Families = [
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    }
];
splitLocRibPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            recvAddressFamilies: splitLocRibIpv6Families,
            sendAddressFamilies: splitLocRibIpv6Families
        })
    )
);
const splitLocRibIpv4Routes = queryLocRibRoutes(splitLocRibPeerUpSession, splitLocRibIpv4.instance);
assert.equal(splitLocRibIpv4Routes.length, 1);
assert.equal(
    splitLocRibIpv4Routes[0].routeState,
    BmpConst.BMP_ROUTE_STATE.ACTIVE,
    'an IPv6-only Loc-RIB Peer Up must not make the IPv4 instance stale'
);
assert.equal(splitLocRibIpv4.instance.instanceState, BmpConst.BMP_SESSION_STATE.PEER_UP);
assert.equal(splitLocRibIpv4.instance.getRibEpoch(), splitLocRibIpv4Epoch);
assert.equal(
    splitLocRibIpv4.instance.isAddPath,
    true,
    'an IPv6-only Loc-RIB Peer Up must retain the existing IPv4 ADD-PATH state'
);
assert.ok(
    Array.from(splitLocRibPeerUpSession.bgpInstanceMap.values()).some(
        instance =>
            Number(instance.afi) === BgpConst.BGP_AFI_TYPE.AFI_IPV6 &&
            Number(instance.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    ),
    'the later IPv6 Loc-RIB Peer Up must still create its own instance'
);

splitLocRibPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            recvAddressFamilies: [],
            sendAddressFamilies: []
        })
    )
);
assert.equal(
    queryLocRibRoutes(splitLocRibPeerUpSession, splitLocRibIpv4.instance)[0].routeState,
    BmpConst.BMP_ROUTE_STATE.STALE,
    'a base IPv4 Loc-RIB Peer Up without MP capability must refresh the existing IPv4 instance'
);
['recvAddPathMap', 'sendAddPathMap', 'addPathReceiveMap', 'addPathSendMap'].forEach(field => {
    assert.equal(
        splitLocRibIpv4.instance[field].has(splitLocRibIpv4AddPathKey),
        false,
        `a base IPv4 Loc-RIB Peer Up without ADD-PATH must clear ${field}`
    );
});
assert.equal(splitLocRibIpv4.instance.isAddPath, false);
assert.equal(splitLocRibIpv4.instance.getInstanceInfo().isAddPath, false);
['instAddPathMap', 'instAddPathReceiveMap', 'instAddPathSendMap'].forEach(field => {
    assert.equal(
        splitLocRibPeerUpSession[field].has(splitLocRibIpv4AddPathKey),
        false,
        `a base IPv4 Loc-RIB Peer Up without ADD-PATH must clear ${field}`
    );
});

const { session: lazyLocRibPeerUpSession } = makeSession();
const lazyLocRibIpv4 = addLocRibRoute(
    lazyLocRibPeerUpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '198.51.104.0',
    24
);
const lazyLocRibIpv4Epoch = lazyLocRibIpv4.instance.getRibEpoch();
lazyLocRibPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED)
    )
);
assert.equal(
    queryLocRibRoutes(lazyLocRibPeerUpSession, lazyLocRibIpv4.instance)[0].routeState,
    BmpConst.BMP_ROUTE_STATE.ACTIVE,
    'the first real Loc-RIB Peer Up must not stale an instance lazily created by Route Monitoring'
);
assert.equal(lazyLocRibIpv4.instance.getRibEpoch(), lazyLocRibIpv4Epoch);
lazyLocRibPeerUpSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED)
    )
);
assert.equal(
    queryLocRibRoutes(lazyLocRibPeerUpSession, lazyLocRibIpv4.instance)[0].routeState,
    BmpConst.BMP_ROUTE_STATE.STALE,
    'a repeated Loc-RIB Peer Up for the same AF must still start a refresh epoch'
);
assert.ok(lazyLocRibIpv4.instance.getRibEpoch() > lazyLocRibIpv4Epoch);

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
const locRibRouteMonitoringRoute = queryLocRibRoutes(session, locRibInstance)[0];
assert.equal(locRibRouteMonitoringRoute.ip, '198.51.100.0');
assert.ok(
    locRibRouteMonitoringRoute
        .getRouteInfo()
        .routeTlvs.some(
            tlv => tlv.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME && tlv.value === 'global'
        ),
    'Route detail should include route-scoped BMPv4 VRF/Table Name TLV'
);

const { session: locRibDefaultRdEvpnAddPathSession } = makeSession();
const locRibDefaultRdEvpnPrivateRd = rd(65000, 200);
const locRibDefaultRdEvpnAddPathFamilies = [
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
    }
];
const locRibDefaultRdEvpnReceiveAddPathFamilies = [
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
        addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
    }
];
locRibDefaultRdEvpnAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            vrfTableName: 'global-evpn',
            recvAddressFamilies: locRibDefaultRdEvpnAddPathFamilies,
            sendAddressFamilies: locRibDefaultRdEvpnReceiveAddPathFamilies
        })
    )
);
locRibDefaultRdEvpnAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: locRibDefaultRdEvpnPrivateRd
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('vrf-evpn-blue')),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateEvpnVxlan(10002, { pathId: 88 }))
        ])
    )
);
const locRibDefaultRdEvpnInstance = locRibDefaultRdEvpnAddPathSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '65000:200',
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN
    )
);
assert.ok(
    locRibDefaultRdEvpnInstance,
    'Loc-RIB EVPN route should create private RD instance from Route Monitoring header RD'
);
const locRibDefaultRdEvpnRoute = queryLocRibRoutes(locRibDefaultRdEvpnAddPathSession, locRibDefaultRdEvpnInstance).find(
    route => route.pathId === 88
);
assert.ok(locRibDefaultRdEvpnRoute, 'Loc-RIB EVPN route should parse ADD-PATH path-id from RD 0:0 capability');
assert.equal(locRibDefaultRdEvpnRoute.labels, 'VNI 10002');
assert.ok(
    hasRouteParseStatus(locRibDefaultRdEvpnRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.WARNING),
    'Loc-RIB EVPN route parsed via RD 0:0 ADD-PATH should be marked warning'
);
assert.equal(locRibDefaultRdEvpnRoute.nlriDetail.errors.length, 0);
assert.ok(
    locRibDefaultRdEvpnRoute.nlriDetail.warnings.includes(LOC_RIB_DEFAULT_RD_ADD_PATH_INFERRED_WARNING),
    'Loc-RIB EVPN route parsed via RD 0:0 ADD-PATH should keep warning detail'
);
assert.equal(locRibDefaultRdEvpnRoute.getRouteListInfo().warnings, undefined);
assert.equal(locRibDefaultRdEvpnRoute.getRouteListInfo().errors, undefined);

const locRibExactRdEvpnNoAddPathRd = rd(65000, 201);
const locRibExactRdEvpnFamilies = [
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN
    }
];
locRibDefaultRdEvpnAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            rd: locRibExactRdEvpnNoAddPathRd,
            vrfTableName: 'vrf-evpn-exact',
            recvAddressFamilies: locRibExactRdEvpnFamilies,
            sendAddressFamilies: locRibExactRdEvpnFamilies
        })
    )
);
locRibDefaultRdEvpnAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: locRibExactRdEvpnNoAddPathRd
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('vrf-evpn-exact')),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateEvpnVxlan(10003))
        ])
    )
);
const locRibExactRdEvpnNoAddPathInstance = locRibDefaultRdEvpnAddPathSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '65000:201',
        BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
        BgpConst.BGP_SAFI_TYPE.SAFI_EVPN
    )
);
const locRibExactRdEvpnNoAddPathRoute = queryLocRibRoutes(
    locRibDefaultRdEvpnAddPathSession,
    locRibExactRdEvpnNoAddPathInstance
).find(route => route.pathId === 0);
assert.ok(
    locRibExactRdEvpnNoAddPathRoute,
    'Loc-RIB EVPN exact RD without ADD-PATH must not fall back to RD 0:0 ADD-PATH'
);
assert.equal(locRibExactRdEvpnNoAddPathRoute.labels, 'VNI 10003');
assert.equal(locRibExactRdEvpnNoAddPathRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.OK);

const { session: locRibPublicPrivateAddPathSession } = makeSession();
const privateLocRibRd = rd(65000, 100);
locRibPublicPrivateAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, { vrfTableName: 'global' })
    )
);
locRibPublicPrivateAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            rd: privateLocRibRd,
            vrfTableName: 'vrf-blue',
            recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
            sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        })
    )
);
locRibPublicPrivateAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('global')),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('198.51.101.0'))
        ])
    )
);
const locRibPublicPrivateAddPathPublicInstance =
    locRibPublicPrivateAddPathSession.bgpInstanceMap.get(locRibInstanceKey);
const locRibPublicPrivateAddPathPrivateInstance = locRibPublicPrivateAddPathSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '65000:100',
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    )
);
assert.ok(locRibPublicPrivateAddPathPrivateInstance, 'Private IPv4 Loc-RIB add-path Peer Up should create instance');
assert.equal(
    locRibPublicPrivateAddPathPrivateInstance.addPathReceiveMap.get(
        `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`
    ),
    true
);
const locRibPublicPrivateAddPathPublicRoutes = queryLocRibRoutes(
    locRibPublicPrivateAddPathSession,
    locRibPublicPrivateAddPathPublicInstance
);
assert.equal(locRibPublicPrivateAddPathPublicRoutes.length, 1);
assert.equal(locRibPublicPrivateAddPathPublicRoutes[0].ip, '198.51.101.0');
assert.equal(locRibPublicPrivateAddPathPublicRoutes[0].pathId, 0);

const { session: locRibStatelessAddPathSession } = makeSession();
const statelessPrivateLocRibRd = rd(65000, 101);
locRibStatelessAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: statelessPrivateLocRibRd
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('vrf-green')),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.STATELESS_PARSING,
                0,
                addPathCapability(BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE)
            ),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateAddPath('10.101.0.0', 56))
        ])
    )
);
locRibStatelessAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('global')),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('198.51.103.0'))
        ])
    )
);
const locRibStatelessPublicInstance = locRibStatelessAddPathSession.bgpInstanceMap.get(locRibInstanceKey);
const locRibStatelessPrivateInstance = locRibStatelessAddPathSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '65000:101',
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    )
);
assert.ok(locRibStatelessPublicInstance, 'Public Loc-RIB route should create an instance without Peer Up');
assert.ok(locRibStatelessPrivateInstance, 'Private Loc-RIB stateless route should create an instance without Peer Up');
const locRibStatelessPublicRoutes = queryLocRibRoutes(locRibStatelessAddPathSession, locRibStatelessPublicInstance);
const locRibStatelessPrivateRoutes = queryLocRibRoutes(locRibStatelessAddPathSession, locRibStatelessPrivateInstance);
assert.ok(locRibStatelessPublicRoutes.some(route => route.ip === '198.51.103.0' && route.pathId === 0));
assert.ok(locRibStatelessPrivateRoutes.some(route => route.ip === '10.101.0.0' && route.pathId === 56));

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
const locRibPeerDownAddressFamilies = [
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST },
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST }
];
locRibPeerDownSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            recvAddressFamilies: locRibPeerDownAddressFamilies,
            sendAddressFamilies: locRibPeerDownAddressFamilies
        })
    )
);
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
let ipv4LocRibRoutes = queryLocRibRoutes(locRibPeerDownSession, ipv4LocRib.instance);
let ipv6LocRibRoutes = queryLocRibRoutes(locRibPeerDownSession, ipv6LocRib.instance);
assert.equal(ipv4LocRibRoutes.length, 1);
assert.equal(ipv6LocRibRoutes.length, 1);
assert.equal(ipv4LocRibRoutes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(ipv6LocRibRoutes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
const ipv4LocRibPeerDownEpoch = ipv4LocRib.instance.getRibEpoch();
const ipv6LocRibPeerDownEpoch = ipv6LocRib.instance.getRibEpoch();
locRibPeerDownSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED)
    )
);
ipv4LocRibRoutes = queryLocRibRoutes(locRibPeerDownSession, ipv4LocRib.instance);
ipv6LocRibRoutes = queryLocRibRoutes(locRibPeerDownSession, ipv6LocRib.instance);
assert.equal(ipv4LocRibRoutes.length, 1);
assert.equal(ipv6LocRibRoutes.length, 1);
assert.equal(ipv4LocRibRoutes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(ipv6LocRibRoutes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(ipv4LocRib.instance.getRibEpoch(), ipv4LocRibPeerDownEpoch);
assert.equal(ipv6LocRib.instance.getRibEpoch(), ipv6LocRibPeerDownEpoch);
assert.equal(ipv4LocRib.instance.instanceState, BmpConst.BMP_SESSION_STATE.PEER_UP);
assert.equal(ipv6LocRib.instance.instanceState, BmpConst.BMP_SESSION_STATE.PEER_DOWN);

const { session: locRibNotificationPeerDownSession, store: locRibNotificationPeerDownStore } = makeSession();
const locRibNotificationRoute = addLocRibRoute(
    locRibNotificationPeerDownSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '198.51.101.0',
    24
);
locRibNotificationPeerDownSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB),
            Buffer.from([BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION]),
            bgpNotification()
        ])
    )
);
const retainedLocRibNotificationRoutes = queryLocRibRoutes(
    locRibNotificationPeerDownSession,
    locRibNotificationRoute.instance
);
assert.equal(retainedLocRibNotificationRoutes.length, 1);
assert.equal(retainedLocRibNotificationRoutes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(locRibNotificationRoute.instance.instanceState, BmpConst.BMP_SESSION_STATE.PEER_DOWN);
assert.equal(
    locRibNotificationPeerDownStore.queryEvents({
        eventType: 'purge',
        scopeKind: 'loc-rib'
    }).total,
    0,
    'a Loc-RIB Peer Down must retain routes even when it carries a valid BGP Notification'
);

const { session: peerUpRefreshSession } = makeSession();
const peerUpRefreshAddressFamilies = [
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST },
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST }
];
peerUpRefreshSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAddressFamilies(0, {
            recvAddressFamilies: peerUpRefreshAddressFamilies,
            sendAddressFamilies: peerUpRefreshAddressFamilies
        })
    )
);
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
let refreshedIpv4Routes = queryBgpRoutes(
    peerUpRefreshSession,
    refreshedBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    ipv4BgpRoute.ribType
);
const refreshedIpv6Routes = queryBgpRoutes(
    peerUpRefreshSession,
    refreshedBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    ipv6BgpRoute.ribType
);
assert.equal(refreshedIpv4Routes.length, 1);
assert.equal(refreshedIpv6Routes.length, 1);
assert.equal(refreshedIpv4Routes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(
    refreshedIpv6Routes[0].routeState,
    BmpConst.BMP_ROUTE_STATE.ACTIVE,
    'an IPv4-only Peer Up must not refresh an omitted IPv6 route scope'
);
assert.deepEqual(refreshedBgpSession.enabledAddressFamilies, peerUpRefreshAddressFamilies);
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
refreshedIpv4Routes = queryBgpRoutes(
    peerUpRefreshSession,
    refreshedBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    ipv4BgpRoute.ribType
);
assert.equal(refreshedIpv4Routes.length, 2);
assert.ok(
    refreshedIpv4Routes.some(
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
const peerDownPostPolicyRoute = addBgpSessionRoute(
    peerDownMultiAfSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '203.0.122.0',
    24,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
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
let peerDownIpv4Routes = queryBgpRoutes(
    peerDownMultiAfSession,
    peerDownIpv4Route.bgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    peerDownIpv4Route.ribType
);
let peerDownIpv6Routes = queryBgpRoutes(
    peerDownMultiAfSession,
    peerDownIpv6Route.bgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    peerDownIpv6Route.ribType
);
let peerDownPostPolicyRoutes = queryBgpRoutes(
    peerDownMultiAfSession,
    peerDownPostPolicyRoute.bgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    peerDownPostPolicyRoute.ribType
);
assert.equal(peerDownIpv4Routes.length, 1);
assert.equal(peerDownIpv6Routes.length, 1);
assert.equal(peerDownPostPolicyRoutes.length, 1);
assert.equal(peerDownIpv4Routes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(peerDownIpv6Routes[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(
    peerDownPostPolicyRoutes[0].routeState,
    BmpConst.BMP_ROUTE_STATE.STALE,
    'Peer Down flags must not leave another monitored RIB view active'
);
assert.deepEqual(
    Array.from(peerDownIpv4Route.bgpSession.routeScopes.keys()).sort(),
    [
        `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}|${BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN}`,
        `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}|${BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN}`,
        `${BgpConst.BGP_AFI_TYPE.AFI_IPV6}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}|${BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN}`
    ].sort(),
    'Peer Down must not synthesize unobserved AFI/SAFI and RIB scope combinations'
);
peerDownMultiAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAf(BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
    )
);
peerDownIpv4Routes = queryBgpRoutes(
    peerDownMultiAfSession,
    peerDownIpv4Route.bgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    peerDownIpv4Route.ribType
);
peerDownIpv6Routes = queryBgpRoutes(
    peerDownMultiAfSession,
    peerDownIpv6Route.bgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    peerDownIpv6Route.ribType
);
peerDownPostPolicyRoutes = queryBgpRoutes(
    peerDownMultiAfSession,
    peerDownPostPolicyRoute.bgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    peerDownPostPolicyRoute.ribType
);
assert.equal(peerDownIpv4Routes.length, 1);
assert.equal(peerDownIpv6Routes.length, 1);
assert.equal(peerDownPostPolicyRoutes.length, 1);

const { session: peerDownNotificationMultiAfSession, store: peerDownNotificationStore } = makeSession();
const peerDownNotificationRecvFamilies = [
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST },
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
    }
];
const peerDownNotificationSendFamilies = [
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST },
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
    }
];
peerDownNotificationMultiAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAddressFamilies(0, {
            recvAddressFamilies: peerDownNotificationRecvFamilies,
            sendAddressFamilies: peerDownNotificationSendFamilies
        })
    )
);
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
const peerDownNotificationPostPolicyRoute = addBgpSessionRoute(
    peerDownNotificationMultiAfSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '203.0.123.0',
    24,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
);
const peerDownNotificationLocRibRoute = addLocRibRoute(
    peerDownNotificationMultiAfSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '198.51.100.0',
    24
);
const peerDownNotificationIpv6AddPathKey = `${BgpConst.BGP_AFI_TYPE.AFI_IPV6}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`;
assert.equal(peerDownNotificationIpv4Route.bgpSession.addPathReceiveMap.get(peerDownNotificationIpv6AddPathKey), true);
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
const notificationOwner = peerDownNotificationMultiAfSession.bgpSessionMap.get(
    peerDownNotificationIpv4Route.sessionKey
);
assert.equal(notificationOwner, peerDownNotificationIpv4Route.bgpSession);
assert.equal(notificationOwner.sessionState, BmpConst.BMP_SESSION_STATE.PEER_DOWN);
[
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        ribType: peerDownNotificationIpv4Route.ribType
    },
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        ribType: peerDownNotificationIpv6Route.ribType
    },
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        ribType: peerDownNotificationPostPolicyRoute.ribType
    }
].forEach(scope => {
    [
        BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
        BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
        BmpConst.BMP_ROUTE_STATE_FILTER.STALE
    ].forEach(routeState => {
        const notificationScopeRoutes = queryBgpRoutes(
            peerDownNotificationMultiAfSession,
            notificationOwner,
            scope.afi,
            scope.safi,
            scope.ribType,
            routeState
        );
        assert.equal(
            notificationScopeRoutes.length,
            0,
            'a valid BGP Notification must delete every persisted peer route view'
        );
    });
});
const notificationLocRibRoutes = queryLocRibRoutes(
    peerDownNotificationMultiAfSession,
    peerDownNotificationLocRibRoute.instance
);
assert.equal(notificationLocRibRoutes.length, 1);
assert.equal(notificationLocRibRoutes[0].routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);
assert.equal(peerDownNotificationLocRibRoute.instance.instanceState, BmpConst.BMP_SESSION_STATE.PEER_UP);
const notificationPurgeEvents = peerDownNotificationStore.queryEvents({
    eventType: 'purge',
    scopeKind: 'peer',
    pageSize: 100
});
assert.equal(notificationPurgeEvents.total, 3);
assert.ok(
    notificationPurgeEvents.list.every(
        event =>
            event.reason ===
            `peer-down-notification:${BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION}`
    )
);
const notificationEpoch = notificationOwner.getRibEpoch(
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    peerDownNotificationIpv4Route.ribType
);
peerDownNotificationMultiAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAf(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
    )
);
assert.equal(
    peerDownNotificationMultiAfSession.bgpSessionMap.get(peerDownNotificationIpv4Route.sessionKey),
    notificationOwner,
    'Peer Up on the same BMP connection must retain the owner epoch generation'
);
assert.equal(
    notificationOwner.getRibEpoch(
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        peerDownNotificationIpv4Route.ribType
    ),
    notificationEpoch,
    'the first Peer Up after Peer Down must not advance an already stale epoch again'
);
assert.equal(
    queryBgpRoutes(
        peerDownNotificationMultiAfSession,
        notificationOwner,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        peerDownNotificationIpv4Route.ribType
    ).length,
    0,
    'Peer Up without a new announcement must not restore routes deleted by a BGP Notification'
);
const expectedNewGenerationAddressFamilies = [
    `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`
];
['enabledAddressFamilies', 'recvAddressFamilies', 'sendAddressFamilies'].forEach(field => {
    assert.deepEqual(
        notificationOwner[field].map(family => `${family.afi}|${family.safi}`),
        expectedNewGenerationAddressFamilies,
        `the first Peer Up after Peer Down must reset old-generation ${field}`
    );
});
['recvAddPathMap', 'sendAddPathMap', 'addPathReceiveMap', 'addPathSendMap', 'addPathMap'].forEach(field => {
    assert.equal(
        notificationOwner[field].has(peerDownNotificationIpv6AddPathKey),
        false,
        `the first Peer Up after Peer Down must reset old-generation ${field}`
    );
});

const { session: remoteNotificationPeerDownSession } = makeSession();
const remoteNotificationRoute = addBgpSessionRoute(
    remoteNotificationPeerDownSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    '203.0.124.0',
    24
);
remoteNotificationPeerDownSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION,
        Buffer.concat([
            peerHeader(),
            Buffer.from([BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION]),
            bgpNotification()
        ])
    )
);
assert.equal(
    queryBgpRoutes(
        remoteNotificationPeerDownSession,
        remoteNotificationRoute.bgpSession,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        remoteNotificationRoute.ribType
    ).length,
    0,
    'a valid remote-system BGP Notification must delete peer routes too'
);

const invalidPeerDownNotificationCases = [
    {
        name: 'truncated BGP header',
        reason: BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION,
        packet: Buffer.alloc(BgpConst.BGP_HEAD_LEN - 1, 0xff)
    },
    {
        name: 'wrong BGP message type',
        reason: BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION,
        packet: bgpPacket(BgpConst.BGP_PACKET_TYPE.KEEPALIVE, Buffer.alloc(0))
    },
    {
        name: 'Notification without error code and subcode',
        reason: BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION,
        packet: bgpPacket(BgpConst.BGP_PACKET_TYPE.NOTIFICATION, Buffer.alloc(0))
    },
    {
        name: 'Notification with an invalid marker',
        reason: BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION,
        packet: (() => {
            const packet = bgpNotification();
            packet[0] = 0;
            return packet;
        })()
    }
];
invalidPeerDownNotificationCases.forEach((testCase, index) => {
    const { session: invalidNotificationSession, store: invalidNotificationStore } = makeSession();
    const route = addBgpSessionRoute(
        invalidNotificationSession,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        `203.0.${125 + index}.0`,
        24
    );
    invalidNotificationSession.processMessage(
        bmpMessage(
            BmpConst.BMP_VERSION.V4,
            BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION,
            Buffer.concat([peerHeader(), Buffer.from([testCase.reason]), testCase.packet])
        )
    );
    const retained = queryBgpRoutes(
        invalidNotificationSession,
        route.bgpSession,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        route.ribType
    );
    assert.equal(retained.length, 1, `${testCase.name} must not hard-delete peer routes`);
    assert.equal(retained[0].routeState, BmpConst.BMP_ROUTE_STATE.STALE);
    assert.equal(
        invalidNotificationStore.queryEvents({ eventType: 'purge', scopeKind: 'peer' }).total,
        0,
        `${testCase.name} must not create purge history`
    );
});

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
let addPathRoutes = queryBgpRoutes(
    addPathSession,
    addPathBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(addPathRoutes.length, 1);
assert.equal(addPathRoutes[0].pathId, 77);
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
addPathRoutes = queryBgpRoutes(
    addPathSession,
    addPathBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(addPathRoutes.length, 0);
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
const addPathDisabledRoutes = queryBgpRoutes(
    addPathSession,
    addPathBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
    BmpConst.BMP_ROUTE_STATE.ACTIVE
);
assert.equal(addPathDisabledRoutes[0].pathId, 0);
assert.equal(
    addPathBgpSession.addPathMap.has(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`),
    false
);

const { session: globalAndL3vpnAddPathSession } = makeSession();
const privateBgpSessionRd = rd(65000, 200);
globalAndL3vpnAddPathSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
globalAndL3vpnAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayload(0, {
            peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
            rd: privateBgpSessionRd,
            recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
            sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY,
            vrfName: 'vrf-blue'
        })
    )
);
globalAndL3vpnAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.118.0'))
        ])
    )
);
globalAndL3vpnAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(0, BmpConst.BMP_PEER_TYPE.L3VPN, { rd: privateBgpSessionRd }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateAddPath('10.200.0.0', 66))
        ])
    )
);
const globalAndL3vpnPublicSession = globalAndL3vpnAddPathSession.bgpSessionMap.get(bgpSessionKey);
const globalAndL3vpnPrivateSession = globalAndL3vpnAddPathSession.bgpSessionMap.get(
    BmpBgpSession.makeKey(BmpConst.BMP_PEER_TYPE.L3VPN, '65000:200', '192.0.2.2', 65000)
);
assert.ok(globalAndL3vpnPrivateSession, 'Private L3VPN BGP session should be tracked separately');
assert.deepEqual(globalAndL3vpnPrivateSession.vrfTableNames, ['vrf-blue']);
assert.deepEqual(globalAndL3vpnPrivateSession.getSessionInfo().vrfTableNames, ['vrf-blue']);
assert.equal(
    globalAndL3vpnPrivateSession.addPathReceiveMap.get(
        `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`
    ),
    true
);
assert.equal(
    globalAndL3vpnPublicSession.addPathReceiveMap.has(
        `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`
    ),
    false
);
const globalAndL3vpnPublicRoutes = queryBgpRoutes(
    globalAndL3vpnAddPathSession,
    globalAndL3vpnPublicSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const globalAndL3vpnPrivateRoutes = queryBgpRoutes(
    globalAndL3vpnAddPathSession,
    globalAndL3vpnPrivateSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.ok(globalAndL3vpnPublicRoutes.some(route => route.ip === '203.0.118.0' && route.pathId === 0));
assert.ok(globalAndL3vpnPrivateRoutes.some(route => route.ip === '10.200.0.0' && route.pathId === 66));

const { session: postRibOutUnadvertisedAfSession } = makeSession();
postRibOutUnadvertisedAfSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
postRibOutUnadvertisedAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_SESSION_FLAGS.POST_POLICY | BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                labeledUnicastUpdate('10.210.0.0', { nextHop: '0.0.0.0', label: 307 })
            )
        ])
    )
);
const postRibOutUnadvertisedAfBgpSession = postRibOutUnadvertisedAfSession.bgpSessionMap.get(bgpSessionKey);
const postRibOutUnadvertisedLabelRoutes = queryBgpRoutes(
    postRibOutUnadvertisedAfSession,
    postRibOutUnadvertisedAfBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
);
assert.ok(
    postRibOutUnadvertisedLabelRoutes.some(route => route.ip === '10.210.0.0' && route.labels === '307(BOS)'),
    'Session Post-Policy Adj-RIB-Out should store routes for AFs missing from Peer Up capabilities'
);
assert.ok(
    postRibOutUnadvertisedAfBgpSession
        .getSessionInfo()
        .enabledAddrFamilyTypes.includes(BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST),
    'Dynamically observed session AF should be exposed in session info'
);

const { session: extendedFlagsPostPolicyRibOutSession } = makeSession();
extendedFlagsPostPolicyRibOutSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
extendedFlagsPostPolicyRibOutSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS,
                0,
                Buffer.from([BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT | BmpConst.BMP_SESSION_FLAGS.POST_POLICY])
            ),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.127.0'))
        ])
    )
);
const extendedFlagsPostPolicyRibOutBgpSession = extendedFlagsPostPolicyRibOutSession.bgpSessionMap.get(bgpSessionKey);
const extendedFlagsPostPolicyAdjRibOutRoutes = queryBgpRoutes(
    extendedFlagsPostPolicyRibOutSession,
    extendedFlagsPostPolicyRibOutBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT
);
const extendedFlagsPostPolicyPostAdjRibOutRoutes = queryBgpRoutes(
    extendedFlagsPostPolicyRibOutSession,
    extendedFlagsPostPolicyRibOutBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
);
assert.ok(
    !extendedFlagsPostPolicyAdjRibOutRoutes.some(route => route.ip === '203.0.127.0'),
    'BMPv4 Extended Flags TLV post-policy RIB-Out should not be copied into Adj-RIB-Out'
);
assert.ok(
    extendedFlagsPostPolicyPostAdjRibOutRoutes.some(route => route.ip === '203.0.127.0'),
    'BMPv4 Extended Flags TLV post-policy RIB-Out should update Post Adj-RIB-Out'
);

const { session: extendedFlagsHeaderRibOutSession } = makeSession();
extendedFlagsHeaderRibOutSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
extendedFlagsHeaderRibOutSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS | BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS, 0, Buffer.from([0])),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.119.0'))
        ])
    )
);
const extendedFlagsHeaderRibOutBgpSession = extendedFlagsHeaderRibOutSession.bgpSessionMap.get(bgpSessionKey);
const extendedFlagsClearedRibInRoutes = queryBgpRoutes(
    extendedFlagsHeaderRibOutSession,
    extendedFlagsHeaderRibOutBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.ok(
    extendedFlagsClearedRibInRoutes.some(route => route.ip === '203.0.119.0'),
    'BMPv4 Extended Flags TLV should override peer-header flags and clear Adj-RIB-Out for pre-policy RIB-In'
);
assert.ok(
    !queryBgpRoutes(
        extendedFlagsHeaderRibOutSession,
        extendedFlagsHeaderRibOutBgpSession,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT
    ).some(route => route.ip === '203.0.119.0'),
    'BMPv4 Extended Flags TLV value 0 must not leak header Adj-RIB-Out into the effective RIB type'
);
extendedFlagsHeaderRibOutSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS,
                0,
                Buffer.from([BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT])
            ),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.125.0'))
        ])
    )
);
const extendedFlagsSetRibOutRoutes = queryBgpRoutes(
    extendedFlagsHeaderRibOutSession,
    extendedFlagsHeaderRibOutBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT
);
assert.ok(
    extendedFlagsSetRibOutRoutes.some(route => route.ip === '203.0.125.0'),
    'BMPv4 Extended Flags TLV should set Adj-RIB-Out even when peer-header only carries the X flag'
);

const { session: extendedFlagsPostPolicyRibInSession } = makeSession();
extendedFlagsPostPolicyRibInSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
extendedFlagsPostPolicyRibInSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS,
                0,
                Buffer.from([BmpConst.BMP_SESSION_FLAGS.POST_POLICY])
            ),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.126.0'))
        ])
    )
);
const extendedFlagsPostPolicyRibInBgpSession = extendedFlagsPostPolicyRibInSession.bgpSessionMap.get(bgpSessionKey);
const extendedFlagsPostPolicyPreRibInRoutes = queryBgpRoutes(
    extendedFlagsPostPolicyRibInSession,
    extendedFlagsPostPolicyRibInBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const extendedFlagsPostPolicyRibInRoutes = queryBgpRoutes(
    extendedFlagsPostPolicyRibInSession,
    extendedFlagsPostPolicyRibInBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
);
assert.ok(
    !extendedFlagsPostPolicyPreRibInRoutes.some(route => route.ip === '203.0.126.0'),
    'BMPv4 Extended Flags TLV post-policy RIB-In should not be copied into pre-policy Adj-RIB-In'
);
assert.ok(
    extendedFlagsPostPolicyRibInRoutes.some(route => route.ip === '203.0.126.0'),
    'BMPv4 Extended Flags TLV post-policy RIB-In should update Adj-RIB-In'
);
const extendedFlagsPostPolicyRibInRouteInfo = extendedFlagsPostPolicyRibInRoutes
    .find(route => route.ip === '203.0.126.0')
    .getRouteInfo();
assert.ok(
    extendedFlagsPostPolicyRibInRouteInfo.routeTlvs.some(
        tlv =>
            tlv.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS &&
            tlv.valueHex === '40' &&
            tlv.decoded?.flagsHex === '0x40'
    ),
    'Route detail should include route-scoped BMPv4 Extended Flags TLV'
);
assert.ok(
    !extendedFlagsPostPolicyRibInRouteInfo.routeTlvs.some(
        tlv => tlv.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE
    ),
    'Route detail should not duplicate the full BGP Message TLV on each route'
);

const { session: rightAlignedExtendedFlagsRibInSession } = makeSession();
rightAlignedExtendedFlagsRibInSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
rightAlignedExtendedFlagsRibInSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS,
                0,
                Buffer.from([0, 0, 0, BmpConst.BMP_SESSION_FLAGS.POST_POLICY])
            ),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdate('203.0.129.0'))
        ])
    )
);
const rightAlignedExtendedFlagsRibInBgpSession = rightAlignedExtendedFlagsRibInSession.bgpSessionMap.get(bgpSessionKey);
const rightAlignedExtendedFlagsPreRibInRoutes = queryBgpRoutes(
    rightAlignedExtendedFlagsRibInSession,
    rightAlignedExtendedFlagsRibInBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const rightAlignedExtendedFlagsRibInRoutes = queryBgpRoutes(
    rightAlignedExtendedFlagsRibInSession,
    rightAlignedExtendedFlagsRibInBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
);
assert.ok(
    !rightAlignedExtendedFlagsPreRibInRoutes.some(route => route.ip === '203.0.129.0'),
    'BMPv4 right-aligned Extended Flags TLV post-policy RIB-In should not update pre-policy Adj-RIB-In'
);
assert.ok(
    rightAlignedExtendedFlagsRibInRoutes.some(route => route.ip === '203.0.129.0'),
    'BMPv4 right-aligned Extended Flags TLV post-policy RIB-In should update Adj-RIB-In'
);
assert.ok(
    rightAlignedExtendedFlagsRibInRoutes
        .find(route => route.ip === '203.0.129.0')
        .getRouteInfo()
        .routeTlvs.some(
            tlv =>
                tlv.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.EXTENDED_FLAGS &&
                tlv.valueHex === '00000040' &&
                tlv.decoded?.flagsHex === '0x40'
        ),
    'Route detail should decode right-aligned BMPv4 Extended Flags TLV compatibility value'
);

const { session: sixPeSession } = makeSession();
sixPeSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAddressFamilies(0, {
            recvAddressFamilies: [
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
                }
            ],
            sendAddressFamilies: [
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
                }
            ]
        })
    )
);
sixPeSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                sixPeLabeledUnicastUpdate('2001:db8:60::', {
                    nextHop: '192.0.2.250',
                    label: 401
                })
            )
        ])
    )
);
const sixPeBgpSession = sixPeSession.bgpSessionMap.get(bgpSessionKey);
const sixPeRoutes = queryBgpRoutes(
    sixPeSession,
    sixPeBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const sixPeRoute = sixPeRoutes.find(route => route.ip === '2001:db8:60::' && route.labels === '401(BOS)');
assert.ok(sixPeRoute, '6PE IPv6 labeled-unicast route should be stored');
assert.equal(
    sixPeRoute.nextHop,
    '::ffff:192.0.2.250',
    '6PE IPv4-mapped IPv6 next-hop should be displayed as IPv4-mapped IPv6'
);
assert.equal(sixPeRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.OK);

const { session: privateUnicastAddPathLabeledRouteSession } = makeSession();
const privateLabeledRouteRd = rd(65000, 201);
const privateLabeledRoutePeer = {
    peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
    rd: privateLabeledRouteRd,
    peerAddress: '192.0.2.6',
    peerAs: 65004
};
privateUnicastAddPathLabeledRouteSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAddressFamilies(0, {
            ...privateLabeledRoutePeer,
            recvAddressFamilies: [
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                    addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
                },
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
                }
            ],
            sendAddressFamilies: [
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                    addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
                },
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
                }
            ]
        })
    )
);
privateUnicastAddPathLabeledRouteSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(0, BmpConst.BMP_PEER_TYPE.L3VPN, {
                rd: privateLabeledRouteRd,
                peerAddress: '192.0.2.6',
                peerAs: 65004
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateAddPath('10.201.1.0', 68))
        ])
    )
);
privateUnicastAddPathLabeledRouteSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(0, BmpConst.BMP_PEER_TYPE.L3VPN, {
                rd: privateLabeledRouteRd,
                peerAddress: '192.0.2.6',
                peerAs: 65004
            }),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                labeledUnicastUpdate('10.201.2.0', { label: 301 })
            )
        ])
    )
);
const privateUnicastAddPathLabeledRouteBgpSession = privateUnicastAddPathLabeledRouteSession.bgpSessionMap.get(
    BmpBgpSession.makeKey(BmpConst.BMP_PEER_TYPE.L3VPN, '65000:201', '192.0.2.6', 65004)
);
const privateUnicastAddPathRoutes = queryBgpRoutes(
    privateUnicastAddPathLabeledRouteSession,
    privateUnicastAddPathLabeledRouteBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const privateLabeledUnicastRoutes = queryBgpRoutes(
    privateUnicastAddPathLabeledRouteSession,
    privateUnicastAddPathLabeledRouteBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.ok(privateUnicastAddPathRoutes.some(route => route.ip === '10.201.1.0' && route.pathId === 68));
assert.ok(privateLabeledUnicastRoutes.some(route => route.ip === '10.201.2.0' && route.pathId === 0));
assert.ok(
    !privateLabeledUnicastRoutes.some(route => route.pathId === 69),
    'Labeled-unicast must not infer ADD-PATH from IPv4 unicast when label AF was advertised'
);
const nonAddPathLabeledRoute = privateLabeledUnicastRoutes.find(
    route => route.ip === '10.201.2.0' && route.pathId === 0
);
assert.equal(nonAddPathLabeledRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.OK);
assert.equal(nonAddPathLabeledRoute.nlriDetail.warnings.length, 0);

const { session: privateLabeledAddPathUnicastNoAddPathSession } = makeSession();
const privateExactLabeledRouteRd = rd(65000, 202);
const privateExactLabeledRoutePeer = {
    peerType: BmpConst.BMP_PEER_TYPE.L3VPN,
    rd: privateExactLabeledRouteRd,
    peerAddress: '192.0.2.7',
    peerAs: 65005
};
privateLabeledAddPathUnicastNoAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        peerUpPayloadForAddressFamilies(0, {
            ...privateExactLabeledRoutePeer,
            recvAddressFamilies: [
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                },
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
                    addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
                }
            ],
            sendAddressFamilies: [
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                },
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
                    addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
                }
            ]
        })
    )
);
privateLabeledAddPathUnicastNoAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(0, BmpConst.BMP_PEER_TYPE.L3VPN, {
                rd: privateExactLabeledRouteRd,
                peerAddress: '192.0.2.7',
                peerAs: 65005
            }),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                labeledUnicastUpdate('10.202.2.0', { label: 303, pathId: 72 })
            )
        ])
    )
);
privateLabeledAddPathUnicastNoAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(0, BmpConst.BMP_PEER_TYPE.L3VPN, {
                rd: privateExactLabeledRouteRd,
                peerAddress: '192.0.2.7',
                peerAs: 65005
            }),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                labeledUnicastNoLabelUpdate('10.202.0.0', { pathId: 74 })
            )
        ])
    )
);
const privateLabeledAddPathUnicastNoAddPathBgpSession = privateLabeledAddPathUnicastNoAddPathSession.bgpSessionMap.get(
    BmpBgpSession.makeKey(BmpConst.BMP_PEER_TYPE.L3VPN, '65000:202', '192.0.2.7', 65005)
);
const exactPrivateLabeledUnicastRoutes = queryBgpRoutes(
    privateLabeledAddPathUnicastNoAddPathSession,
    privateLabeledAddPathUnicastNoAddPathBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const exactPrivateLabeledRoute = exactPrivateLabeledUnicastRoutes.find(
    route => route.ip === '10.202.2.0' && route.pathId === 72
);
assert.ok(exactPrivateLabeledRoute, 'Labeled-unicast exact ADD-PATH must not fall back to IPv4 unicast no ADD-PATH');
assert.equal(exactPrivateLabeledRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.OK);
assert.equal(exactPrivateLabeledRoute.nlriDetail.warnings.length, 0);
const invalidPrivateNoLabelRoute = exactPrivateLabeledUnicastRoutes.find(
    route => route.ip === '10.202.0.0' && route.mask === 16 && route.pathId === 74
);
assert.ok(invalidPrivateNoLabelRoute, 'IPv4 labeled-unicast route without label should still be stored');
assert.ok(
    hasRouteParseStatus(invalidPrivateNoLabelRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.ERROR),
    'IPv4 labeled-unicast route without label should be marked error'
);
assert.ok(
    invalidPrivateNoLabelRoute.nlriDetail.errors.includes('Labeled Unicast NLRI has no MPLS label'),
    'Route detail should keep concrete parser errors'
);
assert.equal(invalidPrivateNoLabelRoute.nlriDetail.warnings.length, 0);
assert.equal(invalidPrivateNoLabelRoute.getRouteListInfo().errors, undefined);

const { session: locRibUnicastAddPathLabeledRouteSession } = makeSession();
const locRibLabeledRouteRd = rd(65000, 102);
const locRibLabeledRoutePeer = {
    flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
    peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
    rd: locRibLabeledRouteRd
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
locRibUnicastAddPathLabeledRouteSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            rd: locRibLabeledRouteRd,
            vrfTableName: 'vrf-label',
            recvAddressFamilies: unicastAddPathAndLabelFamilies,
            sendAddressFamilies: unicastReceiveAddPathAndLabelFamilies
        })
    )
);
locRibUnicastAddPathLabeledRouteSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: locRibLabeledRouteRd
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('vrf-label')),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpUpdateAddPath('10.102.1.0', 70))
        ])
    )
);
locRibUnicastAddPathLabeledRouteSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: locRibLabeledRouteRd
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('vrf-label')),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                labeledUnicastUpdate('10.102.2.0', { nextHop: '0.0.0.0', label: 302 })
            )
        ])
    )
);
const locRibLabeledRouteInstance = locRibUnicastAddPathLabeledRouteSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '65000:102',
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
    )
);
const locRibLabeledRoutes = queryLocRibRoutes(locRibUnicastAddPathLabeledRouteSession, locRibLabeledRouteInstance);
assert.ok(
    !locRibLabeledRoutes.some(route => route.pathId === 71),
    'Loc-RIB labeled route must not infer ADD-PATH from IPv4 unicast when label AF was advertised'
);
const nonAddPathLocRibLabeledRoute = locRibLabeledRoutes.find(route => route.ip === '10.102.2.0' && route.pathId === 0);
assert.ok(
    nonAddPathLocRibLabeledRoute,
    'Loc-RIB labeled route should parse without ADD-PATH when label AF has no ADD-PATH'
);
assert.equal(nonAddPathLocRibLabeledRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.OK);
assert.equal(nonAddPathLocRibLabeledRoute.nlriDetail.errors.length, 0);
assert.equal(nonAddPathLocRibLabeledRoute.nlriDetail.warnings.length, 0);
assert.equal(nonAddPathLocRibLabeledRoute.getRouteListInfo().warnings, undefined);
assert.equal(nonAddPathLocRibLabeledRoute.getRouteListInfo().errors, undefined);

const { session: locRibUnadvertisedLabelAfSession } = makeSession({
    bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
});
const locRibUnadvertisedLabelAfRd = rd(65000, 104);
locRibUnadvertisedLabelAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            rd: locRibUnadvertisedLabelAfRd,
            vrfTableName: 'vrf-label-unadvertised',
            recvAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY,
            sendAddPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
        })
    )
);
locRibUnadvertisedLabelAfSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: locRibUnadvertisedLabelAfRd
            }),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.VRF_TABLE_NAME,
                0,
                Buffer.from('vrf-label-unadvertised')
            ),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.BGP_MESSAGE,
                0,
                labeledUnicastUpdate('1.1.1.0', { nextHop: '0.0.0.0', label: 305, pathId: 76 })
            )
        ])
    )
);
const locRibUnadvertisedLabelAfInstance = locRibUnadvertisedLabelAfSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '65000:104',
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
    )
);
assert.ok(
    locRibUnadvertisedLabelAfInstance,
    'Loc-RIB IPv4 label route should create instance even when Peer Up omitted label AF'
);
const locRibUnadvertisedLabelAfRoutes = queryLocRibRoutes(
    locRibUnadvertisedLabelAfSession,
    locRibUnadvertisedLabelAfInstance
);
const locRibUnadvertisedLabelAfRoute = locRibUnadvertisedLabelAfRoutes.find(
    route => route.ip === '1.1.1.0' && route.pathId === 76
);
assert.ok(
    locRibUnadvertisedLabelAfRoute,
    'Loc-RIB IPv4 label route should infer ADD-PATH from same-RD IPv4 unicast when Peer Up omitted label AF'
);
assert.equal(locRibUnadvertisedLabelAfRoute.labels, '305(BOS)');
assert.ok(
    hasRouteParseStatus(locRibUnadvertisedLabelAfRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.WARNING),
    'Loc-RIB IPv4 label route inferred from unicast ADD-PATH should be marked warning'
);
assert.ok(
    locRibUnadvertisedLabelAfRoute.nlriDetail.warnings.includes(LABEL_UNICAST_ADD_PATH_INFERRED_WARNING),
    'Loc-RIB IPv4 label route inferred from unicast ADD-PATH should keep warning detail'
);
assert.ok(
    !locRibUnadvertisedLabelAfRoutes.some(route => route.ip === '0.0.0.0'),
    'Loc-RIB IPv4 label ADD-PATH inference must not leave a bogus 0.0.0.0 route'
);

const { session: locRibDefaultRdLabelAddPathSession } = makeSession();
const locRibCrossRdLabelRouteRd = rd(65000, 105);
const locRibDefaultRdLabelAddPathFamilies = [
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
        addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
    }
];
const locRibDefaultRdLabelReceiveAddPathFamilies = [
    {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
        addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
    }
];
locRibDefaultRdLabelAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            vrfTableName: 'global-label',
            recvAddressFamilies: locRibDefaultRdLabelAddPathFamilies,
            sendAddressFamilies: locRibDefaultRdLabelReceiveAddPathFamilies
        })
    )
);
locRibDefaultRdLabelAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: locRibCrossRdLabelRouteRd
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('vrf-label-cross-rd')),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                labeledUnicastUpdate('10.105.2.0', { nextHop: '0.0.0.0', label: 306 })
            )
        ])
    )
);
const locRibCrossRdLabelInstance = locRibDefaultRdLabelAddPathSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '65000:105',
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
    )
);
assert.ok(locRibCrossRdLabelInstance, 'Loc-RIB IPv4 label route should create its own RD instance');
const locRibCrossRdLabelRoutes = queryLocRibRoutes(locRibDefaultRdLabelAddPathSession, locRibCrossRdLabelInstance);
const locRibCrossRdLabelRoute = locRibCrossRdLabelRoutes.find(route => route.ip === '10.105.2.0' && route.pathId === 0);
assert.ok(
    locRibCrossRdLabelRoute,
    'Loc-RIB IPv4 label route must not infer ADD-PATH from RD 0:0 label-unicast capability'
);
assert.equal(locRibCrossRdLabelRoute.labels, '306(BOS)');
assert.equal(locRibCrossRdLabelRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.OK);
assert.equal(locRibCrossRdLabelRoute.nlriDetail.warnings.length, 0);
assert.ok(
    !locRibCrossRdLabelRoutes.some(route => route.ip === '0.0.0.0'),
    'Loc-RIB IPv4 label route must not create a bogus 0.0.0.0 route from cross-RD ADD-PATH'
);

const { session: locRibLabeledAddPathUnicastNoAddPathSession } = makeSession();
const locRibExactLabeledRouteRd = rd(65000, 103);
locRibLabeledAddPathUnicastNoAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        locRibPeerUpPayload(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, {
            rd: locRibExactLabeledRouteRd,
            vrfTableName: 'vrf-label-exact',
            recvAddressFamilies: [
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                },
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
                    addPathMode: BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY
                }
            ],
            sendAddressFamilies: [
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                },
                {
                    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
                    addPathMode: BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY
                }
            ]
        })
    )
);
locRibLabeledAddPathUnicastNoAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: locRibExactLabeledRouteRd
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('vrf-label-exact')),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                labeledUnicastUpdate('10.103.2.0', { nextHop: '0.0.0.0', label: 304, pathId: 73 })
            )
        ])
    )
);
locRibLabeledAddPathUnicastNoAddPathSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB, {
                rd: locRibExactLabeledRouteRd
            }),
            indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from('vrf-label-exact')),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                labeledUnicastNoLabelUpdate('10.103.0.0', { nextHop: '0.0.0.0', pathId: 75 })
            )
        ])
    )
);
const exactLocRibLabeledRouteInstance = locRibLabeledAddPathUnicastNoAddPathSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '65000:103',
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
    )
);
const exactLocRibLabeledRoutes = queryLocRibRoutes(
    locRibLabeledAddPathUnicastNoAddPathSession,
    exactLocRibLabeledRouteInstance
);
const exactLocRibLabeledRoute = exactLocRibLabeledRoutes.find(
    route => route.ip === '10.103.2.0' && route.pathId === 73
);
assert.ok(exactLocRibLabeledRoute, 'Loc-RIB labeled exact ADD-PATH must not fall back to IPv4 unicast no ADD-PATH');
assert.equal(exactLocRibLabeledRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.OK);
assert.equal(exactLocRibLabeledRoute.nlriDetail.warnings.length, 0);
const invalidLocRibNoLabelRoute = exactLocRibLabeledRoutes.find(
    route => route.ip === '10.103.0.0' && route.mask === 16 && route.pathId === 75
);
assert.ok(invalidLocRibNoLabelRoute, 'Loc-RIB IPv4 labeled-unicast route without label should still be stored');
assert.ok(
    hasRouteParseStatus(invalidLocRibNoLabelRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.ERROR),
    'Loc-RIB IPv4 labeled-unicast route without label should be marked error'
);
assert.ok(
    invalidLocRibNoLabelRoute.nlriDetail.errors.includes('Labeled Unicast NLRI has no MPLS label'),
    'Loc-RIB route detail should keep concrete parser errors'
);
assert.equal(invalidLocRibNoLabelRoute.nlriDetail.warnings.length, 0);
assert.equal(invalidLocRibNoLabelRoute.getRouteListInfo().errors, undefined);

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
const statelessRoutes = queryBgpRoutes(
    statelessAddPathSession,
    statelessBgpSession,
    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.ok(statelessRoutes.some(route => route.ip === '203.0.115.0' && route.pathId === 88));
assert.ok(statelessRoutes.some(route => route.ip === '203.0.116.0' && route.pathId === 0));
assert.equal(
    statelessBgpSession.addPathMap.has(`${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`),
    false
);

const { session: statelessNoAddPathCompatSession } = makeSession();
statelessNoAddPathCompatSession.processMessage(
    bmpMessage(BmpConst.BMP_VERSION.V4, BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, peerUpPayload())
);
const statelessNoAddPathCompatCases = [
    {
        flags: 0,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        prefix: '203.0.250.0'
    },
    {
        flags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
        prefix: '203.0.251.0'
    },
    {
        flags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
        prefix: '203.0.252.0'
    },
    {
        flags: BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT | BmpConst.BMP_SESSION_FLAGS.POST_POLICY,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT,
        prefix: '203.0.253.0'
    }
];
statelessNoAddPathCompatCases.forEach(({ flags, prefix }) => {
    statelessNoAddPathCompatSession.processMessage(
        bmpMessage(
            BmpConst.BMP_VERSION.V4,
            BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
            Buffer.concat([
                peerHeader(flags),
                indexedTlv(
                    BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.STATELESS_PARSING,
                    0,
                    addPathCapability(BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE)
                ),
                indexedTlv(
                    BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                    0,
                    bgpUpdateWithOriginValidationState(prefix)
                )
            ])
        )
    );
});
const statelessNoAddPathCompatBgpSession = statelessNoAddPathCompatSession.bgpSessionMap.get(bgpSessionKey);
statelessNoAddPathCompatCases.forEach(({ ribType, prefix }) => {
    const route = queryBgpRoutes(
        statelessNoAddPathCompatSession,
        statelessNoAddPathCompatBgpSession,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        ribType
    ).find(candidate => candidate.ip === prefix && candidate.pathId === 0);
    assert.ok(route, `stateless non-ADD-PATH route should be stored in RIB type ${ribType}`);
    assert.ok(
        hasRouteParseStatus(route.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.WARNING),
        `stateless non-ADD-PATH route in RIB type ${ribType} should be marked warning`
    );
    assert.ok(
        hasStatelessAddPathCompatibilityWarning(route),
        `stateless non-ADD-PATH route in RIB type ${ribType} should keep compatibility warning`
    );
});
statelessNoAddPathCompatSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING,
        Buffer.concat([
            peerHeader(BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, BmpConst.BMP_PEER_TYPE.LOCAL_RIB),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.STATELESS_PARSING,
                0,
                addPathCapability(BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE)
            ),
            indexedTlv(
                BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE,
                0,
                bgpUpdateWithOriginValidationState('203.0.254.0')
            )
        ])
    )
);
const statelessNoAddPathCompatLocRibInstance = statelessNoAddPathCompatSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '0:0',
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    )
);
assert.ok(statelessNoAddPathCompatLocRibInstance, 'stateless non-ADD-PATH Loc-RIB route should create instance');
const statelessNoAddPathCompatLocRibRoute = queryLocRibRoutes(
    statelessNoAddPathCompatSession,
    statelessNoAddPathCompatLocRibInstance
).find(route => route.ip === '203.0.254.0' && route.pathId === 0);
assert.ok(statelessNoAddPathCompatLocRibRoute, 'stateless non-ADD-PATH route should be stored in Loc-RIB');
assert.ok(
    hasRouteParseStatus(statelessNoAddPathCompatLocRibRoute.parseStatus, BmpConst.BMP_ROUTE_PARSE_STATUS.WARNING),
    'stateless non-ADD-PATH Loc-RIB route should be marked warning'
);
assert.ok(
    hasStatelessAddPathCompatibilityWarning(statelessNoAddPathCompatLocRibRoute),
    'stateless non-ADD-PATH Loc-RIB route should keep compatibility warning'
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
                    u32(8),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_IN),
                    u16(8),
                    Buffer.from('0000000000000012', 'hex'),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_IN),
                    u16(11),
                    u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
                    Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST]),
                    Buffer.from('0000000000000019', 'hex'),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_IN),
                    u16(8),
                    Buffer.from('0000000000000014', 'hex'),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_IN),
                    u16(11),
                    u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
                    Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST]),
                    Buffer.from('0000000000000021', 'hex'),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT),
                    u16(8),
                    Buffer.from('000000000000000e', 'hex'),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_OUT),
                    u16(11),
                    u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
                    Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST]),
                    Buffer.from('0000000000000016', 'hex'),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT),
                    u16(8),
                    Buffer.from('000000000000000f', 'hex'),
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
const statsTypeReports = statsTypeEvents
    .filter(event => event.type === BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT)
    .map(event => event.payload.data);
assert.equal(statsTypeReports.length, 4, 'RFC 9972 Statistics Report must split into four exact RIB stages');
assert.equal(statsTypeSession.bgpStatisticsReportMap.size, 4);
const explicitPreInReport = statsTypeReports.find(
    report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const explicitPostInReport = statsTypeReports.find(report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN);
const explicitPreOutReport = statsTypeReports.find(report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT);
const explicitPostOutReport = statsTypeReports.find(
    report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
);
assert.deepEqual(
    explicitPreInReport.statistics.map(statistic => statistic.type),
    [BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_IN, BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_IN]
);
assert.deepEqual(
    explicitPostInReport.statistics.map(statistic => statistic.type),
    [
        BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_IN,
        BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_IN
    ]
);
assert.deepEqual(
    explicitPreOutReport.statistics.map(statistic => statistic.type),
    [
        BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT,
        BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_OUT
    ]
);
assert.deepEqual(
    explicitPostOutReport.statistics.map(statistic => statistic.type),
    [
        BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT,
        BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_OUT
    ]
);
assert.equal(explicitPreInReport.statistics[1].typeName, '每 AFI/SAFI Pre-Policy Adj-RIB-In 中的路由数');
assert.equal(explicitPreInReport.statistics[1].afi, BgpConst.BGP_AFI_TYPE.AFI_IPV4);
assert.equal(explicitPreInReport.statistics[1].safi, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
assert.equal(explicitPostInReport.statistics[1].typeName, '每 AFI/SAFI Post-Policy Adj-RIB-In 中的路由数');
assert.equal(explicitPostInReport.statistics[1].value, 33);
assert.equal(explicitPreOutReport.statistics[1].value, 22);
assert.equal(explicitPostOutReport.statistics[1].value, 23);

const { session: mixedStatsSession, events: mixedStatsEvents } = makeSession();
mixedStatsSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT,
        Buffer.concat([
            peerHeader(BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS),
            tlv(
                BmpConst.BMP_STATS_REPORT_TLV_TYPE.EXTENDED_FLAGS,
                Buffer.from([BmpConst.BMP_SESSION_FLAGS.POST_POLICY])
            ),
            tlv(
                BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS,
                Buffer.concat([
                    u32(3),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN),
                    u16(4),
                    u32(12),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT),
                    u16(4),
                    u32(14),
                    u16(BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT),
                    u16(4),
                    u32(15)
                ])
            )
        ])
    )
);
const mixedStatisticsEvents = mixedStatsEvents.filter(event => event.type === BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT);
assert.equal(mixedStatisticsEvents.length, 3, 'a mixed Statistics Report must emit one event per exact RIB stage');
assert.equal(mixedStatsSession.bgpStatisticsReportMap.size, 3);
const mixedPostInReport = mixedStatisticsEvents.find(
    event => event.payload.data.ribType === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
).payload.data;
const mixedPreOutReport = mixedStatisticsEvents.find(
    event => event.payload.data.ribType === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT
).payload.data;
const mixedPostOutReport = mixedStatisticsEvents.find(
    event => event.payload.data.ribType === BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
).payload.data;
assert.equal(mixedPostInReport.rawSessionFlags, BmpConst.BMP_SESSION_FLAGS.EXTENDED_FLAGS);
assert.equal(mixedPostInReport.effectiveSessionFlags, BmpConst.BMP_SESSION_FLAGS.POST_POLICY);
assert.deepEqual(
    mixedPostInReport.statistics.map(statistic => statistic.type),
    [BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN]
);
assert.deepEqual(
    mixedPreOutReport.statistics.map(statistic => statistic.type),
    [BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT]
);
assert.deepEqual(
    mixedPostOutReport.statistics.map(statistic => statistic.type),
    [BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT]
);
mixedStatsSession.processMessage(
    bmpMessage(
        BmpConst.BMP_VERSION.V4,
        BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT,
        Buffer.concat([
            peerHeader(),
            tlv(
                BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS,
                Buffer.concat([u32(1), u16(BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN), u16(4), u32(7)])
            )
        ])
    )
);
assert.equal(mixedStatsSession.bgpStatisticsReportMap.size, 4, 'pre/post in/out reports must not overwrite each other');
const mixedPreInReport = Array.from(mixedStatsSession.bgpStatisticsReportMap.values()).find(
    report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
assert.equal(mixedPreInReport.statistics[0].value, 7);
assert.equal(mixedPostInReport.statistics[0].value, 12);

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
    huaweiDraft20Instance ? queryLocRibRoutes(huaweiDraft20Session.session, huaweiDraft20Instance).length : 0,
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
const huaweiRoutes = queryLocRibRoutes(huaweiSession, huaweiLocRibInstance);
assert.equal(huaweiRoutes.length, 1);
assert.equal(huaweiRoutes[0].ip, '2.1.1.1');
assert.ok(huaweiEvents.some(event => event.type === BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE));

const huaweiDraft19LabelAddPathFrame = bytesFromDump(`
0000   00 50 56 c0 00 03 fa bb 55 54 00 10 08 00 45 00
0010   03 3b 08 04 00 00 ff 06 67 59 c0 a8 64 0b c0 a8
0020   64 03 ca 2c 06 fe 60 b2 82 28 be ba 22 0b 50 18
0030   f0 00 25 89 00 00 04 00 00 00 b0 03 03 80 00 00
0040   00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0050   00 00 00 00 00 00 00 00 00 64 c0 a8 64 0b 6a 3c
0060   5e bf 00 08 29 d8 00 00 00 00 00 00 00 00 00 00
0070   00 00 00 00 00 00 00 00 00 00 ff ff ff ff ff ff
0080   ff ff ff ff ff ff ff ff ff ff 00 31 01 04 00 64
0090   00 b4 c0 a8 64 0b 14 02 12 41 04 00 00 00 64 01
00a0   04 00 01 00 01 45 04 00 01 01 03 ff ff ff ff ff
00b0   ff ff ff ff ff ff ff ff ff ff ff 00 31 01 04 00
00c0   64 00 b4 c0 a8 64 0b 14 02 12 41 04 00 00 00 64
00d0   01 04 00 01 00 01 45 04 00 01 01 03 00 03 00 06
00e0   67 6c 6f 62 61 6c 04 00 00 00 ae 03 03 80 00 00
00f0   00 01 00 00 00 01 00 00 00 00 00 00 00 00 00 00
0100   00 00 00 00 00 00 00 00 00 64 c0 a8 64 0b 6a 3c
0110   5e bf 00 08 29 d8 00 00 00 00 00 00 00 00 00 00
0120   00 00 00 00 00 00 00 00 00 00 ff ff ff ff ff ff
0130   ff ff ff ff ff ff ff ff ff ff 00 31 01 04 00 64
0140   00 b4 c0 a8 64 0b 14 02 12 41 04 00 00 00 64 01
0150   04 00 01 00 01 45 04 00 01 01 03 ff ff ff ff ff
0160   ff ff ff ff ff ff ff ff ff ff ff 00 31 01 04 00
0170   64 00 b4 c0 a8 64 0b 14 02 12 41 04 00 00 00 64
0180   01 04 00 01 00 01 45 04 00 01 01 03 00 03 00 04
0190   76 72 66 31 04 00 00 00 59 00 03 80 00 00 00 00
01a0   00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
01b0   00 00 00 00 00 00 00 64 c0 a8 64 0b 6a 3c 5e bf
01c0   00 08 2f b9 00 03 00 06 00 00 67 6c 6f 62 61 6c
01d0   00 04 00 17 00 00 ff ff ff ff ff ff ff ff ff ff
01e0   ff ff ff ff ff ff 00 17 02 00 00 00 00 04 00 00
01f0   00 75 00 03 80 00 00 00 01 00 00 00 01 00 00 00
0200   00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0210   64 c0 a8 64 0b 6a 3c 5e 69 00 08 31 9c 00 03 00
0220   04 00 00 76 72 66 31 00 04 00 35 00 00 ff ff ff
0230   ff ff ff ff ff ff ff ff ff ff ff ff ff 00 35 02
0240   00 00 00 15 40 01 01 02 40 02 00 40 03 04 00 00
0250   00 00 80 04 04 00 00 00 00 00 00 00 00 20 02 01
0260   01 01 04 00 00 00 90 00 03 80 00 00 00 01 00 00
0270   00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0280   00 00 00 00 00 64 c0 a8 64 0b 6a 3c 5e 69 00 08
0290   31 d6 00 03 00 04 00 00 76 72 66 31 00 04 00 50
02a0   00 00 ff ff ff ff ff ff ff ff ff ff ff ff ff ff
02b0   ff ff 00 50 02 00 00 00 39 40 01 01 02 40 02 00
02c0   80 04 04 00 00 00 00 40 05 04 00 00 00 64 c0 10
02d0   08 00 02 00 01 00 00 00 01 90 0e 00 15 00 01 04
02e0   04 0b 01 01 02 00 00 00 00 00 38 0b b8 01 02 01
02f0   01 02 04 00 00 00 57 00 03 80 00 00 00 01 00 00
0300   00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00
0310   00 00 00 00 00 64 c0 a8 64 0b 6a 3c 5e bf 00 08
0320   31 e2 00 03 00 04 00 00 76 72 66 31 00 04 00 17
0330   00 00 ff ff ff ff ff ff ff ff ff ff ff ff ff ff
0340   ff ff 00 17 02 00 00 00 00
`);

const { session: huaweiLabelAddPathSession } = makeSession({
    bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
});
huaweiLabelAddPathSession.recvMsg(tcpPayloadFromEthernetFrame(huaweiDraft19LabelAddPathFrame));
const huaweiLabelAddPathInstance = huaweiLabelAddPathSession.bgpInstanceMap.get(
    BmpBgpInstance.makeKey(
        BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        '1:1',
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
    )
);
assert.ok(huaweiLabelAddPathInstance, 'Huawei draft-19 Loc-RIB IPv4 label ADD-PATH frame should create label instance');
const huaweiLabelAddPathRoutes = queryLocRibRoutes(huaweiLabelAddPathSession, huaweiLabelAddPathInstance);
assert.ok(
    huaweiLabelAddPathRoutes.some(
        route => route.ip === '2.1.1.2' && route.mask === 32 && route.pathId === 0 && route.labels === '48000(BOS)'
    ),
    'Huawei draft-19 Loc-RIB IPv4 label ADD-PATH frame should keep the real labeled route'
);
assert.ok(
    !huaweiLabelAddPathRoutes.some(route => route.ip === '0.0.0.0'),
    'Huawei draft-19 Loc-RIB IPv4 label ADD-PATH frame must not leave a bogus 0.0.0.0 route'
);

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
