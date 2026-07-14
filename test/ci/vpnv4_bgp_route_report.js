const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');

const AFI = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
const SAFI = BgpConst.BGP_SAFI_TYPE.SAFI_VPN;
const AF = BgpConst.BGP_ADDR_FAMILY.VPNV4;
const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
const ROUTES_PER_VARIANT = 48;
const PAGE_SIZE = 41;
const VPNV4_VARIANTS = [
    { name: 'as2-rd-24-single-label', rdType: 'as2', prefixLength: 24, labelCount: 1 },
    { name: 'ip-rd-32-single-label', rdType: 'ip', prefixLength: 32, labelCount: 1 },
    { name: 'as4-rd-16-two-label', rdType: 'as4', prefixLength: 16, labelCount: 2 },
    { name: 'as2-rd-25-two-label', rdType: 'as2', prefixLength: 25, labelCount: 2 },
    { name: 'ip-rd-30-single-label', rdType: 'ip', prefixLength: 30, labelCount: 1 }
];
const ROUTE_COUNT = VPNV4_VARIANTS.length * ROUTES_PER_VARIANT;

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

function labelEntry(label, bottom = true) {
    const entry = (label << 4) | (bottom ? 1 : 0);
    return Buffer.from([(entry >> 16) & 0xff, (entry >> 8) & 0xff, entry & 0xff]);
}

function rdAs2(index) {
    return Buffer.concat([u16(BgpConst.RD_TYPE.AS2), u16(65000), u32(index + 1)]);
}

function rdIp(index) {
    return Buffer.concat([u16(BgpConst.RD_TYPE.IP), ipBytes(`192.0.2.${1 + (index % 250)}`), u16(1000 + index)]);
}

function rdAs4(index) {
    return Buffer.concat([u16(BgpConst.RD_TYPE.AS4), u32(655360 + index), u16(2000 + index)]);
}

function rdForVariant(variant, index) {
    if (variant.rdType === 'ip') {
        return rdIp(index);
    }
    if (variant.rdType === 'as4') {
        return rdAs4(index);
    }
    return rdAs2(index);
}

function prefixForVariant(variantIndex, routeIndex, prefixLength) {
    switch (prefixLength) {
        case 16:
            return `10.${30 + routeIndex}.0.0`;
        case 24:
            return `10.${variantIndex}.${routeIndex}.0`;
        case 25:
            return `10.${variantIndex}.${routeIndex}.128`;
        case 30:
            return `10.${variantIndex}.${routeIndex}.${(routeIndex % 64) * 4}`;
        case 32:
            return `10.${variantIndex}.${(routeIndex >> 8) & 0xff}.${routeIndex & 0xff}`;
        default:
            throw new Error(`unsupported prefix length: ${prefixLength}`);
    }
}

function prefixBytes(prefix, prefixLength) {
    return ipBytes(prefix).subarray(0, Math.ceil(prefixLength / 8));
}

function vpnv4Nlri(variant, variantIndex, routeIndex) {
    const index = variantIndex * 1000 + routeIndex;
    const labels =
        variant.labelCount === 2
            ? Buffer.concat([labelEntry(3000 + index, false), labelEntry(4000 + index, true)])
            : labelEntry(2000 + index, true);
    const rd = rdForVariant(variant, index);
    const prefix = prefixForVariant(variantIndex, routeIndex, variant.prefixLength);
    const nlriBitLength = labels.length * 8 + BgpConst.BGP_RD_LEN * 8 + variant.prefixLength;

    return {
        rd,
        prefix,
        nlri: Buffer.concat([Buffer.from([nlriBitLength]), labels, rd, prefixBytes(prefix, variant.prefixLength)])
    };
}

function vpnv4Update(variant, variantIndex, routeIndex) {
    const { rd, nlri } = vpnv4Nlri(variant, variantIndex, routeIndex);
    const nextHop = Buffer.concat([rd, ipBytes('192.0.2.254')]);
    const mpReachValue = Buffer.concat([
        u16(AFI),
        Buffer.from([SAFI, nextHop.length]),
        nextHop,
        Buffer.from([0]),
        nlri
    ]);
    const attrs = Buffer.concat([
        pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL)
    ]);
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrs.length), attrs]));
}

function parseVpnv4Route(variant, variantIndex, routeIndex) {
    const parsedPacket = parseBgpPacket(vpnv4Update(variant, variantIndex, routeIndex));
    assert.equal(parsedPacket.valid, true, parsedPacket.error || `VPNv4 variant ${variant.name} should parse`);
    const mpReach = parsedPacket.pathAttributes.find(
        attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI
    ).mpReach;
    assert.equal(mpReach.afi, AFI);
    assert.equal(mpReach.safi, SAFI);
    assert.equal(mpReach.nextHop, '192.0.2.254');
    assert.equal(mpReach.nlri.length, 1);
    assert.equal(mpReach.nlri[0].valid, true, (mpReach.nlri[0].errors || []).join('; '));
    assert.equal(mpReach.nlri[0].length, variant.prefixLength);
    assert.equal(mpReach.nlri[0].labels.length, variant.labelCount);
    assert.equal(mpReach.nlri[0].labels[mpReach.nlri[0].labels.length - 1].bottom, true);
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

async function makeWorker() {
    const BmpWorker = loadBmpWorkerClass(__dirname, module);
    const worker = Object.create(BmpWorker.prototype);
    worker.bmpSessionMap = new Map();
    worker.messageHandler = new CaptureMessageHandler();
    worker.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-vpnv4-report-'));
    const dbPath = path.join(worker.tempDir, 'bmp.sqlite3');
    worker.persistence = new BmpPersistenceClient({ dbPath, batchSize: 256, flushMs: 1 });
    await worker.persistence.open();
    worker.persistenceReader = new BmpPersistenceClient({ dbPath, readOnly: true });
    await worker.persistenceReader.open();
    return worker;
}

async function closeWorker(worker) {
    await worker.persistence?.drain();
    await worker.persistenceReader?.close();
    await worker.persistence?.close();
    fs.rmSync(worker.tempDir, { recursive: true, force: true });
}

async function callWorker(worker, methodName, data) {
    const messageId = `${methodName}-${worker.messageHandler.responses.length + 1}`;
    await worker[methodName](messageId, data);
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

function makeBmpSession(client, worker) {
    worker.bmpConfigData = { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 };
    const bmpSession = new BmpSession({ sendEvent() {} }, worker);
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
    bgpSession.ensureRouteScope(AFI, SAFI, RIB_TYPE);
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

function addRouteToBgpSession(routeWriter, bgpSession, parsedPacket, nlri) {
    const route = new BmpBgpRoute(bgpSession, null);
    routeWriter.setRouteNlri(route, nlri, AFI, SAFI);
    routeWriter.setRouteAttributes(route, parsedPacket);
    route.markActive(bgpSession.getRibEpoch(AFI, SAFI, RIB_TYPE));
    assert.equal(routeWriter.persistSessionRouteUpsert(bgpSession, route, AFI, SAFI, RIB_TYPE), true);
    return route;
}

function addRouteToLocRib(routeWriter, instance, parsedPacket, nlri) {
    const route = new BmpBgpRoute(null, instance);
    routeWriter.setRouteNlri(route, nlri, AFI, SAFI);
    routeWriter.setRouteAttributes(route, parsedPacket);
    route.markActive(instance.getRibEpoch());
    assert.equal(routeWriter.persistInstanceRouteUpsert(instance, route, AFI, SAFI), true);
    return route;
}

function populateVpnv4Routes(routeWriter, bgpSession, locRibInstance) {
    const sessionRoutes = [];
    const locRibRoutes = [];
    const samples = {};

    VPNV4_VARIANTS.forEach((variant, variantIndex) => {
        for (let i = 0; i < ROUTES_PER_VARIANT; i += 1) {
            const { parsedPacket, nlri } = parseVpnv4Route(variant, variantIndex, i);
            const sessionRoute = addRouteToBgpSession(routeWriter, bgpSession, parsedPacket, nlri);
            sessionRoutes.push(sessionRoute);
            locRibRoutes.push(addRouteToLocRib(routeWriter, locRibInstance, parsedPacket, nlri));

            if (!samples[variant.name]) {
                samples[variant.name] = sessionRoute;
            }
        }
    });

    return { sessionRoutes, locRibRoutes, samples };
}

function assertPage(result, total, page, pageSize) {
    const expectedLength = Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize));
    assert.equal(result.total, total);
    assert.equal(result.list.length, expectedLength);
    assert.equal(result.summary.total, total);
    assert.equal(result.summary.active, total);
    assert.equal(result.summary.stale, 0);
}

function assertVariantsPresent(routes) {
    const rdKinds = new Set();
    const prefixLengths = new Set();
    const labelCounts = new Set();

    routes.forEach(route => {
        prefixLengths.add(route.mask);
        labelCounts.add(route.nlriDetail.labels.length);
        if (route.rd.startsWith('192.0.2.')) {
            rdKinds.add('ip');
        } else if (Number(route.rd.split(':')[0]) > 0xffff) {
            rdKinds.add('as4');
        } else {
            rdKinds.add('as2');
        }
    });

    assert.deepEqual([...rdKinds].sort(), ['as2', 'as4', 'ip']);
    assert.deepEqual(
        [...prefixLengths].sort((a, b) => a - b),
        [16, 24, 25, 30, 32]
    );
    assert.deepEqual(
        [...labelCounts].sort((a, b) => a - b),
        [1, 2]
    );
}

async function run(worker) {
    const client = makeClient();
    const bmpSession = makeBmpSession(client, worker);
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

    const { sessionRoutes, locRibRoutes, samples } = populateVpnv4Routes(bmpSession, bgpSession, locRibInstance);
    assert.equal(sessionRoutes.length, ROUTE_COUNT);
    assert.equal(locRibRoutes.length, ROUTE_COUNT);
    assertVariantsPresent(sessionRoutes);
    assertVariantsPresent(locRibRoutes);
    await worker.persistence.drain();

    const sessions = await callWorker(worker, 'getBgpSessions', client);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].routeSummary.total, ROUTE_COUNT);
    assert.ok(sessions[0].enabledAddrFamilyTypes.includes(AF));

    const instances = await callWorker(worker, 'getBgpInstances', client);
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
    const lastPage = Math.ceil(ROUTE_COUNT / PAGE_SIZE);

    assertPage(
        await callWorker(worker, 'getBgpRoutes', { ...sessionQuery, page: 1, pageSize: PAGE_SIZE }),
        ROUTE_COUNT,
        1,
        PAGE_SIZE
    );
    assertPage(
        await callWorker(worker, 'getBgpRoutes', { ...sessionQuery, page: 2, pageSize: PAGE_SIZE }),
        ROUTE_COUNT,
        2,
        PAGE_SIZE
    );
    assertPage(
        await callWorker(worker, 'getBgpRoutes', { ...sessionQuery, page: lastPage, pageSize: PAGE_SIZE }),
        ROUTE_COUNT,
        lastPage,
        PAGE_SIZE
    );
    assertPage(
        await callWorker(worker, 'getBgpInstanceRoutes', { ...instanceQuery, page: 1, pageSize: PAGE_SIZE }),
        ROUTE_COUNT,
        1,
        PAGE_SIZE
    );
    assertPage(
        await callWorker(worker, 'getBgpInstanceRoutes', { ...instanceQuery, page: lastPage, pageSize: PAGE_SIZE }),
        ROUTE_COUNT,
        lastPage,
        PAGE_SIZE
    );

    const exactRoute = samples['ip-rd-32-single-label'];
    const exactByPrefix = await callWorker(worker, 'getBgpRoutes', {
        ...sessionQuery,
        page: 1,
        pageSize: PAGE_SIZE,
        prefixFilter: exactRoute.ip
    });
    assert.equal(exactByPrefix.total, 1);
    assert.equal(exactByPrefix.list[0].routeKey, exactRoute.getRouteKey());

    const cidrRoute = samples['as2-rd-25-two-label'];
    const cidrByPrefix = await callWorker(worker, 'getBgpInstanceRoutes', {
        ...instanceQuery,
        page: 1,
        pageSize: PAGE_SIZE,
        prefixFilter: `${cidrRoute.ip}/${cidrRoute.mask}`
    });
    assert.equal(cidrByPrefix.total, 1);
    assert.equal(cidrByPrefix.list[0].routeKey, cidrRoute.getRouteKey());

    const scanResult = await callWorker(worker, 'getBgpRoutes', {
        ...sessionQuery,
        page: 1,
        pageSize: PAGE_SIZE,
        prefixFilter: '10.1.0.'
    });
    assert.equal(scanResult.total, ROUTES_PER_VARIANT);
    assert.equal(scanResult.list.length, Math.min(PAGE_SIZE, ROUTES_PER_VARIANT));
    assert.ok(scanResult.list.every(route => route.ip.startsWith('10.1.0.')));

    const sessionDetail = await callWorker(worker, 'getBgpRouteDetail', {
        ...sessionQuery,
        routeKey: samples['as4-rd-16-two-label'].getRouteKey()
    });
    assert.equal(sessionDetail.addrFamilyType, AF);
    assert.equal(sessionDetail.mask, 16);
    assert.equal(sessionDetail.nlriDetail.labels.length, 2);
    assert.equal(sessionDetail.labels.includes('(BOS)'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(sessionDetail, 'summary'), false);

    const locRibDetail = await callWorker(worker, 'getBgpInstanceRouteDetail', {
        ...instanceQuery,
        routeKey: samples['as2-rd-24-single-label'].getRouteKey()
    });
    assert.equal(locRibDetail.addrFamilyType, AF);
    assert.equal(locRibDetail.mask, 24);
    assert.equal(locRibDetail.rd.startsWith('65000:'), true);
    assert.equal(locRibDetail.nextHop, '192.0.2.254');

    console.log(
        `VPNv4 BGP route reporting passed: variants=${VPNV4_VARIANTS.map(item => item.name).join(',')}, sessionRoutes=${ROUTE_COUNT}, locRibRoutes=${ROUTE_COUNT}, pageSize=${PAGE_SIZE}`
    );
}

async function main() {
    const worker = await makeWorker();
    try {
        await run(worker);
    } finally {
        await closeWorker(worker);
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
