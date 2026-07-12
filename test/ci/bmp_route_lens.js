const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { buildBmpRouteLens } = require('../../electron/utils/bmpRouteLens');

const clientInfo = {
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.1',
    remotePort: 51000,
    sysName: 'router-a'
};
const bmpSession = {
    bgpSessionMap: new Map(),
    bgpInstanceMap: new Map(),
    getClientInfo: () => ({ ...clientInfo })
};

const bgpSession = new BmpBgpSession(bmpSession);
Object.assign(bgpSession, {
    sessionType: 0,
    sessionRd: '0:0',
    sessionIp: '198.51.100.1',
    sessionAs: 65001,
    sessionRouterId: '198.51.100.1',
    sessionState: BmpConst.BMP_SESSION_STATE.PEER_UP
});
const sessionKey = BmpBgpSession.makeKey(
    bgpSession.sessionType,
    bgpSession.sessionRd,
    bgpSession.sessionIp,
    bgpSession.sessionAs
);
bmpSession.bgpSessionMap.set(sessionKey, bgpSession);

const locRib = new BmpBgpInstance(bmpSession);
Object.assign(locRib, {
    afi: 1,
    safi: 1,
    instanceType: 3,
    instanceRd: '0:0',
    instanceIp: '0.0.0.0',
    instanceAs: 65000,
    instanceRouterId: '192.0.2.1'
});
const instanceKey = BmpBgpInstance.makeKey(locRib.instanceType, locRib.instanceRd, locRib.afi, locRib.safi);
bmpSession.bgpInstanceMap.set(instanceKey, locRib);

function makeRoute(owner, ip, mask, pathId, attributes = {}, options = {}) {
    const route = new BmpBgpRoute(
        owner instanceof BmpBgpSession ? owner : null,
        owner instanceof BmpBgpInstance ? owner : null
    );
    route.ip = ip;
    route.mask = mask;
    route.afi = options.afi || (ip.includes(':') ? 2 : 1);
    route.safi = options.safi || 1;
    route.rd = options.rd || '0:0';
    route.pathId = pathId;
    route.labels = attributes.labels ?? null;
    route.assignRouteAttr({
        origin: attributes.origin ?? 'IGP',
        asPath: attributes.asPath ?? '65001',
        nextHop: attributes.nextHop ?? '192.0.2.254',
        localPref: attributes.localPref ?? 100,
        med: attributes.med ?? 0,
        communities: attributes.communities ?? ['65000:100'],
        otc: attributes.otc ?? null,
        prefixSid: attributes.prefixSid ?? null
    });
    route.markActive(1);
    if (options.stale) {
        route.markStale('test', 1);
    }
    if (options.pathStatus !== undefined) {
        route.setPathStatusMarkings([{ pathStatus: options.pathStatus, reasonCode: options.reasonCode }]);
    }
    return route;
}

function addSessionRoute(ribType, route) {
    const afKey = `${route.afi}|${route.safi}`;
    if (!bgpSession.bgpRoutes.has(afKey)) {
        bgpSession.bgpRoutes.set(afKey, new Map());
    }
    const ribMap = bgpSession.bgpRoutes.get(afKey);
    if (!ribMap.has(ribType)) {
        ribMap.set(ribType, new Map());
    }
    const routeKey = route.getRouteKey();
    ribMap.get(ribType).set(routeKey, route);
    bgpSession.addRouteToPrefixIndex(route.afi, route.safi, ribType, routeKey, route);
}

function addInstanceRoute(route) {
    const routeKey = route.getRouteKey();
    locRib.bgpRoutes.set(routeKey, route);
    locRib.addRouteToPrefixIndex(routeKey, route);
}

const exactPreRoute = makeRoute(bgpSession, '10.0.0.0', 8, 1, { localPref: 100 });
exactPreRoute.setRouteTlvs([{ name: 'VRF/Table Name', value: 'route-blue' }]);
bgpSession.vrfTableNames = ['owner-global', 'owner-blue'];
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, exactPreRoute);
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, makeRoute(bgpSession, '10.0.0.0', 8, 1, { localPref: 200 }));
addSessionRoute(
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
    makeRoute(bgpSession, '10.0.0.0', 8, 1, { nextHop: '192.0.2.253' })
);
addSessionRoute(
    BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT,
    makeRoute(bgpSession, '10.0.0.0', 8, 1, { nextHop: '192.0.2.253' })
);
addInstanceRoute(
    makeRoute(locRib, '10.0.0.0', 8, 1, { localPref: 200 }, { pathStatus: BmpConst.BMP_PATH_STATUS.BEST })
);

addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, makeRoute(bgpSession, '10.1.0.0', 16, 2, { localPref: 150 }));
addSessionRoute(
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
    makeRoute(
        bgpSession,
        '10.2.0.0',
        16,
        6,
        { localPref: 150 },
        { pathStatus: BmpConst.BMP_PATH_STATUS.FILTERED_IN_INBOUND_POLICY }
    )
);
addSessionRoute(
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
    makeRoute(bgpSession, '10.1.2.0', 24, 3, {}, { stale: true })
);
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, makeRoute(bgpSession, '10.3.0.0', 16, 7));
addSessionRoute(
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
    makeRoute(bgpSession, '10.3.0.0', 16, 7, { localPref: 200 }, { stale: true })
);
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, makeRoute(bgpSession, '10.4.5.6', 24, 8));

addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, makeRoute(bgpSession, '2001:db8::', 32, 4, {}, { afi: 2 }));
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, makeRoute(bgpSession, '2001:db8:1::', 48, 5, {}, { afi: 2 }));

const evpnIdentity = 'evpn:mac-ip:65000:1:tag=100:mac=aa:bb:cc:dd:ee:ff:ip=192.0.2.10';
const evpnRoute = makeRoute(bgpSession, evpnIdentity, 216, 20, {}, { afi: 25, safi: 70 });
evpnRoute.routeType = 2;
evpnRoute.nlriDetail = {
    prefix: evpnIdentity,
    routeType: 2,
    routeTypeName: 'MAC/IP Advertisement'
};
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, evpnRoute);

const secondEvpnIdentity = 'evpn:mac-ip:65000:1:tag=101:mac=aa:bb:cc:dd:ee:01:ip=192.0.2.11';
const secondEvpnRoute = makeRoute(bgpSession, secondEvpnIdentity, 216, 21, {}, { afi: 25, safi: 70 });
secondEvpnRoute.routeType = 2;
secondEvpnRoute.nlriDetail = {
    prefix: secondEvpnIdentity,
    routeType: 2,
    routeTypeName: 'Extended MAC/IP Advertisement Route'
};
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, secondEvpnRoute);

const bgpLsIdentity = 'bgp-ls:IPv4 Prefix:203.0.113.0/24';
const bgpLsRoute = makeRoute(bgpSession, bgpLsIdentity, 88, 22, {}, { afi: 16388, safi: 71 });
bgpLsRoute.routeType = 3;
bgpLsRoute.nlriDetail = {
    prefix: bgpLsIdentity,
    nlriType: 3,
    nlriTypeName: 'IPv4 Topology Prefix'
};
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, bgpLsRoute);

const qpRoute = makeRoute(
    bgpSession,
    '192.0.2.0',
    24,
    23,
    {},
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_QP }
);
qpRoute.nlriDetail = {
    prefix: '192.0.2.0',
    length: 24,
    dqpn: 4660,
    dqpnBits: 16,
    nlriBits: 64
};
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, qpRoute);

const mvpnRawIdentity = '0000fde8000000010a000001';
const mvpnRoute = makeRoute(
    bgpSession,
    mvpnRawIdentity,
    12,
    24,
    {},
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_MVPN }
);
mvpnRoute.routeType = BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD;
mvpnRoute.nlriDetail = {
    prefix: mvpnRawIdentity,
    routeType: BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
    rawNlri: mvpnRawIdentity,
    nlriLength: 12
};
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, mvpnRoute);

const vpnRoute = makeRoute(
    bgpSession,
    '172.16.0.0',
    16,
    25,
    { labels: '16000(BOS)' },
    { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_VPN, rd: '65000:100' }
);
vpnRoute.nlriDetail = {
    prefix: '172.16.0.0',
    rd: '65000:100',
    length: 16,
    labels: [{ label: 16000, bottom: true }]
};
addSessionRoute(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, vpnRoute);

const sessionMap = new Map([['127.0.0.1|11019|192.0.2.1|51000', bmpSession]]);

const exact = buildBmpRouteLens(sessionMap, { query: '10.0.0.7/8', routeState: 'active' });
assert.equal(exact.query.mode, 'exact');
assert.equal(exact.query.normalized, '10.0.0.0/8');
assert.deepEqual(exact.summary.stageCounts, { preIn: 1, postIn: 1, locRib: 1, preOut: 1, postOut: 1 });
assert.equal(exact.summary.total, 5);
assert.equal(exact.summary.clientCount, 1);
assert.equal(exact.summary.peerCount, 1);
assert.equal(exact.summary.reportedCount, 1);
assert.equal(exact.stages.locRib[0].ribType, 'loc-rib');
assert.equal(exact.stages.preIn[0].route.localPref, 100);
assert.deepEqual(exact.stages.preIn[0].vrfTableNames, ['route-blue']);
assert.equal(exact.stages.preIn[0].match.matchType, 'exact');
assert.equal(exact.policyDiffs.inbound[0].status, 'modified');
assert.equal(exact.policyDiffs.inbound[0].title, '10.0.0.0/8 · Peer 198.51.100.1');
assert.equal(exact.policyDiffs.inbound[0].context.prefix, '10.0.0.0/8');
assert.equal(exact.policyDiffs.inbound[0].context.peerAs, 65001);
assert.deepEqual(exact.policyDiffs.inbound[0].changes.localPref, { before: 100, after: 200 });
assert.equal(exact.policyDiffs.outbound[0].status, 'unchanged');
assert.ok(exact.insights.some(insight => insight.id === 'path-marking-reported'));
assert.ok(exact.insights.some(insight => insight.id === 'loc-rib-observed'));

const covering = buildBmpRouteLens(sessionMap, { query: '10.1.2.3', routeState: 'active' });
assert.equal(covering.query.mode, 'covering');
assert.deepEqual(
    covering.stages.preIn.map(entry => entry.match.normalizedRoutePrefix),
    ['10.1.0.0/16', '10.0.0.0/8']
);
const missingAfter = covering.policyDiffs.inbound.find(diff => diff.status === 'missing-after');
assert.ok(missingAfter);
assert.equal(missingAfter.evidenceType, 'inferred');
assert.equal(missingAfter.confidence, 'low');
assert.match(missingAfter.description, /不能据此确定路由被策略过滤/);
const noMarking = buildBmpRouteLens(sessionMap, { query: '10.1.0.0/16', routeState: 'active' });
assert.equal(noMarking.policyDiffs.inbound[0].status, 'missing-after');
assert.equal(noMarking.policyDiffs.inbound[0].evidenceType, 'inferred');
assert.equal(noMarking.policyDiffs.inbound[0].confidence, 'low');
assert.deepEqual(noMarking.policyDiffs.inbound[0].changes, {});
assert.deepEqual(noMarking.policyDiffs.inbound[0].changedFields, []);
assert.ok(noMarking.insights.some(insight => insight.id === 'selection-state-inferred'));

const reportedFilter = buildBmpRouteLens(sessionMap, { query: '10.2.0.0/16', routeState: 'active' });
assert.equal(reportedFilter.policyDiffs.inbound[0].status, 'missing-after');
assert.equal(reportedFilter.policyDiffs.inbound[0].evidenceType, 'reported');
assert.equal(reportedFilter.policyDiffs.inbound[0].confidence, 'high');
assert.deepEqual(reportedFilter.policyDiffs.inbound[0].changes, {});
assert.deepEqual(reportedFilter.policyDiffs.inbound[0].changedFields, []);
assert.match(reportedFilter.policyDiffs.inbound[0].description, /Path Marking 明确上报.*入站策略中被过滤/);
assert.equal(reportedFilter.policyDiffs.summary.missingAfterReported, 1);
assert.equal(reportedFilter.policyDiffs.summary.missingAfterInferred, 0);
assert.equal(reportedFilter.summary.inferredCount, 0);
assert.ok(!reportedFilter.insights.some(insight => insight.id === 'post-policy-observation-missing'));

const mixedStates = buildBmpRouteLens(sessionMap, { query: '10.3.0.0/16', routeState: 'all' });
assert.deepEqual(mixedStates.policyDiffs.inbound.map(diff => diff.status).sort(), ['missing-after', 'post-only']);
assert.ok(!mixedStates.policyDiffs.inbound.some(diff => diff.status === 'modified' || diff.status === 'unchanged'));
assert.ok(mixedStates.policyDiffs.inbound.every(diff => Object.keys(diff.changes).length === 0));
assert.ok(mixedStates.policyDiffs.inbound.every(diff => diff.changedFields.length === 0));

const nonCanonicalPrefix = buildBmpRouteLens(sessionMap, { query: '10.4.5.7', routeState: 'active' });
assert.deepEqual(
    nonCanonicalPrefix.stages.preIn.map(entry => entry.match.normalizedRoutePrefix),
    ['10.4.5.0/24', '10.0.0.0/8']
);

const ipv6Covering = buildBmpRouteLens(sessionMap, { query: '2001:db8:1::1234' });
assert.deepEqual(
    ipv6Covering.stages.preIn.map(entry => entry.match.normalizedRoutePrefix),
    ['2001:db8:1::/48', '2001:db8::/32']
);

const evpnExact = buildBmpRouteLens(sessionMap, { query: evpnIdentity.toUpperCase() });
assert.equal(evpnExact.query.mode, 'text');
assert.equal(evpnExact.query.normalized, evpnIdentity);
assert.equal(evpnExact.summary.total, 1);
assert.equal(evpnExact.stages.preIn[0].match.matchType, 'text-exact');
assert.equal(evpnExact.stages.preIn[0].match.routeIdentity, evpnIdentity);
assert.equal(evpnExact.stages.preIn[0].match.displayPrefix, evpnIdentity);
assert.ok(!evpnExact.stages.preIn[0].match.displayPrefix.endsWith('/216'));
assert.equal(evpnExact.policyDiffs.inbound[0].context.prefix, evpnIdentity);

const evpnByType = buildBmpRouteLens(sessionMap, { query: 'mAc/iP Advertisement' });
assert.deepEqual(
    evpnByType.stages.preIn.map(entry => entry.match.matchType),
    ['text-exact', 'text-contains']
);
assert.equal(evpnByType.stages.preIn[0].match.matchedField, 'nlriDetail.routeTypeName');

const bgpLsExact = buildBmpRouteLens(sessionMap, { query: bgpLsIdentity.toUpperCase() });
assert.equal(bgpLsExact.query.mode, 'text');
assert.equal(bgpLsExact.stages.preIn[0].match.matchType, 'text-exact');
assert.equal(bgpLsExact.stages.preIn[0].match.displayPrefix, bgpLsIdentity);
assert.ok(!bgpLsExact.stages.preIn[0].match.displayPrefix.endsWith('/88'));

const bgpLsContains = buildBmpRouteLens(sessionMap, { query: 'IPv4 Prefix:203.0.113.0' });
assert.equal(bgpLsContains.stages.preIn[0].match.matchType, 'text-contains');
assert.equal(bgpLsContains.stages.preIn[0].match.routeIdentity, bgpLsIdentity);

const qpByDqpn = buildBmpRouteLens(sessionMap, { query: 'DQPN=4660' });
assert.equal(qpByDqpn.query.mode, 'text');
assert.equal(qpByDqpn.summary.total, 1);
assert.equal(qpByDqpn.stages.preIn[0].match.matchType, 'text-exact');
assert.equal(qpByDqpn.stages.preIn[0].match.matchedField, 'nlriDetail.dqpnLabel');
assert.equal(qpByDqpn.stages.preIn[0].match.routeIdentity, '192.0.2.0|dqpn=4660');
assert.equal(qpByDqpn.stages.preIn[0].match.displayPrefix, '192.0.2.0/24 · DQPN 4660/16');

const qpByBareDqpn = buildBmpRouteLens(sessionMap, { query: '4660' });
assert.equal(qpByBareDqpn.query.mode, 'text');
assert.equal(qpByBareDqpn.summary.total, 1);
assert.equal(qpByBareDqpn.stages.preIn[0].match.matchedField, 'nlriDetail.dqpn');

const qpByDip = buildBmpRouteLens(sessionMap, { query: '192.0.2.1' });
assert.equal(qpByDip.query.mode, 'covering');
assert.equal(qpByDip.stages.preIn[0].match.displayPrefix, '192.0.2.0/24 · DQPN 4660/16');

const mvpnByType = buildBmpRouteLens(sessionMap, { query: 'MVPN type=1' });
assert.equal(mvpnByType.query.mode, 'text');
assert.equal(mvpnByType.summary.total, 1);
assert.equal(mvpnByType.stages.preIn[0].match.matchType, 'text-exact');
assert.equal(mvpnByType.stages.preIn[0].match.matchedField, 'mvpnRouteType');
assert.equal(mvpnByType.stages.preIn[0].match.routeIdentity, `mvpn:type=1:intra_as_i_pmsi_ad:0x${mvpnRawIdentity}`);
assert.equal(mvpnByType.stages.preIn[0].match.displayPrefix, `MVPN INTRA_AS_I_PMSI_AD · 0x${mvpnRawIdentity}`);

const mvpnByRawIdentity = buildBmpRouteLens(sessionMap, { query: mvpnRawIdentity.toUpperCase() });
assert.equal(mvpnByRawIdentity.stages.preIn[0].match.matchType, 'text-exact');
assert.ok(!mvpnByRawIdentity.stages.preIn[0].match.displayPrefix.endsWith('/12'));

const vpnByRd = buildBmpRouteLens(sessionMap, { query: 'RD=65000:100' });
assert.equal(vpnByRd.summary.total, 1);
assert.equal(vpnByRd.stages.preIn[0].match.matchType, 'text-exact');
assert.equal(vpnByRd.stages.preIn[0].match.matchedField, 'rdLabel');
assert.equal(vpnByRd.stages.preIn[0].match.routeIdentity, '172.16.0.0|rd=65000:100');
assert.equal(vpnByRd.stages.preIn[0].match.displayPrefix, '172.16.0.0/16 · RD 65000:100');

const vpnByLabel = buildBmpRouteLens(sessionMap, { query: 'Labels=16000(BOS)' });
assert.equal(vpnByLabel.summary.total, 1);
assert.equal(vpnByLabel.stages.preIn[0].match.matchedField, 'labelsLabel');

const activeStalePrefix = buildBmpRouteLens(sessionMap, { query: '10.1.2.0/24', routeState: 'active' });
const stalePrefix = buildBmpRouteLens(sessionMap, { query: '10.1.2.0/24', routeState: 'stale' });
const allStates = buildBmpRouteLens(sessionMap, { query: '10.1.2.0/24', routeState: 'all' });
assert.equal(activeStalePrefix.summary.total, 0);
assert.equal(stalePrefix.summary.total, 1);
assert.equal(stalePrefix.stages.preIn[0].route.routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(allStates.summary.total, 1);

for (let pathId = 10; pathId < 20; pathId += 1) {
    addSessionRoute(
        BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        makeRoute(bgpSession, '10.0.0.0', 8, pathId, { localPref: 100 + pathId })
    );
}
const limited = buildBmpRouteLens(sessionMap, {
    query: { value: '10.0.0.0/8', maxResults: 3 },
    routeState: 'active'
});
assert.equal(limited.summary.total, 3);
assert.equal(limited.summary.resultLimit, 3);
assert.equal(limited.summary.truncated, true);
assert.equal(limited.summary.inferredCount, 0);
assert.equal(limited.policyDiffs.summary.incomplete, true);
assert.deepEqual(limited.policyDiffs.inbound, []);
assert.deepEqual(limited.policyDiffs.outbound, []);
assert.deepEqual(
    limited.insights.map(insight => insight.id),
    ['analysis-suppressed-by-truncation']
);

const stableAgain = buildBmpRouteLens(sessionMap, { query: { value: '10.0.0.0/8', maxResults: 3 } });
assert.deepEqual(
    limited.stages.preIn.map(entry => entry.id),
    stableAgain.stages.preIn.map(entry => entry.id)
);

const unmatchedText = buildBmpRouteLens(sessionMap, { query: 'not-an-ip' });
assert.equal(unmatchedText.query.mode, 'text');
assert.equal(unmatchedText.summary.total, 0);
assert.throws(() => buildBmpRouteLens(sessionMap, { query: '' }), /Prefix、IP 或 NLRI 标识/);
assert.throws(() => buildBmpRouteLens(sessionMap, { query: '192.0.2.1/99' }), /CIDR 前缀格式无效/);

console.log('BMP Route Lens tests passed');
