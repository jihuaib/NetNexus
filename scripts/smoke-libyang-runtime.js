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

    const bundledModuleDirectory = path.join(packagedStatus.runtimeDirectory, 'share', 'yang', 'modules', 'libyang');
    const notificationSchemaPaths = [
        path.join(bundledModuleDirectory, 'ietf-subscribed-notifications@2019-09-09.yang'),
        path.join(bundledModuleDirectory, 'ietf-yang-push@2019-09-09.yang')
    ];
    const notificationYanglint = spawnSync(
        packagedStatus.path,
        ['-p', bundledModuleDirectory, ...notificationSchemaPaths],
        { cwd: bundledModuleDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    assert.equal(
        notificationYanglint.status,
        0,
        `RFC 8639/RFC 8641 bundled schema validation failed: ${notificationYanglint.stderr}`
    );
    const notificationSchema = spawnSync(
        packagedStatus.schemaPath,
        [
            '-p',
            bundledModuleDirectory,
            '-F',
            'ietf-subscribed-notifications:encode-xml',
            '-F',
            'ietf-subscribed-notifications:replay',
            '-F',
            'ietf-subscribed-notifications:subtree',
            '-F',
            'ietf-subscribed-notifications:xpath',
            '-F',
            'ietf-yang-push:on-change',
            ...notificationSchemaPaths
        ],
        { cwd: bundledModuleDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    assert.equal(notificationSchema.status, 0, notificationSchema.stderr);
    const notificationTree = validateAuthoritativeSchemaTree(JSON.parse(notificationSchema.stdout));
    const notificationNodeNames = new Set(Object.values(notificationTree.nodes).map(node => node.name));
    for (const operation of [
        'establish-subscription',
        'modify-subscription',
        'delete-subscription',
        'resync-subscription',
        'push-update',
        'push-change-update'
    ]) {
        assert(notificationNodeNames.has(operation), `bundled notification schemas must compile ${operation}`);
    }
    const notificationFeatureArguments = [
        '-F',
        'ietf-subscribed-notifications:encode-xml,replay,subtree,xpath',
        '-F',
        'ietf-yang-push:on-change'
    ];
    const modernRpcPath = path.join(tempRoot, 'establish-subscription.xml');
    fs.writeFileSync(
        modernRpcPath,
        `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="smoke-rpc">
  <establish-subscription xmlns="urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications"
      xmlns:yp="urn:ietf:params:xml:ns:yang:ietf-yang-push"
      xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">
    <yp:datastore>ds:operational</yp:datastore>
    <yp:periodic><yp:period>100</yp:period></yp:periodic>
  </establish-subscription>
</rpc>\n`,
        'utf8'
    );
    const modernRpcValidation = spawnSync(
        packagedStatus.path,
        [
            '-p',
            bundledModuleDirectory,
            ...notificationFeatureArguments,
            '-i',
            '-i',
            '-t',
            'nc-rpc',
            ...notificationSchemaPaths,
            modernRpcPath
        ],
        { cwd: bundledModuleDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    assert.equal(
        modernRpcValidation.status,
        0,
        `RFC 8640 RPC instance validation failed: ${modernRpcValidation.stderr}`
    );

    const pushChangePath = path.join(tempRoot, 'push-change-update.xml');
    fs.writeFileSync(
        pushChangePath,
        `<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0">
  <eventTime>2026-07-19T00:00:00Z</eventTime>
  <push-change-update xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-push">
    <id>0</id>
    <datastore-changes>
      <yang-patch>
        <patch-id>0</patch-id>
        <edit>
          <edit-id>edit-1</edit-id>
          <operation>replace</operation>
          <target xmlns:if="urn:ietf:params:xml:ns:yang:ietf-interfaces">/if:interfaces</target>
          <value><if:interfaces xmlns:if="urn:ietf:params:xml:ns:yang:ietf-interfaces"/></value>
        </edit>
      </yang-patch>
    </datastore-changes>
  </push-change-update>
</notification>\n`,
        'utf8'
    );
    const pushChangeValidation = spawnSync(
        packagedStatus.path,
        [
            '-p',
            bundledModuleDirectory,
            ...notificationFeatureArguments,
            '-i',
            '-i',
            '-t',
            'nc-notif',
            ...notificationSchemaPaths,
            pushChangePath
        ],
        { cwd: bundledModuleDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    assert.equal(
        pushChangeValidation.status,
        0,
        `RFC 8641 push-change-update instance validation failed: ${pushChangeValidation.stderr}`
    );

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

    const referencedWhenDirectory = path.join(directRoot, 'referenced-when');
    fs.mkdirSync(referencedWhenDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(referencedWhenDirectory, 'referenced-when-state@2026-07-19.yang'),
        `module referenced-when-state {
  yang-version 1.1;
  namespace "urn:netnexus:referenced-when:state";
  prefix rws;
  revision 2026-07-19;
  container state { leaf blocked { type boolean; default false; } }
}`,
        'utf8'
    );
    const referencedWhenMainPath = path.join(referencedWhenDirectory, 'referenced-when-main@2026-07-19.yang');
    fs.writeFileSync(
        referencedWhenMainPath,
        `module referenced-when-main {
  yang-version 1.1;
  namespace "urn:netnexus:referenced-when:main";
  prefix rwm;
  import referenced-when-state { prefix rws; revision-date 2026-07-19; }
  revision 2026-07-19;
  container root {
    container guarded {
      when "not(/rws:state/rws:blocked)";
      leaf value { type string; }
    }
  }
}`,
        'utf8'
    );
    const referencedWhenResult = spawnSync(
        packagedStatus.schemaPath,
        [
            '-p',
            path.join(packagedStatus.runtimeDirectory, 'share', 'yang', 'modules', 'libyang'),
            '-p',
            referencedWhenDirectory,
            /* The imported state module is intentionally available only through the search path. */
            referencedWhenMainPath
        ],
        { cwd: directRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    assert.equal(
        referencedWhenResult.status,
        0,
        `cross-module when Schema compilation failed: ${referencedWhenResult.stderr}`
    );
    assert.doesNotMatch(
        referencedWhenResult.stderr,
        /non-implemented|not implemented|check skipped/iu,
        'the Schema helper must implement modules referenced by when expressions'
    );
    const referencedWhenTree = validateAuthoritativeSchemaTree(JSON.parse(referencedWhenResult.stdout));
    assert(
        referencedWhenTree.roots.some(id => referencedWhenTree.nodes[id].name === 'referenced-when-main'),
        'the explicitly requested module must remain an effective Schema root'
    );
    assert(
        Object.values(referencedWhenTree.nodes).some(
            node => node.name === 'guarded' && node.module === 'referenced-when-main'
        ),
        'the effective Schema must retain the node guarded by the cross-module when expression'
    );

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
