const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

process.env.NODE_ENV = 'test';

const RpkiApp = require('../../electron/app/rpkiApp');
const RpkiConst = require('../../electron/const/rpkiConst');
const RequestWorkerClient = require('../../electron/worker/core/requestWorkerClient');
const RpkiSqliteStore = require('../../electron/worker/rpki/rpkiSqliteStore');
const { PROTOCOL_PROCESS_SERVICES } = require('../../electron/worker/core/protocolProcessServices');

class MemoryStore {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial));
    }

    get(key) {
        return this.values.get(key);
    }

    set(key, value) {
        this.values.set(key, value);
    }
}

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(name, handler) {
        this.handlers.set(name, handler);
    }
}

function getFreeTcpPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const result = predicate();
        if (result) return result;
        await delay(25);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}`);
}

function assertNotRunning(response) {
    assert.equal(response.status, 'error');
    assert.equal(response.data, null);
    assert.match(response.msg, /RPKI未运行/);
}

async function assertUtilityProcess(client) {
    const host = client.process;
    assert.equal(host.runtimeKind, 'utility-process', 'RPKI ownership CI must use a real Electron Utility process');
    const pid = await waitFor(() => host.pid, 'RPKI Utility PID');
    assert.notEqual(pid, process.pid, 'RPKI SQLite owner must not be the Electron main process');
    const metric = await waitFor(
        () => app.getAppMetrics().find(item => item.pid === pid),
        `RPKI Utility PID ${pid} to appear in app metrics`
    );
    assert.equal(metric.type, 'Utility');
    assert(
        metric.name === PROTOCOL_PROCESS_SERVICES.RPKI || metric.serviceName === PROTOCOL_PROCESS_SERVICES.RPKI,
        'RPKI Utility must retain its protocol service identity'
    );
    return { host, pid };
}

async function startRpki(rpkiApp, sender) {
    const response = await rpkiApp.handleStartRpki(
        { sender },
        {
            port: await getFreeTcpPort(),
            maxProtocolVersion: RpkiConst.RPKI_MAX_SUPPORTED_VERSION
        }
    );
    assert.equal(response.status, 'success', response.msg);
    assert.equal(rpkiApp.rpkiReady, true, 'RPKI requests must only become available after START succeeds');
    return rpkiApp.worker;
}

async function assertStoppedDataPlane(rpkiApp, roaPath, aspaPath) {
    const roa = { prefix: '192.0.2.0/24', asn: 64512, maxLength: 24 };
    const aspa = { customerAsn: 64512, providerAsns: [64513], afiFlags: 3 };

    for (const response of [
        await rpkiApp.handleAddRoa(null, roa),
        await rpkiApp.handleDeleteRoa(null, roa),
        await rpkiApp.handleDeleteAllRoa(),
        await rpkiApp.handleGetRoaList(null, { page: 1, pageSize: 25 }),
        await rpkiApp.handleImportRoaJson(null, { filePath: roaPath }),
        await rpkiApp.handleAddAspa(null, aspa),
        await rpkiApp.handleDeleteAspa(null, aspa),
        await rpkiApp.handleDeleteAllAspa(),
        await rpkiApp.handleGetAspaList(null, { page: 1, pageSize: 25 }),
        await rpkiApp.handleImportAspaJson(null, { filePath: aspaPath })
    ]) {
        assertNotRunning(response);
    }

    await assert.rejects(rpkiApp.importRoaJsonFile(roaPath), /RPKI未运行/);
    await assert.rejects(rpkiApp.importAspaJsonFile(aspaPath), /RPKI未运行/);
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createRendererTarget(events) {
    return {
        send(channel, payload) {
            if (channel === 'unified-event') events.push(payload);
        },
        isDestroyed() {
            return false;
        }
    };
}

async function testConcurrentStartStopSingleFlight() {
    const startResult = createDeferred();
    const rendererEvents = [];
    const sender = createRendererTarget(rendererEvents);
    const calls = { start: 0, stop: 0, terminate: 0 };
    let onExit = null;
    const worker = {
        addEventListener() {},
        removeEventListener() {},
        sendRequest(op) {
            if (op === RpkiConst.RPKI_REQ_TYPES.START_RPKI) {
                calls.start += 1;
                return startResult.promise;
            }
            if (op === RpkiConst.RPKI_REQ_TYPES.STOP_RPKI) {
                calls.stop += 1;
                return Promise.resolve({ status: 'success', data: null, msg: 'stopped after pending start' });
            }
            throw new Error(`Unexpected fake RPKI operation: ${op}`);
        },
        async terminate() {
            calls.terminate += 1;
            onExit?.(0, worker, { expected: true });
        }
    };
    const rpkiApp = new RpkiApp(new FakeIpcMain(), new MemoryStore());
    rpkiApp.createRpkiProcess = (_workerPath, options) => {
        onExit = options.onExit;
        return worker;
    };

    const firstStart = rpkiApp.handleStartRpki({ sender }, { port: 8282 });
    const secondStart = rpkiApp.handleStartRpki({ sender }, { port: 8283 });
    assert.strictEqual(secondStart, firstStart, 'concurrent START calls must share one lifecycle operation');
    assert.equal(calls.start, 1);

    assert.equal(rpkiApp.cancelPendingStart(), true);
    assert.equal(rpkiApp.rpkiStopping, true, 'an external shutdown cancellation must reserve graceful STOP');
    const firstStop = rpkiApp.handleStopRpki();
    const secondStop = rpkiApp.handleStopRpki();
    assert.strictEqual(secondStop, firstStop, 'concurrent STOP calls must share one lifecycle operation');
    assert.equal(calls.stop, 0, 'STOP must wait for the real START response before graceful shutdown');
    assert.equal(calls.terminate, 0, 'the Utility process must not be killed while START is still settling');

    startResult.resolve({ status: 'success', data: null, msg: 'late start success' });
    const [startResponse, stopResponse] = await Promise.all([firstStart, firstStop]);
    assert.equal(startResponse.status, 'error');
    assert.match(startResponse.msg, /启动已取消/);
    assert.equal(stopResponse.status, 'success', stopResponse.msg);
    assert.equal(calls.stop, 1, 'a successfully initialized Utility must receive graceful STOP before termination');
    assert.equal(calls.terminate, 1);
    assert.equal(rpkiApp.worker, null);
    assert.equal(rpkiApp.rpkiReady, false);

    const runtimeStates = rendererEvents
        .filter(event => event.type === 'rpki:runtimeChanged')
        .map(event => event.data.running);
    assert.deepEqual(runtimeStates, [false], 'a START response arriving during STOP must never emit running=true');
}

async function testTerminateFailureRetainsWorkerForRetry() {
    const rendererEvents = [];
    const sender = createRendererTarget(rendererEvents);
    const calls = { start: 0, stop: 0, terminate: 0 };
    let onExit = null;
    const worker = {
        addEventListener() {},
        removeEventListener() {},
        sendRequest(op) {
            if (op === RpkiConst.RPKI_REQ_TYPES.START_RPKI) {
                calls.start += 1;
                return Promise.resolve({ status: 'success', data: null, msg: 'started' });
            }
            if (op === RpkiConst.RPKI_REQ_TYPES.STOP_RPKI) {
                calls.stop += 1;
                return Promise.resolve({ status: 'success', data: null, msg: 'stopped' });
            }
            throw new Error(`Unexpected fake RPKI operation: ${op}`);
        },
        async terminate() {
            calls.terminate += 1;
            if (calls.terminate === 1) throw new Error('synthetic terminate failure');
            onExit?.(0, worker, { expected: true });
        }
    };
    const rpkiApp = new RpkiApp(new FakeIpcMain(), new MemoryStore());
    rpkiApp.createRpkiProcess = (_workerPath, options) => {
        onExit = options.onExit;
        return worker;
    };

    const started = await rpkiApp.handleStartRpki({ sender }, { port: 8282 });
    assert.equal(started.status, 'success', started.msg);

    const firstStop = await rpkiApp.handleStopRpki();
    assert.equal(firstStop.status, 'error', 'terminate failure must never be reported as a successful STOP');
    assert.match(firstStop.msg, /终止失败.*保留进程句柄/);
    assert.strictEqual(rpkiApp.worker, worker, 'failed termination must retain the exact worker for a retry');
    assert.equal(rpkiApp.rpkiReady, false);
    assert.equal(rpkiApp.rpkiStopping, false, 'failed termination must leave STOP retryable');

    const blockedRestart = await rpkiApp.handleStartRpki({ sender }, { port: 8283 });
    assert.equal(blockedRestart.status, 'error', 'an uncollected Utility process must block a replacement START');

    const retryStop = await rpkiApp.handleStopRpki();
    assert.equal(retryStop.status, 'success', retryStop.msg);
    assert.equal(calls.stop, 1, 'a termination-only retry must not resend STOP to an already stopped Utility');
    assert.equal(calls.terminate, 2);
    assert.equal(rpkiApp.worker, null);

    const runtimeStates = rendererEvents
        .filter(event => event.type === 'rpki:runtimeChanged')
        .map(event => event.data.running);
    assert.deepEqual(runtimeStates, [true, false], 'termination retry must not duplicate runtime state events');
}

async function main() {
    assert.equal(
        process.env.NETNEXUS_EXPECT_UTILITY_PROCESS,
        '1',
        'RPKI ownership CI must run through the real Electron Utility-process wrapper'
    );

    await testConcurrentStartStopSingleFlight();
    await testTerminateFailureRetainsWorkerForRetry();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-rpki-process-ownership-'));
    const dbPath = path.join(tempDir, 'rpki', 'rpki.sqlite3');
    const roaPath = path.join(tempDir, 'roas.json');
    const aspaPath = path.join(tempDir, 'aspas.json');
    fs.writeFileSync(
        roaPath,
        JSON.stringify({
            roas: [
                { prefix: '198.51.100.0/24', asn: 65001, maxLength: 24 },
                { prefix: '203.0.113.0/24', asn: 65002, maxLength: 24 }
            ]
        }),
        'utf8'
    );
    fs.writeFileSync(
        aspaPath,
        JSON.stringify({
            aspas: [
                { customer_asid: 65001, providers: [65010, 65011] },
                { customer_asid: 65002, providers: [65012] }
            ]
        }),
        'utf8'
    );

    const rendererEvents = [];
    const sender = createRendererTarget(rendererEvents);
    const rpkiApp = new RpkiApp(new FakeIpcMain(), new MemoryStore());
    rpkiApp.getRpkiDatabasePath = () => dbPath;

    const originalSqliteOpen = RpkiSqliteStore.prototype.open;
    const originalThreadStart = RequestWorkerClient.prototype.start;
    RpkiSqliteStore.prototype.open = function forbidMainProcessSqliteOpen() {
        throw new Error('MAIN_PROCESS_RPKI_SQLITE_ACCESS_FORBIDDEN');
    };
    RequestWorkerClient.prototype.start = function forbidMainProcessImportThread() {
        throw new Error('MAIN_PROCESS_RPKI_IMPORT_THREAD_FORBIDDEN');
    };

    let firstProcess = null;
    let secondProcess = null;
    try {
        assert.equal(typeof rpkiApp.closeStorage, 'undefined', 'RpkiApp must not expose main-process SQLite lifecycle');
        await assertStoppedDataPlane(rpkiApp, roaPath, aspaPath);
        assert.equal(fs.existsSync(dbPath), false, 'stopped RPKI data-plane calls must not create the database');

        const firstClient = await startRpki(rpkiApp, sender);
        firstProcess = await assertUtilityProcess(firstClient);
        assert.equal(fs.existsSync(dbPath), true, 'the RPKI Utility process must create its SQLite database on START');

        const observedRequests = [];
        const sendRequest = firstClient.sendRequest.bind(firstClient);
        firstClient.sendRequest = async (op, data, options) => {
            const result = await sendRequest(op, data, options);
            observedRequests.push({ op, data, result });
            return result;
        };

        const addedRoa = await rpkiApp.handleAddRoa(null, {
            prefix: '192.0.2.7/24',
            asn: 'AS65000',
            maxLength: 24
        });
        assert.equal(addedRoa.status, 'success', addedRoa.msg);

        const addedAspa = await rpkiApp.handleAddAspa(null, {
            customerAsn: 65000,
            providerAsns: [65020, 65021],
            afiFlags: 3
        });
        assert.equal(addedAspa.status, 'success', addedAspa.msg);

        const roaPage = await rpkiApp.handleGetRoaList(null, { page: 1, pageSize: 25 });
        const aspaPage = await rpkiApp.handleGetAspaList(null, { page: 1, pageSize: 25 });
        assert.equal(roaPage.status, 'success', roaPage.msg);
        assert.equal(aspaPage.status, 'success', aspaPage.msg);
        assert.equal(roaPage.data.storageTotal, 1);
        assert.equal(aspaPage.data.storageTotal, 1);

        const roaStats = await rpkiApp.importRoaJsonFile(roaPath);
        const aspaStats = await rpkiApp.importAspaJsonFile(aspaPath);
        assert.equal(roaStats.imported, 2);
        assert.equal(aspaStats.imported, 2);
        assert(Number.isInteger(roaStats.importWorkerThreadId) && roaStats.importWorkerThreadId > 0);
        assert(Number.isInteger(aspaStats.importWorkerThreadId) && aspaStats.importWorkerThreadId > 0);

        const roaImportRequest = observedRequests.find(entry => entry.op === RpkiConst.RPKI_REQ_TYPES.IMPORT_ROA_JSON);
        const aspaImportRequest = observedRequests.find(
            entry => entry.op === RpkiConst.RPKI_REQ_TYPES.IMPORT_ASPA_JSON
        );
        assert.deepEqual(Object.keys(roaImportRequest.data).sort(), ['filePath', 'limit']);
        assert.deepEqual(Object.keys(aspaImportRequest.data).sort(), ['filePath', 'limit']);
        assert.equal('dbPath' in roaImportRequest.data, false, 'main must not send or own the SQLite import path');

        const rendererImport = await rpkiApp.handleImportRoaJson({ sender }, { filePath: roaPath, limit: 1 });
        assert.equal(rendererImport.status, 'success', rendererImport.msg);
        assert.equal(
            Object.prototype.hasOwnProperty.call(rendererImport.data, 'importWorkerThreadId'),
            false,
            'the nested worker thread id is CI diagnostics and must not reach the renderer'
        );

        const deletedRoa = await rpkiApp.handleDeleteRoa(null, {
            prefix: '192.0.2.0/24',
            asn: 65000,
            maxLength: 24
        });
        const deletedAspa = await rpkiApp.handleDeleteAspa(null, { customerAsn: 65000 });
        assert.equal(deletedRoa.status, 'success', deletedRoa.msg);
        assert.equal(deletedAspa.status, 'success', deletedAspa.msg);

        const clearedRoas = await rpkiApp.handleDeleteAllRoa();
        const clearedAspas = await rpkiApp.handleDeleteAllAspa();
        assert.equal(clearedRoas.status, 'success', clearedRoas.msg);
        assert.equal(clearedAspas.status, 'success', clearedAspas.msg);

        const retainedRoa = { prefix: '10.0.0.0/24', asn: 65100, maxLength: 24 };
        const retainedAspa = { customerAsn: 65100, providerAsns: [65101], afiFlags: 3 };
        assert.equal((await rpkiApp.handleAddRoa(null, retainedRoa)).status, 'success');
        assert.equal((await rpkiApp.handleAddAspa(null, retainedAspa)).status, 'success');

        const firstStop = await rpkiApp.handleStopRpki();
        assert.equal(firstStop.status, 'success', firstStop.msg);
        assert.equal(rpkiApp.rpkiReady, false);
        await waitFor(() => firstProcess.host.runtime === null, 'first RPKI Utility to exit');
        await assertStoppedDataPlane(rpkiApp, roaPath, aspaPath);

        const secondClient = await startRpki(rpkiApp, sender);
        secondProcess = await assertUtilityProcess(secondClient);
        assert.notEqual(secondProcess.pid, firstProcess.pid, 'RPKI restart must create a new Utility process');

        const restoredRoas = await rpkiApp.handleGetRoaList(null, { page: 1, pageSize: 25 });
        const restoredAspas = await rpkiApp.handleGetAspaList(null, { page: 1, pageSize: 25 });
        assert.equal(restoredRoas.data.storageTotal, 1, 'ROA data must be restored by the restarted Utility process');
        assert.equal(restoredAspas.data.storageTotal, 1, 'ASPA data must be restored by the restarted Utility process');

        const secondStop = await rpkiApp.handleStopRpki();
        assert.equal(secondStop.status, 'success', secondStop.msg);
        await waitFor(() => secondProcess.host.runtime === null, 'second RPKI Utility to exit');

        const runtimeStates = rendererEvents
            .filter(event => event.type === 'rpki:runtimeChanged')
            .map(event => event.data.running);
        assert.deepEqual(runtimeStates, [true, false, true, false]);

        console.log(
            `RPKI Utility ownership passed: main=${process.pid}, first=${firstProcess.pid}, second=${secondProcess.pid}, ` +
                `importThreads=${roaStats.importWorkerThreadId}/${aspaStats.importWorkerThreadId}`
        );
    } finally {
        if (rpkiApp.worker) await rpkiApp.handleStopRpki().catch(() => {});
        RequestWorkerClient.prototype.start = originalThreadStart;
        RpkiSqliteStore.prototype.open = originalSqliteOpen;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = main;
