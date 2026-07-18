const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WorkerWithPromise = require('../../electron/worker/core/workerWithPromise');
const { YANG_REQ_TYPES, YANG_EVT_TYPES } = require('../../electron/utils/yang');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-worker-'));
const repositoryRoot = path.join(tempDir, 'repository');
const helperPath = path.join(tempDir, 'fake-yanglint.js');

async function run() {
    fs.writeFileSync(
        helperPath,
        `const args = process.argv.slice(2);
if (args.includes('--version')) console.log('yanglint 3.13.6 (libyang 3.13.6)');
else if (args.includes('--mode=fail')) { console.error('/tmp/worker.yang:4:2: error: worker semantic failure'); process.exitCode = 2; }
`,
        'utf8'
    );
    const workerPath = path.resolve(__dirname, '../../electron/worker/yang/yangCompilerWorker.js');
    const worker = new WorkerWithPromise(workerPath).createLongRunningWorker();
    const progressId = `yang-worker-${Date.now()}`;
    const events = [];
    const listener = event => events.push(event);
    worker.addEventListener(YANG_EVT_TYPES.COMPILE_PROGRESS, listener);

    try {
        const configured = await worker.sendRequest(YANG_REQ_TYPES.CONFIGURE, {
            rootDir: repositoryRoot,
            compilerPath: process.execPath,
            compilerArgs: [helperPath]
        });
        assert.equal(configured.status, 'success');
        assert.equal(configured.data.rootDir, repositoryRoot);
        assert.equal(configured.data.compiler.available, true);
        assert.equal(configured.data.compiler.engine, 'libyang');
        assert.equal(configured.data.compiler.version, '3.13.6');

        const compilerStatus = await worker.sendRequest(YANG_REQ_TYPES.GET_COMPILER_STATUS, {});
        assert.equal(compilerStatus.data.available, true);
        assert.equal(compilerStatus.data.required, true);

        const imported = await worker.sendRequest(YANG_REQ_TYPES.IMPORT_CONTENTS, {
            contents: [
                {
                    expectedName: 'worker-demo',
                    revision: '2026-07-18',
                    source: 'netconf://worker-test/get-schema',
                    content: `module worker-demo {
  yang-version 1.1;
  namespace "urn:worker-demo";
  prefix wd;
  revision 2026-07-18;
  container state { leaf ready { type boolean; } }
}`
                }
            ]
        });
        assert.equal(imported.data.summary.imported, 1);

        const response = await worker.sendRequest(YANG_REQ_TYPES.COMPILE, { progressId });
        assert.equal(response.status, 'success');
        assert.equal(response.data.success, true);
        assert.equal(response.data.compiler.engine, 'libyang');
        assert.equal(response.data.externalCompiler.succeeded, true);
        assert.equal(response.data.schemaTree.authoritative, false);
        assert(events.length > 0);
        assert(events.every(event => event.progressId === progressId));
        assert(events.some(event => event.phase === 'preparing'));
        assert(events.some(event => event.phase === 'parsing'));
        assert.equal(events.at(-1).phase, 'completed');

        const roots = await worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, {
            compileId: response.data.compileId
        });
        assert.equal(roots.data.length, 1);
        const children = await worker.sendRequest(YANG_REQ_TYPES.GET_SCHEMA_CHILDREN, {
            compileId: response.data.compileId,
            parentId: roots.data[0].id
        });
        assert.equal(children.data[0].keyword, 'container');
        const source = await worker.sendRequest(YANG_REQ_TYPES.GET_MODULE_SOURCE, { name: 'worker-demo' });
        assert(source.data.source.includes('container state'));
        const diagnostics = await worker.sendRequest(YANG_REQ_TYPES.GET_DIAGNOSTICS, {
            compileId: response.data.compileId
        });
        assert.deepEqual(diagnostics.data, []);

        const failed = await worker.sendRequest(YANG_REQ_TYPES.COMPILE, {
            compilerArgs: [helperPath, '--mode=fail'],
            force: true
        });
        assert.equal(failed.status, 'success');
        assert.equal(failed.data.success, false);
        assert(failed.data.diagnostics.some(item => item.code === 'YANGLINT' && item.authoritative));

        const cleared = await worker.sendRequest(YANG_REQ_TYPES.CLEAR_WORKSPACE, {});
        assert.equal(cleared.data.modules.length, 0);

        console.log('YANG compiler worker API and progress event tests passed');
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
