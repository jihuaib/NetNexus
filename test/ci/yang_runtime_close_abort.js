'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { profileWorkspaceId } = require('../../electron/utils/yang/yangWorkspaceIdentity');
const { executeLibyangTool } = require('../../electron/utils/yang/libyangRuntime');
const { NETCONF_REQ_TYPES } = require('../../electron/const/yangConst');
const YangProcessService = require('../../electron/worker/yang/yangProcess');
const { YANG_PROCESS_REQ_TYPES } = require('../../electron/worker/yang/yangProcessProtocol');

class FakePort extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
    }

    postMessage(message) {
        this.messages.push(message);
    }
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

function createWorkspace(profileId) {
    const workspaceId = profileWorkspaceId(profileId);
    const hash = 'a'.repeat(64);
    return {
        workspaceId,
        hash,
        workspace: {
            id: workspaceId,
            name: profileId,
            contentHash: `content-${profileId}`,
            modules: [{ hash }]
        },
        modules: [
            {
                hash,
                id: hash,
                fileName: `${profileId}.yang`,
                metadata: { name: profileId, kind: 'module', revision: null },
                diagnostics: []
            }
        ]
    };
}

function createLongRunningRegistry(workspaceState, helperPath, label) {
    const started = createDeferred();
    const state = {
        execution: null,
        signal: null,
        started: started.promise
    };
    const registry = {
        async getCompilerStatus() {
            return { available: true, engine: 'libyang', version: 'test' };
        },
        getWorkspace() {
            return workspaceState.workspace;
        },
        listModules() {
            return workspaceState.modules;
        },
        deleteWorkspace() {
            return true;
        },
        async compile(options = {}) {
            state.signal = options.signal;
            const execution = executeLibyangTool(process.execPath, [helperPath], {
                signal: options.signal,
                timeoutMs: 10_000,
                maxOutputBytes: 4_096,
                toolName: `${label} libyang helper`,
                errorCodePrefix: 'TEST_LIBYANG_HELPER'
            });
            started.resolve();
            state.execution = await execution;
            if (state.execution.error) throw state.execution.error;
            return {
                success: true,
                schemaAvailable: true,
                compileId: `${label}-compile`,
                moduleHashes: [workspaceState.hash],
                fileResults: [{ hash: workspaceState.hash, status: 'compiled' }],
                diagnostics: [],
                schemaTree: {
                    authoritative: true,
                    source: 'libyang-effective',
                    rootId: 'yang-schema-root',
                    roots: [],
                    nodeCount: 0
                },
                summary: { schemaNodes: 0, errors: 0, warnings: 0, compiledFiles: 1, failedFiles: 0 }
            };
        }
    };
    return { registry, state };
}

async function createProcessHarness(temporaryRoot, profileId, persisted = false) {
    const port = new FakePort();
    const netconf = {
        disconnectCount: 0,
        cancelRequest() {},
        async disconnectAll() {
            this.disconnectCount += 1;
            return [];
        },
        async dispatch(operation, data) {
            if (operation === NETCONF_REQ_TYPES.PURGE_PROFILE) {
                return { profileId: data.profileId, removedSubscriptions: 0 };
            }
            throw new Error('unexpected NETCONF operation');
        }
    };
    const service = new YangProcessService(port, { listen: false, netconfService: netconf });
    const workspaceState = createWorkspace(profileId);
    const persistedCompileState = persisted
        ? {
              schemaVersion: 1,
              workspaces: {
                  [workspaceState.workspaceId]: {
                      compileId: 'persisted-compile',
                      success: true,
                      schemaAvailable: true,
                      moduleHashes: [workspaceState.hash],
                      restoreOptions: {},
                      summary: { schemaNodes: 1 },
                      workspaceContentHash: workspaceState.workspace.contentHash
                  }
              }
          }
        : null;
    await service.configure({
        rootDir: path.join(temporaryRoot, `repository-${profileId}`),
        persistedCompileState,
        isPackaged: false
    });
    return { service, netconf, workspaceState };
}

function assertHelperWasAborted(state, elapsedMs, label) {
    assert(state.signal, `${label} must receive an AbortSignal`);
    assert.equal(state.signal.aborted, true, `${label} signal must be aborted before CLOSE resolves`);
    assert.equal(state.execution?.aborted, true, `${label} child process must observe cancellation`);
    assert.equal(state.execution?.error?.code, 'TEST_LIBYANG_HELPER_ABORTED');
    assert.equal(state.execution?.timedOut, false, `${label} must be killed instead of timing out`);
    assert(elapsedMs < 5_000, `${label} CLOSE took ${elapsedMs}ms instead of promptly killing the helper`);
}

async function persistedRestoreCloseTest(temporaryRoot, helperPath) {
    const profileId = 'restore-close-router';
    const { service, netconf, workspaceState } = await createProcessHarness(temporaryRoot, profileId, true);
    const helper = createLongRunningRegistry(workspaceState, helperPath, 'restore');
    service.runtime.compilerClient.registry = helper.registry;

    try {
        const workspaceRequest = service.dispatch('yang:getWorkspace', { profileId });
        await helper.state.started;
        const restoreController = [...service.runtime.runtime.compilationRestoreControllers.values()][0];
        assert(restoreController, 'persisted restore must register its own AbortController');

        const startedAt = Date.now();
        const closeResult = await service.dispatch(YANG_PROCESS_REQ_TYPES.CLOSE);
        const elapsedMs = Date.now() - startedAt;
        const workspaceResponse = await workspaceRequest;

        assert.deepEqual(closeResult, { closed: true });
        assert.equal(netconf.disconnectCount, 1);
        assert.equal(restoreController.signal.aborted, true);
        assert.equal(workspaceResponse.status, 'error');
        assert.equal(service.runtime.runtime.compilationRestorePromises.size, 0);
        assert.equal(service.runtime.runtime.activeCompilationRestores.size, 0);
        assertHelperWasAborted(helper.state, elapsedMs, 'persisted restore');
    } finally {
        await service.runtime?.close().catch(() => {});
    }
}

async function compileTaskCloseTest(temporaryRoot, helperPath) {
    const profileId = 'compile-close-router';
    const { service, netconf, workspaceState } = await createProcessHarness(temporaryRoot, profileId, false);
    const helper = createLongRunningRegistry(workspaceState, helperPath, 'compile');
    service.runtime.compilerClient.registry = helper.registry;

    try {
        const compileResponse = await service.dispatch('yang:compile', { profileId, force: true });
        assert.equal(compileResponse.status, 'success');
        const taskId = compileResponse.data.taskId;
        await helper.state.started;

        const startedAt = Date.now();
        const closeResult = await service.dispatch(YANG_PROCESS_REQ_TYPES.CLOSE);
        const elapsedMs = Date.now() - startedAt;
        const task = service.runtime.runtime.taskManager.tasks.get(taskId);

        assert.deepEqual(closeResult, { closed: true });
        assert.equal(netconf.disconnectCount, 1);
        assert.equal(task?.status, 'cancelled');
        assertHelperWasAborted(helper.state, elapsedMs, 'compile task');
    } finally {
        await service.runtime?.close().catch(() => {});
    }
}

async function workspaceDeleteRestoreAbortTest(temporaryRoot, helperPath) {
    const profileId = 'restore-delete-router';
    const { service, workspaceState } = await createProcessHarness(temporaryRoot, profileId, true);
    const helper = createLongRunningRegistry(workspaceState, helperPath, 'workspace delete');
    service.runtime.compilerClient.registry = helper.registry;

    try {
        const workspaceRequest = service.dispatch('yang:getWorkspace', { profileId });
        await helper.state.started;

        const startedAt = Date.now();
        const deleted = await service.dispatch(YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE, { profileId });
        const elapsedMs = Date.now() - startedAt;
        const workspaceResponse = await workspaceRequest;

        assert.equal(deleted, true);
        assert.equal(workspaceResponse.status, 'error');
        assert.equal(service.runtime.runtime.lastCompile.has(workspaceState.workspaceId), false);
        assert.equal(service.runtime.runtime.compilationRestorePromises.size, 0);
        assert.equal(service.runtime.runtime.activeCompilationRestores.size, 0);
        assertHelperWasAborted(helper.state, elapsedMs, 'workspace-delete restore');
    } finally {
        await service.runtime?.close().catch(() => {});
    }
}

async function main() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-close-abort-'));
    const helperPath = path.join(temporaryRoot, 'long-running-helper.js');
    fs.writeFileSync(helperPath, "'use strict'; setInterval(() => {}, 1000);\n", { mode: 0o700 });
    try {
        await persistedRestoreCloseTest(temporaryRoot, helperPath);
        await compileTaskCloseTest(temporaryRoot, helperPath);
        await workspaceDeleteRestoreAbortTest(temporaryRoot, helperPath);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
    console.log('YANG CLOSE/delete abort persisted restores and active external compiler helpers');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
