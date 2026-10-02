const assert = require('node:assert/strict');

const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { applyIngestSnapshot } = require('../../electron/worker/bmp/bmpIngestSnapshot');
const BmpConst = require('../../electron/const/bmpConst');
const { builders } = require('../../scripts/mockBmpClient');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

function withTimeout(promise, label, milliseconds = 10000) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
        })
    ]).finally(() => clearTimeout(timer));
}

function captureWorkers(pool) {
    return pool.slots.map(slot => ({
        slot,
        worker: slot.worker,
        exited: new Promise(resolve => slot.worker.once('exit', resolve))
    }));
}

async function assertWorkersCleaned(pool, workers) {
    await withTimeout(Promise.all(workers.map(item => item.exited)), 'worker exits');
    assert.equal(pool.slots.length, 0, 'closing must discard every parser slot');
    assert.equal(pool.callbacks.size, 0, 'no IPC request may remain pending after cleanup');
    assert.ok(workers.every(item => item.worker.threadId === -1 && item.slot.alive === false));
    assert.equal(pool.getStatus().ingestWorkerCount, 0);
    assert.equal(pool.getStatus().activeClientCount, 0);
    assert.equal(pool.hasCapacity(), false);
}

async function cleanup(pool, workers) {
    // Bound both the assertion and its failure cleanup. A lost close ACK must
    // fail this test rather than keep the CI process alive indefinitely.
    await withTimeout(pool.close(), 'cleanup close').catch(() => {});
    await withTimeout(Promise.allSettled(workers.map(item => item.worker.terminate())), 'cleanup termination');
}

function makeSession(index) {
    const session = new BmpSession({}, {});
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '192.0.2.10',
        remotePort: 52000 + index,
        persistenceConnectionId: `failure-test-connection-${index}`,
        persistenceConnectionGeneration: 1000 + index,
        persistenceOpenedAtMs: Date.now(),
        socket: {
            destroyed: false,
            paused: false,
            pauseCalls: 0,
            pause() {
                this.paused = true;
                this.pauseCalls += 1;
            },
            resume() {
                this.paused = false;
            },
            destroy() {
                this.destroyed = true;
            }
        }
    });
    return session;
}

function attach(pool, session) {
    const metadata = {
        localIp: session.localIp,
        localPort: session.localPort,
        remoteIp: session.remoteIp,
        remotePort: session.remotePort
    };
    const sessionKey = BmpSession.makeKey(...Object.values(metadata));
    return pool.attach(session, { sessionKey, metadata });
}

async function testRuntimeWorkerCounts() {
    for (const threadCount of [undefined, 1, 16]) {
        const expected = threadCount ?? 4;
        const errors = [];
        const pool = new BmpIngestClientPool({ threadCount, onError: error => errors.push(error) });
        let workers = [];
        try {
            const status = await withTimeout(pool.open(), `open ${expected} workers`);
            workers = captureWorkers(pool);
            assert.equal(status.ingestWorkerCount, expected);
            assert.equal(status.clientLimit, expected);
            assert.equal(status.activeClientCount, 0);
            assert.equal(new Set(status.ingestThreadIds).size, expected);
            assert.ok(status.ingestThreadIds.every(id => Number.isInteger(id) && id > 0));
            assert.equal(status.acceptingClients, true);
            await withTimeout(pool.close(), `close ${expected} workers`);
            await assertWorkersCleaned(pool, workers);
            assert.deepEqual(errors, []);
        } finally {
            await cleanup(pool, workers);
        }
    }
}

async function testActiveWorkerExitFailsClosed() {
    const errors = [];
    const received = [];
    let failureResolve;
    const failed = new Promise(resolve => {
        failureResolve = resolve;
    });
    const pool = new BmpIngestClientPool({
        threadCount: 2,
        onResult(record, result) {
            assert.equal(result.threadId, record.threadId);
            applyIngestSnapshot(record.session, result.snapshot);
            received.push(result);
        },
        onError(error) {
            errors.push(error);
            failureResolve(error);
        }
    });
    let workers = [];
    try {
        await withTimeout(pool.open(), 'active pool open');
        workers = captureWorkers(pool);
        const sessions = [makeSession(1), makeSession(2)];
        const records = sessions.map(session => attach(pool, session));
        assert.ok(records.every(Boolean));
        assert.notEqual(records[0].threadId, records[1].threadId);
        records.forEach((record, index) => {
            assert.equal(pool.send(record, builders.initiationMessage({ sysName: `failure-client-${index}` })), true);
        });
        await withTimeout(pool.fence(), 'initial attach and INIT fence');
        assert.ok(sessions.every(session => session.getPersistentSourceId()));
        assert.ok(received.some(result => result.actions.some(action => action.op === 'mutation')));

        const before = {
            status: pool.getStatus(),
            sources: sessions.map(session => session.getPersistentSourceId()),
            connections: sessions.map(session => session.persistenceConnectionId),
            sequences: sessions.map(session => session.persistenceSequence),
            resultCount: received.length
        };
        await withTimeout(pool.setLogLevel('error'), 'log-level error ACK');
        await withTimeout(pool.setLogLevel('off'), 'log-level off ACK');
        await withTimeout(pool.fence(), 'post-log-level fence');
        assert.equal(pool.config.logLevel, 'off');
        assert.equal(pool.getStatus().activeClientCount, 2);
        assert.deepEqual(pool.getStatus().ingestThreadIds, before.status.ingestThreadIds);
        assert.deepEqual(
            sessions.map(session => session.getPersistentSourceId()),
            before.sources
        );
        assert.deepEqual(
            sessions.map(session => session.persistenceConnectionId),
            before.connections
        );
        assert.deepEqual(
            sessions.map(session => session.persistenceSequence),
            before.sequences
        );
        assert.equal(received.length, before.resultCount + 2, 'control ACKs must not be mistaken for client results');
        assert.ok(records.every(record => !record.closed && !record.closing));
        assert.ok(sessions.every(session => !session.socket.destroyed));

        const victim = workers[records[0].index].worker;
        await withTimeout(victim.terminate(), 'terminate active parser');
        const failure = await withTimeout(failed, 'worker failure notification');
        assert.match(failure.message, /BMP ingest worker .* exited with code/);
        assert.strictEqual(pool.failure, failure);
        assert.equal(errors.length, 1);
        assert.ok(sessions.every(session => session.socket.paused && session.socket.pauseCalls === 1));
        assert.equal(pool.getStatus().ingestWorkerCount, 1, 'the healthy worker still needs final cleanup');
        assert.equal(pool.hasCapacity(), false);
        assert.equal(attach(pool, makeSession(3)), null, 'a failed pool must reject new client attachments');
        for (const record of records) {
            assert.equal(pool.send(record, builders.initiationMessage()), false, 'a failed pool must stop all intake');
        }
        await assert.rejects(withTimeout(pool.fence(), 'failed pool fence'), error => error === failure);
        await assert.rejects(withTimeout(pool.setLogLevel('off'), 'failed pool log-level'), error => error === failure);
        assert.equal(pool.callbacks.size, 0);

        const closing = pool.close();
        assert.strictEqual(pool.close(), closing, 'failed close must remain idempotent');
        await assert.rejects(withTimeout(closing, 'failed pool close'), error => error === failure);
        await assertWorkersCleaned(pool, workers);
        assert.ok(sessions.every(session => session.socket.destroyed));
        assert.equal(errors.length, 1, 'cleanup exits must not report the original pool failure again');
    } finally {
        await cleanup(pool, workers);
    }
}

async function testExpectedExitWithoutShutdownAckDoesNotHang() {
    const errors = [];
    const pool = new BmpIngestClientPool({ threadCount: 1, onError: error => errors.push(error) });
    let workers = [];
    try {
        await withTimeout(pool.open(), 'shutdown-failure pool open');
        workers = captureWorkers(pool);
        const slot = pool.slots[0];
        const nativePostMessage = slot.worker.postMessage.bind(slot.worker);
        let sawShutdown = false;
        // Keep a real Worker and the real pool protocol. Terminate it exactly
        // when shutdown is posted, before it can acknowledge that request.
        slot.worker.postMessage = (message, transferList) => {
            if (message.op === 'shutdown') {
                sawShutdown = true;
                assert.equal(slot.expectedExit, true);
                assert.equal(pool.callbacks.size, 1);
                slot.worker.terminate().catch(() => {});
            }
            return nativePostMessage(message, transferList);
        };
        await assert.rejects(
            withTimeout(pool.close(), 'shutdown without ACK'),
            /BMP ingest worker .* exited with code/
        );
        assert.equal(sawShutdown, true);
        assert.equal(errors.length, 1, 'a missing expected-exit ACK must become one fail-closed error');
        await assertWorkersCleaned(pool, workers);
    } finally {
        await cleanup(pool, workers);
    }
}

function lifecycleFixture(options = {}) {
    const trace = [];
    const events = [];
    const sockets = [makeSession(10).socket, makeSession(11).socket];
    let finishCleanup;
    let fatalResolve;
    const cleaned = new Promise(resolve => {
        finishCleanup = resolve;
    });
    const fatal = new Promise(resolve => {
        fatalResolve = resolve;
    });
    const worker = Object.create(BmpWorker.prototype);
    Object.assign(worker, {
        bmpStopping: options.stopping === true,
        bmpRuntimeStarted: options.started === true,
        ingestRuntimeFailure: null,
        persistenceFailure: null,
        bmpSocketsPaused: false,
        bmpSessionMap: new Map(sockets.map((socket, index) => [index, { socket }])),
        clearPersistenceSweepTimer() {
            trace.push('clear-timer');
        },
        async closeTcpServers() {
            trace.push('close-listeners');
        },
        messageHandler: {
            sendEvent(eventName, data) {
                trace.push('runtime-failure');
                events.push({ eventName, data });
            }
        },
        shutdownBmpRuntime() {
            trace.push('shutdown-start');
            return cleaned.then(() => {
                trace.push('cleanup-finished');
            });
        },
        scheduleFatalExit() {
            trace.push('fatal-exit');
            fatalResolve();
        }
    });
    return { worker, sockets, trace, events, fatal, finishCleanup };
}

async function testRuntimeFailureLifecycle() {
    const failure = new Error('native parser thread unexpectedly exited');
    const running = lifecycleFixture({ started: true });
    running.worker.handleIngestFailure(failure);
    assert.strictEqual(running.worker.persistenceFailure, failure);
    assert.ok(running.sockets.every(socket => socket.paused && socket.destroyed));
    assert.deepEqual(running.trace, ['clear-timer', 'close-listeners', 'runtime-failure', 'shutdown-start']);
    assert.equal(running.events.length, 1);
    assert.equal(running.events[0].eventName, BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE);
    assert.equal(running.events[0].data.code, 'BMP_INGEST_WORKER_EXIT');
    assert.strictEqual(running.events[0].data, running.worker.ingestRuntimeFailure);
    running.worker.handleIngestFailure(new Error('duplicate exit notification'));
    assert.equal(running.events.length, 1);
    assert.equal(running.trace.filter(entry => entry === 'shutdown-start').length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(running.trace.includes('fatal-exit'), false, 'fatal exit must wait for asynchronous resource cleanup');
    running.finishCleanup();
    await withTimeout(running.fatal, 'runtime failure fatal exit');
    assert.deepEqual(running.trace.slice(-2), ['cleanup-finished', 'fatal-exit']);
    running.worker.handleIngestFailure(failure);
    assert.equal(running.trace.filter(entry => entry === 'fatal-exit').length, 1);

    const starting = lifecycleFixture({ started: false });
    starting.worker.handleIngestFailure(failure);
    starting.worker.handleIngestFailure(new Error('another startup error'));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(starting.worker.persistenceFailure, failure);
    assert.ok(starting.sockets.every(socket => socket.paused && socket.destroyed));
    assert.deepEqual(starting.trace, ['clear-timer', 'close-listeners']);
    assert.equal(starting.events.length, 0, 'startup failure must be reported by START, not RUNTIME_FAILURE');
    assert.equal(starting.worker.ingestRuntimeFailure, null);

    const stopping = lifecycleFixture({ started: true, stopping: true });
    stopping.worker.handleIngestFailure(failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopping.worker.persistenceFailure, null);
    assert.equal(stopping.worker.ingestRuntimeFailure, null);
    assert.deepEqual(stopping.trace, []);
    assert.deepEqual(stopping.events, []);
    assert.ok(stopping.sockets.every(socket => !socket.paused && !socket.destroyed));
}

async function main() {
    await testRuntimeWorkerCounts();
    await testActiveWorkerExitFailsClosed();
    await testExpectedExitWithoutShutdownAckDoesNotHang();
    await testRuntimeFailureLifecycle();
    console.log(
        'BMP ingest pool failure tests passed: real workers, fail-closed intake, control ACKs and bounded cleanup'
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
