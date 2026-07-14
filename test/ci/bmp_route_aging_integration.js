const assert = require('node:assert/strict');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpRouteAgingScheduler = require('../../electron/worker/bmp/bmpRouteAgingScheduler');
const BmpSession = require('../../electron/worker/bmp/bmpSession');

const AFI = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
const SAFI = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;

function nextImmediate() {
    return new Promise(resolve => setImmediate(resolve));
}

async function waitForSchedulerIdle(scheduler, label, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (scheduler.getStatus().jobs > 0) {
        if (Date.now() >= deadline) {
            throw new Error(`${label} timed out`);
        }
        await nextImmediate();
    }
    // Give a replaced timer or already queued pump one more turn to expose a
    // duplicate completion callback before assertions are made.
    await nextImmediate();
}

function makeRoute(owner, prefix, epoch) {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: AFI,
        safi: SAFI,
        ribType: RIB_TYPE,
        pathId: 0,
        rd: '0:0',
        ip: prefix,
        mask: 24
    });
    route.markActive(epoch);
    return route;
}

function createHarness(remotePort) {
    const mutations = [];
    const persistenceFailures = [];
    const routeUpdates = [];
    const schedulerErrors = [];
    const scheduler = new BmpRouteAgingScheduler({
        batchSize: 1,
        timeBudgetMs: 100,
        onError: (error, key, phase) => schedulerErrors.push({ error, key, phase })
    });
    const worker = {
        bmpConfigData: {},
        persistence: {},
        enqueuePersistenceMutation(mutation) {
            mutations.push(mutation);
            return true;
        },
        handlePersistenceFailure(error) {
            persistenceFailures.push(error);
        },
        enqueueRouteUpdateEvent(update) {
            routeUpdates.push(update);
        },
        invalidateRouteAssurance() {},
        scheduleInMemoryRouteAging(options) {
            return scheduler.schedule(options);
        }
    };
    const messageHandler = { sendEvent() {} };
    const bmpSession = new BmpSession(messageHandler, worker);
    Object.assign(bmpSession, {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort,
        sysName: 'aging-integration-router',
        bmpVersion: BmpConst.BMP_VERSION.V3
    });

    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, {
        sessionType: BmpConst.BMP_PEER_TYPE.GLOBAL,
        sessionRd: '0:0',
        sessionRdRaw: 'raw:0000000000000000',
        sessionIp: '198.51.100.1',
        sessionAs: 64512,
        sessionState: BmpConst.BMP_SESSION_STATE.PEER_UP
    });
    owner.ribTypes.push(RIB_TYPE);

    const oldRoute = makeRoute(owner, '203.0.113.0', owner.getRibEpoch(AFI, SAFI, RIB_TYPE));
    const routeMap = new Map([[oldRoute.getRouteKey(), oldRoute]]);
    owner.bgpRoutes.set(`${AFI}|${SAFI}`, new Map([[RIB_TYPE, routeMap]]));
    owner.recordRouteAdd(AFI, SAFI, RIB_TYPE, oldRoute);

    const stale = owner.markRoutesStale(AFI, SAFI, [RIB_TYPE], 'peer-up-refresh')[0];
    assert.equal(stale.staleEpoch, 1);
    assert.equal(oldRoute.routeState, BmpConst.BMP_ROUTE_STATE.STALE);

    bmpSession.persistScopeState(owner, AFI, SAFI, RIB_TYPE, 'peer', 'syncing', 'scope_open');

    return {
        bmpSession,
        mutations,
        oldRoute,
        owner,
        persistenceFailures,
        routeMap,
        routeUpdates,
        scheduler,
        schedulerErrors
    };
}

function testMutationBuildFailureIsFailClosed() {
    const harness = createHarness(50003);
    const buildError = new Error('canonical route identity is unavailable');

    assert.equal(
        harness.bmpSession.makeAndEnqueuePersistenceMutation(() => {
            throw buildError;
        }),
        false
    );
    assert.deepEqual(harness.persistenceFailures, [buildError]);
}

function scopeEvents(harness) {
    return harness.mutations.filter(mutation => mutation.scope).map(mutation => mutation.eventType);
}

async function testRefreshTimeoutFinalization() {
    const harness = createHarness(50001);
    const currentRoute = makeRoute(harness.owner, '203.0.114.0', harness.owner.getRibEpoch(AFI, SAFI, RIB_TYPE));
    harness.routeMap.set(currentRoute.getRouteKey(), currentRoute);
    harness.owner.recordRouteAdd(AFI, SAFI, RIB_TYPE, currentRoute);

    assert.deepEqual(harness.owner.getRouteSummary(AFI, SAFI, RIB_TYPE), {
        active: 1,
        stale: 1,
        total: 2
    });
    assert.equal(
        harness.bmpSession.scheduleSessionRouteAging(harness.owner, AFI, SAFI, RIB_TYPE, 0, {
            finalizeRefreshTimeout: true
        }),
        true
    );

    await waitForSchedulerIdle(harness.scheduler, 'refresh-timeout aging');

    assert.equal(harness.routeMap.has(harness.oldRoute.getRouteKey()), false, 'the previous epoch route must age out');
    assert.equal(
        harness.routeMap.get(currentRoute.getRouteKey()),
        currentRoute,
        'the current epoch route must survive'
    );
    assert.deepEqual(harness.owner.getRouteSummary(AFI, SAFI, RIB_TYPE), {
        active: 1,
        stale: 0,
        total: 1
    });
    assert.deepEqual(scopeEvents(harness), ['scope_open', 'scope_timeout']);

    const timeoutMutation = harness.mutations.find(mutation => mutation.eventType === 'scope_timeout');
    assert.ok(timeoutMutation, 'refresh timeout must be persisted');
    assert.equal(timeoutMutation.scope.epoch, 1);
    assert.equal(timeoutMutation.scope.state, 'ready');
    assert.equal(timeoutMutation.reason, 'refresh-timeout');
    assert.equal(harness.bmpSession.getPersistenceScopeState(harness.owner, AFI, SAFI, RIB_TYPE), 'ready');
    assert.deepEqual(
        harness.routeUpdates.map(update => ({ type: update.type, changedCount: update.changedCount })),
        [{ type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE, changedCount: 1 }]
    );
    assert.deepEqual(harness.schedulerErrors, []);
}

async function testEorWinsRefreshTimeoutRace() {
    const harness = createHarness(50002);
    assert.equal(
        harness.bmpSession.scheduleSessionRouteAging(harness.owner, AFI, SAFI, RIB_TYPE, 10_000, {
            finalizeRefreshTimeout: true
        }),
        true
    );
    assert.deepEqual(harness.scheduler.getStatus(), { jobs: 1, ready: 0 });
    assert.equal(harness.routeMap.has(harness.oldRoute.getRouteKey()), true);

    harness.bmpSession.persistScopeState(harness.owner, AFI, SAFI, RIB_TYPE, 'peer', 'ready', 'scope_eor');
    assert.equal(
        harness.bmpSession.scheduleSessionRouteAging(harness.owner, AFI, SAFI, RIB_TYPE, 0),
        false,
        'EOR must reuse and accelerate the fixed scope job instead of creating a competing timeout job'
    );
    assert.equal(harness.scheduler.getStatus().jobs, 1);

    await waitForSchedulerIdle(harness.scheduler, 'EOR aging');

    assert.equal(harness.routeMap.has(harness.oldRoute.getRouteKey()), false);
    assert.deepEqual(scopeEvents(harness), ['scope_open', 'scope_eor']);
    assert.equal(
        harness.mutations.some(mutation => mutation.eventType === 'scope_timeout'),
        false,
        'the replaced refresh-timeout callback must not overwrite EOR'
    );
    assert.equal(harness.bmpSession.getPersistenceScopeState(harness.owner, AFI, SAFI, RIB_TYPE), 'ready');
    assert.equal(harness.mutations.at(-1).eventType, 'scope_eor');
    assert.deepEqual(harness.scheduler.getStatus(), { jobs: 0, ready: 0 });
    assert.deepEqual(harness.schedulerErrors, []);
}

async function main() {
    testMutationBuildFailureIsFailClosed();
    await testRefreshTimeoutFinalization();
    await testEorWinsRefreshTimeoutRace();
    console.log('BMP route aging persistence integration tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
