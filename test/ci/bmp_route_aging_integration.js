const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpSession = require('../../electron/worker/bmp/bmpSession');

const AFI = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
const SAFI = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-route-aging-'));

function makeRoute(owner, prefix, epoch) {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: AFI,
        safi: SAFI,
        ribType: RIB_TYPE,
        pathId: 0,
        rd: '0:0',
        ip: prefix,
        mask: 24,
        nlriDetail: { prefix, length: 24, pathId: 0, rd: '0:0' }
    });
    route.assignRouteAttr({ origin: 'IGP', nextHop: '192.0.2.254' });
    route.markActive(epoch);
    return route;
}

async function createHarness(name, remotePort) {
    const committedBatches = [];
    const persistenceFailures = [];
    const mutations = [];
    const client = new BmpPersistenceClient({
        dbPath: path.join(tempDir, `${name}.sqlite3`),
        batchSize: 100,
        flushMs: 1000,
        onCommittedBatch(result, batch) {
            committedBatches.push({ result, batch });
        }
    });
    await client.open();

    const worker = {
        bmpConfigData: {},
        persistence: client,
        enqueuePersistenceMutation(mutation) {
            mutations.push(mutation);
            client.enqueue(mutation);
            return true;
        },
        handlePersistenceFailure(error) {
            persistenceFailures.push(error);
        },
        enqueueRouteUpdateEvent() {},
        invalidateRouteAssurance() {},
        requestPersistenceSweep() {}
    };
    const bmpSession = new BmpSession({ sendEvent() {} }, worker);
    Object.assign(bmpSession, {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort,
        sysName: 'aging-integration-router',
        bmpVersion: BmpConst.BMP_VERSION.V4
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
    owner.ensureRouteScope(AFI, SAFI, RIB_TYPE);

    return {
        bmpSession,
        client,
        committedBatches,
        mutations,
        owner,
        persistenceFailures,
        scopeId: bmpSession.getPersistenceScopeId(owner, AFI, SAFI, RIB_TYPE, 'peer')
    };
}

async function seedRoutes(harness, prefixes, eventAtMs) {
    harness.bmpSession.persistScopeState(harness.owner, AFI, SAFI, RIB_TYPE, 'peer', 'ready', 'scope_open', {
        eventAtMs
    });
    prefixes.forEach(prefix => {
        const route = makeRoute(harness.owner, prefix, harness.owner.getRibEpoch(AFI, SAFI, RIB_TYPE));
        harness.bmpSession.persistSessionRouteUpsert(harness.owner, route, AFI, SAFI, RIB_TYPE, { eventAtMs });
    });
    await harness.client.fence();
}

function startRefresh(harness, refreshedPrefix, refreshStartedAtMs) {
    const routeCount = harness.owner.getRouteSummary(AFI, SAFI, RIB_TYPE).total || 3;
    harness.owner.setRouteSummary(AFI, SAFI, RIB_TYPE, { active: routeCount, stale: 0, total: routeCount });
    const stale = harness.owner.markRoutesStale(AFI, SAFI, [RIB_TYPE], 'peer-up-refresh')[0];
    assert.equal(stale.staleEpoch, 1);
    harness.bmpSession.persistScopeState(harness.owner, AFI, SAFI, RIB_TYPE, 'peer', 'syncing', 'scope_open', {
        eventAtMs: refreshStartedAtMs,
        reason: 'peer-up-refresh'
    });
    const currentRoute = makeRoute(harness.owner, refreshedPrefix, harness.owner.getRibEpoch(AFI, SAFI, RIB_TYPE));
    harness.bmpSession.persistSessionRouteUpsert(harness.owner, currentRoute, AFI, SAFI, RIB_TYPE);
    return currentRoute;
}

function testMutationBuildFailureIsFailClosed(harness) {
    const buildError = new Error('canonical route identity is unavailable');
    const mutationsBefore = harness.mutations.length;
    assert.equal(
        harness.bmpSession.makeAndEnqueuePersistenceMutation(() => {
            throw buildError;
        }),
        false
    );
    assert.deepEqual(harness.persistenceFailures, [buildError]);
    assert.equal(harness.mutations.length, mutationsBefore);
}

async function testRefreshTimeoutFinalization() {
    const harness = await createHarness('refresh-timeout', 50001);
    try {
        const initialAtMs = Date.now() - 30 * 60 * 1000;
        const refreshStartedAtMs = Date.now() - 20 * 60 * 1000;
        await seedRoutes(harness, ['203.0.113.0', '203.0.114.0', '203.0.115.0'], initialAtMs);
        startRefresh(harness, '203.0.113.0', refreshStartedAtMs);
        await harness.client.fence();

        let routes = await harness.client.queryRoutes({ scopeId: harness.scopeId, routeState: 'all', pageSize: 10 });
        assert.equal(routes.total, 3);
        assert.equal(routes.list.filter(route => route.routeState === 'active').length, 1);
        assert.equal(routes.list.filter(route => route.routeState === 'stale').length, 2);
        let summary = await harness.client.queryScopeSummary({ scopeId: harness.scopeId });
        assert.equal(summary.scopes[0].scopeState, 'syncing');
        assert.equal(summary.scopes[0].currentEpoch, 1);

        const beforeDeadline = await harness.client.sweep({
            staleBeforeMs: 0,
            refreshTimeoutBeforeMs: refreshStartedAtMs - 1,
            eventsBeforeMs: 0,
            routeLimit: 1
        });
        assert.equal(beforeDeadline.routes, 0);

        const firstSweep = await harness.client.sweep({
            staleBeforeMs: 0,
            refreshTimeoutBeforeMs: Date.now() - 10 * 60 * 1000,
            eventsBeforeMs: 0,
            routeLimit: 1
        });
        assert.equal(firstSweep.routes, 1);
        assert.equal(firstSweep.refreshTimeoutScopes, 0);
        summary = await harness.client.queryScopeSummary({ scopeId: harness.scopeId });
        assert.equal(summary.scopes[0].scopeState, 'syncing');

        const secondSweep = await harness.client.sweep({
            staleBeforeMs: 0,
            refreshTimeoutBeforeMs: Date.now() - 10 * 60 * 1000,
            eventsBeforeMs: 0,
            routeLimit: 1
        });
        assert.equal(secondSweep.routes, 1);
        assert.equal(secondSweep.refreshTimeoutScopes, 1);
        routes = await harness.client.queryRoutes({ scopeId: harness.scopeId, routeState: 'all' });
        assert.equal(routes.total, 1);
        assert.equal(routes.list[0].ip, '203.0.113.0');
        assert.equal(routes.list[0].routeState, 'active');
        summary = await harness.client.queryScopeSummary({ scopeId: harness.scopeId });
        assert.equal(summary.scopes[0].scopeState, 'ready');
        assert.equal(summary.scopes[0].staleReason, 'refresh-timeout');
        assert.deepEqual(
            { active: summary.active, stale: summary.stale, total: summary.total },
            {
                active: 1,
                stale: 0,
                total: 1
            }
        );

        testMutationBuildFailureIsFailClosed(harness);
        assert.ok(
            harness.committedBatches.some(batch =>
                batch.result.deltas.some(delta => delta.classification === 'announce')
            ),
            'the client callback should expose committed SQLite route deltas'
        );
    } finally {
        await harness.client.close({ suppressErrors: true });
    }
}

async function testEorOwnsCleanup() {
    const harness = await createHarness('eor-cleanup', 50002);
    try {
        const initialAtMs = Date.now() - 30 * 60 * 1000;
        const refreshStartedAtMs = Date.now() - 20 * 60 * 1000;
        await seedRoutes(harness, ['198.51.100.0', '198.51.101.0'], initialAtMs);
        startRefresh(harness, '198.51.100.0', refreshStartedAtMs);
        harness.bmpSession.persistScopeState(harness.owner, AFI, SAFI, RIB_TYPE, 'peer', 'ready', 'scope_eor', {
            reason: 'eor'
        });
        await harness.client.fence();

        let summary = await harness.client.queryScopeSummary({ scopeId: harness.scopeId });
        assert.equal(summary.scopes[0].scopeState, 'ready');
        assert.equal(summary.scopes[0].eorEpoch, 1);
        assert.equal(summary.stale, 1);

        const swept = await harness.client.sweep({
            staleBeforeMs: 0,
            refreshTimeoutBeforeMs: Date.now(),
            eventsBeforeMs: 0,
            routeLimit: 10
        });
        assert.equal(swept.routes, 1);
        assert.equal(swept.finalizedCleanupScopes, 1);
        assert.equal(swept.refreshTimeoutScopes, 0);

        const routes = await harness.client.queryRoutes({ scopeId: harness.scopeId, routeState: 'all' });
        assert.equal(routes.total, 1);
        assert.equal(routes.list[0].ip, '198.51.100.0');
        assert.equal(routes.list[0].routeState, 'active');
        summary = await harness.client.queryScopeSummary({ scopeId: harness.scopeId });
        assert.equal(summary.scopes[0].scopeState, 'ready');
        assert.equal(summary.scopes[0].eorEpoch, 1);
        assert.equal(summary.scopes[0].staleReason, null);

        const events = await harness.client.queryEvents({ scopeId: harness.scopeId, pageSize: 100 });
        assert.ok(events.list.some(event => event.eventType === 'scope_eor'));
        assert.equal(
            events.list.some(event => event.eventType === 'scope_timeout'),
            false
        );
    } finally {
        await harness.client.close({ suppressErrors: true });
    }
}

async function main() {
    try {
        await testRefreshTimeoutFinalization();
        await testEorOwnsCleanup();
        console.log('BMP SQLite route aging integration tests passed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
