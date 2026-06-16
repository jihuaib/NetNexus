const assert = require('assert');
const path = require('path');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');

const AFI = BgpConst.BGP_AFI_TYPE.AFI_L2VPN;
const SAFI = BgpConst.BGP_SAFI_TYPE.SAFI_EVPN;
const AF = BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN;
const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
const EVPN_ROUTE_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const ROUTES_PER_TYPE = 24;
const ROUTE_COUNT = EVPN_ROUTE_TYPES.length * ROUTES_PER_TYPE;
const PAGE_SIZE = 37;

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function ipBytes(ipAddress) {
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

function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE) {
    return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
}

function evpnRaw24(value) {
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function evpnNlri(routeType, body) {
    return Buffer.concat([Buffer.from([routeType, body.length]), body]);
}

function evpnIpField(ipAddress) {
    return Buffer.concat([Buffer.from([BgpConst.IP_HOST_LEN]), ipBytes(ipAddress)]);
}

function rdFromIndex(index) {
    return Buffer.concat([u16(0), u16(65000), u32(index + 1)]);
}

function esiFromIndex(index) {
    return Buffer.from([0, 1, 2, 3, 4, 5, (index >> 16) & 0xff, (index >> 8) & 0xff, index & 0xff, index % 251]);
}

function macFromIndex(index) {
    return Buffer.from([0xaa, 0xbb, (index >> 16) & 0xff, (index >> 8) & 0xff, index & 0xff, index % 251]);
}

function unicastIp(index) {
    return `10.${(index >> 16) & 0xff}.${(index >> 8) & 0xff}.${index & 0xff}`;
}

function prefixIp(index) {
    return `172.${16 + ((index >> 8) & 0x0f)}.${index & 0xff}.0`;
}

function multicastGroup(index) {
    return `239.${1 + ((index >> 16) & 0x0f)}.${(index >> 8) & 0xff}.${index & 0xff}`;
}

function labelEntry(value) {
    return evpnRaw24(value);
}

function multicastSourceGroupOrigin(index) {
    return Buffer.concat([
        evpnIpField(unicastIp(index)),
        evpnIpField(multicastGroup(index)),
        evpnIpField(unicastIp(index + 1))
    ]);
}

function evpnRouteBody(routeType, index) {
    const rd = rdFromIndex(routeType * 1000 + index);
    const esi = esiFromIndex(routeType * 1000 + index);
    const tag = u32(100 + (index % 100));
    const vni = 10000 + routeType * 100 + index;

    switch (routeType) {
        case 1:
            return Buffer.concat([rd, esi, tag, labelEntry(vni)]);
        case 2:
            return Buffer.concat([
                rd,
                esi,
                tag,
                Buffer.from([48]),
                macFromIndex(index),
                Buffer.from([BgpConst.IP_HOST_LEN]),
                ipBytes(unicastIp(index)),
                labelEntry(vni)
            ]);
        case 3:
            return Buffer.concat([rd, tag, evpnIpField(unicastIp(index))]);
        case 4:
            return Buffer.concat([rd, esi, evpnIpField(unicastIp(index))]);
        case 5:
            return Buffer.concat([
                rd,
                esi,
                tag,
                Buffer.from([24]),
                ipBytes(prefixIp(index)),
                ipBytes(unicastIp(index + 1)),
                labelEntry(vni)
            ]);
        case 6:
            return Buffer.concat([rd, tag, multicastSourceGroupOrigin(index), Buffer.from([0x03])]);
        case 7:
            return Buffer.concat([rd, esi, tag, multicastSourceGroupOrigin(index), Buffer.from([0x02])]);
        case 8:
            return Buffer.concat([rd, esi, tag, multicastSourceGroupOrigin(index), u32(0), Buffer.from([10, 0x01])]);
        case 9:
            return Buffer.concat([rd, tag, Buffer.from([0, 1, 2, 3, 4, 5, (index >> 8) & 0xff, index & 0xff])]);
        case 10:
            return Buffer.concat([rd, tag, multicastSourceGroupOrigin(index)]);
        case 11: {
            const routeKey = evpnNlri(10, Buffer.concat([rd, tag, multicastSourceGroupOrigin(index)]));
            return Buffer.concat([routeKey, evpnIpField(unicastIp(index + 2))]);
        }
        default:
            throw new Error(`unsupported EVPN route type: ${routeType}`);
    }
}

function evpnUpdate(routeType, index) {
    const nlri = evpnNlri(routeType, evpnRouteBody(routeType, index));
    const mpReachValue = Buffer.concat([
        u16(AFI),
        Buffer.from([SAFI, 4]),
        ipBytes('192.0.2.1'),
        Buffer.from([0]),
        nlri
    ]);
    const vxlanEncapsulationCommunity = Buffer.concat([Buffer.from([0x03, 0x0c, 0, 0, 0, 0]), u16(8)]);
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL),
        pathAttr(
            BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
            vxlanEncapsulationCommunity,
            BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
        )
    ]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrs.length), attrs]));
}

function parseEvpnRoute(routeType, index) {
    const parsedPacket = parseBgpPacket(evpnUpdate(routeType, index));
    assert.equal(parsedPacket.valid, true, parsedPacket.error || `EVPN route type ${routeType} should parse`);
    const mpReach = parsedPacket.pathAttributes.find(
        attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI
    ).mpReach;
    assert.equal(mpReach.afi, AFI);
    assert.equal(mpReach.safi, SAFI);
    assert.equal(mpReach.nlri.length, 1);
    assert.equal(mpReach.nlri[0].routeType, routeType);
    assert.equal(mpReach.nlri[0].valid, true, (mpReach.nlri[0].errors || []).join('; '));
    return { parsedPacket, nlri: mpReach.nlri[0] };
}

class CaptureMessageHandler {
    constructor() {
        this.responses = [];
    }

    sendSuccessResponse(messageId, data = null, msg = '') {
        this.responses.push({ messageId, status: 'success', msg, data });
    }

    sendErrorResponse(messageId, msg = '', data = null) {
        this.responses.push({ messageId, status: 'error', msg, data });
    }

    sendEvent() {}
}

function makeWorker() {
    const BmpWorker = loadBmpWorkerClass(__dirname, module);
    const worker = Object.create(BmpWorker.prototype);
    worker.bmpSessionMap = new Map();
    worker.messageHandler = new CaptureMessageHandler();
    return worker;
}

function callWorker(worker, methodName, data) {
    const messageId = `${methodName}-${worker.messageHandler.responses.length + 1}`;
    worker[methodName](messageId, data);
    const response = worker.messageHandler.responses.find(item => item.messageId === messageId);
    assert.ok(response, `${methodName} did not send a response`);
    assert.equal(response.status, 'success', `${methodName} failed: ${response.msg}`);
    return response.data;
}

function makeClient() {
    return {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '127.0.0.2',
        remotePort: 50000
    };
}

function makeBmpSession(client) {
    const bmpSession = new BmpSession(
        { sendEvent() {} },
        { bmpConfigData: { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 } }
    );
    bmpSession.localIp = client.localIp;
    bmpSession.localPort = client.localPort;
    bmpSession.remoteIp = client.remoteIp;
    bmpSession.remotePort = client.remotePort;
    return bmpSession;
}

function makeBgpSession(bmpSession) {
    const bgpSession = new BmpBgpSession(bmpSession);
    bgpSession.sessionType = BmpConst.BMP_PEER_TYPE.GLOBAL;
    bgpSession.sessionFlags = 0;
    bgpSession.rawSessionFlags = 0;
    bgpSession.sessionRd = '0:0';
    bgpSession.sessionIp = '192.0.2.2';
    bgpSession.sessionAs = 65000;
    bgpSession.sessionRouterId = '192.0.2.2';
    bgpSession.sessionState = BmpConst.BMP_SESSION_STATE.PEER_UP;
    bgpSession.enabledAddressFamilies = [{ afi: AFI, safi: SAFI }];
    bgpSession.ribTypes = [RIB_TYPE];
    bgpSession.bgpRoutes.set(`${AFI}|${SAFI}`, new Map([[RIB_TYPE, new Map()]]));
    return bgpSession;
}

function makeLocRibInstance(bmpSession) {
    const instance = new BmpBgpInstance(bmpSession);
    instance.afi = AFI;
    instance.safi = SAFI;
    instance.instanceType = BmpConst.BMP_PEER_TYPE.LOCAL_RIB;
    instance.instanceFlags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED;
    instance.rawInstanceFlags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED;
    instance.instanceRd = '0:0';
    instance.instanceIp = '0.0.0.0';
    instance.instanceAs = 65000;
    instance.instanceRouterId = '192.0.2.1';
    instance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_UP;
    instance.enabledAddressFamilies = [{ afi: AFI, safi: SAFI }];
    instance.vrfTableNames = ['global'];
    return instance;
}

function addRouteToBgpSession(routeWriter, bgpSession, routeMap, parsedPacket, nlri) {
    const route = new BmpBgpRoute(bgpSession, null);
    routeWriter.setRouteNlri(route, nlri, AFI, SAFI);
    routeWriter.setRouteAttributes(route, parsedPacket);
    route.markActive(bgpSession.getRibEpoch(AFI, SAFI, RIB_TYPE));

    const routeKey = route.getRouteKey();
    assert.equal(routeMap.has(routeKey), false, `duplicate BGP session route key ${routeKey}`);
    routeMap.set(routeKey, route);
    bgpSession.recordRouteAdd(AFI, SAFI, RIB_TYPE, route);
    bgpSession.addRouteToPrefixIndex(AFI, SAFI, RIB_TYPE, routeKey, route);
    return route;
}

function addRouteToLocRib(routeWriter, instance, parsedPacket, nlri) {
    const route = new BmpBgpRoute(null, instance);
    routeWriter.setRouteNlri(route, nlri, AFI, SAFI);
    routeWriter.setRouteAttributes(route, parsedPacket);
    route.markActive(instance.getRibEpoch());

    const routeKey = route.getRouteKey();
    assert.equal(instance.bgpRoutes.has(routeKey), false, `duplicate Loc-RIB route key ${routeKey}`);
    instance.bgpRoutes.set(routeKey, route);
    instance.recordRouteAdd(route);
    instance.addRouteToPrefixIndex(routeKey, route);
    return route;
}

function populateEvpnRoutes(bgpSession, locRibInstance) {
    const routeWriter = new BmpSession({ sendEvent() {} }, { bmpConfigData: {} });
    const sessionRouteMap = bgpSession.bgpRoutes.get(`${AFI}|${SAFI}`).get(RIB_TYPE);
    const seenTypes = new Set();
    const samples = {};

    EVPN_ROUTE_TYPES.forEach(routeType => {
        for (let i = 0; i < ROUTES_PER_TYPE; i += 1) {
            const index = routeType * 10000 + i;
            const { parsedPacket, nlri } = parseEvpnRoute(routeType, index);
            seenTypes.add(nlri.routeType);

            const sessionRoute = addRouteToBgpSession(routeWriter, bgpSession, sessionRouteMap, parsedPacket, nlri);
            addRouteToLocRib(routeWriter, locRibInstance, parsedPacket, nlri);

            if (!samples[routeType]) {
                samples[routeType] = sessionRoute;
            }
        }
    });

    assert.deepEqual(
        [...seenTypes].sort((a, b) => a - b),
        EVPN_ROUTE_TYPES
    );
    return { sessionRouteMap, samples };
}

function assertPage(result, total, page, pageSize) {
    const expectedLength = Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize));
    assert.equal(result.total, total);
    assert.equal(result.list.length, expectedLength);
    assert.equal(result.summary.total, total);
    assert.equal(result.summary.active, total);
    assert.equal(result.summary.stale, 0);
}

function assertRouteTypesPresent(routes) {
    const routeTypes = new Set(routes.map(route => route.nlriDetail.routeType));
    assert.deepEqual(
        [...routeTypes].sort((a, b) => a - b),
        EVPN_ROUTE_TYPES
    );
}

function main() {
    const worker = makeWorker();
    const client = makeClient();
    const bmpSession = makeBmpSession(client);
    const bgpSession = makeBgpSession(bmpSession);
    const locRibInstance = makeLocRibInstance(bmpSession);

    bmpSession.bgpSessionMap.set(
        BmpBgpSession.makeKey(bgpSession.sessionType, bgpSession.sessionRd, bgpSession.sessionIp, bgpSession.sessionAs),
        bgpSession
    );
    bmpSession.bgpInstanceMap.set(
        BmpBgpInstance.makeKey(locRibInstance.instanceType, locRibInstance.instanceRd, AFI, SAFI),
        locRibInstance
    );
    worker.bmpSessionMap.set(
        BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort),
        bmpSession
    );

    const { sessionRouteMap, samples } = populateEvpnRoutes(bgpSession, locRibInstance);
    assert.equal(sessionRouteMap.size, ROUTE_COUNT);
    assert.equal(locRibInstance.bgpRoutes.size, ROUTE_COUNT);
    assertRouteTypesPresent([...sessionRouteMap.values()]);
    assertRouteTypesPresent([...locRibInstance.bgpRoutes.values()]);

    const sessions = callWorker(worker, 'getBgpSessions', client);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].routeSummary.total, ROUTE_COUNT);
    assert.ok(sessions[0].enabledAddrFamilyTypes.includes(AF));

    const instances = callWorker(worker, 'getBgpInstances', client);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].addrFamilyType, AF);
    assert.equal(instances[0].routeSummary.total, ROUTE_COUNT);

    const sessionQuery = {
        client,
        session: bgpSession.getSessionInfo(),
        af: AF,
        ribType: RIB_TYPE,
        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
    };
    const instanceQuery = {
        client,
        instance: locRibInstance.getInstanceInfo(),
        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
    };

    assertPage(
        callWorker(worker, 'getBgpRoutes', { ...sessionQuery, page: 1, pageSize: PAGE_SIZE }),
        ROUTE_COUNT,
        1,
        PAGE_SIZE
    );
    assertPage(
        callWorker(worker, 'getBgpRoutes', { ...sessionQuery, page: 2, pageSize: PAGE_SIZE }),
        ROUTE_COUNT,
        2,
        PAGE_SIZE
    );
    assertPage(
        callWorker(worker, 'getBgpRoutes', {
            ...sessionQuery,
            page: Math.ceil(ROUTE_COUNT / PAGE_SIZE),
            pageSize: PAGE_SIZE
        }),
        ROUTE_COUNT,
        Math.ceil(ROUTE_COUNT / PAGE_SIZE),
        PAGE_SIZE
    );

    assertPage(
        callWorker(worker, 'getBgpInstanceRoutes', { ...instanceQuery, page: 1, pageSize: PAGE_SIZE }),
        ROUTE_COUNT,
        1,
        PAGE_SIZE
    );
    assertPage(
        callWorker(worker, 'getBgpInstanceRoutes', {
            ...instanceQuery,
            page: Math.ceil(ROUTE_COUNT / PAGE_SIZE),
            pageSize: PAGE_SIZE
        }),
        ROUTE_COUNT,
        Math.ceil(ROUTE_COUNT / PAGE_SIZE),
        PAGE_SIZE
    );

    const macIpRoute = samples[2];
    const macIpByPrefix = callWorker(worker, 'getBgpRoutes', {
        ...sessionQuery,
        page: 1,
        pageSize: PAGE_SIZE,
        prefixFilter: macIpRoute.nlriDetail.ipAddress
    });
    assert.equal(macIpByPrefix.total, 1);
    assert.equal(macIpByPrefix.list[0].routeKey, macIpRoute.getRouteKey());

    const ipPrefixRoute = samples[5];
    const ipPrefixByCidr = callWorker(worker, 'getBgpInstanceRoutes', {
        ...instanceQuery,
        page: 1,
        pageSize: PAGE_SIZE,
        prefixFilter: `${ipPrefixRoute.nlriDetail.ipPrefix}/${ipPrefixRoute.nlriDetail.prefixLength}`
    });
    assert.equal(ipPrefixByCidr.total, 1);
    assert.equal(ipPrefixByCidr.list[0].routeKey, ipPrefixRoute.getRouteKey());

    const macIpScan = callWorker(worker, 'getBgpRoutes', {
        ...sessionQuery,
        page: 1,
        pageSize: PAGE_SIZE,
        prefixFilter: 'evpn:mac-ip'
    });
    assert.equal(macIpScan.total, ROUTES_PER_TYPE);
    assert.equal(macIpScan.list.length, Math.min(PAGE_SIZE, ROUTES_PER_TYPE));
    assert.ok(macIpScan.list.every(route => route.ip.includes('evpn:mac-ip')));

    const sessionDetail = callWorker(worker, 'getBgpRouteDetail', {
        ...sessionQuery,
        routeKey: samples[11].getRouteKey()
    });
    assert.equal(sessionDetail.routeType, 11);
    assert.equal(sessionDetail.nlriDetail.routeTypeName, 'Leaf A-D');
    assert.equal(Object.prototype.hasOwnProperty.call(sessionDetail, 'summary'), false);

    const locRibDetail = callWorker(worker, 'getBgpInstanceRouteDetail', {
        ...instanceQuery,
        routeKey: samples[6].getRouteKey()
    });
    assert.equal(locRibDetail.routeType, 6);
    assert.equal(locRibDetail.nlriDetail.routeTypeName, 'Selective Multicast Ethernet Tag');
    assert.equal(locRibDetail.nlriDetail.groupAddress.startsWith('239.'), true);

    console.log(
        `EVPN BGP route reporting passed: routeTypes=${EVPN_ROUTE_TYPES.join(',')}, sessionRoutes=${ROUTE_COUNT}, locRibRoutes=${ROUTE_COUNT}, pageSize=${PAGE_SIZE}`
    );
}

main();
