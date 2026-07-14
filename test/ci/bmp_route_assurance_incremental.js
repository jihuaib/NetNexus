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

const makeRoute = (routeKey, pathId = 1) => ({
    routeKey,
    afi: 1,
    safi: 1,
    rd: '0:0',
    ip: '10.10.10.0',
    mask: 24,
    pathId,
    routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
    origin: 'IGP',
    asPath: '65001',
    nextHop: '192.0.2.254',
    localPref: 100,
    med: 0,
    communities: ['65000:100'],
    routeTlvs: [{ name: 'VRF/Table Name', value: 'incremental-lab' }]
});

const clientKey = 'incremental-client';
const ownerKey = 'incremental-peer';
const bmpSession = {
    getClientInfo: () => ({ sysName: 'incremental-router', remoteIp: '192.0.2.1' })
};
const bgpSession = {
    getSessionInfo: () => ({
        sessionIp: '198.51.100.1',
        sessionAs: 65001,
        sessionRd: '0:0',
        vrfTableNames: ['incremental-lab']
    })
};
const routeKey = '1|0:0|10.10.10.0|24';
const preIn = new CountingRouteMap([[routeKey, makeRoute(routeKey)]]);
const postIn = new CountingRouteMap();
const preOut = new CountingRouteMap();
const postOut = new CountingRouteMap();
const locRib = new CountingRouteMap();
bgpSession.bgpRoutes = new Map([
    [
        '1|1',
        new Map([
            [BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, preIn],
            [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, postIn],
            [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT, preOut],
            [BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT, postOut]
        ])
    ]
]);
const bgpInstance = {
    getInstanceInfo: () => ({ afi: 1, safi: 1, instanceRd: '0:0', vrfTableNames: ['incremental-lab'] }),
    bgpRoutes: locRib
};
bmpSession.bgpSessionMap = new Map([[ownerKey, bgpSession]]);
bmpSession.bgpInstanceMap = new Map([['incremental-instance', bgpInstance]]);
const sessionMap = new Map([[clientKey, bmpSession]]);

const service = new BmpRouteAssuranceService();
const first = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(first.summary.categoryCounts['inbound-gap'], 1);
assert.equal(first.summary.cacheHit, false);
const initialIterations = preIn.iterationCount + postIn.iterationCount + preOut.iterationCount + postOut.iterationCount;

const applySessionUpsert = (ribType, route) =>
    service.applyMutation({
        action: 'upsert',
        isNew: true,
        clientKey,
        bmpSession,
        scope: 'session',
        ownerKey,
        owner: bgpSession,
        ribType,
        routeKey,
        route
    });

assert.equal(applySessionUpsert(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, makeRoute(routeKey)), true);
let result = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(result.summary.cacheHit, true);
assert.equal(result.summary.categoryCounts['inbound-gap'], 0);
assert.equal(result.summary.categoryCounts['not-selected'], 1);

assert.equal(
    service.applyMutation({
        action: 'upsert',
        isNew: true,
        clientKey,
        bmpSession,
        scope: 'instance',
        ownerKey: 'incremental-instance',
        owner: bgpInstance,
        stage: 'locRib',
        routeKey,
        route: makeRoute(routeKey)
    }),
    true
);
result = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(result.summary.categoryCounts['not-selected'], 0);
assert.equal(result.summary.categoryCounts['not-exported'], 1);

applySessionUpsert(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT, makeRoute(routeKey));
result = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(result.summary.categoryCounts['not-exported'], 0);
assert.equal(result.summary.categoryCounts['outbound-gap'], 1);

applySessionUpsert(BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT, makeRoute(routeKey));
result = service.query(sessionMap, { page: 1, pageSize: 25 });
assert.equal(result.pagination.total, 0);
assert.equal(result.summary.incrementalUpdateCount, 4);
assert.ok(result.summary.dataRevision >= 4);
assert.equal(
    preIn.iterationCount + postIn.iterationCount + preOut.iterationCount + postOut.iterationCount,
    initialIterations,
    'route deltas must update the live matrix without rescanning the source RIB maps'
);

async function verifyBootstrapSwitch() {
    service.setEnabled(false);
    assert.equal(service.applyMutation({ action: 'delete', clientKey, ownerKey, routeKey }), false);
    assert.throws(() => service.query(sessionMap), /分析未开启/);

    const bootstrapService = new BmpRouteAssuranceService({ enabled: false });
    const bootstrapPromise = bootstrapService.enableWithBootstrap(sessionMap, {}, { chunkSize: 100 });
    assert.equal(bootstrapService.getStatus().state, 'bootstrapping');
    const bootstrapStatus = await bootstrapPromise;
    assert.equal(bootstrapStatus.enabled, true);
    assert.equal(bootstrapStatus.state, 'ready');
    const bootstrappedResult = bootstrapService.query(sessionMap, { page: 1, pageSize: 25 });
    assert.equal(bootstrappedResult.summary.cacheHit, true);
    assert.equal(bootstrappedResult.summary.scannedPathCount, 1);

    bootstrapService.setEnabled(false);
    assert.equal(bootstrapService.getStatus().state, 'disabled');
    assert.equal(bootstrapService.getStats().cacheSize, 0);
}

async function verifyBootstrapMutationRace() {
    const raceClientKey = 'bootstrap-race-client';
    const raceOwnerKey = 'bootstrap-race-peer';
    const raceRouteMap = new CountingRouteMap();
    for (let index = 0; index < 200; index += 1) {
        const thirdOctet = Math.floor(index / 256);
        const fourthOctet = index % 256;
        const ip = `10.${thirdOctet}.${fourthOctet}.0`;
        const key = `1|0:0|${ip}|24`;
        raceRouteMap.set(key, {
            ...makeRoute(key, index + 1),
            ip
        });
    }
    const raceOwner = {
        getSessionInfo: () => ({
            sessionIp: '198.51.100.20',
            sessionAs: 65020,
            sessionRd: '0:0',
            vrfTableNames: ['incremental-lab']
        }),
        bgpRoutes: new Map([
            [
                '1|1',
                new Map([
                    [BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, raceRouteMap],
                    [
                        BmpConst.BMP_BGP_RIB_TYPE.AS_PATH,
                        new Map([
                            ['unsupported-a', makeRoute('unsupported-a', 501)],
                            ['unsupported-b', makeRoute('unsupported-b', 502)]
                        ])
                    ]
                ])
            ]
        ])
    };
    const raceBmpSession = {
        getClientInfo: () => ({ sysName: 'bootstrap-race-router', remoteIp: '192.0.2.20' }),
        bgpSessionMap: new Map([[raceOwnerKey, raceOwner]]),
        bgpInstanceMap: new Map()
    };
    const raceSessionMap = new Map([[raceClientKey, raceBmpSession]]);
    const raceService = new BmpRouteAssuranceService({ enabled: false });
    const replacedKey = raceRouteMap.keys().next().value;
    const originalRoute = raceRouteMap.get(replacedKey);
    let replacementRoute = null;
    let mutationApplied = false;

    await raceService.enableWithBootstrap(
        raceSessionMap,
        {},
        {
            chunkSize: 100,
            onProgress: status => {
                if (mutationApplied || Number(status.progress?.scannedPathCount) < 100) {
                    return;
                }
                mutationApplied = true;
                raceRouteMap.delete(replacedKey);
                raceService.applyMutation({
                    action: 'delete',
                    isNew: false,
                    clientKey: raceClientKey,
                    bmpSession: raceBmpSession,
                    scope: 'session',
                    ownerKey: raceOwnerKey,
                    owner: raceOwner,
                    ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
                    routeKey: replacedKey,
                    route: originalRoute,
                    previous: originalRoute
                });
                replacementRoute = { ...originalRoute, nextHop: '192.0.2.99' };
                raceRouteMap.set(replacedKey, replacementRoute);
                raceService.applyMutation({
                    action: 'upsert',
                    isNew: true,
                    clientKey: raceClientKey,
                    bmpSession: raceBmpSession,
                    scope: 'session',
                    ownerKey: raceOwnerKey,
                    owner: raceOwner,
                    ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
                    routeKey: replacedKey,
                    route: replacementRoute
                });
            }
        }
    );

    assert.equal(mutationApplied, true);
    const result = raceService.query(raceSessionMap, { page: 1, pageSize: 25 });
    assert.equal(result.summary.scannedPathCount, raceRouteMap.size);
    assert.equal(result.summary.filteredPathCount, raceRouteMap.size);
    assert.equal(result.summary.stagePathCounts.preIn, raceRouteMap.size);
    assert.equal(result.summary.categoryCounts['inbound-gap'], raceRouteMap.size);
    const analysis = raceService.cache.values().next().value.analysis;
    assert.equal(analysis._incremental.sourceEntries.has(originalRoute), false);
    assert.equal(analysis._incremental.sourceEntries.has(replacementRoute), true);
}

async function verifyBootstrapInvalidationCancelsOldGeneration() {
    const ghostRouteMap = new CountingRouteMap();
    for (let index = 0; index < 200; index += 1) {
        const ip = `172.16.${index}.0`;
        ghostRouteMap.set(`ghost-${index}`, { ...makeRoute(`ghost-${index}`, index + 1), ip });
    }
    const ghostOwner = {
        getSessionInfo: () => ({ sessionIp: '198.51.100.30', sessionAs: 65030, sessionRd: '0:0' }),
        bgpRoutes: new Map([['1|1', new Map([[BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, ghostRouteMap]])]])
    };
    const ghostBmpSession = {
        getClientInfo: () => ({ sysName: 'ghost-router', remoteIp: '192.0.2.30' }),
        bgpSessionMap: new Map([['ghost-owner', ghostOwner]]),
        bgpInstanceMap: new Map()
    };
    const ghostSessionMap = new Map([['ghost-client', ghostBmpSession]]);
    const ghostService = new BmpRouteAssuranceService({ enabled: false });
    let invalidated = false;
    const cancelledStatus = await ghostService.enableWithBootstrap(
        ghostSessionMap,
        {},
        {
            chunkSize: 100,
            onProgress: status => {
                if (invalidated || Number(status.progress?.scannedPathCount) < 100) {
                    return;
                }
                invalidated = true;
                ghostRouteMap.clear();
                ghostService.invalidate('session-close', { prepareBootstrap: true });
            }
        }
    );

    assert.equal(invalidated, true);
    assert.equal(cancelledStatus.state, 'dirty');
    assert.equal(ghostService.getStats().cacheSize, 0);
    assert.throws(() => ghostService.query(ghostSessionMap), /重新同步/);

    await ghostService.enableWithBootstrap(ghostSessionMap, {});
    const rebuilt = ghostService.query(ghostSessionMap, { page: 1, pageSize: 25 });
    assert.equal(rebuilt.summary.scannedPathCount, 0);
    assert.equal(rebuilt.summary.filteredPathCount, 0);
    assert.equal(rebuilt.summary.stagePathCounts.preIn, 0);
}

verifyBootstrapSwitch()
    .then(verifyBootstrapMutationRace)
    .then(verifyBootstrapInvalidationCancelsOldGeneration)
    .then(() => console.log('BMP Route Assurance incremental update tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
