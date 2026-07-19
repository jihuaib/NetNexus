const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { YangRegistry } = require('../electron/utils/yang');
const { validateAuthoritativeSchemaTree } = require('../electron/utils/yang/yangCompiler');
const { getReleaseManifest, verifyRuntime } = require('./libyang-runtime-config');

const projectRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-libyang-smoke-'));
const profileContext = Object.freeze({
    profileId: 'libyang-runtime-smoke',
    workspaceId: 'profile-libyang-runtime-smoke'
});
const invalidProfileContext = Object.freeze({
    profileId: 'libyang-runtime-smoke-invalid',
    workspaceId: 'profile-libyang-runtime-smoke-invalid'
});
const common = `module netnexus-smoke-types {
  yang-version 1.1;
  namespace "urn:netnexus:smoke:types";
  prefix nst;
  revision 2026-07-18;
  typedef label { type string { length "1..64"; } }
}`;
const child = `submodule netnexus-smoke-child {
  yang-version 1.1;
  belongs-to netnexus-smoke { prefix ns; }
  revision 2026-07-18;
  container child-state { leaf enabled { type boolean; default true; } }
}`;
const main = `module netnexus-smoke {
  yang-version 1.1;
  namespace "urn:netnexus:smoke";
  prefix ns;
  import netnexus-smoke-types { prefix nst; revision-date 2026-07-18; }
  include netnexus-smoke-child { revision-date 2026-07-18; }
  revision 2026-07-18;
  feature advanced;
  container system {
    leaf hostname { type nst:label; mandatory true; }
    leaf mode { if-feature advanced; type enumeration { enum basic; enum advanced; } }
  }
}`;
const invalid = `module netnexus-smoke-invalid {
  yang-version 1.1;
  namespace "urn:netnexus:smoke:invalid";
  prefix nsi;
  revision 2026-07-18;
  leaf broken { type does-not-exist; }
}`;

async function run() {
    const packagedStatus = verifyRuntime({ projectRoot });
    const release = getReleaseManifest(projectRoot);
    assert.equal(packagedStatus.version, release.libyangVersion);
    assert.equal(packagedStatus.schemaContractVersion, 1);
    assert(fs.statSync(packagedStatus.schemaPath).isFile());

    const registry = new YangRegistry({
        rootDir: path.join(tempRoot, 'repository'),
        resourcesPath: path.join(projectRoot, 'resources'),
        isPackaged: false,
        workspaceId: profileContext.workspaceId,
        workspaceName: profileContext.profileId
    });
    const status = await registry.getCompilerStatus({ forceRuntimeDiscovery: true });
    assert.equal(status.available, true, status.error);
    assert.equal(status.source, 'bundled');
    assert.equal(status.version, release.libyangVersion);
    assert.equal(status.schemaVersion, release.libyangVersion);
    assert.equal(status.capabilities.schemaExport, true);
    assert.equal(status.capabilities.coreSchemaExport, true);
    assert.equal(status.capabilities.extensionSchemaExport, false);

    const directRoot = path.join(tempRoot, process.platform === 'win32' ? '中文-libyang-路径' : 'direct-helper');
    const fallbackDirectory = path.join(directRoot, 'fallback');
    const workspaceDirectory = path.join(directRoot, 'workspace');
    fs.mkdirSync(fallbackDirectory, { recursive: true });
    fs.mkdirSync(workspaceDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(fallbackDirectory, 'priority-types@2026-07-18.yang'),
        `module priority-types {
  yang-version 1.1; namespace "urn:priority:types"; prefix pt; revision 2026-07-18;
  feature extra; grouping fields { leaf fallback-marker { type string; } leaf extra-marker { if-feature extra; type string; } }
}`,
        'utf8'
    );
    fs.writeFileSync(
        path.join(workspaceDirectory, 'priority-types@2026-07-18.yang'),
        `module priority-types {
  yang-version 1.1; namespace "urn:priority:types"; prefix pt; revision 2026-07-18;
  feature extra; grouping fields { leaf workspace-marker { type string; } leaf extra-marker { if-feature extra; type string; } }
}`,
        'utf8'
    );
    const directMainPath = path.join(
        directRoot,
        process.platform === 'win32' ? '意外-模型文件.yang' : 'unexpected-file-name.yang'
    );
    fs.writeFileSync(
        directMainPath,
        `module priority-main {
  yang-version 1.1; namespace "urn:priority:main"; prefix pm;
  import priority-types { prefix pt; revision-date 2026-07-18; }
  revision 2026-07-18; feature local;
  container root { uses pt:fields; leaf local-marker { if-feature local; type string; } }
}`,
        'utf8'
    );
    const runDirectHelper = featureArguments =>
        spawnSync(
            packagedStatus.schemaPath,
            [
                '-p',
                path.join(packagedStatus.runtimeDirectory, 'share', 'yang', 'modules', 'libyang'),
                '-p',
                fallbackDirectory,
                '-p',
                workspaceDirectory,
                ...featureArguments.flatMap(feature => ['-F', feature]),
                directMainPath
            ],
            { cwd: directRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
        );
    const selectedMainOnly = runDirectHelper(['priority-main:local']);
    assert.equal(selectedMainOnly.status, 0, selectedMainOnly.stderr);
    const selectedMainTree = validateAuthoritativeSchemaTree(JSON.parse(selectedMainOnly.stdout));
    const selectedMainNames = new Set(Object.values(selectedMainTree.nodes).map(node => node.name));
    assert(selectedMainNames.has('workspace-marker'), 'workspace search path must override the fallback module');
    assert(!selectedMainNames.has('fallback-marker'));
    assert(selectedMainNames.has('local-marker'), 'feature selection must use the parsed module name, not filename');
    assert(!selectedMainNames.has('extra-marker'), 'features in unspecified imported modules must be disabled');

    if (process.platform === 'win32') {
        const unicodeYanglint = spawnSync(
            packagedStatus.path,
            [
                '-p',
                path.join(packagedStatus.runtimeDirectory, 'share', 'yang', 'modules', 'libyang'),
                '-p',
                fallbackDirectory,
                '-p',
                workspaceDirectory,
                directMainPath
            ],
            { cwd: directRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
        );
        assert.equal(
            unicodeYanglint.status,
            0,
            `yanglint must accept a UTF-8 Windows cwd, search path, and filename: ${unicodeYanglint.stderr}`
        );
    }

    const selectedImportedFeature = runDirectHelper(['priority-main:local', 'priority-types:extra']);
    assert.equal(selectedImportedFeature.status, 0, selectedImportedFeature.stderr);
    const selectedImportedTree = validateAuthoritativeSchemaTree(JSON.parse(selectedImportedFeature.stdout));
    assert(
        Object.values(selectedImportedTree.nodes).some(node => node.name === 'extra-marker'),
        'a feature requested for an implicitly loaded module must be applied'
    );

    const missingFeatureModule = runDirectHelper(['missing-feature-module:extra']);
    assert.notEqual(missingFeatureModule.status, 0);
    assert.match(missingFeatureModule.stderr, /missing-feature-module/u);

    const closureDirectory = path.join(directRoot, 'implemented-closure');
    fs.mkdirSync(closureDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(closureDirectory, 'closure-target@2026-07-18.yang'),
        `module closure-target {
  yang-version 1.1; namespace "urn:closure:target"; prefix ct; revision 2026-07-18;
  container root { leaf native-value { type string; } }
}`,
        'utf8'
    );
    const closureAugmentPath = path.join(closureDirectory, 'closure-augment@2026-07-18.yang');
    fs.writeFileSync(
        closureAugmentPath,
        `module closure-augment {
  yang-version 1.1; namespace "urn:closure:augment"; prefix ca;
  import closure-target { prefix ct; revision-date 2026-07-18; }
  revision 2026-07-18;
  augment "/ct:root" { leaf augmented-value { type string; } }
}`,
        'utf8'
    );
    const closureResult = spawnSync(
        packagedStatus.schemaPath,
        [
            '-p',
            path.join(packagedStatus.runtimeDirectory, 'share', 'yang', 'modules', 'libyang'),
            '-p',
            closureDirectory,
            closureAugmentPath
        ],
        { cwd: closureDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    assert.equal(closureResult.status, 0, closureResult.stderr);
    const closureTree = validateAuthoritativeSchemaTree(JSON.parse(closureResult.stdout));
    const closureRoots = closureTree.roots.map(id => closureTree.nodes[id].name);
    assert(closureRoots.includes('closure-augment'));
    assert(
        closureRoots.includes('closure-target'),
        'an implemented target affected by an explicit augment must be included in the effective Schema closure'
    );
    assert(
        Object.values(closureTree.nodes).some(
            node => node.name === 'augmented-value' && node.module === 'closure-augment'
        ),
        'the effective Schema closure must include nodes attached to an implicitly implemented target'
    );

    const deepSchemaPath = path.join(directRoot, 'netnexus-depth-limit.yang');
    const deepContainers = Array.from({ length: 257 }, (_value, index) => `container level-${index} {`).join(' ');
    fs.writeFileSync(
        deepSchemaPath,
        `module netnexus-depth-limit {
  yang-version 1.1; namespace "urn:netnexus:depth-limit"; prefix ndl; revision 2026-07-18;
  ${deepContainers} leaf value { type string; } ${'}'.repeat(257)}
}`,
        'utf8'
    );
    const depthLimitResult = spawnSync(
        packagedStatus.schemaPath,
        ['-p', path.join(packagedStatus.runtimeDirectory, 'share', 'yang', 'modules', 'libyang'), deepSchemaPath],
        { cwd: directRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    assert.notEqual(depthLimitResult.status, 0, 'over-deep effective Schema export must fail closed');
    assert.match(depthLimitResult.stderr, /maxDepth limit of 256/u);

    const imported = registry.importContents(
        [
            { content: common, expectedName: 'netnexus-smoke-types' },
            { content: child, expectedName: 'netnexus-smoke-child' },
            { content: main, expectedName: 'netnexus-smoke' }
        ],
        {
            workspaceId: profileContext.workspaceId,
            workspaceMetadata: { profileId: profileContext.profileId }
        }
    );
    assert.equal(imported.workspace.metadata.profileId, profileContext.profileId);
    const valid = await registry.compile({
        workspaceId: profileContext.workspaceId,
        features: ['netnexus-smoke:advanced'],
        force: true
    });
    assert.equal(valid.success, true, JSON.stringify(valid.diagnostics, null, 2));
    assert.equal(valid.validation.engine, 'libyang');
    assert.equal(valid.externalCompiler.exitCode, 0);
    assert.equal(valid.schemaTree.authoritative, true);
    assert.equal(valid.schemaTree.source, 'libyang-effective');
    assert.equal(valid.schemaTree.scope, 'core-effective-schema');
    const roots = registry.getSchemaRoots({
        workspaceId: profileContext.workspaceId,
        compileId: valid.compileId
    });
    assert(roots.some(node => node.keyword === 'module' && node.name === 'netnexus-smoke'));
    const nodes = [];
    const visit = parentId => {
        for (const node of registry.getSchemaChildren(parentId, {
            workspaceId: profileContext.workspaceId,
            compileId: valid.compileId
        })) {
            nodes.push(node);
            visit(node.id);
        }
    };
    roots.forEach(root => visit(root.id));
    assert(nodes.some(node => node.path === '/netnexus-smoke:system'));
    assert(nodes.some(node => node.path === '/netnexus-smoke:system/mode'));
    assert(nodes.some(node => node.path === '/netnexus-smoke:child-state'));
    const hostname = nodes.find(node => node.path === '/netnexus-smoke:system/hostname');
    assert.equal(hostname.type, 'label');
    assert.equal(hostname.mandatory, true);

    registry.importContents([{ content: invalid, expectedName: 'netnexus-smoke-invalid' }], {
        workspaceId: invalidProfileContext.workspaceId,
        workspaceMetadata: { profileId: invalidProfileContext.profileId }
    });
    const failed = await registry.compile({
        workspaceId: invalidProfileContext.workspaceId,
        force: true
    });
    assert.equal(failed.success, false);
    assert.equal(failed.externalCompiler.succeeded, false);
    assert.equal(failed.schemaTree, null);
    assert(failed.diagnostics.some(diagnostic => diagnostic.authoritative && diagnostic.severity === 'error'));
    assert.deepEqual(
        registry.getSchemaRoots({
            workspaceId: invalidProfileContext.workspaceId,
            compileId: failed.compileId
        }),
        []
    );
    process.stdout.write(
        `Bundled libyang ${status.version} authoritative compiler and effective Schema smoke test passed\n`
    );
}

run()
    .finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
    .catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
