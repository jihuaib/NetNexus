'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app } = require('electron');

const NetconfApp = require('../../electron/app/netconfApp');
const YangApp = require('../../electron/app/yangApp');
const { YANG_EVT_TYPES } = require('../../electron/const/yangConst');
const { PROTOCOL_PROCESS_SERVICES } = require('../../electron/worker/core/protocolProcessServices');
const { YangRegistry } = require('../../electron/utils/yang');
const { MockNetconfServer } = require('../../scripts/mockNetconfServer');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_PROJECT_ROOT = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || PROJECT_ROOT);
const YANG_SERVICE = PROTOCOL_PROCESS_SERVICES.YANG;

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        assert.equal(this.handlers.has(channel), false, `duplicate IPC handler: ${channel}`);
        this.handlers.set(channel, handler);
    }
}

class MemoryStore {
    constructor() {
        this.values = new Map();
    }

    get(key, fallback = undefined) {
        return this.values.has(key) ? this.values.get(key) : fallback;
    }

    set(key, value) {
        this.values.set(key, value);
    }

    delete(key) {
        return this.values.delete(key);
    }
}

class FakeWebContents extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
    }

    isDestroyed() {
        return false;
    }

    send(channel, payload) {
        this.messages.push({ channel, payload });
        this.emit('sent', channel, payload);
    }
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const result = predicate();
        if (result) return result;
        await delay(20);
    } while (Date.now() < deadline);
    throw new Error(message);
}

async function waitForTask(netconfApp, event, taskId, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const response = await netconfApp.handleGetTask(event, taskId);
        if (response.status === 'success' && ['completed', 'failed', 'cancelled'].includes(response.data?.status)) {
            return response.data;
        }
        await delay(20);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for YANG download task ${taskId}`);
}

async function waitForProcessMetric(pid, present, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const metric = app.getAppMetrics().find(item => item.pid === pid);
        if (Boolean(metric) === present) return metric || null;
        await delay(20);
    } while (Date.now() < deadline);

    const state = present ? 'appear in' : 'leave';
    throw new Error(`Timed out waiting for YANG PID ${pid} to ${state} app.getAppMetrics()`);
}

async function waitForProcessPid(host, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    do {
        if (Number.isInteger(host.pid) && host.pid > 0) return host.pid;
        if (!host.runtime) throw new Error(`${YANG_SERVICE} exited before exposing its PID`);
        await delay(10);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${YANG_SERVICE} to expose its PID`);
}

async function assertYangUtilityProcess(client, label) {
    assert(client, `${label}: the YANG process client must exist`);
    const host = client.process;
    assert(host, `${label}: the YANG process host must exist`);
    assert.equal(host.runtimeKind, 'utility-process', `${label}: YANG must use Electron utilityProcess`);

    const pid = await waitForProcessPid(host);
    assert.notEqual(pid, process.pid, `${label}: the Utility PID must differ from the Electron main PID`);
    const metric = await waitForProcessMetric(pid, true);
    assert.equal(metric.type, 'Utility', `${label}: app metrics must identify the process as Utility`);
    assert(
        metric.name === YANG_SERVICE || metric.serviceName === YANG_SERVICE,
        `${label}: app metrics must identify ${YANG_SERVICE}`
    );
    return { client, host, pid };
}

async function waitForYangProcessClient(netconfApp, label) {
    return waitFor(() => netconfApp.workerClient, `${label}: timed out waiting for the YANG process client`, 5_000);
}

async function assertYangProcessStopped(processState, label) {
    await waitFor(() => processState.host.runtime === null, `${label}: YANG Utility did not exit`, 10_000);
    await waitForProcessMetric(processState.pid, false);
}

function yangUtilityMetrics() {
    return app.getAppMetrics().filter(metric => metric.name === YANG_SERVICE || metric.serviceName === YANG_SERVICE);
}

function createProfile(status, id, password = 'netconf') {
    return {
        id,
        name: `NETCONF lifecycle ${id}`,
        host: status.host,
        port: status.port,
        username: status.username,
        password,
        authMethod: 'password',
        hostKeyPolicy: 'strict',
        hostKeyFingerprint: status.fingerprint,
        rememberCredentials: false,
        connectTimeout: 5_000,
        rpcTimeout: 5_000,
        keepaliveInterval: 0,
        keepaliveCountMax: 3,
        autoReconnect: false
    };
}

function terminalTaskEvent(webContents, taskId) {
    for (let index = webContents.messages.length - 1; index >= 0; index -= 1) {
        const message = webContents.messages[index];
        if (message.channel !== 'unified-event' || message.payload?.type !== YANG_EVT_TYPES.TASK_PROGRESS) continue;
        const task = message.payload?.data?.data;
        if (task?.taskId !== taskId) continue;
        if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    }
    return null;
}

async function assertStoppedQueriesDoNotSpawn(yangApp, netconfApp, event, profileId, label) {
    const list = await yangApp.handleListModules(event, { profileId });
    assert.equal(list.status, 'success', `${label}: stopped module query must succeed`);
    assert.deepEqual(list.data, [], `${label}: stopped module query must be empty`);

    const workspace = await yangApp.handleGetWorkspace(event, { profileId });
    assert.equal(workspace.status, 'success', `${label}: stopped workspace query must succeed`);
    assert.deepEqual(workspace.data.modules, [], `${label}: stopped workspace must not expose persisted modules`);
    assert.equal(workspace.data.processRunning, false, `${label}: stopped workspace must report no process`);

    const session = await netconfApp.handleGetSessionState(event, profileId);
    assert.equal(session.status, 'success', `${label}: stopped session query must succeed`);
    assert.equal(session.data.connected, false, `${label}: stopped session must be disconnected`);
    assert.equal(session.data.processRunning, false, `${label}: stopped session must report no process`);

    assert.equal(netconfApp.workerClient, null, `${label}: session query must not create a process client`);
    assert.equal(yangApp.processClient, null, `${label}: YANG queries must not create a process client`);
    await delay(100);
    assert.deepEqual(yangUtilityMetrics(), [], `${label}: read-only queries must not launch a YANG Utility`);
}

async function main() {
    assert.equal(
        process.env.NETNEXUS_EXPECT_UTILITY_PROCESS,
        '1',
        'YANG lifecycle CI must run through the real Electron Utility runner'
    );

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-process-lifecycle-'));
    const server = new MockNetconfServer({ port: 0, quiet: true });
    const ipcMain = new FakeIpcMain();
    const store = new MemoryStore();
    const webContents = new FakeWebContents();
    const event = { sender: webContents };
    const credentialStore = {
        sanitizeProfile: profile => ({ ...profile }),
        protectProfile: profile => ({ ...profile }),
        hydrateProfile: (profile, secrets) => ({ ...profile, ...secrets })
    };
    const yangApp = new YangApp(ipcMain, store, {
        rootDir: path.join(temporaryRoot, 'repository'),
        resourcesPath: path.join(SOURCE_PROJECT_ROOT, 'resources'),
        isPackaged: false,
        primaryWebContents: webContents
    });
    const netconfApp = new NetconfApp(ipcMain, store, {
        credentialStore,
        yangApp,
        primaryWebContents: webContents
    });

    const originalCompile = YangRegistry.prototype.compile;
    const originalImportContents = YangRegistry.prototype.importContents;
    let serverStatus = null;

    try {
        serverStatus = await server.start();
        const profileId = 'yang-process-lifecycle-router';
        const profile = createProfile(serverStatus, profileId);

        assert.deepEqual(yangUtilityMetrics(), [], 'the test must begin without a YANG Utility process');
        await assertStoppedQueriesDoNotSpawn(yangApp, netconfApp, event, profileId, 'initial stopped state');

        const failedProfile = createProfile(serverStatus, 'yang-process-lifecycle-failed', 'incorrect-password');
        const failedConnectPromise = netconfApp.handleConnect(event, failedProfile);
        const failedProcess = await assertYangUtilityProcess(
            await waitForYangProcessClient(netconfApp, 'failed connect'),
            'failed connect'
        );
        const failedConnect = await failedConnectPromise;
        assert.equal(failedConnect.status, 'error', 'invalid credentials must fail the connection');
        assert.equal(netconfApp.workerClient, null, 'failed connect must release the main-process client');
        assert.equal(yangApp.processClient, null, 'failed connect must detach YangApp from the process');
        await assertYangProcessStopped(failedProcess, 'failed connect');

        const connectPromise = netconfApp.handleConnect(event, profile);
        const connectedProcess = await assertYangUtilityProcess(
            await waitForYangProcessClient(netconfApp, 'successful connect'),
            'successful connect'
        );
        const connected = await connectPromise;
        assert.equal(connected.status, 'success', connected.msg);
        assert.strictEqual(netconfApp.workerClient, connectedProcess.client);
        assert.strictEqual(yangApp.processClient, connectedProcess.client, 'NETCONF and YANG must share one client');
        assert.strictEqual(
            connectedProcess.client.process,
            connectedProcess.host,
            'NETCONF and YANG must share one host'
        );

        const connectedSession = await netconfApp.handleGetSessionState(event, profileId);
        assert.equal(connectedSession.status, 'success');
        assert.equal(connectedSession.data.connected, true);
        const emptyOnlineModules = await yangApp.handleListModules(event, { profileId });
        assert.equal(emptyOnlineModules.status, 'success');
        assert.deepEqual(emptyOnlineModules.data, []);
        const emptyOnlineWorkspace = await yangApp.handleGetWorkspace(event, { profileId });
        assert.equal(emptyOnlineWorkspace.status, 'success');
        assert.deepEqual(emptyOnlineWorkspace.data.modules, []);
        assert.equal(connectedProcess.host.pid, connectedProcess.pid, 'queries must stay on the connected Utility PID');
        assert.strictEqual(netconfApp.workerClient, connectedProcess.client);
        assert.strictEqual(yangApp.processClient, connectedProcess.client);

        YangRegistry.prototype.importContents = function forbiddenMainImport() {
            throw new Error('YANG import executed in the Electron main process');
        };
        YangRegistry.prototype.compile = async function forbiddenMainCompile() {
            throw new Error('YANG compile executed in the Electron main process');
        };
        try {
            const discovered = await netconfApp.handleDiscoverModules(event, profileId);
            assert.equal(discovered.status, 'success', discovered.msg);
            const discoveredNames = new Set(discovered.data.modules.map(module => module.name));
            assert(discoveredNames.has('netnexus-mock-device'));
            assert(discoveredNames.has('netnexus-mock-types'));
            assert.equal(
                connectedProcess.host.pid,
                connectedProcess.pid,
                'module discovery must retain the connected Utility PID'
            );

            const download = await netconfApp.handleDownloadModules(event, {
                profileId,
                modules: [{ name: 'netnexus-mock-device', revision: '2026-07-18' }],
                includeDependencies: true
            });
            assert.equal(download.status, 'success', download.msg);
            assert(download.data?.taskId, 'download must return a Utility-owned task id');
            const downloaded = await waitForTask(netconfApp, event, download.data.taskId);
            assert.equal(downloaded.status, 'completed', JSON.stringify(downloaded));
            assert.equal(
                connectedProcess.host.pid,
                connectedProcess.pid,
                'download/import must retain the connected Utility PID'
            );

            const modules = await yangApp.handleListModules(event, { profileId });
            assert.equal(modules.status, 'success');
            assert.equal(modules.data.length, 2);
            assert.equal(
                connectedProcess.host.pid,
                connectedProcess.pid,
                'import must retain the connected Utility PID'
            );

            const compile = await yangApp.handleCompile(event, {
                profileId,
                force: true,
                features: ['netnexus-mock-device:interface-counters']
            });
            assert.equal(compile.status, 'success', compile.msg);
            assert(compile.data?.taskId, 'compile must return a process-owned task id');
            const terminalTask = await waitFor(
                () => terminalTaskEvent(webContents, compile.data.taskId),
                `timed out waiting for compile task ${compile.data.taskId}`,
                120_000
            );
            assert.equal(terminalTask.status, 'completed', JSON.stringify(terminalTask));

            const compiledWorkspace = await yangApp.handleGetWorkspace(event, { profileId });
            assert.equal(compiledWorkspace.status, 'success', compiledWorkspace.msg);
            assert.equal(compiledWorkspace.data.success, true, JSON.stringify(compiledWorkspace.data.diagnostics));
            assert(compiledWorkspace.data.compileId, 'compiled workspace must expose its compile id');
            assert.equal(compiledWorkspace.data.modules.length, 2);
            assert.equal(
                connectedProcess.host.pid,
                connectedProcess.pid,
                'compile must run on the connected Utility PID'
            );
            assert.strictEqual(netconfApp.workerClient, connectedProcess.client);
            assert.strictEqual(yangApp.processClient, connectedProcess.client);
        } finally {
            YangRegistry.prototype.compile = originalCompile;
            YangRegistry.prototype.importContents = originalImportContents;
        }

        const disconnected = await netconfApp.handleDisconnect(event, profileId);
        assert.equal(disconnected.status, 'success', disconnected.msg);
        assert.equal(netconfApp.workerClient, null, 'disconnect must clear the NETCONF process client');
        assert.equal(yangApp.processClient, null, 'disconnect must clear the YANG process client');
        await assertYangProcessStopped(connectedProcess, 'disconnect');
        await assertStoppedQueriesDoNotSpawn(yangApp, netconfApp, event, profileId, 'after disconnect');

        const reconnectPromise = netconfApp.handleConnect(event, profile);
        const reconnectedProcess = await assertYangUtilityProcess(
            await waitForYangProcessClient(netconfApp, 'reconnect'),
            'reconnect'
        );
        const reconnected = await reconnectPromise;
        assert.equal(reconnected.status, 'success', reconnected.msg);
        assert.notEqual(reconnectedProcess.pid, connectedProcess.pid, 'reconnect must create a new YANG Utility PID');
        assert.strictEqual(yangApp.processClient, reconnectedProcess.client);

        const redisconnected = await netconfApp.handleDisconnect(event, profileId);
        assert.equal(redisconnected.status, 'success', redisconnected.msg);
        await assertYangProcessStopped(reconnectedProcess, 'disconnect after reconnect');
        assert.equal(netconfApp.workerClient, null);
        assert.equal(yangApp.processClient, null);

        const testConnectionPromise = netconfApp.handleTestConnection(event, {
            ...profile,
            id: 'yang-process-lifecycle-test-connection'
        });
        const testConnectionProcess = await assertYangUtilityProcess(
            await waitForYangProcessClient(netconfApp, 'testConnection'),
            'testConnection'
        );
        const tested = await testConnectionPromise;
        assert.equal(tested.status, 'success', tested.msg);
        assert.equal(netconfApp.workerClient, null, 'testConnection must not retain an ephemeral process client');
        assert.equal(yangApp.processClient, null, 'testConnection must detach the ephemeral YANG process');
        await assertYangProcessStopped(testConnectionProcess, 'testConnection');
        await assertStoppedQueriesDoNotSpawn(yangApp, netconfApp, event, profileId, 'after testConnection');

        const remoteDisconnectPromise = netconfApp.handleConnect(event, {
            ...profile,
            autoReconnect: true
        });
        const remoteDisconnectProcess = await assertYangUtilityProcess(
            await waitForYangProcessClient(netconfApp, 'remote disconnect'),
            'remote disconnect'
        );
        const remoteConnected = await remoteDisconnectPromise;
        assert.equal(remoteConnected.status, 'success', remoteConnected.msg);
        await server.stop();
        await waitFor(
            () => netconfApp.workerClient === null && yangApp.processClient === null,
            'remote disconnect must release the shared YANG process client',
            10_000
        );
        await assertYangProcessStopped(remoteDisconnectProcess, 'remote disconnect');
        await assertStoppedQueriesDoNotSpawn(yangApp, netconfApp, event, profileId, 'after remote disconnect');

        console.log(
            `YANG process lifecycle passed: failed=${failedProcess.pid}, connected=${connectedProcess.pid}, ` +
                `reconnected=${reconnectedProcess.pid}, tested=${testConnectionProcess.pid}, ` +
                `remote=${remoteDisconnectProcess.pid}`
        );
    } finally {
        YangRegistry.prototype.compile = originalCompile;
        YangRegistry.prototype.importContents = originalImportContents;
        await netconfApp.closeAll().catch(() => {});
        await yangApp.close().catch(() => {});
        if (serverStatus) await server.stop().catch(() => {});
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = main;
