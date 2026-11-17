const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { YangRegistry, YangMetadataParser, parseYangMetadata, METADATA_ENGINE } = require('../../electron/utils/yang');
const YangRuntimeService = require('../../electron/worker/yang/yangRuntimeService');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-libyang-metadata-test-'));
const source = `module vendor-bgp {
    namespace "urn:vendor:bgp";
    prefix bgp;
    import unavailable-types { prefix types; revision-date 2026-01-01; }
    include unavailable-submodule { revision-date 2026-01-02; }
    description "import fake { prefix nope; }" + ' // stays text';
    revision 2026-07-09 { description "first change"; }
    revision 2026-07-09 { description "another change on the same day"; }
    container bgp { leaf asn { type types:asn; } }
}`;

try {
    const unavailable = new YangMetadataParser({ isPackaged: true, resourcesPath: rootDir, env: {} });
    assert.throws(() => unavailable.parse(source), { code: 'LIBYANG_METADATA_UNAVAILABLE' });
    const parsed = parseYangMetadata(source, { sourceName: 'vendor-bgp.yang' });
    assert.equal(parsed.metadataEngine, METADATA_ENGINE);
    assert.equal(parsed.metadata.name, 'vendor-bgp');
    assert.equal(parsed.metadata.revision, '2026-07-09');
    assert.equal(parsed.metadata.description, 'import fake { prefix nope; } // stays text');
    assert.deepEqual(
        parsed.metadata.imports.map(item => item.name),
        ['unavailable-types']
    );
    assert.deepEqual(
        parsed.metadata.includes.map(item => item.name),
        ['unavailable-submodule']
    );
    assert.equal(
        parsed.diagnostics.some(item => item.severity === 'error'),
        false
    );
    assert(parsed.diagnostics.some(item => item.severity === 'warning' && /Duplicate revision/u.test(item.message)));
    assert(parsed.diagnostics.every(item => item.authoritative && item.origin === 'libyang-metadata'));

    const submodule = parseYangMetadata(`submodule unavailable-submodule {
        yang-version 1.1;
        belongs-to vendor-bgp { prefix bgp; }
        import unavailable-types { prefix types; }
        revision 2026-01-02;
        grouping extra { leaf asn { type types:asn; } }
    }`);
    assert.equal(submodule.metadata.kind, 'submodule');
    assert.equal(submodule.metadata.belongsTo, 'vendor-bgp');
    assert.equal(submodule.metadata.belongsToPrefix, 'bgp');
    assert.equal(
        submodule.diagnostics.some(item => item.severity === 'error'),
        false
    );

    const malformed = parseYangMetadata('module broken { namespace "urn:broken";', { sourceName: 'broken.yang' });
    assert.equal(malformed.metadata, null);
    assert(malformed.diagnostics.some(item => item.severity === 'error' && item.source === 'broken.yang'));
    const invalidKeyword = parseYangMetadata('container root;');
    assert.equal(invalidKeyword.metadata, null);
    assert(invalidKeyword.diagnostics.some(item => item.severity === 'error'));

    const registry = new YangRegistry({ rootDir });
    const imported = registry.importContents([{ content: source, expectedName: 'vendor-bgp' }]);
    assert.equal(imported.summary.invalid, 0);
    const entry = imported.imported[0];
    const normalize = entry => YangRuntimeService.prototype.normalizeModule.call({}, entry);
    assert.equal(normalize(entry).status, 'downloaded');
    assert.equal(normalize(entry).compileStatus, 'pending');
    assert.equal(
        YangRuntimeService.prototype.normalizeModule.call({}, entry, new Set(), new Set([entry.hash])).compileStatus,
        'failed',
        'a real compilation failure must still be displayed'
    );

    // Old JS-parser diagnostics must be replaced using the original bytes, even
    // before the user imports or downloads again. Reading cannot mutate snapshots.
    const manifestPath = registry.repository.manifestPath('workspace', 'default');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.modules[0].metadataEngine;
    manifest.modules[0].diagnostics = [{ severity: 'error', code: 'DUPLICATE_REVISION_STATEMENT' }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = fs.readFileSync(manifestPath);
    const restored = registry.listModules()[0];
    assert.equal(restored.metadataEngine, METADATA_ENGINE);
    assert.equal(
        restored.diagnostics.some(item => item.severity === 'error'),
        false
    );
    assert.equal(normalize(restored).compileStatus, 'pending');
    assert.equal(fs.readFileSync(restored.filePath, 'utf8'), source);
    assert.deepEqual(fs.readFileSync(manifestPath), before);

    console.log('libyang-only metadata, missing dependencies, submodules, warnings and legacy workspace tests passed');
} finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
}
