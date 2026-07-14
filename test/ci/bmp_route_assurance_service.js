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

function makeRoute(ip, pathId) {
    return {
        afi: 1,
        safi: 1,
        rd: '0:0',
        ip,
        mask: 24,
        pathId,
        routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
        origin: 'IGP',
        asPath: '65001',
        nextHop: '192.0.2.254',
        localPref: 100,
        med: 0,
        communities: ['65000:100'],
        routeTlvs: [{ name: 'VRF/Table Name', value: 'cache-lab' }]
    };
}

function makeFixture(clientKey = 'cache-client') {
    const preIn = new CountingRouteMap([
        ['first', makeRoute('10.0.0.0', 1)],
        ['second', makeRoute('10.0.1.0', 2)]
    ]);
    const session = {
        sessionIp: '198.51.100.1',
        sessionAs: 65001,
        sessionRd: '0:0',
        vrfTableNames: ['cache-lab'],
        bgpRoutes: new Map([['1|1', new Map([[BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, preIn]])]])
    };
    return {
        preIn,
        sessionMap: new Map([
            [
                clientKey,
                {
                    getClientInfo: () => ({ sysName: clientKey, remoteIp: '192.0.2.1' }),
                    bgpSessionMap: new Map([['cache-peer', session]]),
                    bgpInstanceMap: new Map()
                }
            ]
        ])
    };
}

const fixture = makeFixture();
const service = new BmpRouteAssuranceService({ maxCacheEntries: 2 });

const firstPage = service.query(fixture.sessionMap, { page: 1, pageSize: 1 });
assert.equal(firstPage.summary.cacheHit, false);
assert.equal(firstPage.summary.dataRevision, 0);
assert.equal(firstPage.pagination.total, 2);
assert.equal(firstPage.issues.length, 1);
assert.equal(fixture.preIn.iterationCount, 1);

const secondPage = service.query(fixture.sessionMap, { page: 2, pageSize: 1 });
assert.equal(secondPage.summary.cacheHit, true);
assert.equal(secondPage.pagination.page, 2);
assert.equal(secondPage.issues.length, 1);
assert.notEqual(secondPage.issues[0].id, firstPage.issues[0].id);
assert.equal(fixture.preIn.iterationCount, 1, 'changing page must not scan the source RIB again');

const categoryPage = service.query(fixture.sessionMap, {
    category: 'inbound-gap',
    page: 1,
    pageSize: 200
});
assert.equal(categoryPage.summary.cacheHit, true);
assert.equal(categoryPage.pagination.total, 2);
assert.equal(fixture.preIn.iterationCount, 1, 'category and page size must reuse the aggregate snapshot');

const equivalentDefaults = service.query(fixture.sessionMap, {
    client: '  ',
    routeState: 'NOT-A-STATE',
    page: 1
});
assert.equal(equivalentDefaults.summary.cacheHit, true, 'normalized equivalent filters must share the cache key');

const filtered = service.query(fixture.sessionMap, { vrf: 'cache-lab', page: 1 });
assert.equal(filtered.summary.cacheHit, false);
assert.equal(fixture.preIn.iterationCount, 2, 'an analysis filter change must build a distinct snapshot');

const backToDefault = service.query(fixture.sessionMap, { page: 1 });
assert.equal(backToDefault.summary.cacheHit, true, 'recent snapshots should be retained by the LRU');
assert.equal(fixture.preIn.iterationCount, 2);

const revisionBeforeInvalidate = service.getStats().revision;
assert.equal(service.invalidate('route-monitoring-update'), revisionBeforeInvalidate + 1);
const rebuilt = service.query(fixture.sessionMap, { page: 1 });
assert.equal(rebuilt.summary.cacheHit, false);
assert.equal(rebuilt.summary.dataRevision, revisionBeforeInvalidate + 1);
assert.equal(fixture.preIn.iterationCount, 3);

const otherFixture = makeFixture('other-client');
const otherMapResult = service.query(otherFixture.sessionMap, { page: 1 });
assert.equal(otherMapResult.summary.cacheHit, false, 'different BMP session maps must never share snapshots');
assert.equal(otherFixture.preIn.iterationCount, 1);

const stats = service.getStats();
assert.equal(stats.cacheSize, 2);
assert.equal(stats.maxCacheEntries, 2);
assert.equal(stats.cacheHits, 4);
assert.equal(stats.cacheMisses, 4);
assert.equal(stats.aggregationCount, 4);
assert.equal(stats.invalidationCount, 1);
assert.equal(stats.lastInvalidationReason, 'route-monitoring-update');
assert.ok(stats.lastAggregationDurationMs >= 0);

const revisionBeforeClear = stats.revision;
assert.equal(service.clear(), revisionBeforeClear + 1);
assert.deepEqual(
    {
        cacheSize: service.getStats().cacheSize,
        revision: service.getStats().revision,
        lastInvalidationReason: service.getStats().lastInvalidationReason
    },
    { cacheSize: 0, revision: revisionBeforeClear + 1, lastInvalidationReason: 'clear' }
);

console.log('BMP Route Assurance revision cache service tests passed');
