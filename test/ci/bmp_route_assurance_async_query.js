const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');

class CountingRouteMap extends Map {
    constructor(entries) {
        super(entries);
        this.iterationCount = 0;
    }

    *values() {
        this.iterationCount += 1;
        yield* super.values();
    }
}

function makeRoute(index) {
    const ip = `10.99.${Math.floor(index / 256)}.${index % 256}`;
    return {
        routeKey: `route-${index}`,
        afi: 1,
        safi: 1,
        rd: '0:0',
        ip,
        mask: 32,
        pathId: index + 1,
        routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
        origin: 'IGP',
        asPath: '65099',
        nextHop: '192.0.2.99',
        localPref: 100,
        med: 0,
        communities: ['65099:100'],
        routeTlvs: [{ name: 'VRF/Table Name', value: 'async-query' }]
    };
}

async function verifyAsyncCacheMiss() {
    const routes = new CountingRouteMap();
    for (let index = 0; index < 250; index += 1) {
        const route = makeRoute(index);
        routes.set(route.routeKey, route);
    }
    const clientKey = 'async-query-client';
    const ownerKey = 'async-query-peer';
    const owner = {
        getSessionInfo: () => ({
            sessionIp: '198.51.100.99',
            sessionAs: 65099,
            sessionRd: '0:0',
            vrfTableNames: ['async-query']
        }),
        bgpRoutes: new Map([['1|1', new Map([[BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, routes]])]])
    };
    const bmpSession = {
        getClientInfo: () => ({ sysName: 'async-query-router', remoteIp: '192.0.2.99' }),
        bgpSessionMap: new Map([[ownerKey, owner]]),
        bgpInstanceMap: new Map()
    };
    const sessionMap = new Map([[clientKey, bmpSession]]);
    const service = new BmpRouteAssuranceService();
    let eventLoopYielded = false;
    let mutationApplied = false;
    setImmediate(() => {
        eventLoopYielded = true;
    });

    const first = await service.queryAsync(
        sessionMap,
        { page: 1, pageSize: 25 },
        {
            chunkSize: 100,
            onProgress: status => {
                if (mutationApplied || Number(status.progress?.scannedPathCount) < 100) {
                    return;
                }
                mutationApplied = true;
                const route = makeRoute(250);
                routes.set(route.routeKey, route);
                service.applyMutation({
                    action: 'upsert',
                    isNew: true,
                    clientKey,
                    bmpSession,
                    scope: 'session',
                    ownerKey,
                    owner,
                    ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
                    routeKey: route.routeKey,
                    route
                });
            }
        }
    );

    assert.equal(eventLoopYielded, true, 'filter cache miss must yield instead of blocking the BMP worker');
    assert.equal(mutationApplied, true);
    assert.equal(first.summary.cacheHit, false);
    assert.equal(first.summary.scannedPathCount, routes.size);
    assert.equal(first.summary.stagePathCounts.preIn, routes.size);
    assert.equal(first.summary.categoryCounts['inbound-gap'], routes.size);
    assert.equal(routes.iterationCount, 1);

    const cachedPage = await service.queryAsync(sessionMap, { page: 2, pageSize: 25 });
    assert.equal(cachedPage.summary.cacheHit, true);
    assert.equal(routes.iterationCount, 1, 'pagination must reuse the async snapshot');
}

verifyAsyncCacheMiss()
    .then(() => console.log('BMP Route Assurance async query tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
