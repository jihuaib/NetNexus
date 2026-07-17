const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');

const BmpConst = require('../../electron/const/bmpConst');
const { buildScenario, parseArgs } = require('../../scripts/mockBmpClient');

const workerPath = path.join(__dirname, '..', '..', 'electron', 'worker', 'bmp', 'bmpWorker.js');
const refreshTimeoutMs = 500;

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

function createWorkerHarness(worker) {
    const pending = new Map();
    const events = [];
    let sequence = 0;

    worker.on('message', message => {
        if (message.eventName !== undefined) {
            events.push(message);
            return;
        }

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

    return {
        events,
        request(op, data = null) {
            sequence += 1;
            const messageId = `bmp-reconnect-no-eor-${sequence}`;
            return new Promise((resolve, reject) => {
                pending.set(messageId, { resolve, reject });
                worker.postMessage({ messageId, op, data });
            });
        }
    };
}

async function connectAndSend(port, messages) {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    await once(socket, 'connect');

    for (const message of messages) {
        if (!socket.write(message.data)) {
            await once(socket, 'drain');
        }
    }
    return socket;
}

async function closeSocket(socket) {
    if (!socket || socket.destroyed) {
        return;
    }
    const closed = once(socket, 'close');
    socket.end();
    await closed;
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
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function isOnline(client) {
    return client?.isOnline ?? client?.online;
}

function routeEventUpdates(message) {
    const payload = message?.data?.data;
    if (!payload) {
        return [];
    }
    return Array.isArray(payload.updates) ? payload.updates : [payload];
}

function getReconnectTimeoutRefreshes(events, eventName, sourceId) {
    return events
        .filter(message => message.eventName === eventName)
        .flatMap(routeEventUpdates)
        .filter(
            update =>
                update?.reason === 'reconnect-refresh-timeout' &&
                update?.sourceId === sourceId &&
                typeof update?.scopeId === 'string' &&
                update.scopeId.length > 0
        );
}

async function queryRoutes(request, sourceId, routeState = 'all') {
    return request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, {
        sourceId,
        routeState,
        pageSize: 5000
    });
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-reconnect-no-eor-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const port = await getFreePort();
    const worker = new Worker(workerPath);
    const harness = createWorkerHarness(worker);
    const options = parseArgs(['--routes', '1', '--interval', '0', '--once', '--no-dump-packets']);
    const scenario = buildScenario(options);
    const initiation = scenario.filter(message => message.name === 'initiation');
    let firstSocket = null;
    let reconnectSocket = null;
    let stopped = false;

    assert.equal(initiation.length, 1, 'mock scenario must contain exactly one Initiation message');

    try {
        await harness.request(BmpConst.BMP_REQ_TYPES.START_BMP, {
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
            persistenceEventRetentionMs: 60 * 60 * 1000,
            persistenceSweepIntervalMs: 60 * 60 * 1000,
            persistenceRefreshTimeoutMs: refreshTimeoutMs,
            // Production keeps a safety floor. CI explicitly disables it so the
            // real deadline scheduler can be covered without a minute-long test.
            persistenceRefreshTimeoutFloorMs: 0
        });

        firstSocket = await connectAndSend(port, scenario);
        const seeded = await waitFor(
            'the complete mock RIB to be persisted',
            () => queryRoutes(harness.request, null),
            response =>
                response.data.total > 10 &&
                response.data.list.some(
                    route =>
                        route.scopeKind === 'loc-rib' &&
                        route.afi === 1 &&
                        route.safi === 1 &&
                        route.ip === '10.30.0.0' &&
                        route.scopeState === 'ready' &&
                        route.eorEpoch === route.currentEpoch
                )
        );
        const seededTotal = seeded.data.total;
        const sourceIds = new Set(seeded.data.list.map(route => route.persistentSourceId));
        assert.equal(sourceIds.size, 1, 'seed scenario must belong to one stable BMP source');
        const sourceId = sourceIds.values().next().value;

        await closeSocket(firstSocket);
        firstSocket = null;
        await waitFor(
            'the first BMP connection to become offline',
            () => harness.request(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST),
            response =>
                response.data.length === 1 &&
                response.data[0].persistentSourceId === sourceId &&
                isOnline(response.data[0]) === false
        );
        await waitFor(
            'all disconnected routes to become stale',
            () => queryRoutes(harness.request, sourceId, 'stale'),
            response => response.data.total === seededTotal
        );
        await waitFor(
            'seed route notifications to finish their one-second aggregation window',
            () => harness.events,
            events =>
                events.some(message => message.eventName === BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE) &&
                events.some(message => message.eventName === BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE)
        );

        // Discard all seed/connection-close notifications. From here on the
        // reconnect sends no PU, route, or EOR, so any route notification must
        // have been generated by persistence cleanup itself.
        harness.events.length = 0;
        reconnectSocket = await connectAndSend(port, initiation);
        await waitFor(
            'the Initiation-only reconnect to merge with the same source',
            () => harness.request(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST),
            response =>
                response.data.length === 1 &&
                response.data[0].persistentSourceId === sourceId &&
                isOnline(response.data[0]) === true
        );

        const staleAfterReconnect = await queryRoutes(harness.request, sourceId, 'stale');
        assert.equal(
            staleAfterReconnect.data.total,
            seededTotal,
            'Initiation-only reconnect must retain the old RIB as stale until its refresh deadline'
        );
        assert.equal(
            staleAfterReconnect.data.list.every(route => route.routeState === 'stale'),
            true
        );

        const emptied = await waitFor(
            'the reconnect refresh deadline to physically delete the old RIB',
            () => queryRoutes(harness.request, sourceId),
            response => response.data.total === 0,
            10000
        );
        assert.equal(emptied.data.list.length, 0);

        const sweepEvents = await waitFor(
            'persistence sweep route refresh notifications',
            () => ({
                peer: getReconnectTimeoutRefreshes(harness.events, BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, sourceId),
                locRib: getReconnectTimeoutRefreshes(
                    harness.events,
                    BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE,
                    sourceId
                )
            }),
            value => value.peer.length > 0 && value.locRib.length > 0,
            3000
        );
        assert.equal(new Set(sweepEvents.peer.map(update => update.scopeId)).size > 0, true);
        assert.equal(new Set(sweepEvents.locRib.map(update => update.scopeId)).size > 0, true);

        await harness.request(BmpConst.BMP_REQ_TYPES.STOP_BMP);
        stopped = true;
        await worker.terminate();

        console.log(
            `BMP reconnect without EOR timeout regression passed: routes=${seededTotal}, ` +
                `peerRefreshes=${sweepEvents.peer.length}, locRibRefreshes=${sweepEvents.locRib.length}`
        );
    } finally {
        firstSocket?.destroy();
        reconnectSocket?.destroy();
        if (!stopped) {
            await harness.request(BmpConst.BMP_REQ_TYPES.STOP_BMP).catch(() => {});
        }
        await worker.terminate().catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
