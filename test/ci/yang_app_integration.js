'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YangApp = require('../../electron/app/yangApp');
const { profileWorkspaceId, STATE_STORE_KEY } = YangApp;
const { YANG_REQ_TYPES: WORKER_REQ_TYPES } = require('../../electron/utils/yang');
const { getReleaseManifest } = require('../../scripts/libyang-runtime-config');

const PROFILE_A = 'router-a';
const PROFILE_B = 'router-b';

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

    get(key, fallback = undefined) {
        return this.values.has(key) ? this.values.get(key) : fallback;
    }

    set(key, value) {
        this.values.set(key, value);
    }

    delete(key) {
        this.values.delete(key);
    }
}

function createEvent(events) {
    return {
        sender: {
            isDestroyed: () => false,
            send: (_channel, event) => events.push(event)
        }
    };
}

async function waitForTask(app, taskId) {
    const internal = app.taskManager.tasks.get(taskId);
    assert(internal, `task ${taskId} must exist`);
    await internal.promise;
    assert.equal(internal.status, 'completed', internal.error?.message);
    return internal.result;
}

async function main() {
    const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.resolve(__dirname, '..', '..'));
    const release = getReleaseManifest(projectRoot);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-app-'));
    const sourceDirectory = path.join(temporaryRoot, 'sources');
    fs.mkdirSync(sourceDirectory);
    const typesPath = path.join(sourceDirectory, 'example-types.yang');
    const systemPath = path.join(sourceDirectory, 'example-system.yang');
    const otherPath = path.join(sourceDirectory, 'example-other.yang');
    const invalidPath = path.join(sourceDirectory, 'example-invalid.yang');
    fs.writeFileSync(
        typesPath,
        'module example-types { yang-version 1.1; namespace "urn:example:types"; prefix et; revision 2026-01-01; typedef label { type string; } }'
    );
    fs.writeFileSync(
        systemPath,
        'module example-system { yang-version 1.1; namespace "urn:example:system"; prefix es; import example-types { prefix et; revision-date 2026-01-01; } revision 2026-02-01; feature domain-name; container system { leaf hostname { type et:label; } leaf enabled { type boolean; } leaf domain { if-feature domain-name; type string; } } }'
    );
    fs.writeFileSync(
        otherPath,
        'module example-other { yang-version 1.1; namespace "urn:example:other"; prefix eo; revision 2026-03-01; container other { leaf label { type string; } } }'
    );
    fs.writeFileSync(
        invalidPath,
        'module example-invalid { yang-version 1.1; namespace "urn:example:invalid"; prefix ei; revision 2026-07-18; leaf broken { type does-not-exist; } }'
    );

    const ipc = new FakeIpcMain();
    const store = new MemoryStore();
    const events = [];
    const event = createEvent(events);
    const appOptions = {
        rootDir: path.join(temporaryRoot, 'registry'),
        resourcesPath: path.join(projectRoot, 'resources'),
        isPackaged: false
    };
    assert.match(profileWorkspaceId(PROFILE_A), /^profile-[a-f0-9]{64}$/u);
    assert.notEqual(profileWorkspaceId('router'), profileWorkspaceId(' router '));
    assert.notEqual(profileWorkspaceId('router'), profileWorkspaceId('ROUTER'));
    assert.notEqual(profileWorkspaceId('router'), profileWorkspaceId('router.'));
    assert.throws(() => profileWorkspaceId('   '), /Profile ID/u);
    assert.throws(() => profileWorkspaceId('router\0alias'), /Profile ID/u);
    const resetStore = new MemoryStore();
    resetStore.set(STATE_STORE_KEY, {
        schemaVersion: 1,
        workspaces: {
            [profileWorkspaceId(PROFILE_A)]: { compileId: 'stale-a' },
            [profileWorkspaceId(PROFILE_B)]: { compileId: 'stale-b' }
        }
    });
    const resetApp = new YangApp(new FakeIpcMain(), resetStore, appOptions);
    resetApp.compileResult.set(profileWorkspaceId(PROFILE_A), { compileId: 'stale-a' });
    resetApp.compilationRestorePromises.set(`${profileWorkspaceId(PROFILE_A)}\u0000stale`, Promise.resolve());
    resetApp.invalidateCompilation();
    assert.equal(resetApp.lastCompile.size, 0, 'an unscoped invalidation must clear every Profile compile state');
    assert.equal(resetApp.compileResult.size, 0);
    assert.equal(resetApp.compilationRestorePromises.size, 0);
    assert.equal(resetStore.get(STATE_STORE_KEY, null), null);
    await resetApp.close();

    const freshnessStore = new MemoryStore();
    const freshnessApp = new YangApp(new FakeIpcMain(), freshnessStore, appOptions);
    const freshnessWorkspaceId = profileWorkspaceId(PROFILE_A);
    const freshnessModuleHash = 'a'.repeat(64);
    const freshnessResult = {
        compileId: 'stale-compile',
        success: true,
        moduleHashes: [freshnessModuleHash],
        summary: {}
    };
    freshnessApp.compileResult.set(freshnessWorkspaceId, freshnessResult);
    freshnessApp.persistCompileState(freshnessWorkspaceId, freshnessResult, { contentHash: 'old-content' });
    freshnessApp.send = async (_event, operation) => {
        if (operation === WORKER_REQ_TYPES.GET_WORKSPACE) {
            return { id: freshnessWorkspaceId, contentHash: 'new-content' };
        }
        if (operation === WORKER_REQ_TYPES.LIST_MODULES) {
            return [
                {
                    hash: freshnessModuleHash,
                    fileName: 'freshness.yang',
                    metadata: { name: 'freshness', kind: 'module' }
                }
            ];
        }
        throw new Error(`unexpected freshness operation: ${operation}`);
    };
    const freshnessResponse = await freshnessApp.handleListModules(event, { profileId: PROFILE_A });
    assert.equal(freshnessResponse.status, 'success');
    assert.equal(freshnessResponse.data[0].compiled, false);
    assert.equal(freshnessResponse.data[0].compileStatus, 'pending');
    assert.equal(freshnessApp.lastCompile.has(freshnessWorkspaceId), false);
    assert.equal(freshnessApp.compileResult.has(freshnessWorkspaceId), false);
    assert.equal(freshnessStore.get(STATE_STORE_KEY).workspaces[freshnessWorkspaceId], undefined);
    await freshnessApp.close();

    const closeTaskApp = new YangApp(new FakeIpcMain(), new MemoryStore(), appOptions);
    let releaseCloseTask;
    let signalCloseTaskStarted;
    let closeTaskSignal;
    const closeTaskStarted = new Promise(resolve => {
        signalCloseTaskStarted = resolve;
    });
    const closeTaskBlocked = new Promise(resolve => {
        releaseCloseTask = resolve;
    });
    const closeTask = closeTaskApp.taskManager.start('import', async ({ signal }) => {
        closeTaskSignal = signal;
        signalCloseTaskStarted();
        await closeTaskBlocked;
        return null;
    });
    await closeTaskStarted;
    let closeTaskSettled = false;
    const closeTaskPromise = closeTaskApp.close().then(() => {
        closeTaskSettled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closeTaskSettled, false, 'close must wait for cancelled task executors to settle');
    assert.equal(closeTaskSignal.aborted, true);
    releaseCloseTask();
    await closeTaskPromise;
    assert.equal(closeTaskApp.taskManager.tasks.get(closeTask.taskId).status, 'cancelled');

    const restoreCloseStore = new MemoryStore();
    const restoreCloseApp = new YangApp(new FakeIpcMain(), restoreCloseStore, appOptions);
    const restoreWorkspaceId = profileWorkspaceId(PROFILE_B);
    const restoreWorkspace = { id: restoreWorkspaceId, contentHash: 'restore-content' };
    const restoreState = {
        compileId: 'restore-compile',
        success: true,
        moduleHashes: [],
        restoreOptions: {},
        summary: {},
        workspaceContentHash: restoreWorkspace.contentHash
    };
    restoreCloseApp.lastCompile.set(restoreWorkspaceId, restoreState);
    restoreCloseApp.writeStoredState();
    let rejectRestore;
    let signalRestoreStarted;
    let terminateCount = 0;
    let ensureWithoutWorker = 0;
    const restoreStarted = new Promise(resolve => {
        signalRestoreStarted = resolve;
    });
    const restoreBlocked = new Promise((_resolve, reject) => {
        rejectRestore = reject;
    });
    restoreCloseApp.workerClient = {
        async sendRequest(operation) {
            if (operation === WORKER_REQ_TYPES.GET_WORKSPACE) return { data: restoreWorkspace };
            if (operation === WORKER_REQ_TYPES.COMPILE) {
                signalRestoreStarted();
                return restoreBlocked;
            }
            throw new Error(`unexpected restore operation: ${operation}`);
        },
        async terminate() {
            terminateCount += 1;
            const error = new Error('Worker client terminated');
            error.code = 'WORKER_TERMINATED';
            rejectRestore(error);
        }
    };
    restoreCloseApp.configurePromise = Promise.resolve();
    const originalEnsureWorker = restoreCloseApp.ensureWorker.bind(restoreCloseApp);
    restoreCloseApp.ensureWorker = function ensureWorker(eventArgument) {
        if (!this.workerClient) ensureWithoutWorker += 1;
        return originalEnsureWorker(eventArgument);
    };
    const restoringWorkspace = restoreCloseApp.handleGetWorkspace(event, { profileId: PROFILE_B });
    await restoreStarted;
    await restoreCloseApp.close();
    const interruptedRestore = await restoringWorkspace;
    assert.equal(interruptedRestore.status, 'error');
    assert.equal(terminateCount, 1);
    assert.equal(ensureWithoutWorker, 0, 'a closing request must not start a replacement worker');
    assert.equal(
        restoreCloseStore.get(STATE_STORE_KEY).workspaces[restoreWorkspaceId].compileId,
        restoreState.compileId,
        'closing during restore must preserve the valid persisted compilation state'
    );

    let app = new YangApp(ipc, store, appOptions);
    try {
        assert(ipc.handlers.has('yang:compile'));
        assert(ipc.handlers.has('yang:getCompilerStatus'));
        assert(ipc.handlers.has('yang:validateRpc'));
        const compilerStatus = await app.handleGetCompilerStatus(event, { force: true });
        assert.equal(compilerStatus.status, 'success');
        assert.equal(compilerStatus.data.available, true);
        assert.equal(compilerStatus.data.engine, 'libyang');
        assert.equal(compilerStatus.data.version, release.libyangVersion);
        assert.equal(compilerStatus.data.capabilities.schemaExport, true);
        const importResponse = await app.handleImportFiles(event, {
            profileId: PROFILE_A,
            filePaths: [typesPath, systemPath]
        });
        assert.equal(importResponse.status, 'success');
        const imported = await waitForTask(app, importResponse.data.taskId);
        assert.equal(imported.summary.imported, 2);
        assert.deepEqual(app.taskManager.tasks.get(importResponse.data.taskId).metadata, {
            source: 'files',
            profileId: PROFILE_A,
            workspaceId: profileWorkspaceId(PROFILE_A)
        });
        const profileAManifest = JSON.parse(
            fs.readFileSync(
                path.join(appOptions.rootDir, 'workspaces', profileWorkspaceId(PROFILE_A), 'manifest.json'),
                'utf8'
            )
        );
        assert.equal(profileAManifest.metadata.profileId, PROFILE_A);

        const modulesResponse = await app.handleListModules(event, { profileId: PROFILE_A });
        assert.equal(modulesResponse.status, 'success');
        assert.equal(modulesResponse.data.length, 2);
        const system = modulesResponse.data.find(module => module.name === 'example-system');
        assert(system?.id);

        const compileResponse = await app.handleCompile(event, {
            profileId: PROFILE_A,
            moduleIds: [{ id: system.id, name: system.name, revision: system.revision }],
            features: ['example-system:domain-name'],
            externalTimeout: 45000,
            externalMaxBuffer: 8 * 1024 * 1024
        });
        assert.equal(compileResponse.status, 'success');
        const compiled = await waitForTask(app, compileResponse.data.taskId);
        assert.equal(compiled.modules.length, 2, 'selected compilation must include imported dependencies');
        assert.equal(compiled.success, true);
        assert.equal(compiled.schemaTree.authoritative, true);
        assert.equal(compiled.schemaTree.source, 'libyang-effective');

        const validationResponse = await ipc.handlers.get('yang:validateRpc')(event, {
            profileId: PROFILE_A,
            compileId: compiled.compileId,
            compilerPath: path.join(temporaryRoot, 'renderer-must-not-select-an-executable'),
            rpc: `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="validate-rpc-wiring">
  <edit-config>
    <target><running/></target>
    <config>
      <system xmlns="urn:example:system">
        <enabled>not-a-boolean</enabled>
      </system>
    </config>
  </edit-config>
</rpc>`
        });
        assert.equal(validationResponse.status, 'success');
        assert.equal(validationResponse.data.valid, false);
        assert.equal(validationResponse.data.performed, true);
        assert.equal(validationResponse.data.authoritative, true);
        assert.equal(validationResponse.data.engine, 'libyang');
        assert.equal(validationResponse.data.operation, 'edit-config');
        assert.equal(validationResponse.data.validationType, 'edit');
        assert.equal(validationResponse.data.diagnostics.length, 1);
        assert.match(validationResponse.data.diagnostics[0].message, /boolean|true|false/i);

        const workspaceResponse = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.equal(workspaceResponse.status, 'success');
        assert.equal(workspaceResponse.data.compileId, compiled.compileId);
        assert.equal(workspaceResponse.data.compiler.available, true);
        assert.equal(workspaceResponse.data.summary.nodeCount, compiled.schemaTree.nodeCount);
        assert(workspaceResponse.data.summary.nodeCount >= 2);
        assert.equal(workspaceResponse.data.modules.filter(module => module.compiled).length, 2);

        const rootsResponse = await app.handleGetSchemaRoots(event, {
            profileId: PROFILE_A,
            compileId: compiled.compileId
        });
        assert.equal(rootsResponse.status, 'success');
        const moduleRoot = rootsResponse.data.find(node => node.name === 'example-system');
        assert(moduleRoot);
        const containerResponse = await app.handleGetSchemaChildren(event, {
            profileId: PROFILE_A,
            compileId: compiled.compileId,
            nodeId: moduleRoot.id
        });
        assert.equal(containerResponse.data[0].name, 'system');
        const childrenResponse = await app.handleGetSchemaChildren(event, {
            profileId: PROFILE_A,
            compileId: compiled.compileId,
            nodeId: containerResponse.data[0].id
        });
        assert.equal(childrenResponse.data[0].name, 'hostname');
        assert(childrenResponse.data.some(node => node.name === 'domain'));

        const sourceResponse = await app.handleGetModuleSource(event, {
            profileId: PROFILE_A,
            moduleId: system.id
        });
        assert.equal(sourceResponse.status, 'success');
        assert.match(sourceResponse.data.source, /module example-system/);

        const emptyProfileB = await app.handleListModules(event, { profileId: PROFILE_B });
        assert.equal(emptyProfileB.status, 'success');
        assert.deepEqual(emptyProfileB.data, [], 'a second Profile must not see the first Profile workspace');
        const profileBImportResponse = await app.handleImportFiles(event, {
            profileId: PROFILE_B,
            filePaths: [otherPath]
        });
        const profileBImport = await waitForTask(app, profileBImportResponse.data.taskId);
        assert.equal(profileBImport.summary.imported, 1);
        const profileBModules = await app.handleListModules(event, { profileId: PROFILE_B });
        assert.deepEqual(
            profileBModules.data.map(module => module.name),
            ['example-other']
        );
        const profileBCompileResponse = await app.handleCompile(event, { profileId: PROFILE_B });
        assert.equal(profileBCompileResponse.status, 'success');
        const profileBCompiled = await waitForTask(app, profileBCompileResponse.data.taskId);
        assert.equal(profileBCompiled.success, true);
        assert.notEqual(profileBCompiled.compileId, compiled.compileId);
        const profileAAfterBCompile = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.equal(profileAAfterBCompile.data.compileId, compiled.compileId);
        assert.equal(profileAAfterBCompile.data.modules.length, 2);

        await app.close();
        const staleStore = new MemoryStore();
        staleStore.values = new Map(store.values);
        const staleApp = new YangApp(new FakeIpcMain(), staleStore, appOptions);
        try {
            staleApp.restoreStoredCompilation = async () => {
                throw new Error('simulated restore failure');
            };
            const staleWorkspace = await staleApp.handleGetWorkspace(event, { profileId: PROFILE_A });
            assert.equal(staleWorkspace.status, 'success');
            assert.equal(staleWorkspace.data.compileId, '');
            assert.equal(staleWorkspace.data.success, null);
            assert.equal(staleWorkspace.data.schemaTree, null);
            assert.equal(staleWorkspace.data.restoreError, 'simulated restore failure');
            assert.equal(staleStore.get(STATE_STORE_KEY).workspaces[profileWorkspaceId(PROFILE_A)], undefined);
        } finally {
            await staleApp.close();
        }

        app = new YangApp(new FakeIpcMain(), store, appOptions);
        const restartedWorkspace = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.equal(restartedWorkspace.status, 'success');
        assert.equal(restartedWorkspace.data.compileId, compiled.compileId);
        assert.equal(restartedWorkspace.data.success, true);
        assert.equal(restartedWorkspace.data.schemaTree.authoritative, true);
        assert.equal(restartedWorkspace.data.schemaTree.source, 'libyang-effective');
        assert.equal(restartedWorkspace.data.modules.filter(module => module.compiled).length, 2);
        assert.deepEqual(store.get(STATE_STORE_KEY).workspaces[profileWorkspaceId(PROFILE_A)].restoreOptions.features, [
            'example-system:domain-name'
        ]);
        assert.equal(
            store.get(STATE_STORE_KEY).workspaces[profileWorkspaceId(PROFILE_A)].restoreOptions.externalTimeout,
            45000
        );
        assert.equal(
            store.get(STATE_STORE_KEY).workspaces[profileWorkspaceId(PROFILE_A)].restoreOptions.externalMaxBuffer,
            8 * 1024 * 1024
        );
        const restartedProfileB = await app.handleGetWorkspace(event, { profileId: PROFILE_B });
        assert.equal(restartedProfileB.data.compileId, profileBCompiled.compileId);
        assert.equal(restartedProfileB.data.modules.length, 1);
        assert.equal(restartedProfileB.data.modules[0].name, 'example-other');
        const restartedRoots = await app.handleGetSchemaRoots(event, {
            profileId: PROFILE_A,
            compileId: compiled.compileId
        });
        assert.equal(restartedRoots.status, 'success');
        assert(restartedRoots.data.some(node => node.name === 'example-system'));

        await app.close();
        app = new YangApp(new FakeIpcMain(), store, appOptions);
        const secondRestartWorkspace = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.equal(secondRestartWorkspace.status, 'success');
        assert.equal(secondRestartWorkspace.data.compileId, compiled.compileId);
        assert.equal(secondRestartWorkspace.data.schemaTree.authoritative, true);
        assert.deepEqual(store.get(STATE_STORE_KEY).workspaces[profileWorkspaceId(PROFILE_A)].restoreOptions.features, [
            'example-system:domain-name'
        ]);

        assert.equal(await app.deleteProfileWorkspace(PROFILE_B, event), true);
        const deletedProfileModules = await app.handleListModules(event, { profileId: PROFILE_B });
        assert.deepEqual(deletedProfileModules.data, []);
        assert.equal(store.get(STATE_STORE_KEY).workspaces[profileWorkspaceId(PROFILE_B)], undefined);
        const retainedProfileA = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.equal(retainedProfileA.data.compileId, compiled.compileId);

        const invalidImportResponse = await app.handleImportFiles(event, {
            profileId: PROFILE_A,
            filePaths: [invalidPath]
        });
        assert.equal(invalidImportResponse.status, 'success');
        const invalidImport = await waitForTask(app, invalidImportResponse.data.taskId);
        assert.equal(invalidImport.summary.imported, 1);
        const failedCompileResponse = await app.handleCompile(event, { profileId: PROFILE_A, force: true });
        const failedTask = app.taskManager.tasks.get(failedCompileResponse.data.taskId);
        await failedTask.promise;
        assert.equal(failedTask.status, 'failed');
        assert.match(failedTask.error.code, /^LIBYANG/);
        const failedWorkspace = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.equal(failedWorkspace.data.success, false);
        assert.equal(failedWorkspace.data.schemaAvailable, true);
        assert.equal(failedWorkspace.data.partialSchema, true);
        assert.equal(failedWorkspace.data.schemaTree.partial, true);
        assert(failedWorkspace.data.summary.nodeCount > 0);
        assert(failedWorkspace.data.compileId);
        assert(failedWorkspace.data.diagnostics.some(item => item.authoritative && item.severity === 'error'));
        assert.deepEqual(
            Object.fromEntries(failedWorkspace.data.modules.map(module => [module.name, module.compileStatus])),
            {
                'example-invalid': 'failed',
                'example-system': 'compiled',
                'example-types': 'compiled'
            }
        );
        assert.equal(failedWorkspace.data.summary.compiledFiles, 2);
        assert.equal(failedWorkspace.data.summary.failedFiles, 1);
        assert.deepEqual(
            Object.fromEntries(failedWorkspace.data.fileResults.map(result => [result.name, result.status])),
            {
                'example-invalid': 'failed',
                'example-system': 'compiled',
                'example-types': 'compiled'
            }
        );
        const failedModuleList = await app.handleListModules(event, { profileId: PROFILE_A });
        assert.deepEqual(Object.fromEntries(failedModuleList.data.map(module => [module.name, module.compileStatus])), {
            'example-invalid': 'failed',
            'example-system': 'compiled',
            'example-types': 'compiled'
        });
        assert.deepEqual(
            (
                await app.handleGetSchemaRoots(event, {
                    profileId: PROFILE_A,
                    compileId: failedWorkspace.data.compileId
                })
            ).data
                .map(root => root.name)
                .sort(),
            ['example-system', 'example-types']
        );
        const partialValidation = await app.handleValidateRpc(event, {
            profileId: PROFILE_A,
            compileId: failedWorkspace.data.compileId,
            rpc: `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="partial-schema-validation">
  <edit-config>
    <target><running/></target>
    <config><system xmlns="urn:example:system"><enabled>not-a-boolean</enabled></system></config>
  </edit-config>
</rpc>`
        });
        assert.equal(partialValidation.status, 'success');
        assert.equal(partialValidation.data.performed, true);
        assert.equal(partialValidation.data.valid, false);

        const failedCompileId = failedWorkspace.data.compileId;
        await app.close();
        app = new YangApp(new FakeIpcMain(), store, appOptions);
        const restartedFailedWorkspace = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.equal(restartedFailedWorkspace.data.compileId, failedCompileId);
        assert.equal(restartedFailedWorkspace.data.success, false);
        assert.equal(restartedFailedWorkspace.data.schemaAvailable, true);
        assert.equal(restartedFailedWorkspace.data.partialSchema, true);
        assert.equal(restartedFailedWorkspace.data.schemaTree.partial, true);
        assert.deepEqual(
            Object.fromEntries(
                restartedFailedWorkspace.data.modules.map(module => [module.name, module.compileStatus])
            ),
            {
                'example-invalid': 'failed',
                'example-system': 'compiled',
                'example-types': 'compiled'
            }
        );
        const restoredFailedDiagnostics = await app.handleGetDiagnostics(event, {
            profileId: PROFILE_A,
            compileId: failedCompileId
        });
        assert.equal(restoredFailedDiagnostics.status, 'success');
        assert(
            restoredFailedDiagnostics.data.some(
                diagnostic =>
                    diagnostic.severity === 'error' && /does-not-exist|Referenced type/u.test(diagnostic.message)
            )
        );
        const restoredFailedWorkspace = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.deepEqual(
            Object.fromEntries(restoredFailedWorkspace.data.modules.map(module => [module.name, module.compileStatus])),
            {
                'example-invalid': 'failed',
                'example-system': 'compiled',
                'example-types': 'compiled'
            }
        );
        assert.deepEqual(
            (
                await app.handleGetSchemaRoots(event, {
                    profileId: PROFILE_A,
                    compileId: failedCompileId
                })
            ).data
                .map(root => root.name)
                .sort(),
            ['example-system', 'example-types']
        );

        const clearResponse = await app.handleClearWorkspace(event, { profileId: PROFILE_A });
        assert.equal(clearResponse.status, 'success');
        const clearedWorkspace = await app.handleGetWorkspace(event, { profileId: PROFILE_A });
        assert.equal(clearedWorkspace.data.compileId, '');
        const retainedModules = await app.handleListModules(event, { profileId: PROFILE_A });
        assert.equal(retainedModules.data.length, 3, 'clearing schema context must retain local source modules');
        assert(events.some(item => item.type === 'yang:taskProgress'));
        assert(
            events.some(
                item =>
                    item.type === 'yang:taskProgress' &&
                    item.data?.data?.phase === 'completed' &&
                    item.data.data.profileId === PROFILE_B &&
                    item.data.data.workspaceId === profileWorkspaceId(PROFILE_B)
            ),
            'terminal YANG task events must retain their Profile workspace context'
        );

        const originalPath = process.env.PATH;
        const unavailableApp = new YangApp(new FakeIpcMain(), new MemoryStore(), {
            rootDir: path.join(temporaryRoot, 'unavailable-registry'),
            compilerPath: path.join(temporaryRoot, 'missing-yanglint'),
            resourcesPath: path.join(temporaryRoot, 'missing-resources'),
            isPackaged: true
        });
        try {
            process.env.PATH = '';
            const unavailableStatus = await unavailableApp.handleGetCompilerStatus(event, { force: true });
            assert.equal(unavailableStatus.status, 'success');
            assert.equal(unavailableStatus.data.available, false);
            const refusedCompile = await unavailableApp.handleCompile(event, { profileId: PROFILE_A });
            assert.equal(refusedCompile.status, 'error');
            assert.match(refusedCompile.msg, /libyang.*不可用/);
        } finally {
            process.env.PATH = originalPath;
            await unavailableApp.close();
        }
    } finally {
        await app.close();
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }

    console.log('YANG Electron app real libyang Schema, dependency compilation, and clear-context tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
