const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WorkerWithPromise = require('../../electron/worker/core/workerWithPromise');
const { YANG_REQ_TYPES, YANG_EVT_TYPES } = require('../../electron/utils/yang');
const { getReleaseManifest } = require('../../scripts/libyang-runtime-config');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.resolve(__dirname, '..', '..'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-worker-'));
const repositoryRoot = path.join(tempDir, 'repository');

async function run() {
    const workerPath = path.resolve(__dirname, '../../electron/worker/yang/yangCompilerWorker.js');
    const worker = new WorkerWithPromise(workerPath).createLongRunningWorker();
    const progressId = `yang-worker-${Date.now()}`;
    const events = [];
    const listener = event => events.push(event);
    worker.addEventListener(YANG_EVT_TYPES.COMPILE_PROGRESS, listener);

    try {
        const release = getReleaseManifest(projectRoot);
        const configured = await worker.sendRequest(YANG_REQ_TYPES.CONFIGURE, {
            rootDir: repositoryRoot,
            resourcesPath: path.join(projectRoot, 'resources'),
            isPackaged: false
        });
        assert.equal(configured.status, 'success');
        assert.equal(configured.data.rootDir, repositoryRoot);
        assert.equal(configured.data.compiler.available, true, configured.data.compiler.error);
        assert.equal(configured.data.compiler.engine, 'libyang');
        assert.equal(configured.data.compiler.version, release.libyangVersion);
        assert.equal(configured.data.compiler.capabilities.schemaExport, true);

        const compilerStatus = await worker.sendRequest(YANG_REQ_TYPES.GET_COMPILER_STATUS, {});
        assert.equal(compilerStatus.data.available, true);
        assert.equal(compilerStatus.data.required, true);

        const workerDemo = `module worker-demo {
  yang-version 1.1;
  namespace "urn:worker-demo";
  prefix wd;
  revision 2026-07-18;
  container state { leaf ready { type boolean; } }
}`;
        const imported = await worker.sendRequest(YANG_REQ_TYPES.IMPORT_CONTENTS, {
            contents: [
                {
                    expectedName: 'worker-demo',
                    revision: '2026-07-18',
                    source: 'netconf://worker-test/get-schema',
                    content: workerDemo
                }
            ]
        });
        assert.equal(imported.data.summary.imported, 1);
        const defaultModulePath = imported.data.imported[0].filePath;
        assert(fs.existsSync(defaultModulePath));

        const response = await worker.sendRequest(YANG_REQ_TYPES.COMPILE, { progressId, force: true });
        assert.equal(response.status, 'success');
        assert.equal(response.data.success, true, JSON.stringify(response.data.diagnostics, null, 2));
        assert.equal(response.data.compiler.engine, 'libyang');
        assert.equal(response.data.externalCompiler.succeeded, true);
        assert.equal(response.data.schemaTree.authoritative, true);
        assert.equal(response.data.schemaTree.source, 'libyang-effective');
        assert(events.length > 0);
        assert(events.every(event => event.progressId === progressId));
        assert(events.some(event => event.phase === 'preparing'));
        assert(events.some(event => event.phase === 'external'));
        assert(events.some(event => event.phase === 'schema'));
        assert.equal(events.at(-1).phase, 'completed');

        const replicaImport = await worker.sendRequest(YANG_REQ_TYPES.IMPORT_CONTENTS, {
            workspaceId: 'replica',
            contents: [{ expectedName: 'worker-demo', revision: '2026-07-18', content: workerDemo }]
        });
        assert.notEqual(replicaImport.data.imported[0].filePath, imported.data.imported[0].filePath);
        assert(fs.existsSync(replicaImport.data.imported[0].filePath));
        const replicaCompile = await worker.sendRequest(YANG_REQ_TYPES.COMPILE, { workspaceId: 'replica' });
        assert.equal(replicaCompile.data.compileId, response.data.compileId);
        assert.equal(replicaCompile.data.cacheHit, true);
        const scopedReplicaRoots = await worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, {
            workspaceId: 'replica'
        });
        assert(scopedReplicaRoots.data.some(node => node.name === 'worker-demo'));

        const roots = await worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, {
            compileId: response.data.compileId
        });
        assert.equal(roots.data.length, 1);
        assert.equal(roots.data[0].keyword, 'module');
        assert.equal(roots.data[0].name, 'worker-demo');
        const children = await worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_CHILDREN, {
            compileId: response.data.compileId,
            parentId: roots.data[0].id
        });
        assert.equal(children.data[0].keyword, 'container');
        assert.equal(children.data[0].name, 'state');
        const source = await worker.sendRequest(YANG_REQ_TYPES.GET_MODULE_SOURCE, { name: 'worker-demo' });
        assert(source.data.source.includes('container state'));
        const replicaSource = await worker.sendRequest(YANG_REQ_TYPES.GET_MODULE_SOURCE, {
            workspaceId: 'replica',
            hash: replicaImport.data.imported[0].hash
        });
        assert(replicaSource.data.source.includes('container state'));
        const diagnostics = await worker.sendRequest(YANG_REQ_TYPES.GET_DIAGNOSTICS, {
            compileId: response.data.compileId
        });
        assert.deepEqual(diagnostics.data, []);

        const invalidImport = await worker.sendRequest(YANG_REQ_TYPES.IMPORT_CONTENTS, {
            workspaceId: 'invalid',
            contents: [
                {
                    expectedName: 'worker-invalid',
                    content: `module worker-invalid {
  yang-version 1.1;
  namespace "urn:worker:invalid";
  prefix wi;
  revision 2026-07-18;
  leaf broken { type does-not-exist; }
}`
                }
            ]
        });
        assert.equal(invalidImport.data.summary.imported, 1);
        const failed = await worker.sendRequest(YANG_REQ_TYPES.COMPILE, {
            workspaceId: 'invalid',
            force: true
        });
        assert.equal(failed.status, 'success');
        assert.equal(failed.data.success, false);
        assert(
            failed.data.diagnostics.some(
                item => typeof item.code === 'string' && item.code.startsWith('LIBYANG') && item.authoritative
            ),
            JSON.stringify(failed.data.diagnostics, null, 2)
        );
        const failedRoots = await worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, {
            compileId: failed.data.compileId,
            workspaceId: 'invalid'
        });
        assert.deepEqual(failedRoots.data, []);

        const cleared = await worker.sendRequest(YANG_REQ_TYPES.CLEAR_WORKSPACE, {});
        assert.equal(cleared.data.modules.length, 0);
        assert.equal(
            fs.existsSync(defaultModulePath),
            false,
            'the worker must physically delete the cleared workspace YANG copy'
        );
        assert.deepEqual((await worker.sendRequest(YANG_REQ_TYPES.LIST_MODULES, {})).data, []);
        await assert.rejects(
            worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, { workspaceId: 'default' }),
            /No YANG compilation is loaded for workspace:default/u
        );
        await assert.rejects(
            worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, {
                workspaceId: 'default',
                compileId: response.data.compileId
            }),
            /is not loaded for workspace:default/u
        );
        assert.equal(
            (await worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, { workspaceId: 'replica' })).data.length,
            1
        );
        const retainedReplica = await worker.sendRequest(YANG_REQ_TYPES.LIST_MODULES, { workspaceId: 'replica' });
        assert.equal(retainedReplica.data.length, 1);
        assert(fs.existsSync(retainedReplica.data[0].filePath));
        const deleted = await worker.sendRequest(YANG_REQ_TYPES.DELETE_WORKSPACE, {});
        assert.equal(deleted.data, true);
        assert.equal((await worker.sendRequest(YANG_REQ_TYPES.DELETE_WORKSPACE, {})).data, false);
        assert.equal(
            (await worker.sendRequest(YANG_REQ_TYPES.LIST_MODULES, { workspaceId: 'replica' })).data.length,
            1
        );
        assert.equal(
            (await worker.sendRequest(YANG_REQ_TYPES.DELETE_WORKSPACE, { workspaceId: 'replica' })).data,
            true
        );
        await assert.rejects(
            worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, { workspaceId: 'replica' }),
            /No YANG compilation is loaded for workspace:replica/u
        );

        console.log('YANG compiler worker real libyang Schema API and progress event tests passed');
    } finally {
        worker.removeEventListener(YANG_EVT_TYPES.COMPILE_PROGRESS, listener);
        await worker.terminate();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
