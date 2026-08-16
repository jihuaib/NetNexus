'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const projectRoot = path.resolve(__dirname, '..', '..');
const yangAppPath = path.join(projectRoot, 'electron', 'app', 'yangApp.js');
const netconfAppPath = path.join(projectRoot, 'electron', 'app', 'netconfApp.js');
const yangProcessPath = path.join(projectRoot, 'electron', 'worker', 'yang', 'yangProcess.js');
const yangDownloadServicePath = path.join(projectRoot, 'electron', 'worker', 'yang', 'yangDownloadService.js');
const yangRuntimeServicePath = path.join(projectRoot, 'electron', 'worker', 'yang', 'yangRuntimeService.js');
const yangRuntimeHostPath = path.join(projectRoot, 'electron', 'worker', 'yang', 'yangRuntimeHost.js');
const localCompilerClientPath = path.join(projectRoot, 'electron', 'worker', 'yang', 'localYangCompilerClient.js');
const YangApp = require(yangAppPath);
const NetconfApp = require(netconfAppPath);
const { LOG_REQ_TYPES } = require('../../electron/const/toolsConst');
const { NETCONF_REQ_TYPES } = require('../../electron/const/yangConst');
const {
    YANG_PROCESS_REQ_TYPES,
    YANG_PROCESS_EVT_TYPES,
    YANG_RENDERER_CHANNELS
} = require('../../electron/worker/yang/yangProcessProtocol');

const DEFAULT_REQUEST_TIMEOUT = 120000;

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
    constructor(values = {}) {
        this.values = new Map(Object.entries(values));
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

class FakeProcessClient extends EventEmitter {
    constructor() {
        super();
        this.calls = [];
        this.responses = new Map();
    }

    async sendRequest(operation, data, options = {}) {
        this.calls.push({ operation, data, options });
        if (this.responses.has(operation)) {
            return { status: 'success', data: this.responses.get(operation) };
        }
        if (operation === YANG_PROCESS_REQ_TYPES.CONFIGURE) {
            return { status: 'success', data: { configured: true } };
        }
        return {
            status: 'success',
            data: {
                status: 'success',
                data: { operation, payload: data },
                msg: 'forwarded'
            }
        };
    }
}

function assertStaticMainProcessBoundary() {
    const source = fs.readFileSync(yangAppPath, 'utf8');
    const forbiddenDependencies = [
        ['YangRegistry', /\bYangRegistry\b/u],
        ['TaskManager', /\bTaskManager\b/u],
        ['RequestWorkerClient', /\bRequestWorkerClient\b/u],
        ['WorkerWithPromise', /\bWorkerWithPromise\b/u],
        ['YangCompilerWorker', /\bYangCompilerWorker\b/u],
        ['LocalYangCompilerClient', /\bLocalYangCompilerClient\b/u],
        ['yangCompilerWorker module', /yangCompilerWorker/u],
        ['worker_threads', /require\(["'](?:node:)?worker_threads["']\)/u],
        ['child_process', /require\(["'](?:node:)?child_process["']\)/u],
        ['worker path resolver', /require\(["'][^"']*workerPathResolver[^"']*["']\)/u],
        ['YANG aggregate business module', /require\(["']\.\.\/utils\/yang(?:\/index(?:\.js)?)?["']\)/u],
        ['NETCONF business module', /require\(["'][^"']*utils\/netconf(?:\/index(?:\.js)?)?["']\)/u],
        ['NETCONF worker implementation', /require\(["'][^"']*netconfWorker[^"']*["']\)/u]
    ];

    for (const [label, pattern] of forbiddenDependencies) {
        assert.doesNotMatch(source, pattern, `Electron main YangApp must not depend on ${label}`);
    }

    for (const legacyBusinessState of [
        'taskManager',
        'compileResult',
        'lastCompile',
        'compilationRestorePromises',
        'progressReporters',
        'activeWorkspaceImports'
    ]) {
        assert.doesNotMatch(
            source,
            new RegExp(`\\b${legacyBusinessState}\\b`, 'u'),
            `Electron main YangApp must not own ${legacyBusinessState} business state`
        );
    }

    assert.match(source, /yangProcessProtocol/u, 'Electron main YangApp must use the YANG process protocol');
    assert.match(source, /\.sendRequest\(/u, 'Electron main YangApp must forward requests through a process client');

    const runtimeSource = fs.readFileSync(yangRuntimeServicePath, 'utf8');
    const runtimeHostSource = fs.readFileSync(yangRuntimeHostPath, 'utf8');
    const localCompilerSource = fs.readFileSync(localCompilerClientPath, 'utf8');
    for (const [label, pattern] of [
        ['RequestWorkerClient', /\bRequestWorkerClient\b/u],
        ['yangCompilerWorker module', /yangCompilerWorker/u],
        ['worker path resolver', /workerPathResolver/u],
        ['worker_threads', /require\(["'](?:node:)?worker_threads["']\)/u]
    ]) {
        assert.doesNotMatch(
            `${runtimeSource}\n${runtimeHostSource}\n${localCompilerSource}`,
            pattern,
            `YANG process compilation must not delegate to ${label}`
        );
    }
    assert.match(runtimeHostSource, /LocalYangCompilerClient/u, 'YANG process host must own the local compiler client');
    assert.match(localCompilerSource, /YangRegistry/u, 'the local YANG process compiler must own YangRegistry');

    const netconfSource = fs.readFileSync(netconfAppPath, 'utf8');
    for (const [label, pattern] of [
        ['download TaskManager', /\bTaskManager\b/u],
        ['download inventory state', /\bthis\.inventories\b/u],
        ['get-schema execution', /NETCONF_REQ_TYPES\.GET_SCHEMA/u],
        ['download dependency selection', /selectInventoryModules|inventoryDeclaredDependencies|parsedDependencies/u],
        ['download executor', /\bdownloadOne\s*\(/u],
        ['download failure policy', /INITIAL_PASSWORD_CHANGE_REQUIRED_CODE|\bdownloadFailure\s*\(/u],
        ['YANG import execution', /\.importDownloadedContents\s*\(/u]
    ]) {
        assert.doesNotMatch(netconfSource, pattern, `Electron main NetconfApp must not own ${label}`);
    }
    assert.match(netconfSource, /YANG_PROCESS_REQ_TYPES\.DOWNLOAD_MODULES/u);
    assert.match(netconfSource, /YANG_PROCESS_REQ_TYPES\.GET_TASK/u);
    assert.match(netconfSource, /YANG_PROCESS_REQ_TYPES\.CANCEL_TASK/u);

    const processSource = fs.readFileSync(yangProcessPath, 'utf8');
    const downloadSource = fs.readFileSync(yangDownloadServicePath, 'utf8');
    assert.match(processSource, /YangDownloadService/u, 'the unified YANG process must own download orchestration');
    assert.match(processSource, /YANG_PROCESS_REQ_TYPES\.DOWNLOAD_MODULES/u);
    assert.match(downloadSource, /\bTaskManager\b/u);
    assert.match(downloadSource, /NETCONF_REQ_TYPES\.GET_SCHEMA/u);
    assert.match(downloadSource, /importDownloadedContents/u);
}

function createEvent() {
    return {
        sender: {
            isDestroyed: () => false,
            send() {}
        }
    };
}

async function assertStoppedRuntimeContract(app, ipc) {
    assert.equal(app.processClient, null);
    assert.equal(app.getRunning(), false);

    const listResult = await ipc.handlers.get('yang:listModules')(createEvent(), {
        profileId: 'stopped-profile'
    });
    assert.equal(listResult.status, 'success');
    assert.deepEqual(listResult.data, []);

    const workspaceResult = await ipc.handlers.get('yang:getWorkspace')(createEvent(), {
        profileId: 'stopped-profile'
    });
    assert.equal(workspaceResult.status, 'success');
    assert.equal(workspaceResult.data.profileId, 'stopped-profile');
    assert.equal(workspaceResult.data.processRunning, false);
    assert.equal(workspaceResult.data.compileId, '');
    assert.equal(workspaceResult.data.schemaTree, null);
    assert.deepEqual(workspaceResult.data.modules, []);
    assert.deepEqual(workspaceResult.data.fileResults, []);
    assert.deepEqual(workspaceResult.data.diagnostics, []);
    assert.equal(workspaceResult.data.summary.moduleCount, 0);
    assert.equal(workspaceResult.data.summary.nodeCount, 0);

    const compilerResult = await ipc.handlers.get('yang:getCompilerStatus')(createEvent(), {});
    assert.equal(compilerResult.status, 'success');
    assert.equal(compilerResult.data.available, false);
    assert.equal(compilerResult.data.source, 'stopped');

    const runtimeResult = await ipc.handlers.get('yang:getRuntimeState')(createEvent());
    assert.deepEqual(runtimeResult.data, {
        running: false,
        ready: false,
        processRunning: false,
        activeProfileId: null
    });

    assert.equal(app.processClient, null, 'read-only YANG IPC must not lazily create the YANG process');
    assert.equal(app.getRunning(), false);
}

function rendererForwardingCases() {
    return new Map([
        ['yang:listModules', { profileId: 'router-a', query: 'interfaces' }],
        ['yang:importFiles', { profileId: 'router-a', filePaths: ['/tmp/interfaces.yang'] }],
        ['yang:importDirectory', { profileId: 'router-a', directoryPath: '/tmp/yang-models' }],
        ['yang:compile', { profileId: 'router-a', moduleIds: ['ietf-interfaces'] }],
        ['yang:getCompilerStatus', { force: true }],
        ['yang:clearWorkspace', { profileId: 'router-a' }],
        ['yang:getWorkspace', { profileId: 'router-a' }],
        ['yang:getSchemaRoots', { profileId: 'router-a', compileId: 'compile-1' }],
        ['yang:getSchemaChildren', { profileId: 'router-a', compileId: 'compile-1', parentId: 'schema-node-1' }],
        ['yang:getSchemaNode', { profileId: 'router-a', compileId: 'compile-1', nodeId: 'schema-node-2' }],
        [
            'yang:validateRpc',
            { profileId: 'router-a', compileId: 'compile-1', rpc: '<rpc message-id="1"><get/></rpc>' }
        ],
        ['yang:getModuleSource', { profileId: 'router-a', hash: 'module-hash-1' }],
        ['yang:getDiagnostics', { profileId: 'router-a', compileId: 'compile-1' }]
    ]);
}

async function assertRunningForwardingContract(app, ipc, store) {
    const client = new FakeProcessClient();
    const persistedState = { schemaVersion: 1, workspaces: { existing: { compileId: 'persisted' } } };
    store.set(YangApp.STATE_STORE_KEY, persistedState);
    store.set(YangApp.PENDING_WORKSPACE_DELETIONS_KEY, ['deleted-profile']);

    await app.attachProcessClient(client);
    assert.strictEqual(app.processClient, client);
    assert.equal(app.getRunning(), true);

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].operation, YANG_PROCESS_REQ_TYPES.CONFIGURE);
    assert.deepEqual(client.calls[0].data.persistedCompileState, persistedState);
    assert.deepEqual(client.calls[0].data.pendingWorkspaceDeletions, ['deleted-profile']);
    assert.equal(client.calls[0].options.timeoutMs, 30000);
    assert.equal(store.get(YangApp.PENDING_WORKSPACE_DELETIONS_KEY, null), null);

    const cases = rendererForwardingCases();
    assert.deepEqual(
        new Set(cases.keys()),
        new Set(YANG_RENDERER_CHANNELS),
        'every renderer-owned YANG process channel must have an explicit forwarding assertion'
    );

    for (const [channel, payload] of cases) {
        const before = client.calls.length;
        const result = await ipc.handlers.get(channel)(createEvent(), payload);
        assert.equal(client.calls.length, before + 1, `${channel} must issue exactly one process request`);
        const call = client.calls.at(-1);
        assert.equal(call.operation, channel, `${channel} must preserve the process operation name`);
        assert.deepEqual(call.data, payload, `${channel} must preserve its renderer payload`);
        assert.equal(
            call.options.timeoutMs,
            channel === 'yang:compile'
                ? 10 * 60 * 1000
                : channel === 'yang:validateRpc'
                  ? 60000
                  : DEFAULT_REQUEST_TIMEOUT,
            `${channel} must use the facade timeout contract`
        );
        assert.deepEqual(result, {
            status: 'success',
            data: { operation: channel, payload },
            msg: 'forwarded'
        });
        assert.strictEqual(app.processClient, client, `${channel} must reuse the attached YANG process`);
    }

    client.responses.set(YANG_PROCESS_REQ_TYPES.GET_WORKSPACE_GENERATION, 17);
    assert.equal(await app.getWorkspaceGeneration({ profileId: 'router-a' }), 17);
    assert.deepEqual(client.calls.at(-1), {
        operation: YANG_PROCESS_REQ_TYPES.GET_WORKSPACE_GENERATION,
        data: { profileId: 'router-a' },
        options: { timeoutMs: DEFAULT_REQUEST_TIMEOUT, signal: undefined }
    });

    const downloaded = { imported: 2 };
    client.responses.set(YANG_PROCESS_REQ_TYPES.IMPORT_DOWNLOADED_CONTENTS, downloaded);
    assert.deepEqual(
        await app.importDownloadedContents([{ content: 'module demo {}' }], { profileId: 'router-a' }),
        downloaded
    );
    assert.deepEqual(client.calls.at(-1).data, {
        contents: [{ content: 'module demo {}' }],
        options: { profileId: 'router-a' }
    });

    client.responses.set(YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE, true);
    const deletedWorkspaceId = app.profileWorkspaceId('router-a');
    store.set(YangApp.STATE_STORE_KEY, {
        schemaVersion: 1,
        workspaces: {
            [deletedWorkspaceId]: { compileId: 'deleted-compile' },
            retained: { compileId: 'retained-compile' }
        }
    });
    store.set(YangApp.PENDING_WORKSPACE_DELETIONS_KEY, ['router-a', 'retained-profile']);
    assert.equal(await app.deleteProfileWorkspace('router-a'), true);
    assert.deepEqual(client.calls.at(-1).data, { profileId: 'router-a' });
    assert.deepEqual(store.get(YangApp.PENDING_WORKSPACE_DELETIONS_KEY), ['retained-profile']);
    assert.deepEqual(store.get(YangApp.STATE_STORE_KEY).workspaces, {
        retained: { compileId: 'retained-compile' }
    });

    app.setActiveProfileId('router-a');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.calls.at(-1).operation, YANG_PROCESS_REQ_TYPES.SET_ACTIVE_PROFILE);
    assert.deepEqual(client.calls.at(-1).data, { profileId: 'router-a' });

    await app.handleLogLevelChange('debug');
    assert.equal(client.calls.at(-1).operation, LOG_REQ_TYPES.SET_LOG_LEVEL);
    assert.equal(client.calls.at(-1).data, 'debug');

    const nextPersistedState = { schemaVersion: 1, workspaces: {} };
    client.emit('event', YANG_PROCESS_EVT_TYPES.STATE_UPDATE, {
        key: YangApp.STATE_STORE_KEY,
        value: nextPersistedState
    });
    assert.deepEqual(store.get(YangApp.STATE_STORE_KEY), nextPersistedState);

    app.detachProcessClient(client);
    assert.equal(app.processClient, null);
    assert.equal(app.getRunning(), false);

    const callsAfterDetach = client.calls.length;
    const stoppedAgain = await ipc.handlers.get('yang:listModules')(createEvent(), { profileId: 'router-a' });
    assert.deepEqual(stoppedAgain.data, []);
    assert.equal(client.calls.length, callsAfterDetach, 'stopped reads must not reuse a detached process client');
}

async function assertNetconfYangForwardingBoundary() {
    const ipc = new FakeIpcMain();
    const app = new NetconfApp(ipc, new MemoryStore(), {
        yangApp: { setActiveProfileId() {} }
    });
    const client = new FakeProcessClient();
    client.responses.set(NETCONF_REQ_TYPES.DISCOVER_MODULES, { modules: [{ name: 'ietf-interfaces' }] });
    client.responses.set(YANG_PROCESS_REQ_TYPES.DOWNLOAD_MODULES, {
        taskId: 'download-task-1',
        status: 'running'
    });
    app.workerClient = client;
    app.workerReadyPromise = Promise.resolve();
    const event = createEvent();
    const request = {
        profileId: 'router-a',
        modules: [{ name: 'ietf-interfaces', revision: '2018-02-20' }],
        includeDependencies: true
    };

    const beforeDiscover = client.calls.length;
    assert.equal((await app.handleDiscoverModules(event, 'router-a')).status, 'success');
    assert.equal(client.calls.length, beforeDiscover + 1);
    assert.equal(client.calls.at(-1).operation, NETCONF_REQ_TYPES.DISCOVER_MODULES);
    assert.equal(client.calls.at(-1).data, 'router-a', 'main must preserve the discover payload');

    const beforeDownload = client.calls.length;
    assert.equal((await app.handleDownloadModules(event, request)).status, 'success');
    assert.equal(client.calls.length, beforeDownload + 1);
    assert.equal(client.calls.at(-1).operation, YANG_PROCESS_REQ_TYPES.DOWNLOAD_MODULES);
    assert.strictEqual(client.calls.at(-1).data, request, 'main must forward the exact download payload object');
    app.eventDispatcher.cleanup();
}

async function main() {
    assertStaticMainProcessBoundary();

    const ipc = new FakeIpcMain();
    const store = new MemoryStore();
    const app = new YangApp(ipc, store, {
        rootDir: path.join(projectRoot, '.tmp-yang-main-boundary-registry'),
        resourcesPath: path.join(projectRoot, 'resources'),
        isPackaged: false
    });

    try {
        await assertStoppedRuntimeContract(app, ipc);
        await assertRunningForwardingContract(app, ipc, store);
        await assertNetconfYangForwardingBoundary();
        console.log('YANG Electron-main static boundary, stopped-state and IPC forwarding tests passed');
    } finally {
        await app.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
