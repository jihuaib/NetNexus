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

const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
const PAGE_SIZE = 29;

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

function updatePacket(attrs) {
    const attrBuffer = Buffer.concat(attrs);
    const body = Buffer.concat([u16(0), u16(attrBuffer.length), attrBuffer]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, body);
}

function mpReachUpdate(afi, safi, nextHop, nlri) {
    const value = Buffer.concat([u16(afi), Buffer.from([safi, nextHop.length]), nextHop, Buffer.from([0]), nlri]);
    return updatePacket([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, value, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL)
    ]);
}

function flowSpecLength(length) {
    if (length < 240) {
        return Buffer.from([length]);
    }
    return Buffer.from([0xf0 | ((length >> 8) & 0x0f), length & 0xff]);
}

function prefixComponent(type, prefix, prefixLength, afi) {
    if (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) {
        const carriedBytes = Math.ceil(prefixLength / 8);
        return Buffer.concat([Buffer.from([type, prefixLength, 0]), prefix.subarray(0, carriedBytes)]);
    }
    return Buffer.concat([Buffer.from([type, prefixLength]), ipBytes(prefix).subarray(0, Math.ceil(prefixLength / 8))]);
}

function op1Component(type, operator, value) {
    return Buffer.from([type, operator, value & 0xff]);
}

function op2Component(type, operator, value) {
    return Buffer.concat([Buffer.from([type, operator]), u16(value)]);
}

function op4Component(type, operator, value) {
    return Buffer.concat([Buffer.from([type, operator]), u32(value)]);
}

function flowSpecNlri(components) {
    const body = Buffer.concat(components);
    return Buffer.concat([flowSpecLength(body.length), body]);
}

function ipv6PrefixBytes(groupA, groupB = 0, groupC = 0, groupD = 0) {
    return Buffer.from([
        0x20,
        0x01,
        0x0d,
        0xb8,
        (groupA >> 8) & 0xff,
        groupA & 0xff,
        (groupB >> 8) & 0xff,
        groupB & 0xff,
        (groupC >> 8) & 0xff,
        groupC & 0xff,
        (groupD >> 8) & 0xff,
        groupD & 0xff,
        0,
        0,
        0,
        0
    ]);
}

function buildIpv4FlowSpecNlri(variant, routeIndex) {
    if (variant.name === 'ipv4-dst-fragment') {
        return flowSpecNlri([
            prefixComponent(1, `10.0.${routeIndex}.1`, 32, BgpConst.BGP_AFI_TYPE.AFI_IPV4),
            op1Component(12, 0x80, 1 + (routeIndex % 7))
        ]);
    }

    if (variant.name === 'ipv4-src-proto') {
        return flowSpecNlri([
            prefixComponent(1, `10.1.${routeIndex}.0`, 24, BgpConst.BGP_AFI_TYPE.AFI_IPV4),
            prefixComponent(2, `198.51.${routeIndex}.0`, 24, BgpConst.BGP_AFI_TYPE.AFI_IPV4),
            op1Component(3, 0x81, routeIndex % 2 === 0 ? 6 : 17)
        ]);
    }

    return flowSpecNlri([
        prefixComponent(1, `10.2.0.${routeIndex + 1}`, 32, BgpConst.BGP_AFI_TYPE.AFI_IPV4),
        op2Component(5, 0x91, 4000 + routeIndex),
        op2Component(10, 0x92, 1000 + routeIndex)
    ]);
}

function buildIpv6FlowSpecNlri(variant, routeIndex) {
    if (variant.name === 'ipv6-dst-src-proto') {
        return flowSpecNlri([
            prefixComponent(1, ipv6PrefixBytes(routeIndex), 48, BgpConst.BGP_AFI_TYPE.AFI_IPV6),
            prefixComponent(2, ipv6PrefixBytes(0x0100, routeIndex), 64, BgpConst.BGP_AFI_TYPE.AFI_IPV6),
            op1Component(3, 0x81, routeIndex % 2 === 0 ? 6 : 17)
        ]);
    }

    return flowSpecNlri([
        prefixComponent(1, ipv6PrefixBytes(0x0200, routeIndex), 64, BgpConst.BGP_AFI_TYPE.AFI_IPV6),
        op4Component(13, 0xa1, 0x10000 + routeIndex)
    ]);
}

function tlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}

function rdFromIndex(index) {
    return Buffer.concat([u16(BgpConst.RD_TYPE.AS2), u16(65000), u32(index + 1)]);
}

function bgpLsNlri(type, body) {
    return Buffer.concat([u16(type), u16(body.length), body]);
}

function bgpLsBody(protocolId, identifier, tlvs) {
    return Buffer.concat([Buffer.from([protocolId]), u32(0), u32(identifier), ...tlvs]);
}

function nodeDescriptor(routeIndex, remote = false) {
    const routerBase = remote ? 100 : 0;
    return tlv(
        remote ? 257 : 256,
        Buffer.concat([
            tlv(512, u32(65000 + routerBase + routeIndex)),
            tlv(515, ipBytes(`10.${remote ? 200 : 100}.${Math.floor(routeIndex / 250)}.${1 + (routeIndex % 250)}`))
        ])
    );
}

function ipReachability(prefixLength, prefixBytesValue) {
    return tlv(265, Buffer.concat([Buffer.from([prefixLength]), prefixBytesValue.subarray(0, Math.ceil(prefixLength / 8))]));
}

function buildBgpLsNlri(variant, routeIndex, vpn = false) {
    const identifier = variant.type * 10000 + routeIndex + 1;
    let body;

    if (variant.name.endsWith('node')) {
        body = bgpLsBody(variant.type === 4 ? 6 : 3, identifier, [nodeDescriptor(routeIndex)]);
    } else if (variant.name.endsWith('link')) {
        body = bgpLsBody(3, identifier, [
            nodeDescriptor(routeIndex),
            nodeDescriptor(routeIndex, true),
            tlv(259, ipBytes(`10.10.${routeIndex}.1`)),
            tlv(260, ipBytes(`10.10.${routeIndex}.2`))
        ]);
    } else if (variant.name.endsWith('ipv4-prefix')) {
        body = bgpLsBody(3, identifier, [
            nodeDescriptor(routeIndex),
            ipReachability(24, ipBytes(`172.16.${routeIndex}.0`))
        ]);
    } else {
        body = bgpLsBody(6, identifier, [
            nodeDescriptor(routeIndex),
            ipReachability(64, ipv6PrefixBytes(0x0300, routeIndex))
        ]);
    }

    return bgpLsNlri(variant.type, vpn ? Buffer.concat([rdFromIndex(identifier), body]) : body);
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
    const bmpSession = new BmpSession({ sendEvent() {} }, { bmpConfigData: { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 } });
    bmpSession.localIp = client.localIp;
    bmpSession.localPort = client.localPort;
    bmpSession.remoteIp = client.remoteIp;
    bmpSession.remotePort = client.remotePort;
    return bmpSession;
}

function makeBgpSession(bmpSession, scenario) {
    const bgpSession = new BmpBgpSession(bmpSession);
    bgpSession.sessionType = BmpConst.BMP_PEER_TYPE.GLOBAL;
    bgpSession.sessionFlags = 0;
    bgpSession.rawSessionFlags = 0;
    bgpSession.sessionRd = '0:0';
    bgpSession.sessionIp = '192.0.2.2';
    bgpSession.sessionAs = 65000;
    bgpSession.sessionRouterId = '192.0.2.2';
    bgpSession.sessionState = BmpConst.BMP_SESSION_STATE.PEER_UP;
    bgpSession.enabledAddressFamilies = [{ afi: scenario.afi, safi: scenario.safi }];
    bgpSession.ribTypes = [RIB_TYPE];
    bgpSession.bgpRoutes.set(`${scenario.afi}|${scenario.safi}`, new Map([[RIB_TYPE, new Map()]]));
    return bgpSession;
}

function makeLocRibInstance(bmpSession, scenario) {
    const instance = new BmpBgpInstance(bmpSession);
    instance.afi = scenario.afi;
    instance.safi = scenario.safi;
    instance.instanceType = BmpConst.BMP_PEER_TYPE.LOCAL_RIB;
    instance.instanceFlags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED;
    instance.rawInstanceFlags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED;
    instance.instanceRd = '0:0';
    instance.instanceIp = '0.0.0.0';
    instance.instanceAs = 65000;
    instance.instanceRouterId = '192.0.2.1';
    instance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_UP;
    instance.enabledAddressFamilies = [{ afi: scenario.afi, safi: scenario.safi }];
    instance.vrfTableNames = ['global'];
    return instance;
}

function parseScenarioRoute(scenario, variant, routeIndex) {
    const parsedPacket = parseBgpPacket(scenario.buildUpdate(variant, routeIndex));
    assert.equal(parsedPacket.valid, true, parsedPacket.error || `${scenario.name} ${variant.name} should parse`);
    const attr = parsedPacket.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI);
    assert.ok(attr, 'MP_REACH_NLRI attribute must exist');
    assert.equal(attr.mpReach.afi, scenario.afi);
    assert.equal(attr.mpReach.safi, scenario.safi);
    assert.equal(attr.mpReach.nlri.length, 1);
    assert.equal(attr.mpReach.nlri[0].valid, true, (attr.mpReach.nlri[0].errors || []).join('; '));
    scenario.validateNlri(variant, attr.mpReach.nlri[0]);
    return { parsedPacket, nlri: attr.mpReach.nlri[0] };
}

function addRouteToBgpSession(routeWriter, scenario, bgpSession, routeMap, parsedPacket, nlri) {
    const route = new BmpBgpRoute(bgpSession, null);
    routeWriter.setRouteNlri(route, nlri, scenario.afi, scenario.safi);
    routeWriter.setRouteAttributes(route, parsedPacket);
    route.markActive(bgpSession.getRibEpoch(scenario.afi, scenario.safi, RIB_TYPE));

    const routeKey = route.getRouteKey();
    assert.equal(routeMap.has(routeKey), false, `duplicate BGP session route key ${routeKey}`);
    routeMap.set(routeKey, route);
    bgpSession.recordRouteAdd(scenario.afi, scenario.safi, RIB_TYPE, route);
    bgpSession.addRouteToPrefixIndex(scenario.afi, scenario.safi, RIB_TYPE, routeKey, route);
    return route;
}

function addRouteToLocRib(routeWriter, scenario, instance, parsedPacket, nlri) {
    const route = new BmpBgpRoute(null, instance);
    routeWriter.setRouteNlri(route, nlri, scenario.afi, scenario.safi);
    routeWriter.setRouteAttributes(route, parsedPacket);
    route.markActive(instance.getRibEpoch());

    const routeKey = route.getRouteKey();
    assert.equal(instance.bgpRoutes.has(routeKey), false, `duplicate Loc-RIB route key ${routeKey}`);
    instance.bgpRoutes.set(routeKey, route);
    instance.recordRouteAdd(route);
    instance.addRouteToPrefixIndex(routeKey, route);
    return route;
}

function populateScenarioRoutes(scenario, bgpSession, locRibInstance) {
    const routeWriter = new BmpSession({ sendEvent() {} }, { bmpConfigData: {} });
    const sessionRouteMap = bgpSession.bgpRoutes.get(`${scenario.afi}|${scenario.safi}`).get(RIB_TYPE);
    const samples = {};

    scenario.variants.forEach(variant => {
        for (let i = 0; i < scenario.routesPerVariant; i += 1) {
            const { parsedPacket, nlri } = parseScenarioRoute(scenario, variant, i);
            const sessionRoute = addRouteToBgpSession(routeWriter, scenario, bgpSession, sessionRouteMap, parsedPacket, nlri);
            addRouteToLocRib(routeWriter, scenario, locRibInstance, parsedPacket, nlri);
            if (!samples[variant.name]) {
                samples[variant.name] = sessionRoute;
            }
        }
    });

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

function runScenario(scenario) {
    const worker = makeWorker();
    const client = makeClient();
    const bmpSession = makeBmpSession(client);
    const bgpSession = makeBgpSession(bmpSession, scenario);
    const locRibInstance = makeLocRibInstance(bmpSession, scenario);
    const total = scenario.variants.length * scenario.routesPerVariant;

    bmpSession.bgpSessionMap.set(
        BmpBgpSession.makeKey(bgpSession.sessionType, bgpSession.sessionRd, bgpSession.sessionIp, bgpSession.sessionAs),
        bgpSession
    );
    bmpSession.bgpInstanceMap.set(
        BmpBgpInstance.makeKey(locRibInstance.instanceType, locRibInstance.instanceRd, scenario.afi, scenario.safi),
        locRibInstance
    );
    worker.bmpSessionMap.set(BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort), bmpSession);

    const { sessionRouteMap, samples } = populateScenarioRoutes(scenario, bgpSession, locRibInstance);
    assert.equal(sessionRouteMap.size, total);
    assert.equal(locRibInstance.bgpRoutes.size, total);
    scenario.assertRoutes([...sessionRouteMap.values()]);
    scenario.assertRoutes([...locRibInstance.bgpRoutes.values()]);

    const sessions = callWorker(worker, 'getBgpSessions', client);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].routeSummary.total, total);
    assert.ok(sessions[0].enabledAddrFamilyTypes.includes(scenario.af));

    const instances = callWorker(worker, 'getBgpInstances', client);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].addrFamilyType, scenario.af);
    assert.equal(instances[0].routeSummary.total, total);

    const sessionQuery = {
        client,
        session: bgpSession.getSessionInfo(),
        af: scenario.af,
        ribType: RIB_TYPE,
        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
    };
    const instanceQuery = {
        client,
        instance: locRibInstance.getInstanceInfo(),
        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
    };
    const lastPage = Math.ceil(total / PAGE_SIZE);

    assertPage(callWorker(worker, 'getBgpRoutes', { ...sessionQuery, page: 1, pageSize: PAGE_SIZE }), total, 1, PAGE_SIZE);
    assertPage(callWorker(worker, 'getBgpRoutes', { ...sessionQuery, page: 2, pageSize: PAGE_SIZE }), total, 2, PAGE_SIZE);
    assertPage(callWorker(worker, 'getBgpRoutes', { ...sessionQuery, page: lastPage, pageSize: PAGE_SIZE }), total, lastPage, PAGE_SIZE);
    assertPage(callWorker(worker, 'getBgpInstanceRoutes', { ...instanceQuery, page: 1, pageSize: PAGE_SIZE }), total, 1, PAGE_SIZE);
    assertPage(
        callWorker(worker, 'getBgpInstanceRoutes', { ...instanceQuery, page: lastPage, pageSize: PAGE_SIZE }),
        total,
        lastPage,
        PAGE_SIZE
    );

    const exactRoute = samples[scenario.exactVariant];
    const exactResult = callWorker(worker, 'getBgpRoutes', {
        ...sessionQuery,
        page: 1,
        pageSize: PAGE_SIZE,
        prefixFilter: exactRoute.ip
    });
    assert.equal(exactResult.total, 1);
    assert.equal(exactResult.list[0].routeKey, exactRoute.getRouteKey());

    const scanResult = callWorker(worker, 'getBgpRoutes', {
        ...sessionQuery,
        page: 1,
        pageSize: PAGE_SIZE,
        prefixFilter: scenario.scanFilter
    });
    assert.equal(scanResult.total, scenario.scanExpectedTotal);
    assert.equal(scanResult.list.length, Math.min(PAGE_SIZE, scenario.scanExpectedTotal));
    assert.ok(scanResult.list.every(scenario.scanPredicate));

    const sessionDetail = callWorker(worker, 'getBgpRouteDetail', {
        ...sessionQuery,
        routeKey: samples[scenario.detailVariant].getRouteKey(),
        includeSummary: true
    });
    const locRibDetail = callWorker(worker, 'getBgpInstanceRouteDetail', {
        ...instanceQuery,
        routeKey: samples[scenario.locRibDetailVariant].getRouteKey()
    });
    scenario.assertDetail(sessionDetail, locRibDetail);

    return total;
}

const ipv4FlowSpecScenario = {
    name: 'IPv4 FlowSpec',
    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    safi: BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
    af: BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC,
    routesPerVariant: 40,
    variants: [{ name: 'ipv4-dst-fragment' }, { name: 'ipv4-src-proto' }, { name: 'ipv4-port-length' }],
    buildUpdate: (variant, routeIndex) =>
        mpReachUpdate(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC, Buffer.alloc(0), buildIpv4FlowSpecNlri(variant, routeIndex)),
    validateNlri: (variant, nlri) => {
        assert.ok(nlri.components.length >= 2);
        if (variant.name === 'ipv4-dst-fragment') {
            assert.ok(nlri.prefix.includes('fragment any'));
        }
    },
    assertRoutes: routes => {
        assert.ok(routes.every(route => route.getAddrFamilyType() === BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC));
        assert.ok(routes.some(route => route.ip.includes('dst-port =')));
        assert.ok(routes.some(route => route.ip.includes('src=')));
    },
    exactVariant: 'ipv4-port-length',
    scanFilter: 'fragment any',
    scanExpectedTotal: 40,
    scanPredicate: route => route.ip.includes('fragment any'),
    detailVariant: 'ipv4-src-proto',
    locRibDetailVariant: 'ipv4-dst-fragment',
    assertDetail: (sessionDetail, locRibDetail) => {
        assert.equal(sessionDetail.addrFamilyType, BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC);
        assert.ok(sessionDetail.nlriDetail.components.some(component => component.name === 'src'));
        assert.ok(sessionDetail.summary.includes('IPv4/FlowSpec'));
        assert.equal(locRibDetail.addrFamilyType, BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC);
        assert.ok(locRibDetail.ip.includes('fragment any'));
    }
};

const ipv6FlowSpecScenario = {
    name: 'IPv6 FlowSpec',
    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
    safi: BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
    af: BgpConst.BGP_ADDR_FAMILY.IPV6_FLOWSPEC,
    routesPerVariant: 36,
    variants: [{ name: 'ipv6-dst-src-proto' }, { name: 'ipv6-dst-flow-label' }],
    buildUpdate: (variant, routeIndex) =>
        mpReachUpdate(BgpConst.BGP_AFI_TYPE.AFI_IPV6, BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC, Buffer.alloc(0), buildIpv6FlowSpecNlri(variant, routeIndex)),
    validateNlri: (variant, nlri) => {
        assert.ok(nlri.components.length >= 2);
        if (variant.name === 'ipv6-dst-flow-label') {
            assert.ok(nlri.prefix.includes('flow-label ='));
        }
    },
    assertRoutes: routes => {
        assert.ok(routes.every(route => route.getAddrFamilyType() === BgpConst.BGP_ADDR_FAMILY.IPV6_FLOWSPEC));
        assert.ok(routes.some(route => route.ip.includes('flow-label =')));
        assert.ok(routes.some(route => route.ip.includes('src=2001:db8:100:')));
    },
    exactVariant: 'ipv6-dst-flow-label',
    scanFilter: 'flow-label =',
    scanExpectedTotal: 36,
    scanPredicate: route => route.ip.includes('flow-label ='),
    detailVariant: 'ipv6-dst-src-proto',
    locRibDetailVariant: 'ipv6-dst-flow-label',
    assertDetail: (sessionDetail, locRibDetail) => {
        assert.equal(sessionDetail.addrFamilyType, BgpConst.BGP_ADDR_FAMILY.IPV6_FLOWSPEC);
        assert.ok(sessionDetail.nlriDetail.components.some(component => component.name === 'src'));
        assert.ok(sessionDetail.summary.includes('IPv6/FlowSpec'));
        assert.equal(locRibDetail.addrFamilyType, BgpConst.BGP_ADDR_FAMILY.IPV6_FLOWSPEC);
        assert.ok(locRibDetail.ip.includes('flow-label ='));
    }
};

function makeBgpLsScenario(name, safi, af, namespace, vpn = false) {
    return {
        name,
        afi: BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
        safi,
        af,
        routesPerVariant: 25,
        variants: [
            { name: `${namespace}-node`, type: 1 },
            { name: `${namespace}-link`, type: 2 },
            { name: `${namespace}-ipv4-prefix`, type: 3 },
            { name: `${namespace}-ipv6-prefix`, type: 4 }
        ],
        buildUpdate: (variant, routeIndex) =>
            mpReachUpdate(BgpConst.BGP_AFI_TYPE.AFI_BGP_LS, safi, Buffer.alloc(0), buildBgpLsNlri(variant, routeIndex, vpn)),
        validateNlri: (variant, nlri) => {
            assert.equal(nlri.routeType, variant.type);
            assert.equal(nlri.vpn === true, vpn);
            if (vpn) {
                assert.ok(nlri.rd);
            }
        },
        assertRoutes: routes => {
            const routeTypes = new Set(routes.map(route => route.routeType));
            assert.deepEqual([...routeTypes].sort((a, b) => a - b), [1, 2, 3, 4]);
            assert.ok(routes.every(route => route.getAddrFamilyType() === af));
            assert.ok(routes.some(route => route.ip.includes(':Link:')));
            assert.ok(routes.some(route => route.ip.includes(':IPv6 Prefix:')));
        },
        exactVariant: `${namespace}-node`,
        scanFilter: `${namespace}:Link:`,
        scanExpectedTotal: 25,
        scanPredicate: route => route.ip.includes(`${namespace}:Link:`),
        detailVariant: `${namespace}-ipv4-prefix`,
        locRibDetailVariant: `${namespace}-ipv6-prefix`,
        assertDetail: (sessionDetail, locRibDetail) => {
            assert.equal(sessionDetail.addrFamilyType, af);
            assert.equal(sessionDetail.routeType, 3);
            assert.ok(sessionDetail.ip.includes(`${namespace}:IPv4 Prefix:`));
            assert.ok(sessionDetail.summary.includes(safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS ? 'BGP-LS/BGP-LS' : 'BGP-LS/BGP-LS-VPN'));
            assert.equal(locRibDetail.addrFamilyType, af);
            assert.equal(locRibDetail.routeType, 4);
            assert.ok(locRibDetail.ip.includes(`${namespace}:IPv6 Prefix:`));
            if (vpn) {
                assert.ok(sessionDetail.rd);
                assert.ok(locRibDetail.rd);
            }
        }
    };
}

const scenarios = [
    ipv4FlowSpecScenario,
    ipv6FlowSpecScenario,
    makeBgpLsScenario(
        'BGP-LS',
        BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS,
        BgpConst.BGP_ADDR_FAMILY.LINK_STATE,
        'bgp-ls',
        false
    ),
    makeBgpLsScenario(
        'BGP-LS VPN',
        BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN,
        BgpConst.BGP_ADDR_FAMILY.LINK_STATE_VPN,
        'bgp-ls-vpn',
        true
    )
];

const totals = scenarios.map(runScenario);

console.log(
    `FlowSpec/BGP-LS route reporting passed: ipv4FlowSpec=${totals[0]}, ipv6FlowSpec=${totals[1]}, bgpLs=${totals[2]}, bgpLsVpn=${totals[3]}, pageSize=${PAGE_SIZE}`
);
