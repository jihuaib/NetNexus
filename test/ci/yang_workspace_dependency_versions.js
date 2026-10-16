const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { YangRegistry, LibyangRuntime } = require('../../electron/utils/yang');
const { getReleaseManifest } = require('../../scripts/libyang-runtime-config');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.resolve(__dirname, '..', '..'));
const resourcesPath = path.join(projectRoot, 'resources');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-yang-versions-'));

const workspaceBase = `module netnexus-workspace-base {
  yang-version 1.1;
  namespace "urn:netnexus:workspace:base";
  prefix wb;
  revision 2020-01-01;
  typedef interface-ref {
    type leafref { path "/wb:interfaces/wb:interface/wb:name"; }
  }
  container interfaces {
    list interface {
      key "name";
      leaf name { type string; }
      container workspace-only { leaf enabled { type boolean; } }
    }
  }
}`;

const fallbackBase = workspaceBase
    .replace('revision 2020-01-01;', 'revision 2026-01-01;')
    .replace('workspace-only', 'fallback-only');

const fallbackPrimitive = `module netnexus-fallback-primitive {
  yang-version 1.1;
  namespace "urn:netnexus:fallback:primitive";
  prefix fp;
  revision 2026-01-01;
  typedef small-number { type uint8 { range "1..9"; } }
}`;

const fallbackShared = `module netnexus-fallback-shared {
  yang-version 1.1;
  namespace "urn:netnexus:fallback:shared";
  prefix fs;
  import netnexus-fallback-primitive { prefix fp; }
  import netnexus-workspace-base { prefix wb; }
  revision 2026-01-01;
  typedef small-number { type fp:small-number; }
  typedef interface-ref { type wb:interface-ref; }
}`;

const workspaceExtension = `module netnexus-workspace-extension {
  yang-version 1.1;
  namespace "urn:netnexus:workspace:extension";
  prefix we;
  import netnexus-workspace-base { prefix wb; }
  import netnexus-fallback-shared { prefix fs; }
  revision 2026-01-01;
  augment "/wb:interfaces/wb:interface/wb:workspace-only" {
    leaf dependency-marker { type fs:small-number; }
    leaf selected-interface { type fs:interface-ref; }
  }
}`;

function createRegistry(name, runtime, options = {}) {
    return new YangRegistry({
        rootDir: path.join(temporaryRoot, name),
        resourcesPath,
        isPackaged: false,
        runtime,
        ...options
    });
}

function importModules(registry, contents) {
    const result = registry.importContents(contents.map(content => ({ content, source: 'test' })));
    assert.equal(result.summary.imported, contents.length);
}

function collectNodes(registry, compileId) {
    const roots = registry.getSchemaRoots({ compileId });
    const nodes = [...roots];
    const walk = parentId => {
        for (const node of registry.getSchemaChildren(parentId, { compileId })) {
            nodes.push(node);
            walk(node.id);
        }
    };
    roots.forEach(root => walk(root.id));
    return nodes;
}

function editConfigRpc(marker) {
    return `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="dependency-versions">
  <edit-config>
    <target><running/></target>
    <config>
      <interfaces xmlns="urn:netnexus:workspace:base">
        <interface>
          <name>eth0</name>
          <workspace-only>
            <enabled>true</enabled>
            <dependency-marker xmlns="urn:netnexus:workspace:extension">${marker}</dependency-marker>
          </workspace-only>
        </interface>
      </interfaces>
    </config>
  </edit-config>
</rpc>`;
}

async function assertWorkspaceDependencyPrecedence(runtime) {
    const fallbackDirectory = path.join(temporaryRoot, 'fallback');
    const nestedDirectory = path.join(fallbackDirectory, 'nested', 'types');
    fs.mkdirSync(nestedDirectory, { recursive: true });
    fs.writeFileSync(path.join(fallbackDirectory, 'netnexus-workspace-base@2026-01-01.yang'), fallbackBase);
    fs.writeFileSync(
        path.join(fallbackDirectory, 'netnexus-workspace-base@2027-01-01.yin'),
        `<module name="netnexus-workspace-base" xmlns="urn:ietf:params:xml:ns:yang:yin:1">
  <yang-version value="1.1"/>
  <namespace uri="urn:netnexus:workspace:base"/>
  <prefix value="wb"/>
  <revision date="2027-01-01"/>
  <container name="fallback-only"/>
</module>`
    );
    fs.writeFileSync(path.join(nestedDirectory, 'netnexus-fallback-primitive@2026-01-01.yang'), fallbackPrimitive);
    fs.writeFileSync(path.join(nestedDirectory, 'netnexus-fallback-shared@2026-01-01.yang'), fallbackShared);

    const registry = createRegistry('workspace', runtime, { searchPaths: [fallbackDirectory] });
    importModules(registry, [workspaceBase, workspaceExtension]);
    const compiled = await registry.compile({ force: true });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));
    assert.equal(compiled.schemaAvailable, true);
    assert.equal(compiled.partialSchema, false);
    assert.equal(compiled.summary.failedFiles, 0);
    const nodes = collectNodes(registry, compiled.compileId);
    assert(
        nodes.some(node => node.name === 'workspace-only'),
        'the workspace revision must remain implemented'
    );
    assert(!nodes.some(node => node.name === 'fallback-only'), 'the newer fallback revision must not enter the Schema');
    const marker = nodes.find(node => node.name === 'dependency-marker');
    assert(marker, 'augment must target the workspace revision');
    assert.equal(marker.baseType, 'uint8', 'nested transitive fallback typedefs must still resolve');
    assert(
        nodes.some(node => node.name === 'selected-interface'),
        'transitive fallback imports must use workspace modules'
    );

    const validRpc = await registry.validateRpc({ compileId: compiled.compileId, rpc: editConfigRpc(7) });
    assert.equal(validRpc.valid, true, JSON.stringify(validRpc.diagnostics, null, 2));
    const invalidRpc = await registry.validateRpc({ compileId: compiled.compileId, rpc: editConfigRpc(10) });
    assert.equal(invalidRpc.valid, false, 'RPC validation must preserve fallback typedef restrictions');
    assert.match(invalidRpc.diagnostics[0]?.rawMessage || '', /range|Invalid value/iu);

    for (const revision of ['2026-01-01', '2030-01-01']) {
        const lockedRegistry = createRegistry(`locked-${revision}`, runtime, { searchPaths: [fallbackDirectory] });
        const lockedExtension = workspaceExtension.replace(
            'import netnexus-workspace-base { prefix wb; }',
            `import netnexus-workspace-base { prefix wb; revision-date ${revision}; }`
        );
        importModules(lockedRegistry, [workspaceBase, lockedExtension]);
        const locked = await lockedRegistry.compile({ force: true });
        assert.equal(locked.success, false, 'an incompatible explicit revision-date must not be rewritten');
        assert(
            locked.fileResults.some(file => file.name === 'netnexus-workspace-extension' && file.status === 'failed'),
            JSON.stringify(locked.fileResults, null, 2)
        );
        assert(
            locked.diagnostics.some(diagnostic => /revision|netnexus-workspace-base/iu.test(diagnostic.message)),
            JSON.stringify(locked.diagnostics, null, 2)
        );
    }
}

async function assertWorkspaceSubmodulePrecedence(runtime) {
    const fallbackDirectory = path.join(temporaryRoot, 'submodule-fallback');
    fs.mkdirSync(fallbackDirectory, { recursive: true });
    const workspacePart = `submodule netnexus-workspace-part {
  yang-version 1.1;
  belongs-to netnexus-include-host { prefix host; }
  revision 2020-01-01;
  leaf workspace-submodule-only { type string; }
}`;
    fs.writeFileSync(
        path.join(fallbackDirectory, 'netnexus-workspace-part@2026-01-01.yang'),
        workspacePart
            .replace('revision 2020-01-01;', 'revision 2026-01-01;')
            .replace('workspace-submodule-only', 'fallback-submodule-only')
    );
    const registry = createRegistry('submodule', runtime, { searchPaths: [fallbackDirectory] });
    importModules(registry, [
        `module netnexus-include-host {
  yang-version 1.1;
  namespace "urn:netnexus:include:host";
  prefix host;
  include netnexus-workspace-part;
  revision 2026-01-01;
}`,
        workspacePart
    ]);
    const compiled = await registry.compile({ force: true });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));
    const nodes = collectNodes(registry, compiled.compileId);
    assert(nodes.some(node => node.name === 'workspace-submodule-only'));
    assert(!nodes.some(node => node.name === 'fallback-submodule-only'));
}

async function assertBundledDependencyPrecedence(runtime, status) {
    assert(
        status.moduleSearchPath && fs.existsSync(status.moduleSearchPath),
        'bundled dependency modules are required'
    );
    const interfaceSource = fs.readFileSync(
        path.join(status.moduleSearchPath, 'ietf-interfaces@2018-02-20.yang'),
        'utf8'
    );
    const ipSource = fs.readFileSync(path.join(status.moduleSearchPath, 'ietf-ip@2018-02-22.yang'), 'utf8');
    // Use the actual bundled models with an older workspace revision to reproduce the reported conflict.
    const olderInterfaceSource = interfaceSource
        .replace('revision 2018-02-20 {', 'revision 2018-01-09 {')
        .replace(/\}\s*$/u, '  leaf workspace-interface-revision { type string; }\n}\n');
    assert.notEqual(olderInterfaceSource, interfaceSource);
    const typeModuleNames = ['ietf-inet-types', 'ietf-yang-types'];
    const olderTypeSources = typeModuleNames.map(name => {
        const source = fs.readFileSync(path.join(status.moduleSearchPath, `${name}@2025-12-22.yang`), 'utf8');
        const olderSource = source.replace('revision 2025-12-22 {', 'revision 2025-12-21 {');
        assert.notEqual(olderSource, source);
        return olderSource;
    });
    const registry = createRegistry('bundled', runtime);
    // Native context initialization still needs its bundled types at their exact internal revisions.
    importModules(registry, [olderInterfaceSource, ipSource, ...olderTypeSources]);
    const compiled = await registry.compile({ force: true });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));
    assert.equal(compiled.schemaAvailable, true);
    assert.equal(compiled.partialSchema, false);
    assert.equal(compiled.summary.failedFiles, 0);
    for (const name of typeModuleNames) {
        assert(
            compiled.modules.some(
                module => module.metadata?.name === name && module.metadata.revision === '2025-12-21'
            ),
            `the older workspace ${name} revision must compile alongside native bootstrap dependencies`
        );
    }
    const nodes = collectNodes(registry, compiled.compileId);
    assert(nodes.some(node => node.name === 'workspace-interface-revision'));
    assert(nodes.some(node => node.name === 'ipv4' && node.module === 'ietf-ip'));
    assert(nodes.some(node => node.name === 'ipv6' && node.module === 'ietf-ip'));
}

async function assertPartialSchemaFailureDiagnostics(runtime) {
    const registry = createRegistry('partial', runtime);
    importModules(registry, [
        `module aaa-broken {
  namespace "urn:netnexus:broken";
  prefix broken;
  import absent-dependency { prefix absent; }
  revision 2026-01-01;
  leaf broken { type absent:missing; }
}`,
        `module duplicate-namespace-first {
  namespace "urn:netnexus:duplicate";
  prefix first;
  revision 2026-01-01;
  leaf first { type string; }
}`,
        `module duplicate-namespace-second {
  namespace "urn:netnexus:duplicate";
  prefix second;
  revision 2026-01-01;
  leaf second { type string; }
}`
    ]);
    const compiled = await registry.compile({ force: true });
    assert.equal(compiled.success, false);
    assert.equal(compiled.schemaAvailable, false);
    assert.equal(compiled.schemaTree, null);
    assert.equal(compiled.summary.compiledFiles, 2, JSON.stringify(compiled.fileResults, null, 2));
    assert.equal(compiled.summary.failedFiles, 1);
    assert(
        compiled.diagnostics.some(
            diagnostic =>
                diagnostic.origin === 'partial-schema' &&
                diagnostic.severity === 'error' &&
                /namespace/iu.test(diagnostic.message)
        ),
        'failed partial Schema compilation must preserve its namespace-conflict diagnostic'
    );
    assert.equal(
        compiled.summary.errors,
        compiled.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
    );
}

async function run() {
    try {
        const runtime = new LibyangRuntime({ resourcesPath, isPackaged: false });
        const status = await runtime.getStatus({ force: true });
        const release = getReleaseManifest(projectRoot);
        assert.equal(status.available, true, status.error);
        assert.equal(status.version, release.libyangVersion);
        assert.equal(status.schemaVersion, release.libyangVersion);
        assert.equal(status.capabilities.schemaExport, true, 'the native Schema helper is required');
        assert.equal(status.capabilities.dataValidation, true, 'native RPC validation is required');
        await assertWorkspaceDependencyPrecedence(runtime);
        await assertWorkspaceSubmodulePrecedence(runtime);
        await assertBundledDependencyPrecedence(runtime, status);
        await assertPartialSchemaFailureDiagnostics(runtime);
        console.log('YANG workspace dependency revision tests passed');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
