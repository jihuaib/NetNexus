const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');

const service = new BmpRouteAssuranceService();
const worker = {
    applyRouteAssuranceMutation: mutation => service.applyMutation(mutation)
};
const bmpSession = new BmpSession({ sendEvent() {} }, worker);
bmpSession.localIp = '127.0.0.1';
bmpSession.localPort = 11019;
bmpSession.remoteIp = '127.0.0.2';
bmpSession.remotePort = 50000;
bmpSession.sysName = 'observed-map-router';

const bgpSession = new BmpBgpSession(bmpSession);
bgpSession.sessionType = BmpConst.BMP_PEER_TYPE.GLOBAL;
bgpSession.sessionRd = '0:0';
bgpSession.sessionIp = '198.51.100.1';
bgpSession.sessionAs = 65001;
bgpSession.vrfTableNames = ['observed-map-lab'];
const ownerKey = BmpBgpSession.makeKey(
    bgpSession.sessionType,
    bgpSession.sessionRd,
    bgpSession.sessionIp,
    bgpSession.sessionAs
);
bmpSession.bgpSessionMap.set(ownerKey, bgpSession);

const routeKey = '1|0:0|203.0.113.0|24';
const makeRoute = () => ({
    routeKey,
    afi: 1,
    safi: 1,
    rd: '0:0',
    ip: '203.0.113.0',
    mask: 24,
    pathId: 1,
    routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
    pathStatus: null,
    origin: 'IGP',
    asPath: '65001',
    nextHop: '192.0.2.254',
    localPref: 100,
    med: 0,
    communities: []
});

const preIn = bmpSession.getOrCreateBgpSessionRouteMap(
    bgpSession,
    1,
    1,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
);
const postIn = bmpSession.getOrCreateBgpSessionRouteMap(
    bgpSession,
    1,
    1,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
);
preIn.set(routeKey, makeRoute());

const clientKey = BmpSession.makeKey(
    bmpSession.localIp,
    bmpSession.localPort,
    bmpSession.remoteIp,
    bmpSession.remotePort
);
const sessionMap = new Map([[clientKey, bmpSession]]);
let result = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(result.summary.categoryCounts['inbound-gap'], 1);
assert.equal(result.summary.cacheHit, false);

const postRoute = makeRoute();
postIn.set(routeKey, postRoute);
result = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(result.summary.cacheHit, true);
assert.equal(result.summary.categoryCounts['inbound-gap'], 0);
assert.equal(result.summary.categoryCounts['not-selected'], 1);

postRoute.pathStatus = BmpConst.BMP_PATH_STATUS.NONSELECTED;
postIn.set(routeKey, postRoute);
result = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(result.issues[0].evidenceType, 'reported');

postIn.delete(routeKey);
result = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(result.summary.categoryCounts['inbound-gap'], 1);
assert.equal(result.summary.categoryCounts['not-selected'], 0);
assert.equal(result.summary.incrementalUpdateCount, 3);

console.log('BMP Route Assurance observed route-map integration tests passed');
