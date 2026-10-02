const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareWorkspace } = require('../../scripts/run-ci-tests-on-minified-electron');

const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-minified-workspace-fixture-'));
let workspace;
try {
    for (const directory of [
        'electron/utils',
        'shared',
        'src/view/bgp',
        'test/ci',
        '.github/workflows',
        'docs',
        'resources/grpc',
        'node_modules',
        'scripts'
    ]) {
        fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    }
    for (const file of ['package.json', 'package-lock.json']) fs.writeFileSync(path.join(sourceRoot, file), '{}');
    fs.writeFileSync(path.join(sourceRoot, 'README.md'), 'workspace fixture');
    fs.writeFileSync(path.join(sourceRoot, 'vite.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(sourceRoot, 'shared/bgpAttributes.json'), JSON.stringify({ name: 'shared-fixture' }));
    fs.writeFileSync(
        path.join(sourceRoot, 'shared/bgpExtendedCommunities.js'),
        'module.exports = { value: "shared-module" };'
    );
    fs.writeFileSync(
        path.join(sourceRoot, 'electron/utils/sharedProbe.js'),
        'module.exports = { registry: require("../../shared/bgpAttributes.json"), parser: require("../../shared/bgpExtendedCommunities") };'
    );
    fs.writeFileSync(
        path.join(sourceRoot, 'src/view/bgp/workspaceProbe.js'),
        'module.exports = { registry: require("../../../shared/bgpAttributes.json"), kind: "source-workspace" };'
    );

    workspace = prepareWorkspace(sourceRoot);
    assert.equal(fs.lstatSync(path.join(workspace, 'shared')).isDirectory(), true);
    assert.equal(
        fs.lstatSync(path.join(workspace, 'shared')).isSymbolicLink(),
        false,
        'shared resources must be copied, not linked to unminified source'
    );
    const probe = require(path.join(workspace, 'electron/utils/sharedProbe.js'));
    assert.deepEqual(probe, { registry: { name: 'shared-fixture' }, parser: { value: 'shared-module' } });
    assert.equal(fs.lstatSync(path.join(workspace, 'src')).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(workspace, 'src')).isSymbolicLink(), false);
    assert.deepEqual(require(path.join(workspace, 'src/view/bgp/workspaceProbe.js')), {
        registry: { name: 'shared-fixture' },
        kind: 'source-workspace'
    });
    fs.writeFileSync(path.join(workspace, 'src/view/bgp/workspaceProbe.js'), 'module.exports = {};');
    assert.match(
        fs.readFileSync(path.join(sourceRoot, 'src/view/bgp/workspaceProbe.js'), 'utf8'),
        /source-workspace/,
        'copied renderer-model edits must not affect the source project'
    );
    fs.writeFileSync(path.join(workspace, 'shared/bgpAttributes.json'), '{}');
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(sourceRoot, 'shared/bgpAttributes.json'), 'utf8')),
        { name: 'shared-fixture' },
        'workspace edits must not affect the source project'
    );
    console.log('Minified CI workspace shared JSON/JS and src-model resource isolation tests passed');
} finally {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
}
