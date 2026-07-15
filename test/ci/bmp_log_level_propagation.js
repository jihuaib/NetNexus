const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const BmpApp = require('../../electron/app/bmpApp');
const { LOG_REQ_TYPES } = require('../../electron/const/toolsConst');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

function loadSystemAppClass() {
    const originalLoad = Module._load;
    const stubbedDependencies = new Set([
        './bgpApp',
        './toolsApp',
        './bmpApp',
        './rpkiApp',
        './ftpApp',
        './snmpApp',
        './dhcpApp',
        './ntpApp',
        './radiusApp',
        './tftpApp',
        './syslogApp',
        './updater',
        './nativeApp',
        './externalApiServer',
        './cli',
        './wiresharkPluginInstaller'
    ]);
    class DummyDependency {}
    Module._load = function loadWithSystemAppStubs(request, parent, isMain) {
        if (request === 'electron') {
            return { app: {}, dialog: {}, BrowserWindow: {} };
        }
        if (request === 'electron-store') {
            return DummyDependency;
        }
        if (request === './bmpApiRoutes') {
            return () => {};
        }
        if (stubbedDependencies.has(request)) {
            return DummyDependency;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return require('../../electron/app/systemApp');
    } finally {
        Module._load = originalLoad;
    }
}

const SystemApp = loadSystemAppClass();

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(messages, predicate, label) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        const match = messages.find(predicate);
        if (match) {
            return match;
        }
        await delay(2);
    }
    throw new Error(`timed out waiting for ${label}`);
}

async function exerciseMessageHandler({ withHook, failHook = false }) {
    const handlerPath = path.join(__dirname, '..', '..', 'electron', 'worker', 'core', 'workerMessageHandler.js');
    const hook = withHook
        ? `async logLevel => {
               parentPort.postMessage({ kind: 'hook-start', logLevel });
               await new Promise(resolve => setImmediate(resolve));
               parentPort.postMessage({ kind: 'hook-end', logLevel });
               ${failHook ? "throw new Error('synthetic hook failure');" : ''}
           }`
        : 'null';
    const source = `
        const { parentPort } = require('node:worker_threads');
        const WorkerMessageHandler = require(${JSON.stringify(handlerPath)});
        const handler = new WorkerMessageHandler({ onLogLevelChange: ${hook} });
        handler.init();
        parentPort.postMessage({ kind: 'ready' });
    `;
    const worker = new Worker(source, { eval: true });
    const messages = [];
    worker.on('message', message => messages.push(message));
    try {
        await waitFor(messages, message => message.kind === 'ready', 'worker ready');
        worker.postMessage({ messageId: 'set-log-level', op: LOG_REQ_TYPES.SET_LOG_LEVEL, data: 'off' });
        const response = await waitFor(
            messages,
            message => message.messageId === 'set-log-level',
            'SET_LOG_LEVEL response'
        );
        await delay(20);
        assert.equal(response.status, 'success');
        assert.equal(
            messages.filter(message => message.messageId === 'set-log-level').length,
            1,
            'SET_LOG_LEVEL must produce exactly one response'
        );
        if (withHook) {
            const hookStart = messages.findIndex(message => message.kind === 'hook-start');
            const hookEnd = messages.findIndex(message => message.kind === 'hook-end');
            const responseIndex = messages.findIndex(message => message.messageId === 'set-log-level');
            assert.ok(hookStart >= 0 && hookEnd > hookStart);
            assert.ok(responseIndex > hookEnd, 'the response should be sent after the asynchronous hook settles');
            assert.equal(messages[hookStart].logLevel, 'off');
        }
    } finally {
        await worker.terminate();
    }
}

async function testWorkerMessageHandler() {
    await exerciseMessageHandler({ withHook: false });
    await exerciseMessageHandler({ withHook: true });
    await exerciseMessageHandler({ withHook: true, failHook: true });
}

async function testBmpWorkerPropagation() {
    const worker = Object.create(BmpWorker.prototype);
    worker.bmpConfigData = {
        persistenceDbPath: '/tmp/netnexus-bmp-log-level.sqlite3',
        logLevel: 'debug'
    };
    worker.persistenceFailure = null;
    worker.bmpSocketsPaused = false;
    worker.schedulePersistenceSweep = () => {};

    const created = [];
    const forwarded = [];
    const writer = {
        async open() {
            return {
                schemaVersion: BmpPersistenceStore.SCHEMA_VERSION,
                journalMode: 'wal',
                dbPath: worker.bmpConfigData.persistenceDbPath
            };
        },
        async setLogLevel(logLevel) {
            forwarded.push(['writer', logLevel]);
        }
    };
    const reader = {
        async open() {},
        async close() {},
        async setLogLevel(logLevel) {
            forwarded.push(['reader', logLevel]);
            if (logLevel === 'warn') {
                throw new Error('synthetic reader failure');
            }
        }
    };
    worker.createPersistenceClient = options => {
        created.push(options);
        return options.readOnly ? reader : writer;
    };

    await worker.initializePersistence();
    assert.equal(created.length, 2);
    assert.equal(created[0].logLevel, 'debug');
    assert.equal(created[0].readOnly, undefined);
    assert.equal(created[1].logLevel, 'debug');
    assert.equal(created[1].readOnly, true);

    await worker.handleLogLevelChange('info');
    assert.deepEqual(forwarded, [
        ['writer', 'info'],
        ['reader', 'info']
    ]);
    assert.equal(worker.bmpConfigData.logLevel, 'info');

    await assert.doesNotReject(worker.handleLogLevelChange('warn'));
    assert.equal(worker.bmpConfigData.logLevel, 'warn');
}

async function testBmpAppOfflinePropagation() {
    const app = Object.create(BmpApp.prototype);
    app.persistenceDbPath = '/tmp/netnexus-bmp-offline-log-level.sqlite3';
    app.logLevel = 'debug';
    app.offlinePersistenceReader = null;
    app.offlinePersistenceOpenPromise = null;

    const created = [];
    app.createPersistenceClient = options => {
        const client = {
            options,
            async open() {
                return { schemaVersion: BmpPersistenceStore.SCHEMA_VERSION };
            },
            async close() {}
        };
        created.push(client);
        return client;
    };

    const reader = await app.openOfflinePersistenceReader();
    assert.equal(reader, created[0]);
    assert.deepEqual(
        created.map(client => client.options.readOnly === true),
        [true]
    );
    assert.deepEqual(
        created.map(client => client.options.logLevel),
        ['debug']
    );

    const forwarded = [];
    app.offlinePersistenceReader = {
        async setLogLevel(logLevel) {
            forwarded.push(logLevel);
        }
    };
    await app.handleLogLevelChange('info');
    assert.deepEqual(forwarded, ['info']);
    assert.equal(app.logLevel, 'info');

    app.offlinePersistenceReader = {
        async setLogLevel() {
            throw new Error('synthetic offline reader failure');
        }
    };
    await assert.doesNotReject(app.handleLogLevelChange('warn'));

    const incompatibleApp = Object.create(BmpApp.prototype);
    incompatibleApp.persistenceDbPath = '/tmp/netnexus-bmp-offline-incompatible.sqlite3';
    incompatibleApp.logLevel = 'debug';
    incompatibleApp.offlinePersistenceReader = null;
    incompatibleApp.offlinePersistenceOpenPromise = null;
    const incompatibleClients = [];
    incompatibleApp.createPersistenceClient = options => {
        const client = {
            options,
            async open() {
                const error = new Error('schema incompatible');
                error.code = 'BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE';
                throw error;
            },
            async close() {}
        };
        incompatibleClients.push(client);
        return client;
    };
    await assert.rejects(
        incompatibleApp.openOfflinePersistenceReader(),
        error => error.code === 'BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE'
    );
    assert.equal(incompatibleClients.length, 1, 'an incompatible database must not start an in-process migrator');
    assert.equal(incompatibleClients[0].options.readOnly, true);
    assert.equal(incompatibleApp.offlinePersistenceReader, null);
    assert.equal(incompatibleApp.offlinePersistenceOpenPromise, null);
}

async function testSystemAppHook() {
    const systemApp = Object.create(SystemApp.prototype);
    systemApp.currentLogLevel = 'debug';
    const calls = [];
    const appInstance = {
        logLevel: 'off',
        worker: {
            async sendRequest(op, logLevel) {
                calls.push(['worker', op, logLevel]);
            }
        },
        worker6: null,
        mibWorker: null,
        async handleLogLevelChange(logLevel) {
            await Promise.resolve();
            calls.push(['hook', logLevel]);
        }
    };

    systemApp.applyLogLevelToApp(appInstance);
    await delay(0);
    assert.equal(appInstance.logLevel, 'debug');
    assert.deepEqual(calls, [
        ['worker', LOG_REQ_TYPES.SET_LOG_LEVEL, 'debug'],
        ['hook', 'debug']
    ]);

    const failingApp = {
        worker: null,
        worker6: null,
        mibWorker: null,
        handleLogLevelChange() {
            throw new Error('synthetic app hook failure');
        }
    };
    systemApp.applyLogLevelToApp(failingApp);
    await delay(0);
    assert.equal(failingApp.logLevel, 'debug');
}

async function main() {
    await testWorkerMessageHandler();
    await testBmpWorkerPropagation();
    await testBmpAppOfflinePropagation();
    await testSystemAppHook();
    console.log('BMP log level propagation tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
