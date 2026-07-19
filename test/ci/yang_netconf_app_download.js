'use strict';

const assert = require('node:assert/strict');
const NetconfApp = require('../../electron/app/netconfApp');
const { NETCONF_REQ_TYPES } = require('../../electron/const/yangConst');

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

async function main() {
    const importedBatches = [];
    const deletedWorkspaces = [];
    const purgedProfiles = [];
    let blockedImport = null;
    let signalImportStarted = null;
    const schemaFailures = new Map();
    const app = new NetconfApp(new FakeIpcMain(), new MemoryStore(), {
        yangApp: {
            setActiveProfileId() {},
            async importDownloadedContents(contents, options) {
                importedBatches.push({ contents, options });
                if (blockedImport) {
                    signalImportStarted?.();
                    await blockedImport;
                }
                return { summary: { imported: contents.length, failed: 0 } };
            },
            async deleteProfileWorkspace(profileId) {
                deletedWorkspaces.push(profileId);
                return true;
            }
        }
    });
    const profileId = 'download-router';
    const inventory = {
        source: 'rfc8525',
        modules: [
            {
                name: 'example-system',
                revision: '2026-02-01',
                submodules: [{ name: 'example-system-part', revision: '2026-02-01', format: 'yang' }]
            },
            { name: 'example-types', revision: '2026-03-01', conformanceType: 'import' }
        ]
    };
    const requested = [];
    app.activeProfileId = profileId;
    app.inventories.set(profileId, inventory);
    app.workerClient = {
        async sendRequest(operation, data) {
            if (operation === NETCONF_REQ_TYPES.DISCONNECT_ALL) return { status: 'success', data: [] };
            if (operation === NETCONF_REQ_TYPES.DISCONNECT) {
                return { status: 'success', data: { profileId: data.profileId, status: 'disconnected' } };
            }
            if (operation === NETCONF_REQ_TYPES.PURGE_PROFILE) {
                purgedProfiles.push(data.profileId);
                return { status: 'success', data: { profileId: data.profileId, removedSubscriptions: 0 } };
            }
            assert.equal(operation, NETCONF_REQ_TYPES.GET_SCHEMA);
            const name = data.module.name;
            requested.push({
                name,
                revision: data.module.revision || '',
                kind: data.module.kind || (data.module.submodule ? 'submodule' : 'module')
            });
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
            assert(fixtures[name], `unexpected get-schema request for ${name}`);
            if (schemaFailures.has(name)) {
                const failure = schemaFailures.get(name);
                throw typeof failure === 'function' ? failure() : failure;
            }
            return { status: 'success', data: fixtures[name] };
        },
        async terminate() {}
    };
    const event = {
        sender: {
            isDestroyed: () => false,
            send() {}
        }
    };

    for (let index = 0; index < 300; index += 1) {
        app.rememberSubscriptionSnapshot({
            id: `snapshot-history-${index}`,
            profileId: 'snapshot-history-router',
            state: 'TERMINATED',
            createdAt: new Date(index * 1000).toISOString(),
            terminatedAt: new Date(index * 1000 + 1).toISOString(),
            requestXml: '<rpc/>'
        });
    }
    assert(app.subscriptionSnapshot('snapshot-history-router').total <= 256);

    const response = await app.handleDownloadModules(event, {
        modules: [{ name: 'example-system', revision: '2026-02-01' }],
        includeDependencies: true
    });
    assert.equal(response.status, 'success');
    const task = app.taskManager.tasks.get(response.data.taskId);
    await task.promise;
    assert.equal(task.status, 'completed', task.error?.message);
    assert.deepEqual(requested, [
        { name: 'example-system', revision: '2026-02-01', kind: 'module' },
        { name: 'example-system-part', revision: '2026-02-01', kind: 'submodule' },
        { name: 'example-types', revision: '2026-01-01', kind: 'module' },
        { name: 'example-common', revision: '2025-12-01', kind: 'module' }
    ]);
    assert.equal(importedBatches.length, 1);
    assert.deepEqual(
        importedBatches[0].contents.map(item => item.expectedName),
        ['example-system', 'example-system-part', 'example-types', 'example-common']
    );
    assert.match(importedBatches[0].contents[0].content, /^module example-system/u);
    assert.match(importedBatches[0].contents[1].content, /^submodule example-system-part/u);
    assert.match(importedBatches[0].contents[2].content, /^module example-types/u);
    assert.match(importedBatches[0].contents[3].content, /^module example-common/u);
    assert.equal(importedBatches[0].options.profileId, profileId);

    const secondProfileId = 'download-router-b';
    app.saveStoredProfiles([
        { id: profileId, name: 'Router A' },
        { id: secondProfileId, name: 'Router B' }
    ]);
    app.inventories.set(secondProfileId, inventory);
    let releaseBlockedImport;
    blockedImport = new Promise(resolve => {
        releaseBlockedImport = resolve;
    });
    const importStarted = new Promise(resolve => {
        signalImportStarted = resolve;
    });
    const secondResponse = await app.handleDownloadModules(event, {
        profileId: secondProfileId,
        modules: [{ name: 'example-system', revision: '2026-02-01' }],
        includeDependencies: true
    });
    const secondTask = app.taskManager.tasks.get(secondResponse.data.taskId);
    await importStarted;
    const deletePromise = app.handleDeleteProfile(event, secondProfileId);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(deletedWorkspaces, [], 'workspace deletion must wait for the cancelled import to settle');
    releaseBlockedImport();
    const deleteResponse = await deletePromise;
    assert.equal(deleteResponse.status, 'success');
    assert.equal(secondTask.status, 'cancelled');
    assert.deepEqual(deletedWorkspaces, [secondProfileId]);
    assert.deepEqual(purgedProfiles, [secondProfileId]);
    assert.equal(app.inventories.has(secondProfileId), false);
    assert.deepEqual(
        app.getStoredProfiles().map(profile => profile.id),
        [profileId]
    );
    assert.equal(importedBatches[1].options.profileId, secondProfileId);

    blockedImport = null;
    signalImportStarted = null;
    requested.length = 0;
    const partialImportIndex = importedBatches.length;
    schemaFailures.set('example-types', () => {
        const error = new Error(
            'NETCONF RPC failed: No permission to do the operation due to the initial password, please change it.'
        );
        error.code = 'NETCONF_RPC_ERROR';
        error.data = {
            errors: [
                {
                    type: 'application',
                    tag: 'access-denied',
                    severity: 'error',
                    message: 'No permission to do the operation due to the initial password, please change it.'
                }
            ]
        };
        return error;
    });
    const partialResponse = await app.handleDownloadModules(event, {
        profileId,
        modules: [{ name: 'example-system', revision: '2026-02-01' }],
        includeDependencies: true
    });
    const partialTask = app.taskManager.tasks.get(partialResponse.data.taskId);
    await partialTask.promise;
    assert.equal(partialTask.status, 'completed', partialTask.error?.message);
    assert.equal(partialTask.result.partial, true);
    assert.equal(partialTask.result.stoppedEarly, true);
    assert.equal(partialTask.result.downloaded, 2);
    assert.equal(partialTask.result.persisted, 2);
    assert.equal(partialTask.result.attempted, 3);
    assert.equal(partialTask.result.unattempted, 1);
    assert.equal(partialTask.result.failed.length, 1);
    assert.equal(partialTask.result.failed[0].name, 'example-types');
    assert.equal(partialTask.result.failed[0].code, 'NETCONF_INITIAL_PASSWORD_CHANGE_REQUIRED');
    assert.equal(partialTask.result.stopReason.code, 'NETCONF_INITIAL_PASSWORD_CHANGE_REQUIRED');
    assert.deepEqual(
        requested.map(item => item.name),
        ['example-system', 'example-system-part', 'example-types'],
        'a session-wide initial-password error must stop before later dependencies are attempted'
    );
    assert.equal(importedBatches.length, partialImportIndex + 1);
    assert.deepEqual(
        importedBatches[partialImportIndex].contents.map(item => item.expectedName),
        ['example-system', 'example-system-part']
    );

    schemaFailures.clear();
    requested.length = 0;
    const importsBeforeRejectedBatch = importedBatches.length;
    schemaFailures.set('example-system', () => {
        const error = new Error(
            'NETCONF RPC failed: No permission to do the operation due to the initial password, please change it.'
        );
        error.code = 'NETCONF_RPC_ERROR';
        return error;
    });
    const rejectedResponse = await app.handleDownloadModules(event, {
        profileId,
        modules: [{ name: 'example-system', revision: '2026-02-01' }],
        includeDependencies: true
    });
    const rejectedTask = app.taskManager.tasks.get(rejectedResponse.data.taskId);
    await rejectedTask.promise;
    assert.equal(rejectedTask.status, 'failed');
    assert.equal(rejectedTask.error.code, 'NETCONF_INITIAL_PASSWORD_CHANGE_REQUIRED');
    assert.match(rejectedTask.error.message, /设备要求先修改初始密码/u);
    assert.deepEqual(
        requested.map(item => item.name),
        ['example-system']
    );
    assert.equal(importedBatches.length, importsBeforeRejectedBatch, 'a fully rejected batch has no source to import');
    schemaFailures.clear();

    await app.closeAll();

    const barrierProfileId = 'barrier-router';
    let signalDeleteStarted;
    let releaseDelete;
    const deleteStarted = new Promise(resolve => {
        signalDeleteStarted = resolve;
    });
    const deleteBlocked = new Promise(resolve => {
        releaseDelete = resolve;
    });
    const barrierApp = new NetconfApp(new FakeIpcMain(), new MemoryStore(), {
        credentialStore: {
            sanitizeProfile: profile => ({ ...profile }),
            protectProfile: profile => ({ ...profile }),
            hydrateProfile: (profile, secrets) => ({ ...profile, ...secrets })
        },
        yangApp: {
            setActiveProfileId() {},
            async deleteProfileWorkspace(profileId) {
                assert.equal(profileId, barrierProfileId);
                signalDeleteStarted();
                await deleteBlocked;
                return true;
            }
        }
    });
    const barrierProfile = {
        id: barrierProfileId,
        name: 'Barrier router',
        host: '192.0.2.10',
        port: 830,
        username: 'tester',
        password: 'secret',
        authMethod: 'password',
        hostKeyPolicy: 'accept-new'
    };
    barrierApp.saveStoredProfiles([barrierProfile]);
    const deferredOperations = new Map();
    const operationCounts = new Map();
    const deferredOperation = operation => {
        let resolve;
        const promise = new Promise(promiseResolve => {
            resolve = promiseResolve;
        });
        deferredOperations.set(operation, { promise, resolve });
    };
    [
        NETCONF_REQ_TYPES.CONNECT,
        NETCONF_REQ_TYPES.DISCOVER_MODULES,
        NETCONF_REQ_TYPES.EXECUTE_OPERATION,
        NETCONF_REQ_TYPES.SEND_RPC
    ].forEach(deferredOperation);
    barrierApp.workerClient = {
        async sendRequest(operation, data) {
            operationCounts.set(operation, (operationCounts.get(operation) || 0) + 1);
            if (operation === NETCONF_REQ_TYPES.DISCONNECT) {
                return { data: { profileId: data.profileId, status: 'disconnected' } };
            }
            if (operation === NETCONF_REQ_TYPES.PURGE_PROFILE) {
                return { data: { profileId: data.profileId, removedSubscriptions: 0 } };
            }
            if (operation === NETCONF_REQ_TYPES.DISCONNECT_ALL) return { data: [] };
            const deferred = deferredOperations.get(operation);
            assert(deferred, `unexpected barrier operation: ${operation}`);
            if (operationCounts.get(operation) > 1) return { data: {} };
            return deferred.promise;
        },
        async terminate() {}
    };

    const oldConnect = barrierApp.handleConnect(event, barrierProfileId);
    const oldDiscover = barrierApp.handleDiscoverModules(event, barrierProfileId);
    const oldExecute = barrierApp.handleExecuteOperation(event, {
        profileId: barrierProfileId,
        operation: 'get'
    });
    const oldRpc = barrierApp.handleSendRpc(event, {
        profileId: barrierProfileId,
        rpc: '<rpc/>'
    });
    const deleteBarrierProfile = barrierApp.handleDeleteProfile(event, barrierProfileId);
    await deleteStarted;

    const countsBeforeBlockedCalls = new Map(operationCounts);
    const blockedResponses = await Promise.all([
        barrierApp.handleSaveProfile(null, { ...barrierProfile, name: 'Must not be saved' }),
        barrierApp.handleConnect(event, barrierProfileId),
        barrierApp.handleDiscoverModules(event, barrierProfileId),
        barrierApp.handleExecuteOperation(event, { profileId: barrierProfileId, operation: 'get' }),
        barrierApp.handleSendRpc(event, { profileId: barrierProfileId, rpc: '<rpc/>' })
    ]);
    blockedResponses.forEach(response => assert.equal(response.status, 'error'));
    for (const operation of deferredOperations.keys()) {
        assert.equal(operationCounts.get(operation), countsBeforeBlockedCalls.get(operation));
    }
    assert.equal(barrierApp.findStoredProfile(barrierProfileId).name, barrierProfile.name);

    releaseDelete();
    const deletedBarrierProfile = await deleteBarrierProfile;
    assert.equal(deletedBarrierProfile.status, 'success');
    deferredOperations.get(NETCONF_REQ_TYPES.CONNECT).resolve({
        data: { profileId: barrierProfileId, status: 'connected' }
    });
    deferredOperations.get(NETCONF_REQ_TYPES.DISCOVER_MODULES).resolve({ data: { modules: [{ name: 'late' }] } });
    deferredOperations.get(NETCONF_REQ_TYPES.EXECUTE_OPERATION).resolve({ data: { ok: true } });
    deferredOperations.get(NETCONF_REQ_TYPES.SEND_RPC).resolve({ data: { ok: true } });
    const staleResponses = await Promise.all([oldConnect, oldDiscover, oldExecute, oldRpc]);
    staleResponses.forEach(response => assert.equal(response.status, 'error'));
    assert.equal(barrierApp.activeProfileId, null);
    assert.equal(barrierApp.inventories.has(barrierProfileId), false);
    assert.equal(barrierApp.findStoredProfile(barrierProfileId), null);
    await barrierApp.closeAll();

    console.log('NETCONF app get-schema dependency-closure and YANG import tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
