const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { buildBmpRouteAssurance } = require('../../electron/utils/bmpRouteAssurance');

const clientInfo = {
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.1',
    remotePort: 50000,
    sysName: 'assurance-router'
};
const bmpSession = {
    bgpSessionMap: new Map(),
    bgpInstanceMap: new Map(),
    getClientInfo: () => ({ ...clientInfo })
};

function makeSession(ip, asn) {
    const session = new BmpBgpSession(bmpSession);
    Object.assign(session, {
        sessionType: BmpConst.BMP_PEER_TYPE.GLOBAL,
        sessionRd: '0:0',
        sessionIp: ip,
        sessionAs: asn,
        sessionRouterId: ip,
        sessionState: BmpConst.BMP_SESSION_STATE.PEER_UP,
        vrfTableNames: ['blue']
    });
    const key = BmpBgpSession.makeKey(session.sessionType, session.sessionRd, session.sessionIp, session.sessionAs);
    bmpSession.bgpSessionMap.set(key, session);
    return session;
}

const ingress = makeSession('198.51.100.1', 65001);
const egressA = makeSession('198.51.100.2', 65002);
const egressB = makeSession('198.51.100.3', 65003);

const locRib = new BmpBgpInstance(bmpSession);
Object.assign(locRib, {
    afi: 1,
    safi: 1,
    instanceType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
    instanceRd: '0:0',
    instanceIp: '0.0.0.0',
    instanceAs: 65000,
    instanceRouterId: '192.0.2.1',
    vrfTableNames: ['blue']
});
const locKey = BmpBgpInstance.makeKey(locRib.instanceType, locRib.instanceRd, locRib.afi, locRib.safi);
bmpSession.bgpInstanceMap.set(locKey, locRib);

function makeRoute(owner, identity, mask, pathId, attrs = {}, options = {}) {
    const route = new BmpBgpRoute(
        owner instanceof BmpBgpSession ? owner : null,
        owner instanceof BmpBgpInstance ? owner : null
    );
    Object.assign(route, {
        ip: identity,
        mask,
        afi: options.afi || BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        safi: options.safi || BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        rd: options.rd || '0:0',
        pathId
    });
    route.assignRouteAttr({
        origin: attrs.origin || 'IGP',
        asPath: attrs.asPath || '65001',
        nextHop: attrs.nextHop || '192.0.2.254',
        localPref: attrs.localPref ?? 100,
        med: attrs.med ?? 0,
        communities: attrs.communities || ['65000:100'],
        otc: null,
        prefixSid: null
    });
    route.setRouteTlvs([{ name: 'VRF/Table Name', value: 'blue' }]);
    route.markActive(1);
    if (options.pathStatus !== undefined) {
        route.setPathStatusMarkings([{ pathStatus: options.pathStatus }]);
    }
    if (options.nlriDetail) {
        route.nlriDetail = options.nlriDetail;
        route.routeType = options.nlriDetail.routeType ?? null;
    }
    return route;
}

function addSessionRoute(session, ribType, route) {
    const afKey = `${route.afi}|${route.safi}`;
    if (!session.bgpRoutes.has(afKey)) {
        session.bgpRoutes.set(afKey, new Map());
    }
    if (!session.bgpRoutes.get(afKey).has(ribType)) {
        session.bgpRoutes.get(afKey).set(ribType, new Map());
    }
    session.bgpRoutes.get(afKey).get(ribType).set(route.getRouteKey(), route);
}

function addLocRoute(route) {
    locRib.bgpRoutes.set(route.getRouteKey(), route);
}

function addInbound(identity, mask, pathId, options = {}) {
    addSessionRoute(
        ingress,
        BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        makeRoute(ingress, identity, mask, pathId, options.preAttrs, options.preOptions)
    );
    if (options.post !== false) {
        addSessionRoute(
            ingress,
            BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
            makeRoute(ingress, identity, mask, pathId, options.postAttrs, options.postOptions || options.preOptions)
        );
    }
}

// A complete IPv4 route exported to two peers with intentionally different Post-Out attributes.
addInbound('10.0.0.0', 24, 1, { postAttrs: { localPref: 200 } });
addLocRoute(makeRoute(locRib, '10.0.0.0', 24, 1, { localPref: 200 }));
[egressA, egressB].forEach(peer => {
    addSessionRoute(peer, BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT, makeRoute(peer, '10.0.0.0', 24, 1));
});
addSessionRoute(
    egressA,
    BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT,
    makeRoute(egressA, '10.0.0.0', 24, 1, { nextHop: '192.0.2.2', communities: ['65000:200'] })
);
addSessionRoute(
    egressB,
    BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT,
    makeRoute(egressB, '10.0.0.0', 24, 1, { nextHop: '192.0.2.3', communities: ['65000:300'] })
);

// Reported inbound filter.
addInbound('10.1.0.0', 24, 2, {
    post: false,
    preOptions: { pathStatus: BmpConst.BMP_PATH_STATUS.FILTERED_IN_INBOUND_POLICY }
});

// Loc-RIB route with no Adj-RIB-Out.
addInbound('10.2.0.0', 24, 3);
addLocRoute(makeRoute(locRib, '10.2.0.0', 24, 3));

// Pre-Out without Post-Out: this is outbound-gap, not not-exported.
addInbound('10.3.0.0', 24, 4);
addLocRoute(makeRoute(locRib, '10.3.0.0', 24, 4));
addSessionRoute(
    egressA,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
    makeRoute(egressA, '10.3.0.0', 24, 4, {}, { pathStatus: BmpConst.BMP_PATH_STATUS.FILTERED_IN_OUTBOUND_POLICY })
);

// EVPN inferred inbound visibility gap.
const evpn = 'evpn:mac-ip:65000:1:tag=100:mac=aa:bb:cc:dd:ee:ff:ip=192.0.2.10';
addSessionRoute(
    ingress,
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
    makeRoute(
        ingress,
        evpn,
        216,
        5,
        {},
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
            nlriDetail: { prefix: evpn, routeType: 2, routeTypeName: 'MAC/IP Advertisement' }
        }
    )
);

// BGP-LS route reaches Post-In but not Loc-RIB, with explicit NONSELECTED marking.
const bgpLs = 'bgp-ls:Link:10.0.0.1->10.0.0.2';
addSessionRoute(
    ingress,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
    makeRoute(
        ingress,
        bgpLs,
        88,
        6,
        {},
        {
            afi: BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS,
            pathStatus: BmpConst.BMP_PATH_STATUS.NONSELECTED,
            nlriDetail: { prefix: bgpLs, nlriType: 2, nlriTypeName: 'Link' }
        }
    )
);

const sessionMap = new Map([['client-a', bmpSession]]);
const result = buildBmpRouteAssurance(sessionMap);

assert.deepEqual(result.funnel, { preIn: 5, postIn: 4, locRib: 3, preOut: 2, postOut: 1 });
assert.deepEqual(result.summary.stageCounts, result.funnel);
assert.deepEqual(result.summary.stagePathCounts, { preIn: 5, postIn: 4, locRib: 3, preOut: 3, postOut: 2 });
assert.equal(result.summary.uniqueNlriCount, 6);
assert.equal(result.summary.clientCount, 1);
assert.deepEqual(result.summary.categoryCounts, {
    'inbound-gap': 2,
    'not-selected': 1,
    'not-exported': 1,
    'outbound-gap': 1,
    'multi-egress-inconsistent': 1
});

const reportedInbound = result.issues.find(issue => issue.category === 'inbound-gap' && issue.prefix === '10.1.0.0/24');
assert.equal(reportedInbound.evidenceType, 'reported');
assert.equal(reportedInbound.confidence, 'high');
assert.ok(reportedInbound.description.includes('Path Marking'));

const inferredEvpn = result.issues.find(issue => issue.category === 'inbound-gap' && issue.prefix === evpn);
assert.equal(inferredEvpn.evidenceType, 'inferred');
assert.equal(inferredEvpn.confidence, 'low');
assert.ok(inferredEvpn.description.includes('不能据此确定'));

const notSelected = result.issues.find(issue => issue.category === 'not-selected');
assert.equal(notSelected.prefix, bgpLs);
assert.equal(notSelected.evidenceType, 'reported');

const notExported = result.issues.find(issue => issue.category === 'not-exported');
assert.equal(notExported.prefix, '10.2.0.0/24');
assert.equal(notExported.evidenceType, 'inferred');
assert.ok(!result.issues.some(issue => issue.category === 'not-exported' && issue.prefix === '10.3.0.0/24'));

const outboundGap = result.issues.find(issue => issue.category === 'outbound-gap');
assert.equal(outboundGap.prefix, '10.3.0.0/24');
assert.equal(outboundGap.evidenceType, 'reported');

const inconsistent = result.issues.find(issue => issue.category === 'multi-egress-inconsistent');
assert.equal(inconsistent.evidenceType, 'observed');
assert.equal(inconsistent.peers.length, 2);
assert.deepEqual(
    inconsistent.differences.map(difference => difference.field),
    ['nextHop', 'communities']
);

const evpnOnly = buildBmpRouteAssurance(sessionMap, { query: 'evpn:mac-ip', af: 'L2VPN EVPN' });
assert.equal(evpnOnly.summary.uniqueNlriCount, 1);
assert.equal(evpnOnly.issues[0].prefix, evpn);
assert.equal(evpnOnly.issues[0].routeLensQuery, evpn);

const bgpLsOnly = buildBmpRouteAssurance(sessionMap, { query: 'bgp-ls:Link', category: 'not-selected' });
assert.equal(bgpLsOnly.pagination.total, 1);
assert.equal(bgpLsOnly.issues[0].nlri.afLabel, 'BGP-LS BGP-LS');

const paged = buildBmpRouteAssurance(sessionMap, { page: 2, pageSize: 2 });
assert.equal(paged.pagination.page, 2);
assert.equal(paged.pagination.pageSize, 2);
assert.equal(paged.pagination.total, 6);
assert.equal(paged.issues.length, 2);

const clientFiltered = buildBmpRouteAssurance(sessionMap, { client: 'assurance-router', vrf: 'blue' });
assert.equal(clientFiltered.summary.uniqueNlriCount, 6);

assert.throws(() => buildBmpRouteAssurance(sessionMap, { query: '10.0.0.0/not-a-mask' }), /CIDR 前缀格式无效/);
assert.ok(notSelected.evidence.length > 0);
assert.ok(notExported.evidence.length > 0);
assert.ok(inconsistent.evidence.length > 0);

function makePlainRoute(info) {
    return {
        routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
        getRouteInfo: () => ({
            rd: '0:0',
            pathId: 0,
            routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
            pathStatus: null,
            ...info,
            routeKey: info.routeKey || `${info.pathId || 0}|${info.rd || '0:0'}|${info.ip}|${info.mask}`
        })
    };
}

function makePlainBmpSession(sessionDefinitions) {
    return {
        getClientInfo: () => ({ sysName: 'plain-router', remoteIp: '192.0.2.200' }),
        bgpSessionMap: new Map(
            sessionDefinitions.map(definition => [
                definition.key,
                {
                    getSessionInfo: () => ({
                        sessionIp: definition.peerIp,
                        sessionAs: definition.peerAs,
                        sessionRd: '0:0',
                        vrfTableNames: definition.vrfTableNames || []
                    }),
                    bgpRoutes: new Map([
                        [
                            definition.afKey || '1|1',
                            new Map([
                                [
                                    definition.ribType,
                                    new Map(definition.routes.map((route, index) => [`${index}`, route]))
                                ]
                            ])
                        ]
                    ])
                }
            ])
        ),
        bgpInstanceMap: new Map()
    };
}

// The aggregate scans beyond Route Lens' 2,000-result ceiling and exposes Global as a real facet.
const bulkRoutes = Array.from({ length: 2005 }, (_, index) =>
    makePlainRoute({
        afi: 1,
        safi: 1,
        ip: `172.${Math.floor(index / 256)}.${index % 256}.0`,
        mask: 24,
        pathId: index
    })
);
const bulkSessionMap = new Map([
    [
        'bulk-client',
        makePlainBmpSession([
            {
                key: 'bulk-peer',
                peerIp: '198.51.100.200',
                peerAs: 65100,
                ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
                routes: bulkRoutes
            }
        ])
    ]
]);
const bulk = buildBmpRouteAssurance(bulkSessionMap, { vrf: '__global__' });
assert.equal(bulk.funnel.preIn, 2005);
assert.equal(bulk.summary.scannedPathCount, 2005);
assert.equal(bulk.summary.filteredPathCount, 2005);
assert.ok(bulk.facets.vrfs.some(facet => facet.value === '__global__' && facet.label === 'Global'));

// One egress Peer with multiple Add-Path variants is not a multi-egress inconsistency.
const samePeerRoutes = [
    makePlainRoute({ afi: 1, safi: 1, ip: '198.18.0.0', mask: 24, pathId: 1, nextHop: '192.0.2.1' }),
    makePlainRoute({ afi: 1, safi: 1, ip: '198.18.0.0', mask: 24, pathId: 2, nextHop: '192.0.2.2' })
];
const addPathOnly = buildBmpRouteAssurance(
    new Map([
        [
            'add-path-client',
            makePlainBmpSession([
                {
                    key: 'one-egress-peer',
                    peerIp: '198.51.100.201',
                    peerAs: 65101,
                    ribType: BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT,
                    routes: samePeerRoutes
                }
            ])
        ]
    ])
);
assert.equal(addPathOnly.summary.categoryCounts['multi-egress-inconsistent'], 0);

const qp = makePlainRoute({
    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    safi: BgpConst.BGP_SAFI_TYPE.SAFI_QP,
    ip: '192.0.2.0',
    mask: 24,
    nlriDetail: { prefix: '192.0.2.0', dqpn: 4660, dqpnBits: 16 }
});
const mvpnRaw = '0000fde8000000010a000001';
const mvpn = makePlainRoute({
    afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
    safi: BgpConst.BGP_SAFI_TYPE.SAFI_MVPN,
    ip: mvpnRaw,
    mask: 12,
    routeType: BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
    nlriDetail: {
        prefix: mvpnRaw,
        routeType: BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
        rawNlri: mvpnRaw
    }
});
const semantic = buildBmpRouteAssurance(
    new Map([
        [
            'semantic-client',
            makePlainBmpSession([
                {
                    key: 'semantic-peer',
                    peerIp: '198.51.100.202',
                    peerAs: 65102,
                    ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
                    routes: [qp, mvpn]
                }
            ])
        ]
    ])
);
const qpIssue = semantic.issues.find(issue => issue.prefix.includes('DQPN'));
const mvpnIssue = semantic.issues.find(issue => issue.prefix.startsWith('MVPN'));
assert.equal(qpIssue.routeLensQuery, '192.0.2.0|dqpn=4660');
assert.ok(mvpnIssue.routeLensQuery.startsWith('mvpn:type='));

console.log('BMP Route Assurance aggregation tests passed');
