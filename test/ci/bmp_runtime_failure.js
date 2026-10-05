const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const BmpConst = require('../../electron/const/bmpConst');
const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

function bounded(promise, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000);
        })
    ]).finally(() => clearTimeout(timer));
}

function fixture(config = {}) {
    const events = [];
    const responses = [];
    let onFatal;
    const fatal = new Promise(resolve => {
        onFatal = resolve;
    });
    const worker = Object.create(BmpWorker.prototype);
    Object.assign(worker, {
        bmpConfigData: { threadCount: 1, port: 0, logLevel: 'off', ...config },
        bmpSessionMap: new Map(),
        bmpRuntimeStarted: false,
        bmpStopping: false,
        persistenceFailure: null,
        ingestPool: null,
        routeUpdateAggregator: { clear() {} },
        routeAssuranceService: { enabled: false, setEnabled() {} },
        messageHandler: {
            sendEvent(eventName, data) {
                events.push({ eventName, data });
            },
            sendSuccessResponse(messageId, data, msg) {
                responses.push({ messageId, data, msg, success: true });
            },
            sendErrorResponse(messageId, msg) {
                responses.push({ messageId, msg, success: false });
            }
        },
        scheduleFatalExit() {
            onFatal();
        }
    });
    return { worker, events, responses, fatal };
}

async function testIdleWriterExit() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-idle-failure-'));
    const { worker, events, fatal } = fixture({ persistenceDbPath: path.join(directory, 'bmp.sqlite3') });
    const nativeWorkers = [];
    try {
        await bounded(worker.initializePersistence(), 'open persistence');
        worker.ingestPool = new BmpIngestClientPool({
            threadCount: 1,
            onError: error => worker.handleIngestFailure(error)
        });
        await bounded(worker.ingestPool.open(), 'open parsers');
        await worker.startPlainTcpServers();
        worker.bmpRuntimeStarted = true;
        const writer = worker.persistence.clients[0].worker;
        nativeWorkers.push(writer, worker.persistenceReader.worker, worker.ingestPool.slots[0].worker);
        assert.equal(worker.bmpSessionMap.size, 0, 'failure must be handled even without a connected client');
        await writer.terminate();
        await bounded(fatal, 'fatal shutdown');
        const failures = events.filter(event => event.eventName === BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE);
        assert.equal(failures.length, 1);
        assert.equal(failures[0].data.code, 'BMP_PERSISTENCE_WORKER_FAILURE');
        assert.equal(worker.bmpRuntimeStarted, false);
        assert.equal(worker.server, null);
        assert.equal(worker.ipv6Server, null);
        assert.equal(worker.ingestPool, null);
        assert.equal(worker.persistence, null);
        assert.equal(worker.persistenceReader, null);
        assert.ok(nativeWorkers.every(nativeWorker => nativeWorker.threadId === -1));
        worker.handlePersistenceFailure(new Error('duplicate failure'));
        assert.equal(events.filter(event => event.eventName === BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE).length, 1);
    } finally {
        await bounded(worker.shutdownBmpRuntime({ emitTermination: false }), 'cleanup').catch(() => {});
        await Promise.allSettled(nativeWorkers.map(nativeWorker => nativeWorker.terminate()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function testBindErrorAndRetry() {
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen({ host: '0.0.0.0', port: 0 }, resolve);
    });
    const { worker, responses } = fixture({ port: blocker.address().port });
    try {
        await bounded(worker.startTcpServer('occupied'), 'occupied-port START response');
        assert.equal(responses.length, 1);
        assert.equal(responses[0].success, false);
        assert.match(responses[0].msg, /EADDRINUSE/);
        assert.equal(worker.server, null);
        assert.equal(worker.ipv6Server, null);
        assert.equal(worker.bmpConfigData, null);
        worker.bmpConfigData = { port: 0, threadCount: 1 };
        await bounded(worker.startTcpServer('retry'), 'retry START response');
        assert.equal(responses[1].success, true);
        assert.equal(worker.bmpRuntimeStarted, true);
        assert.equal(worker.server.listenerCount('listening'), 0);
        assert.equal(worker.server.listenerCount('error'), 1, 'only the runtime listener should remain');
    } finally {
        await worker.shutdownBmpRuntime({ emitTermination: false });
        await new Promise(resolve => blocker.close(resolve));
    }
}

async function testFatalExitWaitsForListenerCleanup() {
    const { worker, events, fatal } = fixture();
    worker.bmpRuntimeStarted = true;
    let finishHelper;
    let stopCalls = 0;
    let exited = false;
    fatal.then(() => {
        exited = true;
    });
    worker.tcpAuthForwardingServer = {
        stop() {
            stopCalls += 1;
            return new Promise(resolve => {
                finishHelper = resolve;
            });
        }
    };
    worker.handlePersistenceFailure(new Error('writer failed'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopCalls, 1, 'concurrent listener cleanup must share one close operation');
    assert.equal(exited, false, 'fatal exit must wait for the original helper cleanup');
    assert.equal(worker.bmpStopping, true);
    assert.equal(events.filter(event => event.eventName === BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE).length, 1);
    finishHelper();
    await bounded(fatal, 'helper cleanup before fatal exit');
    assert.equal(worker.bmpStopping, false);
    assert.equal(worker.tcpServersClosePromise, null);
}

async function testRunningListenerError() {
    const { worker, events, fatal } = fixture();
    await worker.startTcpServer('start');
    const server = worker.server;
    server.emit('error', Object.assign(new Error('listener failed after startup'), { code: 'EIO' }));
    await bounded(fatal, 'runtime listener shutdown');
    const failures = events.filter(event => event.eventName === BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].data.code, 'BMP_LISTENER_ERROR');
    assert.equal(worker.bmpRuntimeStarted, false);
    assert.equal(server.listening, false);
    assert.equal(worker.server, null);
    server.emit('error', new Error('late duplicate'));
    assert.equal(events.filter(event => event.eventName === BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE).length, 1);
}

async function main() {
    await testIdleWriterExit();
    await testBindErrorAndRetry();
    await testFatalExitWaitsForListenerCleanup();
    await testRunningListenerError();
    console.log('BMP runtime failure regression passed: idle writer cleanup, bind rejection and retry');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
