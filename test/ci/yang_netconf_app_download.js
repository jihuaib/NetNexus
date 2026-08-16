'use strict';

const assert = require('node:assert/strict');
const NetconfApp = require('../../electron/app/netconfApp');
const { NETCONF_REQ_TYPES } = require('../../electron/const/yangConst');
const YangDownloadService = require('../../electron/worker/yang/yangDownloadService');
const YangProcessService = require('../../electron/worker/yang/yangProcess');
const { YANG_PROCESS_REQ_TYPES } = require('../../electron/worker/yang/yangProcessProtocol');

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }
}

class MemoryStore {
    constructor() {
        this.values = new Map();
    }

    get(key, fallback) {
        return this.values.has(key) ? this.values.get(key) : fallback;
    }

    set(key, value) {
        this.values.set(key, value);
    }
}

const immediate = () => new Promise(resolve => setImmediate(resolve));

const inventory = {
    source: 'rfc8525',
    modules: [
        {
            name: 'example-system',
            revision: '2026-02-01',
            submodules: [{ name: 'example-system-part', revision: '2026-02-01', format: 'yang' }]
        },
        { name: 'example-types', revision: '2026-03-01', conformanceType: 'import' },
        { name: 'example-common', revision: '2025-12-01', conformanceType: 'import' }
    ]
};

const fixtures = {
    'example-system': {
        content:
            'module example-system { namespace "urn:example:system"; prefix es; include example-system-part { revision-date 2026-02-01; } import example-types { prefix et; revision-date 2026-01-01; } revision 2026-02-01; container system { leaf hostname { type et:label; } } }',
        dependencies: [
            { name: 'example-system-part', revisionDate: '2026-02-01', kind: 'submodule' },
            { name: 'example-types', revisionDate: '2026-01-01', kind: 'module' }
        ]
    },
    'example-system-part': {
        content:
            'submodule example-system-part { belongs-to example-system { prefix es; } import example-common { prefix ec; revision-date 2025-12-01; } revision 2026-02-01; container details { leaf label { type ec:label; } } }',
        dependencies: [{ name: 'example-common', revisionDate: '2025-12-01', kind: 'module' }]
    },
    'example-types': {
        content:
            'module example-types { namespace "urn:example:types"; prefix et; import example-common { prefix ec; revision-date 2025-12-01; } revision 2026-01-01; typedef label { type ec:label; } }',
        dependencies: [{ name: 'example-common', revisionDate: '2025-12-01', kind: 'module' }]
    },
    'example-common': {
        content:
            'module example-common { namespace "urn:example:common"; prefix ec; revision 2025-12-01; typedef label { type string; } }',
        dependencies: []
    }
};

async function waitTask(service, publicTask) {
    const task = service.taskManager.tasks.get(publicTask.taskId);
    assert(task, 'download task must live in the Utility-side service');
    await task.promise;
    return task;
}

async function testUtilityDownloadService() {
    const importedBatches = [];
    const requested = [];
    const schemaFailures = new Map();
    const workspaceGenerations = new Map([
        ['download-router', 7],
        ['download-router-b', 11]
    ]);
    let blockedImport = null;
    let signalImportStarted = null;
    const netconf = {
        async dispatch(operation, data) {
            if (operation === NETCONF_REQ_TYPES.DISCOVER_MODULES) {
                return { ...inventory, profileId: data.profileId };
            }
            assert.equal(operation, NETCONF_REQ_TYPES.GET_SCHEMA);
            const module = data.module;
            const name = module.name;
            requested.push({
                name,
                revision: module.revision || '',
                kind: module.kind || (module.submodule ? 'submodule' : 'module')
            });
            const failure = schemaFailures.get(name);
            if (failure) throw typeof failure === 'function' ? failure() : failure;
            assert(fixtures[name], 'unexpected get-schema request for ' + name);
            return fixtures[name];
        }
    };
    const service = new YangDownloadService({
        netconfService: netconf,
        runtimeHost: { runtime: { activeProfileId: 'download-router' } },
        getWorkspaceGeneration: ({ profileId }) => workspaceGenerations.get(profileId) || 0,
        async importDownloadedContents(contents, options) {
            importedBatches.push({ contents, options });
            if (blockedImport) {
                signalImportStarted?.();
                await blockedImport;
            }
            return { summary: { imported: contents.length, failed: 0 } };
        },
        onProgress() {}
    });

    service.rememberInventory('download-router', inventory);
    const firstTask = await waitTask(
        service,
        service.startDownload({
            modules: [{ name: 'example-system', revision: '2026-02-01' }],
            includeDependencies: true
        })
    );
    assert.equal(firstTask.status, 'completed', firstTask.error?.message);
    assert.deepEqual(requested, [
        { name: 'example-system', revision: '2026-02-01', kind: 'module' },
        { name: 'example-system-part', revision: '2026-02-01', kind: 'submodule' },
        { name: 'example-types', revision: '2026-01-01', kind: 'module' },
        { name: 'example-common', revision: '2025-12-01', kind: 'module' }
    ]);
    assert.deepEqual(
        importedBatches[0].contents.map(item => item.expectedName),
        ['example-system', 'example-system-part', 'example-types', 'example-common']
    );
    assert.equal(importedBatches[0].options.profileId, 'download-router');
    assert.equal(importedBatches[0].options.workspaceGeneration, 7);

    service.rememberInventory('download-router-b', inventory);
    let releaseBlockedImport;
    blockedImport = new Promise(resolve => {
        releaseBlockedImport = resolve;
    });
    const importStarted = new Promise(resolve => {
        signalImportStarted = resolve;
    });
    const secondPublicTask = service.startDownload({
        profileId: 'download-router-b',
        modules: [{ name: 'example-system', revision: '2026-02-01' }],
        includeDependencies: true
    });
    const secondTask = service.taskManager.tasks.get(secondPublicTask.taskId);
    await importStarted;
    let cancellationSettled = false;
    const cancellation = service.cancelProfile('download-router-b').then(() => {
        cancellationSettled = true;
    });
    await immediate();
    assert.equal(cancellationSettled, false, 'profile cleanup must wait for an active import to settle');
    releaseBlockedImport();
    await cancellation;
    assert.equal(secondTask.status, 'cancelled');
    assert.equal(service.inventories.has('download-router-b'), false);
    blockedImport = null;
    signalImportStarted = null;

    requested.length = 0;
    service.rememberInventory('download-router', inventory);
    schemaFailures.set('example-types', () => {
        const error = new Error(
            'NETCONF RPC failed: No permission to do the operation due to the initial password, please change it.'
        );
        error.code = 'NETCONF_RPC_ERROR';
        error.errors = [
            {
                type: 'application',
                tag: 'access-denied',
                severity: 'error',
                message: 'No permission to do the operation due to the initial password, please change it.'
            }
        ];
        return error;
    });
    const partialTask = await waitTask(
        service,
        service.startDownload({
            profileId: 'download-router',
            modules: [{ name: 'example-system', revision: '2026-02-01' }],
            includeDependencies: true
        })
    );
    assert.equal(partialTask.status, 'completed', partialTask.error?.message);
    assert.equal(partialTask.result.partial, true);
    assert.equal(partialTask.result.stoppedEarly, true);
    assert.equal(partialTask.result.downloaded, 2);
    assert.equal(partialTask.result.persisted, 2);
    assert.equal(partialTask.result.failed[0].code, 'NETCONF_INITIAL_PASSWORD_CHANGE_REQUIRED');
    assert.equal(partialTask.result.failed[0].details[0].tag, 'access-denied');
    assert.deepEqual(
        requested.map(item => item.name),
        ['example-system', 'example-system-part', 'example-types']
    );

    schemaFailures.clear();
    requested.length = 0;
    schemaFailures.set('example-system', () => {
        const error = new Error(
            'NETCONF RPC failed: No permission to do the operation due to the initial password, please change it.'
        );
        error.code = 'NETCONF_RPC_ERROR';
        return error;
    });
    const rejectedTask = await waitTask(
        service,
        service.startDownload({
            profileId: 'download-router',
            modules: [{ name: 'example-system', revision: '2026-02-01' }],
            includeDependencies: true
        })
    );
    assert.equal(rejectedTask.status, 'failed');
    assert.equal(rejectedTask.error.code, 'NETCONF_INITIAL_PASSWORD_CHANGE_REQUIRED');
    assert.match(rejectedTask.error.message, /设备要求先修改初始密码/u);
}

async function testDeleteWaitsForUtilityImport() {
    const order = [];
    let failDeleteProfile = '';
    let releaseImport;
    let signalImportStarted;
    const importBlocked = new Promise(resolve => {
        releaseImport = resolve;
    });
    const importStarted = new Promise(resolve => {
        signalImportStarted = resolve;
    });
    const netconf = {
        async dispatch(operation, data) {
            if (operation === NETCONF_REQ_TYPES.GET_SCHEMA) {
                return {
                    content: 'module delete-gate { namespace "urn:delete:gate"; prefix dg; }',
                    dependencies: []
                };
            }
            if (operation === NETCONF_REQ_TYPES.PURGE_PROFILE) {
                order.push('purge-profile');
                return { profileId: 'delete-gate-router' };
            }
            if (operation === NETCONF_REQ_TYPES.CONNECT) {
                return { profileId: data.id, status: 'connected' };
            }
            if (operation === NETCONF_REQ_TYPES.DISCOVER_MODULES) return { modules: [] };
            throw new Error('unexpected delete-gate NETCONF operation: ' + operation);
        },
        cancelRequest() {},
        async disconnectAll() {}
    };
    const processService = new YangProcessService(null, { listen: false, netconfService: netconf });
    processService.runtime = {
        runtime: { activeProfileId: 'delete-gate-router' },
        async deleteProfileWorkspace(profileId) {
            if (profileId === failDeleteProfile) {
                failDeleteProfile = '';
                throw new Error('injected workspace delete failure');
            }
            if (profileId !== 'delete-gate-router') return true;
            order.push('delete-workspace');
            return true;
        },
        setActiveProfileId() {},
        handles: operation => operation === 'yang:getWorkspace',
        async dispatch() {
            throw new Error('deleted profile runtime operation reached the runtime');
        },
        async close() {}
    };
    const downloads = new YangDownloadService({
        netconfService: netconf,
        runtimeHost: processService.runtime,
        validateProfile: profileId => processService.assertProfileAvailable(profileId),
        getWorkspaceGeneration: () => 0,
        async importDownloadedContents(contents) {
            assert.equal(contents.length, 1);
            order.push('import-start');
            signalImportStarted();
            await importBlocked;
            order.push('import-settled');
            return { summary: { imported: 1, failed: 0 } };
        },
        onProgress() {}
    });
    downloads.rememberInventory('delete-gate-router', {
        modules: [{ name: 'delete-gate', revision: '', format: 'yang' }]
    });
    processService.downloads = downloads;

    const publicTask = downloads.startDownload({
        profileId: 'delete-gate-router',
        modules: [{ name: 'delete-gate' }]
    });
    const internalTask = downloads.taskManager.tasks.get(publicTask.taskId);
    await importStarted;
    let deletionSettled = false;
    const deletion = processService
        .dispatch(YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE, { profileId: 'delete-gate-router' })
        .then(result => {
            deletionSettled = true;
            return result;
        });
    await immediate();
    assert.equal(deletionSettled, false, 'workspace deletion must wait for the Utility import gate');
    assert.deepEqual(order, ['import-start', 'purge-profile']);

    releaseImport();
    assert.equal(await deletion, true);
    assert.equal(internalTask.status, 'cancelled');
    assert.deepEqual(order, ['import-start', 'purge-profile', 'import-settled', 'delete-workspace']);
    await assert.rejects(
        processService.dispatch(NETCONF_REQ_TYPES.DISCOVER_MODULES, 'delete-gate-router'),
        error => error.code === 'NETCONF_PROFILE_DELETING'
    );
    await assert.rejects(
        processService.dispatch(YANG_PROCESS_REQ_TYPES.DOWNLOAD_MODULES, { profileId: 'delete-gate-router' }),
        error => error.code === 'NETCONF_PROFILE_DELETING'
    );
    await assert.rejects(
        processService.dispatch(YANG_PROCESS_REQ_TYPES.IMPORT_DOWNLOADED_CONTENTS, {
            contents: [],
            options: { profileId: 'delete-gate-router' }
        }),
        error => error.code === 'NETCONF_PROFILE_DELETING'
    );
    await assert.rejects(
        processService.dispatch('yang:getWorkspace', { profileId: 'delete-gate-router' }),
        error => error.code === 'NETCONF_PROFILE_DELETING'
    );
    await assert.rejects(
        processService.dispatch(NETCONF_REQ_TYPES.GET_SESSION_STATE, { profileId: 'delete-gate-router' }),
        error => error.code === 'NETCONF_PROFILE_DELETING'
    );
    await assert.rejects(
        processService.dispatch(YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE, {}),
        error => error.code === 'NETCONF_PROFILE_REQUIRED'
    );

    await processService.dispatch(NETCONF_REQ_TYPES.CONNECT, { id: 'delete-gate-router' });
    assert.equal(processService.deletedProfiles.has('delete-gate-router'), false);
    assert.deepEqual(await processService.dispatch(NETCONF_REQ_TYPES.DISCOVER_MODULES, 'delete-gate-router'), {
        modules: []
    });

    failDeleteProfile = 'delete-retry-router';
    await assert.rejects(
        processService.dispatch(YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE, {
            profileId: 'delete-retry-router'
        }),
        /injected workspace delete failure/u
    );
    assert.equal(
        processService.deletedProfiles.has('delete-retry-router'),
        false,
        'a failed delete must roll back its Utility tombstone so the operation can retry'
    );
    assert.equal(
        await processService.dispatch(YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE, {
            profileId: 'delete-retry-router'
        }),
        true
    );
}

async function testProcessRoutesAndCloseGate() {
    const calls = [];
    let releaseClose;
    const closeBlocked = new Promise(resolve => {
        releaseClose = resolve;
    });
    const service = new YangProcessService(null, {
        listen: false,
        netconfService: {
            async dispatch(operation, data, context) {
                calls.push({ operation, data, context });
                return { modules: [{ name: 'routed' }] };
            },
            cancelRequest() {},
            async disconnectAll() {
                calls.push({ operation: NETCONF_REQ_TYPES.DISCONNECT_ALL });
            }
        }
    });
    service.runtime = {
        runtime: { activeProfileId: 'process-router' },
        async close() {
            await closeBlocked;
        },
        setActiveProfileId() {}
    };
    service.downloads = {
        discoverModules: async (profileId, context) => {
            calls.push({ operation: 'utility-discover', profileId, context });
            return inventory;
        },
        startDownload: request => {
            calls.push({ operation: 'utility-download', request });
            return { taskId: 'utility-task', status: 'running' };
        },
        getTask: taskId => ({ taskId, status: 'completed' }),
        cancelTask: taskId => taskId === 'utility-task',
        abortAll: () => []
    };

    assert.equal(
        (await service.dispatch(NETCONF_REQ_TYPES.DISCOVER_MODULES, 'process-router', { messageId: 'discover' }))
            .source,
        'rfc8525'
    );
    assert.equal(
        (
            await service.dispatch(YANG_PROCESS_REQ_TYPES.DOWNLOAD_MODULES, {
                profileId: 'process-router',
                modules: []
            })
        ).taskId,
        'utility-task'
    );
    assert.deepEqual(await service.dispatch(YANG_PROCESS_REQ_TYPES.GET_TASK, 'utility-task'), {
        taskId: 'utility-task',
        status: 'completed'
    });
    assert.equal(await service.dispatch(YANG_PROCESS_REQ_TYPES.CANCEL_TASK, 'utility-task'), true);
    assert.deepEqual(calls[0], {
        operation: 'utility-discover',
        profileId: 'process-router',
        context: { messageId: 'discover' }
    });
    assert.deepEqual(calls[1], {
        operation: 'utility-download',
        request: { profileId: 'process-router', modules: [] }
    });

    const closePromise = service.dispatch(YANG_PROCESS_REQ_TYPES.CLOSE);
    await assert.rejects(
        service.dispatch(YANG_PROCESS_REQ_TYPES.GET_TASK, 'late-task'),
        error => error.code === 'YANG_PROCESS_CLOSING'
    );
    releaseClose();
    assert.deepEqual(await closePromise, { closed: true });
}

async function testMainForwardingBoundary() {
    const calls = [];
    const app = new NetconfApp(new FakeIpcMain(), new MemoryStore(), {
        yangApp: { setActiveProfileId() {} }
    });
    const client = {
        async sendRequest(operation, data, options) {
            calls.push({ operation, data, options });
            if (operation === NETCONF_REQ_TYPES.DISCOVER_MODULES) return { data: inventory };
            if (operation === YANG_PROCESS_REQ_TYPES.DOWNLOAD_MODULES) {
                return { data: { taskId: 'utility-task', status: 'running' } };
            }
            if (operation === YANG_PROCESS_REQ_TYPES.GET_TASK) {
                return { data: { taskId: data, status: 'completed' } };
            }
            if (operation === YANG_PROCESS_REQ_TYPES.CANCEL_TASK) return { data: true };
            if (operation === YANG_PROCESS_REQ_TYPES.CLOSE) return { data: { closed: true } };
            throw new Error('unexpected main-process request: ' + operation);
        },
        async terminate() {}
    };
    app.workerClient = client;
    app.workerReadyPromise = Promise.resolve();
    const event = {
        sender: {
            isDestroyed: () => false,
            send() {}
        }
    };
    const downloadRequest = {
        profileId: 'main-router',
        modules: [{ name: 'example-system', revision: '2026-02-01' }],
        includeDependencies: true
    };

    assert.equal((await app.handleDiscoverModules(event, 'main-router')).status, 'success');
    assert.equal((await app.handleDownloadModules(event, downloadRequest)).status, 'success');
    assert.equal((await app.handleGetTask(event, 'utility-task')).data.status, 'completed');
    assert.equal((await app.handleCancelTask(event, 'utility-task')).status, 'success');
    assert.equal(Object.hasOwn(app, 'taskManager'), false);
    assert.equal(Object.hasOwn(app, 'inventories'), false);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].operation, NETCONF_REQ_TYPES.DISCOVER_MODULES);
    assert.equal(calls[0].data, 'main-router');
    assert.equal(calls[1].operation, YANG_PROCESS_REQ_TYPES.DOWNLOAD_MODULES);
    assert.equal(calls[1].data, downloadRequest, 'main must forward the original download payload');
    assert.equal(calls[2].operation, YANG_PROCESS_REQ_TYPES.GET_TASK);
    assert.equal(calls[2].data, 'utility-task');
    assert.equal(calls[3].operation, YANG_PROCESS_REQ_TYPES.CANCEL_TASK);
    assert.equal(calls[3].data, 'utility-task');

    await app.closeAll();
}

async function main() {
    await testUtilityDownloadService();
    await testDeleteWaitsForUtilityImport();
    await testProcessRoutesAndCloseGate();
    await testMainForwardingBoundary();
    console.log('YANG Utility download orchestration and main forwarding tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
