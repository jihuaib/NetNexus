const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { YangRegistry } = require('../../electron/utils/yang');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-compile-'));
const repositoryRoot = path.join(tempDir, 'repository');
const helperPath = path.join(tempDir, 'fake-yanglint.js');

const commonTypes = `module common-types {
  yang-version 1.1;
  namespace "urn:common";
  prefix ct;
  revision 2025-01-02;
  typedef label { type string; }
}`;

const demoExtra = `submodule demo-extra {
  yang-version 1.1;
  belongs-to demo { prefix d; }
  revision 2026-07-18;
  notification extra-event { leaf detail { type string; } }
}`;

const demo = `module demo {
  yang-version 1.1;
  namespace "urn:demo";
  prefix d;
  revision 2026-07-18;
  import common-types { prefix ct; revision-date 2025-01-02; }
  include demo-extra { revision-date 2026-07-18; }
  feature turbo;
  container system {
    leaf hostname { type ct:label; mandatory true; }
    leaf-list address { type string; }
    list interface {
      key "name";
      leaf name { type string; }
      choice mode {
        case routed { leaf address-family { type string; } }
        case switched { leaf vlan { type uint16; } }
      }
      action reset {
        input { leaf force { type boolean; default "false"; } }
        output { leaf accepted { type boolean; } }
      }
    }
    notification state-change { leaf reason { type string; } }
  }
  rpc ping {
    input { leaf destination { type string; } }
    output { leaf result { type string; } }
  }
}`;

function installFakeYanglint() {
    fs.writeFileSync(
        helperPath,
        `const fs = require('fs');
const args = process.argv.slice(2);
const mode = (args.find(arg => arg.startsWith('--mode=')) || '').slice(7);
if (args.includes('--version')) {
  console.log('yanglint ' + (process.env.FAKE_YANGLINT_VERSION || '3.13.6') + ' (libyang ' + (process.env.FAKE_LIBYANG_VERSION || '3.13.6') + ')');
  process.exit(0);
}
if (process.env.FAKE_YANGLINT_LOG) fs.writeFileSync(process.env.FAKE_YANGLINT_LOG, JSON.stringify(args));
if (mode === 'timeout') {
  setTimeout(() => process.exit(0), 2000);
} else if (mode === 'output') {
  process.stdout.write('x'.repeat(20000));
} else if (mode === 'fail') {
  console.error('/tmp/demo.yang:12:3: error: simulated libyang semantic failure');
  process.exit(2);
} else if (mode === 'silent-fail') {
  process.exit(7);
} else if (mode === 'warn') {
  console.error('libyang warn : simulated libyang warning');
}
`,
        'utf8'
    );
}

function createRegistry(rootDir = repositoryRoot, options = {}) {
    return new YangRegistry({
        rootDir,
        compilerPath: process.execPath,
        compilerArgs: [helperPath],
        ...options
    });
}

function createBundledRuntime(version) {
    return {
        async getStatus() {
            return {
                available: true,
                required: true,
                engine: 'libyang',
                executable: 'yanglint',
                version,
                path: path.join(tempDir, 'bundled-runtime', 'bin', 'yanglint'),
                source: 'bundled',
                runtimeRoot: path.join(tempDir, 'bundled-runtime'),
                capabilities: { schemaValidation: true, yang11: true }
            };
        },
        async execute() {
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
                signal: null,
                timedOut: false,
                outputLimitExceeded: false,
                durationMs: 1,
                error: null
            };
        }
    };
}

async function run() {
    try {
        installFakeYanglint();
        const registry = createRegistry();
        const status = await registry.getCompilerStatus();
        assert.equal(status.available, true);
        assert.equal(status.required, true);
        assert.equal(status.engine, 'libyang');
        assert.equal(status.version, '3.13.6');

        const importResult = registry.importContents([
            { content: commonTypes, expectedName: 'common-types', revision: '2025-01-02', source: 'test' },
            { content: demoExtra, expectedName: 'demo-extra', revision: '2026-07-18', source: 'test' },
            { content: demo, expectedName: 'demo', revision: '2026-07-18', source: 'test' }
        ]);
        assert.equal(importResult.summary.imported, 3);

        const progress = [];
        const compiled = await registry.compile({ onProgress: event => progress.push(event) });
        assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));
        assert.equal(compiled.cacheHit, false);
        assert.equal(compiled.compiler.engine, 'libyang');
        assert.equal(compiled.compiler.version, '3.13.6');
        assert.equal(compiled.validation.authoritative, true);
        assert.equal(compiled.externalCompiler.succeeded, true);
        assert.equal(compiled.schemaTree.authoritative, false);
        assert.equal(compiled.schemaTree.source, 'builtin-preview');
        assert.equal(compiled.summary.modules, 2);
        assert.equal(compiled.summary.submodules, 1);
        assert.equal(compiled.summary.missingDependencies, 0);
        assert(!compiled.diagnostics.some(diagnostic => diagnostic.code === 'DEPENDENCY_CYCLE'));
        assert(progress.some(event => event.phase === 'runtime'));
        assert(progress.some(event => event.phase === 'parsing'));
        assert(progress.some(event => event.phase === 'dependencies'));
        assert(progress.some(event => event.phase === 'schema'));
        assert(progress.some(event => event.phase === 'external'));
        assert.equal(progress.at(-1).phase, 'completed');
        assert.equal(progress.at(-1).percent, 100);

        const roots = registry.getSchemaRoots({ compileId: compiled.compileId });
        assert.equal(roots.length, 3);
        assert(roots.some(root => root.hasChildren));

        const allNodes = [];
        const walk = parentId => {
            for (const child of registry.getSchemaChildren(parentId, { compileId: compiled.compileId })) {
                allNodes.push(child);
                walk(child.id);
            }
        };
        roots.forEach(root => walk(root.id));
        const keywords = new Set(allNodes.map(node => node.keyword));
        for (const keyword of [
            'container',
            'list',
            'leaf',
            'leaf-list',
            'choice',
            'case',
            'rpc',
            'action',
            'notification',
            'input',
            'output'
        ]) {
            assert(keywords.has(keyword), `schema preview must contain ${keyword}`);
        }
        const hostname = allNodes.find(node => node.name === 'hostname');
        assert.equal(hostname.type, 'ct:label');
        assert.equal(hostname.mandatory, true);
        assert.equal(registry.getSchemaNode(hostname.id).path, hostname.path);

        const cached = await registry.compile();
        assert.equal(cached.compileId, compiled.compileId);
        assert.equal(cached.cacheHit, true);

        const restoredRegistry = createRegistry();
        const restored = await restoredRegistry.compile();
        assert.equal(restored.cacheHit, true, 'a fresh registry must restore the disk cache');
        assert(restoredRegistry.getSchemaRoots().length > 0);

        const differentRuntime = await restoredRegistry.compile({
            env: { ...process.env, FAKE_YANGLINT_VERSION: '3.14.0', FAKE_LIBYANG_VERSION: '3.14.0' }
        });
        assert.equal(differentRuntime.compiler.version, '3.14.0');
        assert.notEqual(
            differentRuntime.compileId,
            compiled.compileId,
            'runtime version must be part of the cache key'
        );
        assert.equal(differentRuntime.cacheHit, false);

        const bundledRepositoryRoot = path.join(tempDir, 'bundled-repository');
        const bundledRegistry = new YangRegistry({
            rootDir: bundledRepositoryRoot,
            runtime: createBundledRuntime('5.8.6')
        });
        bundledRegistry.importContents([
            { content: commonTypes, expectedName: 'common-types' },
            { content: demoExtra, expectedName: 'demo-extra' },
            { content: demo, expectedName: 'demo' }
        ]);
        const bundledCompile = await bundledRegistry.compile();
        assert.equal(bundledCompile.success, true);
        assert.equal(bundledCompile.compiler.source, 'bundled');
        assert.equal(bundledCompile.compiler.version, '5.8.6');
        const upgradedBundledRegistry = new YangRegistry({
            rootDir: bundledRepositoryRoot,
            runtime: createBundledRuntime('5.9.0')
        });
        const upgradedBundledCompile = await upgradedBundledRegistry.compile();
        assert.notEqual(upgradedBundledCompile.compileId, bundledCompile.compileId);
        assert.equal(upgradedBundledCompile.cacheHit, false, 'a bundled libyang upgrade must invalidate the cache');

        const searchDirectory = path.join(tempDir, 'search');
        const deviationPath = path.join(tempDir, 'demo-deviation.yang');
        const argumentLog = path.join(tempDir, 'yanglint-args.json');
        fs.mkdirSync(searchDirectory);
        fs.writeFileSync(
            deviationPath,
            'module demo-deviation { namespace "urn:demo:deviation"; prefix dd; revision 2026-07-18; }',
            'utf8'
        );
        const selectedFeatures = await registry.compile({
            force: true,
            features: ['demo:turbo'],
            deviations: [deviationPath],
            searchPaths: [searchDirectory],
            env: { ...process.env, FAKE_YANGLINT_LOG: argumentLog }
        });
        assert.equal(selectedFeatures.success, true);
        assert.deepEqual(selectedFeatures.externalCompiler.features, ['demo:turbo']);
        assert(selectedFeatures.externalCompiler.searchPaths.includes(searchDirectory));
        assert.deepEqual(selectedFeatures.externalCompiler.deviations, [deviationPath]);
        const invokedArgs = JSON.parse(fs.readFileSync(argumentLog, 'utf8'));
        const searchArguments = invokedArgs
            .map((argument, index) => (argument === '-p' ? invokedArgs[index + 1] : null))
            .filter(Boolean);
        assert(searchArguments.includes(searchDirectory));
        assert.equal(invokedArgs[invokedArgs.indexOf('-F') + 1], 'demo:turbo');
        assert(invokedArgs.includes(deviationPath));

        const missingModule = `module needs-missing {
  namespace "urn:missing";
  prefix nm;
  revision 2026-07-18;
  import absent-types { prefix at; revision-date 2020-01-01; }
}`;
        const duplicateOne = `module duplicate-demo {
  namespace "urn:duplicate:one";
  prefix dd;
  revision 2026-01-01;
  leaf one { type string; }
}`;
        const duplicateTwo = `module duplicate-demo {
  namespace "urn:duplicate:two";
  prefix dd;
  revision 2026-01-01;
  leaf two { type string; }
}`;
        registry.importContents(
            [
                { content: missingModule, expectedName: 'needs-missing' },
                { content: duplicateOne, expectedName: 'duplicate-demo' },
                { content: duplicateTwo, expectedName: 'duplicate-demo' }
            ],
            { workspaceId: 'errors' }
        );
        const failed = await registry.compile({
            workspaceId: 'errors',
            compilerArgs: [helperPath, '--mode=fail'],
            force: true
        });
        assert.equal(failed.success, false);
        assert(failed.diagnostics.some(item => item.code === 'MISSING_DEPENDENCY' && item.authoritative === false));
        assert(failed.diagnostics.some(item => item.code === 'DUPLICATE_REVISION' && item.authoritative === false));
        const semanticError = failed.diagnostics.find(item => item.code === 'YANGLINT');
        assert.equal(semanticError.severity, 'error');
        assert.equal(semanticError.line, 12);
        assert.equal(semanticError.column, 3);
        assert.equal(semanticError.authoritative, true);

        const silentFailure = await registry.compile({
            compilerArgs: [helperPath, '--mode=silent-fail'],
            force: true
        });
        assert.equal(silentFailure.success, false);
        assert(silentFailure.diagnostics.some(item => item.code === 'YANGLINT_FAILED' && item.authoritative));

        const unavailableRegistry = new YangRegistry({
            rootDir: repositoryRoot,
            compilerPath: path.join(tempDir, 'missing-yanglint'),
            resourcesPath: path.join(tempDir, 'empty-resources'),
            isPackaged: true
        });
        const unavailable = await unavailableRegistry.compile({
            env: { PATH: '' },
            force: true
        });
        assert.equal(unavailable.success, false);
        assert.equal(unavailable.compiler.available, false);
        assert.equal(unavailable.externalCompiler.invoked, false);
        assert(unavailable.diagnostics.some(item => item.code === 'YANGLINT_UNAVAILABLE'));
        assert(
            unavailableRegistry.getSchemaRoots({ compileId: unavailable.compileId }).length > 0,
            'preview remains available'
        );

        const timedOut = await registry.compile({
            compilerArgs: [helperPath, '--mode=timeout'],
            externalTimeout: 100,
            force: true
        });
        assert.equal(timedOut.success, false);
        assert.equal(timedOut.externalCompiler.timedOut, true);
        assert(timedOut.diagnostics.some(item => item.code === 'YANGLINT_TIMEOUT'));

        const outputLimited = await registry.compile({
            compilerArgs: [helperPath, '--mode=output'],
            externalMaxBuffer: 1024,
            force: true
        });
        assert.equal(outputLimited.success, false);
        assert.equal(outputLimited.externalCompiler.outputTruncated, true);
        assert(outputLimited.diagnostics.some(item => item.code === 'YANGLINT_OUTPUT_LIMIT'));

        console.log('Authoritative libyang compiler, preview index, diagnostics, and cache tests passed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
