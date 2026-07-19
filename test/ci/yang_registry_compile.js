const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { YangRegistry } = require('../../electron/utils/yang');
const { getReleaseManifest } = require('../../scripts/libyang-runtime-config');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.resolve(__dirname, '..', '..'));
const resourcesPath = path.join(projectRoot, 'resources');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-compile-'));
const repositoryRoot = path.join(tempDir, 'repository');

function readSchemaPathList(listPath) {
    const content = fs.readFileSync(listPath);
    assert(content.length > 0 && content.at(-1) === 0, 'schema path list must be NUL-terminated');
    return content
        .subarray(0, content.length - 1)
        .toString('utf8')
        .split('\0');
}

const commonTypes = `module common-types {
  yang-version 1.1;
  namespace "urn:common";
  prefix ct;
  revision 2025-01-02;
  typedef label { type string; }
  feature extended-identity;
  grouping refined-presence {
    container refined-container { leaf refined-value { type string; } }
  }
  grouping identity-fields {
    leaf serial { type string; }
    leaf extended-serial { if-feature extended-identity; type string; }
  }
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
  import common-types { prefix ct; revision-date 2025-01-02; }
  include demo-extra { revision-date 2026-07-18; }
  reference "demo-module-reference";
  revision 2026-07-18;
  feature turbo;
  container system {
    uses ct:identity-fields;
    uses ct:refined-presence {
      refine refined-container { presence "created by an effective refine"; }
    }
    leaf hostname { type ct:label; mandatory true; }
    leaf-list address { type string; }
    leaf turbo-mode { if-feature turbo; type boolean; }
    list interface {
      key "name";
      leaf name { type string; }
      choice mode {
        default routed;
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

const demoAugment = `module demo-augment {
  yang-version 1.1;
  namespace "urn:demo:augment";
  prefix da;
  import demo { prefix d; revision-date 2026-07-18; }
  revision 2026-07-18;
  augment "/d:system" { leaf augmented-state { type string; } }
}`;

function demoDeviation(mandatory = false) {
    return `module demo-deviation {
  yang-version 1.1;
  namespace "urn:demo:deviation";
  prefix dd;
  import demo { prefix d; revision-date 2026-07-18; }
  revision 2026-07-18;
  leaf deviation-owner-state { type string; }
  deviation "/d:system/d:address" { deviate not-supported; }
  deviation "/d:system/d:hostname" { deviate replace { mandatory ${mandatory}; } }
}`;
}

function createRegistry(rootDir = repositoryRoot, options = {}) {
    return new YangRegistry({
        rootDir,
        resourcesPath,
        isPackaged: false,
        ...options
    });
}

async function run() {
    try {
        const release = getReleaseManifest(projectRoot);
        const registry = createRegistry();
        const status = await registry.getCompilerStatus({ force: true });
        assert.equal(status.available, true, status.error);
        assert.equal(status.required, true);
        assert.equal(status.engine, 'libyang');
        assert.equal(status.version, release.libyangVersion);
        assert.equal(status.schemaVersion, release.libyangVersion);
        assert.equal(status.capabilities.schemaExport, true);

        const imported = registry.importContents([
            { content: commonTypes, expectedName: 'common-types', revision: '2025-01-02', source: 'test' },
            { content: demoExtra, expectedName: 'demo-extra', revision: '2026-07-18', source: 'test' },
            { content: demo, expectedName: 'demo', revision: '2026-07-18', source: 'test' },
            { content: demoAugment, expectedName: 'demo-augment', revision: '2026-07-18', source: 'test' }
        ]);
        assert.equal(imported.summary.imported, 4);

        const progress = [];
        const compiled = await registry.compile({
            onProgress: event => progress.push(event),
            force: true
        });
        assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));
        assert.equal(compiled.schemaAvailable, true);
        assert.equal(compiled.partialSchema, false);
        assert.equal(compiled.cacheHit, false);
        assert.equal(compiled.compiler.engine, 'libyang');
        assert.equal(compiled.compiler.version, release.libyangVersion);
        assert.equal(compiled.validation.authoritative, true);
        assert.equal(compiled.externalCompiler.succeeded, true);
        assert(path.isAbsolute(compiled.externalCompiler.schemaListPath));
        assert.equal(
            compiled.externalCompiler.args[compiled.externalCompiler.args.indexOf('--schema-list') + 1],
            compiled.externalCompiler.schemaListPath
        );
        const compiledTopLevelHashes = new Set(
            compiled.modules.filter(module => module.metadata?.kind === 'module').map(module => module.hash)
        );
        assert.deepEqual(
            readSchemaPathList(compiled.externalCompiler.schemaListPath),
            compiled.externalCompiler.schemaInputs
                .filter(input => compiledTopLevelHashes.has(input.hash))
                .map(input => input.path)
        );
        assert(
            compiled.externalCompiler.schemaInputs.every(input => !compiled.externalCompiler.args.includes(input.path)),
            'schema paths must stay out of the process command line'
        );
        assert.equal(compiled.schemaTree.authoritative, true);
        assert.equal(compiled.schemaTree.source, 'libyang-effective');
        assert.equal(compiled.schemaTree.scope, 'core-effective-schema');
        assert.equal(compiled.summary.modules, 3);
        assert.equal(compiled.summary.submodules, 1);
        assert.equal(compiled.summary.missingDependencies, 0);
        assert.equal(compiled.summary.compiledFiles, compiled.fileResults.length);
        assert.equal(compiled.summary.failedFiles, 0);
        assert(compiled.fileResults.every(fileResult => fileResult.status === 'compiled'));
        assert(!compiled.diagnostics.some(diagnostic => diagnostic.code === 'DEPENDENCY_CYCLE'));
        assert(progress.some(event => event.phase === 'runtime'));
        assert(progress.some(event => event.phase === 'external'));
        assert(progress.some(event => event.phase === 'schema'));
        const parsingProgress = progress.filter(event => event.phase === 'parsing');
        assert.equal(parsingProgress.length, compiled.fileResults.length);
        assert(
            parsingProgress.every(event => event.currentFile && event.currentHash && event.fileStatus === 'parsed'),
            'parsing progress must identify each source file without claiming compilation success'
        );
        const fileResultProgress = progress.filter(event => event.phase === 'file-result');
        assert.equal(fileResultProgress.length, compiled.fileResults.length);
        assert(
            fileResultProgress.every(
                event => event.currentFile && event.currentHash && ['compiled', 'failed'].includes(event.fileStatus)
            ),
            'final per-file progress must carry a stable source identity and compilation status'
        );
        assert.equal(progress.at(-1).phase, 'completed');
        assert.equal(progress.at(-1).percent, 100);

        const roots = registry.getSchemaRoots({ compileId: compiled.compileId });
        assert.equal(roots.length, 3);
        assert(roots.every(root => root.keyword === 'module'));
        assert(roots.some(root => root.name === 'demo' && root.hasChildren));
        assert.equal(roots.find(root => root.name === 'demo').reference, 'demo-module-reference');

        const collectNodes = (schemaRoots, compileId, schemaRegistry = registry) => {
            const collected = [];
            const walk = parentId => {
                for (const child of schemaRegistry.getSchemaChildren(parentId, { compileId })) {
                    collected.push(child);
                    walk(child.id);
                }
            };
            schemaRoots.forEach(root => walk(root.id));
            return collected;
        };
        const allNodes = collectNodes(roots, compiled.compileId);
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
            assert(
                keywords.has(keyword),
                `libyang effective schema must contain ${keyword}; got ${[...keywords].sort().join(', ')}`
            );
        }
        const hostname = allNodes.find(node => node.name === 'hostname');
        assert(hostname);
        assert.equal(hostname.type, 'label');
        assert.equal(hostname.mandatory, true);
        assert.equal(allNodes.find(node => node.name === 'refined-container').presence, true);
        assert.equal(allNodes.find(node => node.name === 'mode' && node.keyword === 'choice').default, 'routed');
        assert.equal(registry.getSchemaNode(hostname.id).path, hostname.path);
        assert(
            allNodes.some(node => node.name === 'serial'),
            'libyang must expand grouping/uses into the effective tree'
        );
        assert(
            allNodes.some(node => node.name === 'extended-serial'),
            'default compilation must enable every feature'
        );
        assert(
            allNodes.some(node => node.name === 'augmented-state' && node.module === 'demo-augment'),
            'libyang must attach augment nodes to their effective target'
        );
        assert(
            allNodes.some(node => node.name === 'turbo-mode'),
            'libyang default all-features mode must include the if-feature node'
        );

        const disabledFeatures = await registry.compile({
            features: [{ module: 'demo', features: [] }],
            force: true
        });
        assert.equal(disabledFeatures.success, true, JSON.stringify(disabledFeatures.diagnostics, null, 2));
        const disabledRoots = registry.getSchemaRoots({ compileId: disabledFeatures.compileId });
        const disabledNodes = collectNodes(disabledRoots, disabledFeatures.compileId);
        assert.equal(
            disabledNodes.some(node => node.name === 'turbo-mode'),
            false,
            'explicitly disabled if-feature nodes must disappear from the effective tree'
        );
        assert.equal(
            disabledNodes.some(node => node.name === 'extended-serial'),
            false,
            'once -F is used, features in unspecified modules must be disabled like yanglint'
        );

        const multipleSelectedFeatures = await registry.compile({
            features: ['demo:turbo', 'common-types:extended-identity'],
            force: true
        });
        assert.equal(
            multipleSelectedFeatures.success,
            true,
            JSON.stringify(multipleSelectedFeatures.diagnostics, null, 2)
        );
        const multipleSelectedNodes = collectNodes(
            registry.getSchemaRoots({ compileId: multipleSelectedFeatures.compileId }),
            multipleSelectedFeatures.compileId
        );
        assert(multipleSelectedNodes.some(node => node.name === 'turbo-mode'));
        assert(multipleSelectedNodes.some(node => node.name === 'extended-serial'));

        const cached = await registry.compile();
        assert.equal(cached.compileId, compiled.compileId);
        assert.equal(cached.cacheHit, true);

        const replicaImport = registry.importContents(
            [
                { content: commonTypes, expectedName: 'common-types', revision: '2025-01-02', source: 'replica' },
                { content: demoExtra, expectedName: 'demo-extra', revision: '2026-07-18', source: 'replica' },
                { content: demo, expectedName: 'demo', revision: '2026-07-18', source: 'replica' },
                { content: demoAugment, expectedName: 'demo-augment', revision: '2026-07-18', source: 'replica' }
            ],
            { workspaceId: 'replica' }
        );
        const defaultEntries = registry.listModules();
        const replicaEntries = registry.listModules({ workspaceId: 'replica' });
        assert.equal(replicaEntries.length, defaultEntries.length);
        for (const replicaEntry of replicaEntries) {
            const defaultEntry = defaultEntries.find(entry => entry.hash === replicaEntry.hash);
            assert(defaultEntry);
            assert.notEqual(replicaEntry.filePath, defaultEntry.filePath);
            assert(fs.existsSync(replicaEntry.filePath));
        }
        assert(replicaImport.imported.every(entry => entry.deduplicated === false));
        const replicaCompiled = await registry.compile({ workspaceId: 'replica' });
        assert.equal(replicaCompiled.compileId, compiled.compileId);
        assert.equal(replicaCompiled.cacheHit, true, 'compiled cache must remain shared across isolated workspaces');
        const replicaRootsBeforeAdditiveImport = registry
            .getSchemaRoots({ workspaceId: 'replica', compileId: replicaCompiled.compileId })
            .map(root => root.name)
            .sort();
        registry.importContents(
            [
                {
                    content:
                        'module replica-extra { yang-version 1.1; namespace "urn:replica:extra"; prefix re; revision 2026-07-19; }',
                    expectedName: 'replica-extra'
                }
            ],
            { workspaceId: 'replica' }
        );
        assert.deepEqual(
            registry
                .getSchemaRoots({
                    workspaceId: 'replica',
                    compileId: replicaCompiled.compileId
                })
                .map(root => root.name)
                .sort(),
            replicaRootsBeforeAdditiveImport,
            'adding a source hash outside the compiled input set must retain the loaded Schema context'
        );
        registry.clearWorkspace('replica');
        assert.equal(registry.listModules({ workspaceId: 'replica' }).length, 0);
        assert.throws(
            () => registry.getSchemaRoots({ workspaceId: 'replica' }),
            /No YANG compilation is loaded for workspace:replica/u
        );
        assert.equal(registry.listModules().length, 4);
        assert.equal((await registry.compile()).compileId, compiled.compileId);
        assert.equal(registry.deleteWorkspace('replica'), true);
        assert.equal(registry.listModules().length, 4);

        const restoredRegistry = createRegistry();
        const restored = await restoredRegistry.compile();
        assert.equal(restored.cacheHit, true, 'a fresh registry must restore the authoritative Schema cache');
        assert(restoredRegistry.getSchemaRoots().length > 0);

        const searchDirectory = path.join(tempDir, 'search');
        const deviationPath = path.join(tempDir, 'demo-deviation.yang');
        fs.mkdirSync(searchDirectory);
        fs.writeFileSync(deviationPath, demoDeviation(false), 'utf8');
        const selectedFeatures = await registry.compile({
            force: true,
            features: ['demo:turbo'],
            deviations: [deviationPath],
            searchPaths: [searchDirectory]
        });
        assert.equal(selectedFeatures.success, true, JSON.stringify(selectedFeatures.diagnostics, null, 2));
        assert.deepEqual(selectedFeatures.externalCompiler.features, ['demo:turbo']);
        assert(selectedFeatures.externalCompiler.searchPaths.includes(searchDirectory));
        assert.deepEqual(selectedFeatures.externalCompiler.deviations, [deviationPath]);
        assert.equal(selectedFeatures.schemaTree.authoritative, true);
        const selectedRoots = registry.getSchemaRoots({ compileId: selectedFeatures.compileId });
        const selectedNodes = collectNodes(selectedRoots, selectedFeatures.compileId);
        assert(
            selectedNodes.some(node => node.name === 'turbo-mode'),
            'enabled if-feature node must be present'
        );
        assert.equal(
            selectedNodes.some(node => node.name === 'address'),
            false,
            'not-supported deviation must remove the effective node'
        );
        assert.equal(
            selectedNodes.find(node => node.name === 'hostname').mandatory,
            false,
            'replace deviation must update the effective node properties'
        );

        fs.writeFileSync(deviationPath, demoDeviation(true), 'utf8');
        const changedDeviation = await registry.compile({
            features: ['demo:turbo'],
            deviations: [deviationPath],
            searchPaths: [searchDirectory]
        });
        assert.equal(changedDeviation.cacheHit, false, 'external deviation content must participate in the cache key');
        assert.notEqual(changedDeviation.compileId, selectedFeatures.compileId);
        const changedDeviationNodes = collectNodes(
            registry.getSchemaRoots({ compileId: changedDeviation.compileId }),
            changedDeviation.compileId
        );
        assert.equal(changedDeviationNodes.find(node => node.name === 'hostname').mandatory, true);

        const missingDeviation = await registry.compile({
            force: true,
            deviations: [{ name: 'missing-deviation' }]
        });
        assert.equal(missingDeviation.success, false);
        assert(missingDeviation.diagnostics.some(diagnostic => diagnostic.code === 'DEVIATION_NOT_FOUND'));

        const unknownFeatureModule = await registry.compile({
            force: true,
            features: ['not-loaded:feature']
        });
        assert.equal(unknownFeatureModule.success, false);
        assert(
            unknownFeatureModule.diagnostics.some(diagnostic => /not-loaded/u.test(diagnostic.message)),
            JSON.stringify(unknownFeatureModule.diagnostics, null, 2)
        );

        const deviationRegistry = createRegistry(path.join(tempDir, 'deviation-repository'));
        deviationRegistry.importContents([
            { content: commonTypes, expectedName: 'common-types', revision: '2025-01-02', source: 'test' },
            { content: demoExtra, expectedName: 'demo-extra', revision: '2026-07-18', source: 'test' },
            { content: demo, expectedName: 'demo', revision: '2026-07-18', source: 'test' },
            { content: demoAugment, expectedName: 'demo-augment', revision: '2026-07-18', source: 'test' },
            { content: demoDeviation(false), expectedName: 'demo-deviation', revision: '2026-07-18' }
        ]);
        const repositoryDeviation = await deviationRegistry.compile({
            force: true,
            deviations: [{ name: 'demo-deviation', revision: '2026-07-18' }]
        });
        assert.equal(repositoryDeviation.success, true, JSON.stringify(repositoryDeviation.diagnostics, null, 2));
        const selectedDeviationPath = repositoryDeviation.externalCompiler.deviations[0];
        assert.equal(
            readSchemaPathList(repositoryDeviation.externalCompiler.schemaListPath).filter(
                schemaPath => schemaPath === selectedDeviationPath
            ).length,
            1,
            'a repository deviation must be listed exactly once as a top-level workspace module'
        );
        const repositoryDeviationRoots = deviationRegistry.getSchemaRoots({
            compileId: repositoryDeviation.compileId
        });
        assert(
            repositoryDeviationRoots.some(root => root.name === 'demo-deviation'),
            'a selected repository deviation remains a workspace module and must keep its Schema root'
        );
        const repositoryDeviationNodes = collectNodes(
            repositoryDeviationRoots,
            repositoryDeviation.compileId,
            deviationRegistry
        );
        assert(
            repositoryDeviationNodes.some(node => node.name === 'deviation-owner-state'),
            'data owned by a repository deviation module must remain in the effective Schema'
        );

        const missingModule = `module needs-missing {
  yang-version 1.1;
  namespace "urn:missing";
  prefix nm;
  revision 2026-07-18;
  import absent-types { prefix at; revision-date 2020-01-01; }
}`;
        const duplicateOne = `module duplicate-demo {
  yang-version 1.1;
  namespace "urn:duplicate:one";
  prefix dd;
  revision 2026-01-01;
  leaf one { type string; }
}`;
        const duplicateTwo = `module duplicate-demo {
  yang-version 1.1;
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
            { workspaceId: 'dependency-errors' }
        );
        const dependencyFailure = await registry.compile({ workspaceId: 'dependency-errors', force: true });
        assert.equal(dependencyFailure.success, false);
        assert.equal(dependencyFailure.schemaAvailable, true);
        assert.equal(dependencyFailure.partialSchema, true);
        assert(
            dependencyFailure.diagnostics.some(
                item => item.code === 'MISSING_DEPENDENCY' && item.authoritative === false
            )
        );
        assert(
            dependencyFailure.diagnostics.some(
                item => item.code === 'DUPLICATE_REVISION' && item.authoritative === false
            )
        );
        assert.deepEqual(
            registry
                .getSchemaRoots({ workspaceId: 'dependency-errors', compileId: dependencyFailure.compileId })
                .map(root => root.name),
            ['duplicate-demo']
        );

        const sharedNamespaceOne = `module shared-namespace-one {
  yang-version 1.1;
  namespace "urn:shared:namespace";
  prefix sno;
  revision 2026-07-19;
  leaf one { type string; }
}`;
        const sharedNamespaceTwo = `module shared-namespace-two {
  yang-version 1.1;
  namespace "urn:shared:namespace";
  prefix snt;
  revision 2026-07-19;
  leaf two { type string; }
}`;
        registry.importContents(
            [
                { content: sharedNamespaceOne, expectedName: 'shared-namespace-one' },
                { content: sharedNamespaceTwo, expectedName: 'shared-namespace-two' }
            ],
            { workspaceId: 'partial-schema-conflict' }
        );
        const partialSchemaConflict = await registry.compile({
            workspaceId: 'partial-schema-conflict',
            force: true
        });
        assert.equal(partialSchemaConflict.success, false);
        assert(partialSchemaConflict.fileResults.every(fileResult => fileResult.status === 'compiled'));
        assert.equal(partialSchemaConflict.schemaAvailable, false);
        assert.equal(partialSchemaConflict.partialSchema, false);
        assert.equal(partialSchemaConflict.schemaTree, null);
        assert.equal(
            registry.getSchemaRoots({
                workspaceId: 'partial-schema-conflict',
                compileId: partialSchemaConflict.compileId
            }).length,
            0
        );

        const invalidType = `module invalid-type {
  yang-version 1.1;
  namespace "urn:invalid:type";
  prefix it;
  revision 2026-07-18;
  leaf broken { type does-not-exist; }
}`;
        registry.importContents([{ content: invalidType, expectedName: 'invalid-type' }], {
            workspaceId: 'semantic-error'
        });
        const semanticFailure = await registry.compile({ workspaceId: 'semantic-error', force: true });
        assert.equal(semanticFailure.success, false);
        assert.equal(semanticFailure.schemaAvailable, false);
        assert.equal(semanticFailure.schemaTree, null);
        assert.deepEqual(
            semanticFailure.fileResults.map(fileResult => fileResult.status),
            ['failed']
        );
        assert.equal(semanticFailure.summary.compiledFiles, 0);
        assert.equal(semanticFailure.summary.failedFiles, 1);
        assert(
            semanticFailure.diagnostics.some(
                item =>
                    item.authoritative &&
                    item.severity === 'error' &&
                    typeof item.code === 'string' &&
                    item.code.startsWith('LIBYANG')
            ),
            JSON.stringify(semanticFailure.diagnostics, null, 2)
        );
        assert.equal(
            registry.getSchemaRoots({ workspaceId: 'semantic-error', compileId: semanticFailure.compileId }).length,
            0
        );

        const unavailableRegistry = new YangRegistry({
            rootDir: path.join(tempDir, 'unavailable-repository'),
            compilerPath: path.join(tempDir, 'missing-yanglint'),
            resourcesPath: path.join(tempDir, 'empty-resources'),
            isPackaged: true
        });
        const unavailable = await unavailableRegistry.compile({ env: { PATH: '' }, force: true });
        assert.equal(unavailable.success, false);
        assert.equal(unavailable.schemaAvailable, false);
        assert.equal(unavailable.schemaTree, null);
        assert.equal(unavailable.compiler.available, false);
        assert.equal(unavailable.externalCompiler.invoked, false);
        assert(unavailable.diagnostics.some(item => item.code === 'LIBYANG_RUNTIME_UNAVAILABLE'));
        assert.equal(unavailableRegistry.getSchemaRoots({ compileId: unavailable.compileId }).length, 0);

        console.log('Authoritative libyang compiler, effective Schema, diagnostics, and cache tests passed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
