const assert = require('node:assert/strict');
const Module = require('node:module');

const DhcpConst = require('../../electron/const/dhcpConst');
const Dhcp6Const = require('../../electron/const/dhcp6Const');
const {
    PROTOCOL_PROCESS_SERVICES,
    getProtocolProcessDisplayName
} = require('../../electron/worker/core/protocolProcessServices');

const queuedClients = [];
const createdFactories = [];
const createdDispatchers = [];

class FakeProcessClient {
    constructor(responses = new Map()) {
        this.responses = responses;
        this.requests = [];
        this.listeners = new Map();
        this.terminateCount = 0;
    }

    async sendRequest(op, data = null, options = {}) {
        this.requests.push({ op, data, options });
        const response = this.responses.get(op);
        if (response instanceof Error) throw response;
        if (typeof response === 'function') return response(data, options);
        return response || { status: 'success', msg: 'ok', data: null };
    }

    addEventListener(eventName, listener) {
        if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
        this.listeners.get(eventName).add(listener);
    }

    removeEventListener(eventName, listener) {
        this.listeners.get(eventName)?.delete(listener);
    }

    emitEvent(eventName, data) {
        this.listeners.get(eventName)?.forEach(listener => listener(data));
    }

    async terminate() {
        this.terminateCount += 1;
    }
}

class FakeProtocolProcessWithPromise {
    constructor(processPath, options) {
        this.processPath = processPath;
        this.options = options;
        createdFactories.push(this);
    }

    createLongRunningProcess() {
        const client = queuedClients.shift();
        assert(client, 'a fake DHCP process client must be queued before start');
        client.processOptions = this.options;
        return client;
    }
}

class FakeEventDispatcher {
    constructor() {
        this.webContents = null;
        this.emitted = [];
        this.cleaned = false;
        createdDispatchers.push(this);
    }

    setWebContents(webContents) {
        this.webContents = webContents;
    }

    emit(eventName, data) {
        this.emitted.push({ eventName, data });
    }

    cleanup() {
        this.cleaned = true;
        this.webContents = null;
    }
}

function loadDhcpApp() {
    const originalLoad = Module._load;
    const loggerStub = { info() {}, warn() {}, error() {} };

    Module._load = function loadWithStubs(request, parent, isMain) {
        if (request === '../worker/core/protocolProcessWithPromise') return FakeProtocolProcessWithPromise;
        if (request === '../worker/core/workerPathResolver') {
            return { resolveWorkerPath: relativePath => relativePath };
        }
        if (request === '../utils/eventDispatcher') return FakeEventDispatcher;
        if (request === '../log/logger') return loggerStub;
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return require('../../electron/app/dhcpApp');
    } finally {
        Module._load = originalLoad;
    }
}

const DhcpApp = loadDhcpApp();

function createApp(client) {
    queuedClients.push(client);
    const ipcHandlers = new Map();
    const ipcMain = {
        handle(channel, handler) {
            ipcHandlers.set(channel, handler);
        }
    };
    const store = {
        values: new Map(),
        set(key, value) {
            this.values.set(key, value);
        },
        get(key) {
            return this.values.get(key);
        }
    };
    const app = new DhcpApp(ipcMain, store);
    const webContents = {};
    return { app, ipcHandlers, store, webContents };
}

function createConfig() {
    return {
        ...DhcpConst.DEFAULT_DHCP_CONFIG,
        v6: { ...Dhcp6Const.DEFAULT_DHCP6_CONFIG }
    };
}

function requestOps(client) {
    return client.requests.map(request => request.op);
}

async function testCombinedLifecycleAndRouting() {
    const responses = new Map([
        [DhcpConst.DHCP_REQ_TYPES.START_DHCP, { status: 'success', msg: 'v4 started', data: null }],
        [Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6, { status: 'success', msg: 'v6 started', data: null }],
        [
            DhcpConst.DHCP_REQ_TYPES.GET_LEASE_LIST,
            { status: 'success', msg: 'v4 leases', data: [{ macAddr: '00:11:22:33:44:55', ip: '192.0.2.100' }] }
        ],
        [
            Dhcp6Const.DHCP6_REQ_TYPES.GET_LEASE_LIST,
            { status: 'success', msg: 'v6 leases', data: [{ duid: '00010001aabbccdd', ip: '2001:db8::100' }] }
        ],
        [DhcpConst.DHCP_REQ_TYPES.RELEASE_LEASE, { status: 'success', msg: 'v4 released', data: null }],
        [Dhcp6Const.DHCP6_REQ_TYPES.RELEASE_LEASE, { status: 'success', msg: 'v6 released', data: null }],
        [DhcpConst.DHCP_REQ_TYPES.STOP_DHCP, { status: 'success', msg: 'v4 stopped', data: null }],
        [Dhcp6Const.DHCP6_REQ_TYPES.STOP_DHCP6, { status: 'success', msg: 'v6 stopped', data: null }]
    ]);
    const client = new FakeProcessClient(responses);
    const { app, webContents } = createApp(client);
    const factoryCountBefore = createdFactories.length;

    const started = await app.handleStartDhcp({ sender: webContents }, createConfig());
    assert.equal(started.status, 'success');
    assert.equal(createdFactories.length, factoryCountBefore + 1, 'DHCP start must create exactly one process');
    const factory = createdFactories.at(-1);
    assert.equal(factory.processPath, 'dhcp/dhcpProcess.js');
    assert.equal(factory.options.serviceName, PROTOCOL_PROCESS_SERVICES.DHCP);
    assert.equal(app.worker, client);
    assert.equal(app.dhcp6Running, true);
    assert.deepEqual(requestOps(client).slice(0, 2), [
        DhcpConst.DHCP_REQ_TYPES.START_DHCP,
        Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6
    ]);

    const duplicateStart = await app.handleStartDhcp({ sender: webContents }, createConfig());
    assert.equal(duplicateStart.status, 'error');
    assert.equal(createdFactories.length, factoryCountBefore + 1, 'duplicate start must reuse the running state');

    client.emitEvent(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, { opType: 'add', data: { ip: '192.0.2.100' } });
    client.emitEvent(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, { opType: 'add', data: { ip: '2001:db8::100' } });
    const dispatcher = createdDispatchers.at(-1);
    assert.deepEqual(
        dispatcher.emitted.map(event => event.data.data.version),
        [4, 6]
    );

    const leases = await app.handleGetLeaseList();
    assert.equal(leases.status, 'success');
    assert.deepEqual(leases.data, [
        { macAddr: '00:11:22:33:44:55', ip: '192.0.2.100', version: 4, id: '00:11:22:33:44:55' },
        { duid: '00010001aabbccdd', ip: '2001:db8::100', version: 6, id: '00010001aabbccdd' }
    ]);

    assert.equal((await app.handleReleaseLease(null, '00:11:22:33:44:55')).status, 'success');
    assert.equal((await app.handleReleaseDhcp6Lease(null, '00010001aabbccdd')).status, 'success');

    const stopped = await app.handleStopDhcp();
    assert.equal(stopped.status, 'success');
    assert.equal(client.terminateCount, 1, 'combined DHCP process must terminate once');
    assert.equal(app.worker, null);
    assert.equal(app.dhcp6Running, false);
    assert.equal(dispatcher.cleaned, true);
    assert(requestOps(client).includes(DhcpConst.DHCP_REQ_TYPES.STOP_DHCP));
    assert(requestOps(client).includes(Dhcp6Const.DHCP6_REQ_TYPES.STOP_DHCP6));
}

async function testDhcp6StartFailureKeepsDhcp4Running() {
    const responses = new Map([
        [DhcpConst.DHCP_REQ_TYPES.START_DHCP, { status: 'success', msg: 'v4 started', data: null }],
        [Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6, new Error('synthetic v6 bind failure')],
        [DhcpConst.DHCP_REQ_TYPES.STOP_DHCP, { status: 'success', msg: 'v4 stopped', data: null }]
    ]);
    const client = new FakeProcessClient(responses);
    const { app, webContents } = createApp(client);

    const started = await app.handleStartDhcp({ sender: webContents }, createConfig());
    assert.equal(started.status, 'success');
    assert.equal(app.worker, client, 'v4 must remain attached after a v6 startup failure');
    assert.equal(app.dhcp6Running, false);
    assert.equal(client.terminateCount, 0);
    assert.equal((await app.handleReleaseDhcp6Lease(null, 'missing-duid')).status, 'error');

    await app.handleStopDhcp();
    assert.equal(client.terminateCount, 1);
    assert.equal(requestOps(client).includes(Dhcp6Const.DHCP6_REQ_TYPES.STOP_DHCP6), false);
}

async function testSharedProcessExitDuringDhcp6StartFailsWholeStart() {
    const workerExitError = new Error('synthetic shared DHCP process exit');
    workerExitError.code = 'WORKER_EXIT';
    const client = new FakeProcessClient();
    client.responses = new Map([
        [DhcpConst.DHCP_REQ_TYPES.START_DHCP, { status: 'success', msg: 'v4 started', data: null }],
        [
            Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6,
            () => {
                client.processOptions.onExit(19, client, { expected: false });
                throw workerExitError;
            }
        ]
    ]);
    const { app, webContents } = createApp(client);

    const started = await app.handleStartDhcp({ sender: webContents }, createConfig());
    const dispatcher = createdDispatchers.at(-1);

    assert.equal(started.status, 'error');
    assert.match(started.msg, /shared DHCP process exit/);
    assert.equal(app.worker, null, 'a dead shared process must not be reported as a running DHCPv4 server');
    assert.equal(app.dhcp6Running, false);
    assert.equal(app.eventDispatcher, null);
    assert.equal(dispatcher.cleaned, true);
    assert.equal(client.terminateCount, 0, 'the already exited shared process must not be terminated a second time');
}

async function testUnexpectedExitClearsCombinedState() {
    const client = new FakeProcessClient(
        new Map([
            [DhcpConst.DHCP_REQ_TYPES.START_DHCP, { status: 'success', msg: 'v4 started', data: null }],
            [Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6, { status: 'success', msg: 'v6 started', data: null }]
        ])
    );
    const { app, webContents } = createApp(client);

    await app.handleStartDhcp({ sender: webContents }, createConfig());
    const dispatcher = createdDispatchers.at(-1);
    client.processOptions.onExit(17, client, { expected: false });

    assert.equal(app.worker, null);
    assert.equal(app.dhcp6Running, false);
    assert.equal(app.eventDispatcher, null);
    assert.equal(dispatcher.cleaned, true);
}

async function main() {
    assert.notEqual(DhcpConst.DHCP_REQ_TYPES.START_DHCP, Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6);
    assert.notEqual(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT);
    assert.equal(getProtocolProcessDisplayName(PROTOCOL_PROCESS_SERVICES.DHCP), 'DHCP 协议进程');
    await testCombinedLifecycleAndRouting();
    await testDhcp6StartFailureKeepsDhcp4Running();
    await testSharedProcessExitDuringDhcp6StartFailsWholeStart();
    await testUnexpectedExitClearsCombinedState();
    assert.equal(queuedClients.length, 0);
    console.log('DHCP combined process lifecycle tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
