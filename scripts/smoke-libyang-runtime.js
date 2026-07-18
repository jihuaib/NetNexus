const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { YangRegistry } = require('../electron/utils/yang');
const { getReleaseManifest, verifyRuntime } = require('./libyang-runtime-config');

const projectRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-libyang-smoke-'));
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

    const registry = new YangRegistry({
        rootDir: path.join(tempRoot, 'repository'),
        resourcesPath: path.join(projectRoot, 'resources'),
        isPackaged: false
    });
    const status = await registry.getCompilerStatus({ forceRuntimeDiscovery: true });
    assert.equal(status.available, true, status.error);
    assert.equal(status.source, 'bundled');
    assert.equal(status.version, release.libyangVersion);
    registry.importContents([
        { content: common, expectedName: 'netnexus-smoke-types' },
        { content: child, expectedName: 'netnexus-smoke-child' },
        { content: main, expectedName: 'netnexus-smoke' }
    ]);
    const valid = await registry.compile({ features: ['netnexus-smoke:advanced'], force: true });
    assert.equal(valid.success, true, JSON.stringify(valid.diagnostics, null, 2));
    assert.equal(valid.validation.engine, 'libyang');
    assert.equal(valid.externalCompiler.exitCode, 0);

    registry.importContents([{ content: invalid, expectedName: 'netnexus-smoke-invalid' }], {
        workspaceId: 'invalid'
    });
    const failed = await registry.compile({ workspaceId: 'invalid', force: true });
    assert.equal(failed.success, false);
    assert.equal(failed.externalCompiler.succeeded, false);
    assert(failed.diagnostics.some(diagnostic => diagnostic.authoritative && diagnostic.severity === 'error'));
    process.stdout.write(`Bundled libyang ${status.version} authoritative compiler smoke test passed\n`);
}

run()
    .finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
    .catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
