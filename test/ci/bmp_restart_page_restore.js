const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');

const BmpConst = require('../../electron/const/bmpConst');
const { getAddrFamilyType } = require('../../electron/utils/bgpUtils');
const { buildScenario, parseArgs } = require('../../scripts/mockBmpClient');

const workerPath = path.join(__dirname, '..', '..', 'electron', 'worker', 'bmp', 'bmpWorker.js');
const defaultLocRibPrefix = '10.30.0.0';
const defaultPeerPrefix = '10.10.0.0';

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function createRequester(worker, requestPrefix) {
    const pending = new Map();
    let sequence = 0;

    worker.on('message', message => {
        const waiter = pending.get(message.messageId);
        if (!waiter) {
            return;
        }
        pending.delete(message.messageId);
        if (message.status === 'success') {
            waiter.resolve(message);
        } else {
            waiter.reject(new Error(message.msg || 'BMP worker request failed'));
        }
    });
    worker.on('error', error => {
        pending.forEach(waiter => waiter.reject(error));
        pending.clear();
    });
    worker.on('exit', code => {
        if (code === 0 || pending.size === 0) {
            return;
        }
        const error = new Error(`BMP worker exited with code ${code}`);
        pending.forEach(waiter => waiter.reject(error));
        pending.clear();
    });

    return (op, data = null) => {
        sequence += 1;
        const messageId = `${requestPrefix}-${sequence}`;
        return new Promise((resolve, reject) => {
            pending.set(messageId, { resolve, reject });
            worker.postMessage({ messageId, op, data });
        });
    };
}

async function startWorker(dbPath, port, name) {
    const worker = new Worker(workerPath);
    const request = createRequester(worker, name);
    try {
        await request(BmpConst.BMP_REQ_TYPES.START_BMP, {
            port,
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
            pathMarkingTlvType: BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
            enableAuth: false,
            persistenceEnabled: true,
            persistenceDbPath: dbPath,
            persistenceBatchSize: 64,
            persistenceFlushMs: 5,
            persistenceHighWatermarkBytes: 4 * 1024 * 1024,
            persistenceLowWatermarkBytes: 2 * 1024 * 1024,
            persistenceStaleRetentionMs: 60 * 60 * 1000,
            persistenceEventRetentionMs: 60 * 60 * 1000
        });
        return { worker, request, stopped: false };
    } catch (error) {
        await worker.terminate().catch(() => {});
        throw error;
    }
}

async function stopWorker(harness) {
    if (!harness || harness.stopped) {
        return;
    }
    harness.stopped = true;
    try {
        await harness.request(BmpConst.BMP_REQ_TYPES.STOP_BMP);
    } finally {
        await harness.worker.terminate().catch(() => {});
    }
}

function sendScenario(port, messages) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setNoDelay(true);
        socket.once('error', reject);
        socket.once('connect', async () => {
            try {
                for (const message of messages) {
                    if (!socket.write(message.data)) {
                        await once(socket, 'drain');
                    }
                }
                resolve(socket);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function waitFor(description, action, predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const value = await action();
            if (predicate(value)) {
                return value;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function isOnline(item) {
    return item?.isOnline ?? item?.online;
}

function findScope(scopes, scopeId) {
    return (Array.isArray(scopes) ? scopes : []).find(scope => scope.persistentScopeId === scopeId);
}

function findSessionByScope(sessions, scopeId) {
    return sessions.find(session => findScope(session.routeScopes, scopeId));
}

function findInstanceByScope(instances, scopeId) {
    return instances.find(instance => instance.persistentScopeId === scopeId);
}

function assertUnique(items, keySelector, label) {
    const keys = items.map(keySelector);
    assert.equal(keys.every(Boolean), true, `${label} must expose stable persisted identities`);
    assert.equal(new Set(keys).size, keys.length, `${label} must not contain duplicate persisted identities`);
}

async function getCompleteScenario(request) {
    return waitFor(
        'the mock Loc-RIB EOR to be committed',
        () =>
            request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, {
                routeState: 'all',
                pageSize: 5000
            }),
        response =>
            response.data.list.some(
                route =>
                    route.scopeKind === 'loc-rib' &&
                    route.afi === 1 &&
                    route.safi === 1 &&
                    route.ip === defaultLocRibPrefix &&
                    route.scopeState === 'ready' &&
                    route.eorEpoch === route.currentEpoch
            )
    );
}

async function getOnlyClient(request, expectedOnline) {
    const response = await waitFor(
        expectedOnline ? 'one online restored client' : 'one offline restored client',
        () => request(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST),
        result =>
            result.data.length === 1 &&
            Boolean(result.data[0].persistentSourceId) &&
            isOnline(result.data[0]) === expectedOnline
    );
    return response.data[0];
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-restart-page-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const port = await getFreePort();
    const options = parseArgs(['--routes', '1', '--interval', '0', '--once', '--no-dump-packets']);
    const scenario = buildScenario(options);
    let firstHarness = null;
    let secondHarness = null;
    let thirdHarness = null;
    let firstSocket = null;
    let secondSocket = null;

    try {
        firstHarness = await startWorker(dbPath, port, 'bmp-restart-seed');
        firstSocket = await sendScenario(port, scenario);

        const seededRoutes = (await getCompleteScenario(firstHarness.request)).data;
        const locRibRoute = seededRoutes.list.find(
            route =>
                route.scopeKind === 'loc-rib' && route.afi === 1 && route.safi === 1 && route.ip === defaultLocRibPrefix
        );
        const peerRoute = seededRoutes.list.find(
            route => route.scopeKind === 'peer' && route.afi === 1 && route.safi === 1 && route.ip === defaultPeerPrefix
        );
        assert.ok(locRibRoute, 'seed scenario must persist the default IPv4 Loc-RIB route');
        assert.ok(peerRoute, 'seed scenario must persist the default IPv4 peer route');

        const firstClient = await getOnlyClient(firstHarness.request, true);
        const sourceId = firstClient.persistentSourceId;
        const locRibScopeId = locRibRoute.persistentScopeId;
        const peerScopeId = peerRoute.persistentScopeId;
        const firstSessions = (await firstHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, firstClient)).data;
        const firstInstances = (await firstHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, firstClient)).data;
        assert.ok(findSessionByScope(firstSessions, peerScopeId), 'live peer page must expose its persisted scope');
        assert.ok(
            findInstanceByScope(firstInstances, locRibScopeId),
            'live instance page must expose its persisted scope'
        );
        assertUnique(firstSessions, session => session.persistentOwnerKey, 'live BGP sessions');
        assertUnique(firstInstances, instance => instance.persistentScopeId, 'live BGP instances');

        const firstSocketClosed = once(firstSocket, 'close');
        firstSocket.end();
        await firstSocketClosed;
        firstSocket = null;
        await stopWorker(firstHarness);

        // This is a genuinely fresh worker: its in-memory session map starts empty,
        // and no BMP device has reconnected when the following page queries run.
        secondHarness = await startWorker(dbPath, port, 'bmp-restart-restore');
        const offlineClient = await getOnlyClient(secondHarness.request, false);
        assert.equal(offlineClient.persistentSourceId, sourceId, 'restart must retain the stable source identity');
        assert.equal(offlineClient.connectionState, 'closed');

        const offlineSessions = (await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, offlineClient))
            .data;
        const offlineInstances = (await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, offlineClient))
            .data;
        assert.equal(offlineSessions.length, firstSessions.length, 'restart must restore every BGP session page node');
        assert.equal(
            offlineInstances.length,
            firstInstances.length,
            'restart must restore every Loc-RIB instance page node'
        );
        assert.equal(
            offlineSessions.every(session => isOnline(session) === false),
            true
        );
        assert.equal(
            offlineInstances.every(instance => isOnline(instance) === false),
            true
        );
        assertUnique(offlineSessions, session => session.persistentOwnerKey, 'offline BGP sessions');
        assertUnique(offlineInstances, instance => instance.persistentScopeId, 'offline BGP instances');

        const offlineSession = findSessionByScope(offlineSessions, peerScopeId);
        const offlinePeerScope = findScope(offlineSession?.routeScopes, peerScopeId);
        const offlineInstance = findInstanceByScope(offlineInstances, locRibScopeId);
        assert.ok(offlineSession, 'restart must restore the peer owner for the stable scope ID');
        assert.ok(offlineInstance, 'restart must restore the Loc-RIB owner for the stable scope ID');
        assert.equal(offlinePeerScope.scopeState, 'down');
        assert.equal(offlineInstance.scopeState, 'down');

        const offlinePeerRoutes = await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES, {
            client: offlineClient,
            session: offlineSession,
            af: offlinePeerScope.addrFamilyType || getAddrFamilyType(offlinePeerScope.afi, offlinePeerScope.safi),
            ribType: offlinePeerScope.ribType,
            page: 1,
            pageSize: 10,
            routeState: 'all',
            prefixFilter: defaultPeerPrefix
        });
        assert.equal(offlinePeerRoutes.data.total, 1);
        assert.equal(offlinePeerRoutes.data.list[0].routeState, 'stale');

        const offlineInstanceRoutes = await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES, {
            client: offlineClient,
            instance: offlineInstance,
            page: 1,
            pageSize: 10,
            routeState: 'all',
            prefixFilter: defaultLocRibPrefix
        });
        assert.equal(offlineInstanceRoutes.data.total, 1);
        assert.equal(offlineInstanceRoutes.data.list[0].routeState, 'stale');
        assert.deepEqual(offlineInstanceRoutes.data.summary, {
            active: 0,
            stale: offlineInstance.routeSummary.total,
            total: offlineInstance.routeSummary.total
        });

        const offlineActiveRoutes = await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES, {
            client: offlineClient,
            instance: offlineInstance,
            page: 1,
            pageSize: 10,
            routeState: 'active',
            prefixFilter: defaultLocRibPrefix
        });
        assert.equal(offlineActiveRoutes.data.total, 0, 'offline routes must never be presented as active');

        const offlineDetail = await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTE_DETAIL, {
            client: offlineClient,
            instance: offlineInstance,
            routeKey: locRibRoute.routeKey
        });
        assert.equal(offlineDetail.data.persistentRouteId, locRibRoute.persistentRouteId);
        assert.equal(offlineDetail.data.persistentScopeId, locRibScopeId);

        secondSocket = await sendScenario(port, scenario);
        const onlineClient = await getOnlyClient(secondHarness.request, true);
        assert.equal(onlineClient.persistentSourceId, sourceId, 'same BMP source must merge with its offline node');

        const refreshedRoutes = (await getCompleteScenario(secondHarness.request)).data;
        assert.equal(
            refreshedRoutes.total,
            seededRoutes.total,
            'same-source refresh must not duplicate persisted routes'
        );
        const refreshedLocRibRoute = refreshedRoutes.list.find(
            route => route.persistentScopeId === locRibScopeId && route.ip === defaultLocRibPrefix
        );
        assert.ok(refreshedLocRibRoute, 'same source must reuse the stable Loc-RIB scope ID');
        assert.equal(refreshedLocRibRoute.routeState, 'active');
        assert.equal(refreshedLocRibRoute.scopeState, 'ready');
        assert.equal(refreshedLocRibRoute.eorEpoch, refreshedLocRibRoute.currentEpoch);

        const onlineSessions = (await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, onlineClient))
            .data;
        const onlineInstances = (await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, onlineClient))
            .data;
        assert.equal(onlineSessions.length, offlineSessions.length, 'reconnect must not duplicate BGP session nodes');
        assert.equal(onlineInstances.length, offlineInstances.length, 'reconnect must not duplicate Loc-RIB nodes');
        assertUnique(onlineSessions, session => session.persistentOwnerKey, 'reconnected BGP sessions');
        assertUnique(onlineInstances, instance => instance.persistentScopeId, 'reconnected BGP instances');

        const onlineInstance = findInstanceByScope(onlineInstances, locRibScopeId);
        assert.ok(onlineInstance, 'reconnected page must retain the stable scope lookup');
        assert.equal(isOnline(onlineInstance), true);
        const activeInstanceRoutes = await secondHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES, {
            client: onlineClient,
            instance: onlineInstance,
            page: 1,
            pageSize: 10,
            routeState: 'active',
            prefixFilter: defaultLocRibPrefix
        });
        assert.equal(activeInstanceRoutes.data.total, 1);
        assert.equal(activeInstanceRoutes.data.list[0].routeState, 'active');

        // Also cover an ungraceful collector restart. The preceding persisted
        // route query fences every EOR/update before the worker is terminated.
        const secondSocketClosed = once(secondSocket, 'close');
        secondHarness.stopped = true;
        await secondHarness.worker.terminate();
        await secondSocketClosed;
        secondSocket = null;

        thirdHarness = await startWorker(dbPath, port, 'bmp-restart-after-crash');
        const crashRestoredClient = await getOnlyClient(thirdHarness.request, false);
        assert.equal(crashRestoredClient.persistentSourceId, sourceId);
        const crashRestoredInstances = (
            await thirdHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, crashRestoredClient)
        ).data;
        const crashRestoredInstance = findInstanceByScope(crashRestoredInstances, locRibScopeId);
        assert.ok(crashRestoredInstance, 'collector crash recovery must retain the Loc-RIB page node');
        assert.equal(crashRestoredInstance.scopeState, 'down');
        assert.equal(crashRestoredInstance.staleReason, 'collector-restart');
        const crashRestoredRoutes = await thirdHarness.request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES, {
            client: crashRestoredClient,
            instance: crashRestoredInstance,
            page: 1,
            pageSize: 10,
            routeState: 'all',
            prefixFilter: defaultLocRibPrefix
        });
        assert.equal(crashRestoredRoutes.data.total, 1);
        assert.equal(crashRestoredRoutes.data.list[0].routeState, 'stale');

        console.log(
            `BMP restart page restore regression passed: source=${sourceId.slice(0, 12)}, ` +
                `sessions=${onlineSessions.length}, instances=${onlineInstances.length}, routes=${refreshedRoutes.total}`
        );
    } finally {
        firstSocket?.destroy();
        secondSocket?.destroy();
        await stopWorker(firstHarness).catch(() => {});
        await stopWorker(secondHarness).catch(() => {});
        await stopWorker(thirdHarness).catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
