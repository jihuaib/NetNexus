'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YangApp = require('../../electron/app/yangApp');
const { getReleaseManifest } = require('../../scripts/libyang-runtime-config');

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
    const invalidPath = path.join(sourceDirectory, 'example-invalid.yang');
    fs.writeFileSync(
        typesPath,
        'module example-types { yang-version 1.1; namespace "urn:example:types"; prefix et; revision 2026-01-01; typedef label { type string; } }'
    );
    fs.writeFileSync(
        systemPath,
        'module example-system { yang-version 1.1; namespace "urn:example:system"; prefix es; import example-types { prefix et; revision-date 2026-01-01; } revision 2026-02-01; feature domain-name; container system { leaf hostname { type et:label; } leaf domain { if-feature domain-name; type string; } } }'
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
    let app = new YangApp(ipc, store, appOptions);
    try {
        assert(ipc.handlers.has('yang:compile'));
        assert(ipc.handlers.has('yang:getCompilerStatus'));
        const compilerStatus = await app.handleGetCompilerStatus(event, { force: true });
        assert.equal(compilerStatus.status, 'success');
        assert.equal(compilerStatus.data.available, true);
        assert.equal(compilerStatus.data.engine, 'libyang');
        assert.equal(compilerStatus.data.version, release.libyangVersion);
        assert.equal(compilerStatus.data.capabilities.schemaExport, true);
        const importResponse = await app.handleImportFiles(event, [typesPath, systemPath]);
        assert.equal(importResponse.status, 'success');
        const imported = await waitForTask(app, importResponse.data.taskId);
        assert.equal(imported.summary.imported, 2);

        const modulesResponse = await app.handleListModules(event);
        assert.equal(modulesResponse.status, 'success');
        assert.equal(modulesResponse.data.length, 2);
        const system = modulesResponse.data.find(module => module.name === 'example-system');
        assert(system?.id);

        const compileResponse = await app.handleCompile(event, {
            moduleIds: [{ id: system.id, name: system.name, revision: system.revision }],
            features: ['example-system:domain-name']
        });
        assert.equal(compileResponse.status, 'success');
        const compiled = await waitForTask(app, compileResponse.data.taskId);
        assert.equal(compiled.modules.length, 2, 'selected compilation must include imported dependencies');
        assert.equal(compiled.success, true);
        assert.equal(compiled.schemaTree.authoritative, true);
        assert.equal(compiled.schemaTree.source, 'libyang-effective');

        const workspaceResponse = await app.handleGetWorkspace(event);
        assert.equal(workspaceResponse.status, 'success');
        assert.equal(workspaceResponse.data.compileId, compiled.compileId);
        assert.equal(workspaceResponse.data.compiler.available, true);
        assert.equal(workspaceResponse.data.summary.nodeCount, compiled.schemaTree.nodeCount);
        assert(workspaceResponse.data.summary.nodeCount >= 2);
        assert.equal(workspaceResponse.data.modules.filter(module => module.compiled).length, 2);

        const rootsResponse = await app.handleGetSchemaRoots(event, { compileId: compiled.compileId });
        assert.equal(rootsResponse.status, 'success');
        const moduleRoot = rootsResponse.data.find(node => node.name === 'example-system');
        assert(moduleRoot);
        const containerResponse = await app.handleGetSchemaChildren(event, {
            compileId: compiled.compileId,
            nodeId: moduleRoot.id
        });
        assert.equal(containerResponse.data[0].name, 'system');
        const childrenResponse = await app.handleGetSchemaChildren(event, {
            compileId: compiled.compileId,
            nodeId: containerResponse.data[0].id
        });
        assert.equal(childrenResponse.data[0].name, 'hostname');
        assert(childrenResponse.data.some(node => node.name === 'domain'));

        const sourceResponse = await app.handleGetModuleSource(event, { moduleId: system.id });
        assert.equal(sourceResponse.status, 'success');
        assert.match(sourceResponse.data.source, /module example-system/);

        await app.close();
        app = new YangApp(new FakeIpcMain(), store, appOptions);
        const restartedWorkspace = await app.handleGetWorkspace(event);
        assert.equal(restartedWorkspace.status, 'success');
        assert.equal(restartedWorkspace.data.compileId, compiled.compileId);
        assert.equal(restartedWorkspace.data.success, true);
        assert.equal(restartedWorkspace.data.schemaTree.authoritative, true);
        assert.equal(restartedWorkspace.data.schemaTree.source, 'libyang-effective');
        assert.equal(restartedWorkspace.data.modules.filter(module => module.compiled).length, 2);
        assert.deepEqual(store.get('yang-workspace-state').restoreOptions.features, ['example-system:domain-name']);
        const restartedRoots = await app.handleGetSchemaRoots(event, { compileId: compiled.compileId });
        assert.equal(restartedRoots.status, 'success');
        assert(restartedRoots.data.some(node => node.name === 'example-system'));

        await app.close();
        app = new YangApp(new FakeIpcMain(), store, appOptions);
        const secondRestartWorkspace = await app.handleGetWorkspace(event);
        assert.equal(secondRestartWorkspace.status, 'success');
        assert.equal(secondRestartWorkspace.data.compileId, compiled.compileId);
        assert.equal(secondRestartWorkspace.data.schemaTree.authoritative, true);
        assert.deepEqual(store.get('yang-workspace-state').restoreOptions.features, ['example-system:domain-name']);

        const invalidImportResponse = await app.handleImportFiles(event, [invalidPath]);
        assert.equal(invalidImportResponse.status, 'success');
        const invalidImport = await waitForTask(app, invalidImportResponse.data.taskId);
        assert.equal(invalidImport.summary.imported, 1);
        const failedCompileResponse = await app.handleCompile(event, { force: true });
        const failedTask = app.taskManager.tasks.get(failedCompileResponse.data.taskId);
        await failedTask.promise;
        assert.equal(failedTask.status, 'failed');
        assert.match(failedTask.error.code, /^LIBYANG/);
        const failedWorkspace = await app.handleGetWorkspace(event);
        assert.equal(failedWorkspace.data.success, false);
        assert(failedWorkspace.data.compileId);
        assert(failedWorkspace.data.diagnostics.some(item => item.authoritative && item.severity === 'error'));
        assert.equal(failedWorkspace.data.modules.filter(module => module.compiled).length, 0);
        assert.equal(failedWorkspace.data.modules.filter(module => module.compileStatus === 'failed').length, 3);
        assert.deepEqual(
            (await app.handleGetSchemaRoots(event, { compileId: failedWorkspace.data.compileId })).data,
            []
        );

        const clearResponse = await app.handleClearWorkspace(event);
        assert.equal(clearResponse.status, 'success');
        const clearedWorkspace = await app.handleGetWorkspace(event);
        assert.equal(clearedWorkspace.data.compileId, '');
        const retainedModules = await app.handleListModules(event);
        assert.equal(retainedModules.data.length, 3, 'clearing schema context must retain local source modules');
        assert(events.some(item => item.type === 'yang:taskProgress'));

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
            const refusedCompile = await unavailableApp.handleCompile(event);
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
