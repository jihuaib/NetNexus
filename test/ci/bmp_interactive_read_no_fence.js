const assert = require('node:assert/strict');

const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function expectSettledBeforeImmediate(promise, message) {
    let settled = false;
    let value;
    let error;
    promise.then(
        result => {
            settled = true;
            value = result;
        },
        reason => {
            settled = true;
            error = reason;
        }
    );

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, message);
    if (error) {
        throw error;
    }
    return value;
}

async function main() {
    let fenceGate = deferred();
    const calls = {
        fence: 0,
        reader: [],
        writer: []
    };
    const client = {
        persistentSourceId: 'interactive-source',
        sourceId: 'interactive-source',
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 50000
    };
    const topology = {
        clients: [
            {
                ...client,
                sessions: [],
                instances: []
            }
        ]
    };
    const route = {
        persistentSourceId: client.persistentSourceId,
        persistentScopeId: 'interactive-scope',
        persistentRouteId: 'interactive-route',
        routeKey: '0|0:0|203.0.113.0|24',
        scopeKind: 'peer',
        ribType: 2,
        afi: 1,
        safi: 1,
        addrFamilyType: 1,
        ip: '203.0.113.0',
        mask: 24,
        rd: '0:0',
        pathId: 0,
        origin: 'IGP',
        asPath: '65000',
        nextHop: '192.0.2.254',
        routeState: 'active'
    };
    const routeScopeSnapshot = {
        routes: {
            list: [route],
            total: 1
        },
        summary: {
            active: 1,
            stale: 0,
            total: 1
        }
    };

    const writer = {
        fence() {
            calls.fence += 1;
            return fenceGate.promise;
        },
        queryTopology(query) {
            calls.writer.push({ method: 'queryTopology', query });
            return topology;
        },
        queryRouteScope(query) {
            calls.writer.push({ method: 'queryRouteScope', query });
            return routeScopeSnapshot;
        },
        queryRoutes(query) {
            calls.writer.push({ method: 'queryRoutes', query });
            return { list: [route], total: 1 };
        },
        getWatermark() {
            return { queueLength: 1000, bufferedBytes: 1024, paused: false };
        }
    };
    const reader = {
        async queryTopology(query) {
            calls.reader.push({ method: 'queryTopology', query });
            return topology;
        },
        async queryRouteScope(query) {
            calls.reader.push({ method: 'queryRouteScope', query });
            return routeScopeSnapshot;
        },
        async queryRoutes(query) {
            calls.reader.push({ method: 'queryRoutes', query });
            if (query.legacyRouteKey) {
                return { list: [route], total: 1 };
            }
            if (query.defaultFenceProbe) {
                return { list: [], total: 0, probe: 'default-fence-complete' };
            }
            return { list: [], total: 0 };
        },
        async getStatus() {
            calls.reader.push({ method: 'getStatus' });
            return { ready: true, journalMode: 'wal' };
        }
    };
    const responses = new Map();
    const worker = Object.create(BmpWorker.prototype);
    Object.assign(worker, {
        persistence: writer,
        persistenceReader: reader,
        bmpSessionMap: new Map(),
        messageHandler: {
            sendSuccessResponse(messageId, data, msg) {
                responses.set(messageId, { status: 'success', data, msg });
            },
            sendErrorResponse(messageId, msg) {
                responses.set(messageId, { status: 'error', msg });
            }
        }
    });

    const clientTopology = await expectSettledBeforeImmediate(
        worker.queryClientTopology(client),
        'interactive topology query must not wait for the writer fence'
    );
    assert.equal(clientTopology.client.persistentSourceId, client.persistentSourceId);

    const routePage = await expectSettledBeforeImmediate(
        worker.queryRouteScope(
            { scopeId: route.persistentScopeId },
            { page: 1, pageSize: 25, routeState: 'active', prefixFilter: '' }
        ),
        'interactive route page query must not wait for the writer fence'
    );
    assert.equal(routePage.total, 1);
    assert.equal(routePage.list[0].routeKey, route.routeKey);

    const routeDetail = await expectSettledBeforeImmediate(
        worker.queryRouteDetail({ scopeId: route.persistentScopeId }, route.routeKey),
        'interactive route detail query must not wait for the writer fence'
    );
    assert.equal(routeDetail.persistentRouteId, route.persistentRouteId);

    await expectSettledBeforeImmediate(
        worker.getRouteLens('interactive-route-lens', {
            query: '203.0.113.0/24',
            routeState: 'active'
        }),
        'interactive Route Lens query must not wait for the writer fence'
    );
    assert.equal(responses.get('interactive-route-lens')?.status, 'success');

    await expectSettledBeforeImmediate(
        worker.getPersistenceStatus('interactive-persistence-status'),
        'interactive persistence status must not wait for the writer fence'
    );
    assert.equal(responses.get('interactive-persistence-status')?.status, 'success');
    assert.equal(responses.get('interactive-persistence-status')?.data?.watermark?.queueLength, 1000);

    assert.equal(calls.fence, 0, 'interactive reads must explicitly bypass the writer fence');
    assert.deepEqual(
        calls.reader.map(call => call.method),
        ['queryTopology', 'queryRouteScope', 'queryRoutes', 'queryRoutes', 'getStatus']
    );
    assert.deepEqual(calls.writer, [], 'interactive reads should use the read replica when it is available');

    const topologyReaderCallsBeforeExplicitLists = calls.reader.length;
    let sessionListSettled = false;
    let instanceListSettled = false;
    const sessionList = worker.getBgpSessions('explicit-session-list', client).then(() => {
        sessionListSettled = true;
    });
    const instanceList = worker.getBgpInstances('explicit-instance-list', client).then(() => {
        instanceListSettled = true;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sessionListSettled, false, 'the explicit session list must wait for queued writer mutations');
    assert.equal(instanceListSettled, false, 'the explicit instance list must wait for queued writer mutations');
    assert.equal(calls.fence, 2);
    assert.equal(
        calls.reader.length,
        topologyReaderCallsBeforeExplicitLists,
        'fenced topology lists must not reach the read replica before the writer fence completes'
    );

    fenceGate.resolve();
    await Promise.all([sessionList, instanceList]);
    assert.equal(responses.get('explicit-session-list')?.status, 'success');
    assert.equal(responses.get('explicit-instance-list')?.status, 'success');
    assert.deepEqual(
        calls.reader.slice(topologyReaderCallsBeforeExplicitLists).map(call => call.method),
        ['queryTopology', 'queryTopology']
    );

    const readerCallsBeforeDefaultRead = calls.reader.length;
    const fenceCallsBeforeDefaultRead = calls.fence;
    fenceGate = deferred();
    let defaultReadSettled = false;
    const defaultRead = worker.readPersistence('queryRoutes', { defaultFenceProbe: true }).then(result => {
        defaultReadSettled = true;
        return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(defaultReadSettled, false, 'readPersistence must wait for the writer fence by default');
    assert.equal(calls.fence, fenceCallsBeforeDefaultRead + 1);
    assert.equal(
        calls.reader.length,
        readerCallsBeforeDefaultRead,
        'the default read must not reach the read replica before the fence completes'
    );

    fenceGate.resolve();
    const defaultResult = await defaultRead;
    assert.equal(defaultResult.probe, 'default-fence-complete');
    assert.equal(calls.reader.length, readerCallsBeforeDefaultRead + 1);

    // During a large table dump the writer queue may take tens of seconds to
    // drain. Fenced reads must give up waiting after the configured bound and
    // serve the committed state instead of leaving the page empty.
    fenceGate = deferred();
    worker.bmpConfigData = { persistenceReadFenceTimeoutMs: 20 };
    const readerCallsBeforeBoundedRead = calls.reader.length;
    const boundedStartedAt = Date.now();
    const boundedResult = await worker.readPersistence('queryRoutes', { defaultFenceProbe: true });
    assert.equal(boundedResult.probe, 'default-fence-complete');
    assert.equal(calls.reader.length, readerCallsBeforeBoundedRead + 1);
    assert.ok(Date.now() - boundedStartedAt < 1000, 'a bounded fence must not wait for the writer queue to drain');
    assert.ok(Date.now() - boundedStartedAt >= 15, 'the bounded fence must still wait up to the timeout');

    let boundedListSettled = false;
    const boundedList = worker.getBgpSessions('bounded-session-list', client).then(() => {
        boundedListSettled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(boundedListSettled, false, 'the explicit session list still waits for the fence first');
    await boundedList;
    assert.equal(responses.get('bounded-session-list')?.status, 'success');

    // A fence that fails after the read already timed out must not surface as
    // an unhandled rejection.
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const failingGate = deferred();
    worker.persistence = {
        ...writer,
        fence() {
            return failingGate.promise;
        }
    };
    await worker.readPersistence('queryRoutes', {});
    failingGate.promise.catch(() => {});
    failingGate.reject(new Error('writer failed after the read timed out'));
    await new Promise(resolve => setTimeout(resolve, 10));
    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(unhandled, []);
    worker.persistence = writer;
    fenceGate.resolve();

    console.log('BMP interactive persistence reads bypass writer fence tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
