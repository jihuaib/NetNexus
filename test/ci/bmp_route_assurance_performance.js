const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const BmpConst = require('../../electron/const/bmpConst');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');

if (typeof global.gc !== 'function') {
    const result = spawnSync(process.execPath, ['--expose-gc', __filename], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: process.env
    });
    process.exit(result.status ?? 1);
}

const PATH_COUNT = Number(process.env.BMP_ASSURANCE_PERF_ROUTES || 1_000_000);
const FIRST_BUILD_BUDGET_MS = Number(process.env.BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS || 15_000);
const CACHED_PAGE_BUDGET_MS = Number(process.env.BMP_ASSURANCE_CACHED_PAGE_BUDGET_MS || 100);
const RETAINED_HEAP_BUDGET_BYTES = Number(process.env.BMP_ASSURANCE_RETAINED_HEAP_BUDGET_BYTES || 512 * 1024 * 1024);
const PEAK_RSS_BUDGET_BYTES = Number(process.env.BMP_ASSURANCE_PEAK_RSS_BUDGET_BYTES || 1536 * 1024 * 1024);

assert.ok(Number.isInteger(PATH_COUNT) && PATH_COUNT >= 250, 'route count must be an integer of at least 250');
assert.equal(PATH_COUNT % 5, 0, 'route count must be divisible by the five RIB stages');

const PREFIX_COUNT = PATH_COUNT / 5;
const ANOMALY_COUNT = Math.min(
    PREFIX_COUNT,
    Number(process.env.BMP_ASSURANCE_PERF_ANOMALIES || Math.min(100_000, Math.max(1, Math.floor(PREFIX_COUNT / 2))))
);

function ipv4At(index) {
    assert.ok(index >= 0 && index < 0x01000000, 'the compact fixture supports up to 16,777,216 prefixes');
    return `10.${(index >>> 16) & 0xff}.${(index >>> 8) & 0xff}.${index & 0xff}`;
}

/**
 * Presents a million-path data set without allocating a million input route objects.
 * The production aggregate must copy only the compact information it actually needs.
 */
class VirtualRouteMap extends Map {
    constructor(count, identityAt) {
        super();
        this.count = count;
        this.identityAt = identityAt;
        this.iterationCount = 0;
        this.currentIndex = 0;
        this.route = {
            routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
            getRouteInfo: () => {
                const index = this.currentIndex;
                const identity = this.identityAt(index);
                return {
                    afi: 1,
                    safi: 1,
                    rd: '0:0',
                    ip: identity,
                    mask: 32,
                    pathId: index,
                    routeKey: `${index}|0:0|${identity}|32`,
                    routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
                    pathStatus: null,
                    origin: 'IGP',
                    asPath: '65001',
                    nextHop: '192.0.2.254',
                    localPref: 100,
                    med: 0,
                    communities: ['65000:100'],
                    labels: []
                };
            }
        };
    }

    get size() {
        return this.count;
    }

    *values() {
        this.iterationCount += 1;
        for (let index = 0; index < this.count; index += 1) {
            this.currentIndex = index;
            yield this.route;
        }
    }
}

function normalIdentity(index) {
    return ipv4At(index);
}

function preInIdentity(index) {
    // A small displaced range creates enough inbound-gap issues to exercise real pagination.
    return ipv4At(index < ANOMALY_COUNT ? PREFIX_COUNT + index : index);
}

const routeMaps = {
    preIn: new VirtualRouteMap(PREFIX_COUNT, preInIdentity),
    postIn: new VirtualRouteMap(PREFIX_COUNT, normalIdentity),
    locRib: new VirtualRouteMap(PREFIX_COUNT, normalIdentity),
    preOut: new VirtualRouteMap(PREFIX_COUNT, normalIdentity),
    postOut: new VirtualRouteMap(PREFIX_COUNT, normalIdentity)
};

const bgpSession = {
    getSessionInfo: () => ({
        sessionIp: '198.51.100.1',
        sessionAs: 65001,
        sessionRd: '0:0',
        vrfTableNames: ['million-route-lab']
    }),
    bgpRoutes: new Map([
        [
            '1|1',
            new Map([
                [BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, routeMaps.preIn],
                [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, routeMaps.postIn],
                [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT, routeMaps.preOut],
                [BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT, routeMaps.postOut]
            ])
        ]
    ])
};

const bgpInstance = {
    getInstanceInfo: () => ({
        afi: 1,
        safi: 1,
        instanceRd: '0:0',
        vrfTableNames: ['million-route-lab']
    }),
    bgpRoutes: routeMaps.locRib
};

const sessionMap = new Map([
    [
        'million-route-client',
        {
            getClientInfo: () => ({ sysName: 'million-route-router', remoteIp: '192.0.2.1' }),
            bgpSessionMap: new Map([['million-route-peer', bgpSession]]),
            bgpInstanceMap: new Map([['million-route-loc-rib', bgpInstance]])
        }
    ]
]);
const service = new BmpRouteAssuranceService();

const totalSourceIterations = () =>
    Object.values(routeMaps).reduce((total, routeMap) => total + routeMap.iterationCount, 0);

global.gc();
const heapBefore = process.memoryUsage().heapUsed;
const firstStartedAt = performance.now();
const firstPage = service.query(sessionMap, { page: 1, pageSize: 25 });
const firstBuildMs = performance.now() - firstStartedAt;
const maxRss = process.resourceUsage().maxRSS;
const currentRssBytes = process.memoryUsage().rss;
const peakRssBytes = [maxRss, maxRss * 1024]
    .filter(candidate => candidate >= currentRssBytes)
    .sort((left, right) => left - right)[0];
global.gc();
const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;
const iterationsAfterFirstBuild = totalSourceIterations();

assert.equal(firstPage.summary.scannedPathCount, PATH_COUNT);
assert.equal(firstPage.summary.cacheHit, false);
assert.ok(Number.isInteger(firstPage.summary.dataRevision));
assert.ok(firstPage.summary.aggregationDurationMs >= 0);
assert.ok(firstPage.summary.queryDurationMs >= 0);
assert.deepEqual(firstPage.funnel, {
    preIn: PREFIX_COUNT,
    postIn: PREFIX_COUNT,
    locRib: PREFIX_COUNT,
    preOut: PREFIX_COUNT,
    postOut: PREFIX_COUNT
});
assert.equal(firstPage.summary.categoryCounts['inbound-gap'], ANOMALY_COUNT);
assert.equal(firstPage.pagination.total, ANOMALY_COUNT);
assert.equal(firstPage.issues.length, Math.min(25, ANOMALY_COUNT));
assert.equal(iterationsAfterFirstBuild, 5, 'the initial aggregate must make exactly one pass over each RIB stage');
assert.ok(
    firstBuildMs <= FIRST_BUILD_BUDGET_MS,
    `one-million-path initial aggregate took ${firstBuildMs.toFixed(1)}ms (budget ${FIRST_BUILD_BUDGET_MS}ms)`
);
assert.ok(
    retainedHeapBytes <= RETAINED_HEAP_BUDGET_BYTES,
    `aggregate retained ${(retainedHeapBytes / 1024 / 1024).toFixed(1)}MiB (budget ${(
        RETAINED_HEAP_BUDGET_BYTES /
        1024 /
        1024
    ).toFixed(1)}MiB)`
);
assert.ok(
    peakRssBytes <= PEAK_RSS_BUDGET_BYTES,
    `aggregate peak RSS was ${(peakRssBytes / 1024 / 1024).toFixed(1)}MiB (budget ${(
        PEAK_RSS_BUDGET_BYTES /
        1024 /
        1024
    ).toFixed(1)}MiB)`
);

const cachedStartedAt = performance.now();
const secondPage = service.query(sessionMap, { page: 2, pageSize: 25 });
const cachedPageMs = performance.now() - cachedStartedAt;

assert.equal(secondPage.summary.cacheHit, true);
assert.equal(secondPage.summary.dataRevision, firstPage.summary.dataRevision);
assert.equal(secondPage.pagination.page, 2);
assert.equal(secondPage.pagination.total, ANOMALY_COUNT);
assert.equal(secondPage.issues.length, Math.min(25, Math.max(0, ANOMALY_COUNT - 25)));
assert.equal(
    totalSourceIterations(),
    iterationsAfterFirstBuild,
    'changing pages must reuse the aggregate cache instead of rescanning one million paths'
);
assert.ok(
    cachedPageMs <= CACHED_PAGE_BUDGET_MS,
    `cached pagination took ${cachedPageMs.toFixed(1)}ms (budget ${CACHED_PAGE_BUDGET_MS}ms)`
);

const categoryPageStartedAt = performance.now();
const categoryPage = service.query(sessionMap, {
    category: 'inbound-gap',
    page: Math.min(1000, Math.ceil(ANOMALY_COUNT / 25)),
    pageSize: 25
});
const categoryPageMs = performance.now() - categoryPageStartedAt;
assert.equal(categoryPage.summary.cacheHit, true);
assert.equal(categoryPage.pagination.total, ANOMALY_COUNT);
assert.equal(totalSourceIterations(), iterationsAfterFirstBuild, 'category pagination must not rescan the source RIB');
assert.ok(
    categoryPageMs <= CACHED_PAGE_BUDGET_MS,
    `cached category pagination took ${categoryPageMs.toFixed(1)}ms (budget ${CACHED_PAGE_BUDGET_MS}ms)`
);

service.invalidate('million-route-performance-test');
const invalidatedPage = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(invalidatedPage.summary.cacheHit, false);
assert.ok(invalidatedPage.summary.dataRevision > secondPage.summary.dataRevision);
assert.equal(
    totalSourceIterations(),
    iterationsAfterFirstBuild * 2,
    'invalidating the service must force exactly one new pass over every RIB stage'
);
assert.ok(service.getStats().aggregationCount >= 2);

console.log(
    `BMP Route Assurance ${PATH_COUNT.toLocaleString('en-US')}-path benchmark passed: ` +
        `initial=${firstBuildMs.toFixed(1)}ms, cached-page=${cachedPageMs.toFixed(1)}ms, ` +
        `cached-category-page=${categoryPageMs.toFixed(1)}ms, ` +
        `retained-heap=${Math.max(0, retainedHeapBytes / 1024 / 1024).toFixed(1)}MiB, ` +
        `peak-rss=${(peakRssBytes / 1024 / 1024).toFixed(1)}MiB`
);
