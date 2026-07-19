const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { YangRegistry, parseYang } = require('../../electron/utils/yang');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-repository-'));
const repositoryRoot = path.join(tempDir, 'repository');
const sourceDirectory = path.join(tempDir, 'sources');
const nestedDirectory = path.join(sourceDirectory, 'nested');

try {
    const lexicalSource = `module lexical-demo {
  yang-version 1.1;
  namespace "urn:lexical://demo";
  prefix ld;
  // module commented-out { revision 1900-01-01; }
  /* import phantom { prefix p; } */
  revision 2026-07-18;
  import common-types {
    prefix ct;
    revision-date 2025-01-02;
  }
  include lexical-extra { revision-date 2026-07-18; }
  feature fast-mode;
  deviation "/ld:obsolete" { deviate not-supported; }
  description "quoted // comment and { brace }" +
              ' concatenate safely';
  container root { leaf name { type string; } }
}`;
    const parsed = parseYang(lexicalSource, { sourceName: 'lexical-demo.yang' });
    assert.equal(parsed.diagnostics.filter(item => item.severity === 'error').length, 0);
    assert.equal(parsed.metadata.kind, 'module');
    assert.equal(parsed.metadata.name, 'lexical-demo');
    assert.equal(parsed.metadata.yangVersion, '1.1');
    assert.equal(parsed.metadata.namespace, 'urn:lexical://demo');
    assert.equal(parsed.metadata.revision, '2026-07-18');
    assert.deepEqual(parsed.metadata.features, ['fast-mode']);
    assert.deepEqual(
        parsed.metadata.deviations.map(item => item.target),
        ['/ld:obsolete']
    );
    assert.deepEqual(parsed.metadata.imports[0], {
        kind: 'import',
        name: 'common-types',
        revisionDate: '2025-01-02',
        prefix: 'ct',
        description: null,
        line: 8,
        column: 3
    });
    assert.equal(parsed.metadata.includes[0].name, 'lexical-extra');
    assert.equal(parsed.metadata.description, 'quoted // comment and { brace } concatenate safely');

    const malformed = parseYang('module bad { namespace "urn:bad"; /* never closed', { sourceName: 'bad.yang' });
    assert(malformed.diagnostics.some(item => item.code === 'UNTERMINATED_COMMENT'));
    assert(malformed.diagnostics.some(item => item.code === 'UNCLOSED_BLOCK'));

    fs.mkdirSync(nestedDirectory, { recursive: true });
    const lexicalPath = path.join(sourceDirectory, 'lexical-demo.yang');
    const extraPath = path.join(nestedDirectory, 'lexical-extra.yang');
    fs.writeFileSync(lexicalPath, lexicalSource, 'utf8');
    fs.writeFileSync(
        extraPath,
        `submodule lexical-extra {
  yang-version 1.1;
  belongs-to lexical-demo { prefix ld; }
  revision 2026-07-18;
  notification extra-event { leaf detail { type string; } }
}`,
        'utf8'
    );
    fs.writeFileSync(path.join(sourceDirectory, 'ignore.txt'), lexicalSource, 'utf8');

    const registry = new YangRegistry({ rootDir: repositoryRoot });
    const imported = registry.importDirectory(sourceDirectory);
    assert.equal(imported.summary.discovered, 2);
    assert.equal(imported.summary.imported, 2);
    assert.equal(imported.summary.failed, 0);
    assert.equal(imported.workspace.modules.length, 2);

    const lexicalEntry = imported.imported.find(entry => entry.metadata?.name === 'lexical-demo');
    assert(lexicalEntry);
    assert(fs.existsSync(lexicalEntry.filePath));
    assert.match(lexicalEntry.filePath, /workspaces[/\\]default[/\\]modules[/\\][a-f0-9]{64}\.yang$/);
    assert.equal(fs.existsSync(path.join(repositoryRoot, 'blobs')), false);
    assert.equal(fs.existsSync(path.join(repositoryRoot, 'catalog.json')), false);

    const downloaded = registry.importContents([
        {
            content: lexicalSource,
            expectedName: 'lexical-demo',
            revision: '2026-07-18',
            source: 'netconf://router-1/get-schema'
        }
    ]);
    assert.equal(downloaded.imported[0].hash, lexicalEntry.hash);
    assert.equal(downloaded.imported[0].deduplicated, true);
    assert(downloaded.imported[0].origins.includes('netconf://router-1/get-schema'));
    assert.equal(downloaded.workspace.modules.length, 2, 'workspace references must deduplicate identical modules');

    const isolated = registry.importContents(
        [
            {
                content: lexicalSource,
                expectedName: 'lexical-demo',
                revision: '2026-07-18',
                source: 'netconf://router-2/get-schema'
            }
        ],
        { workspaceId: 'router-two', workspaceMetadata: { profileId: 'router-two' } }
    );
    const isolatedEntry = isolated.imported[0];
    assert.equal(isolatedEntry.hash, lexicalEntry.hash);
    assert.equal(isolatedEntry.deduplicated, false, 'deduplication must be scoped to one workspace');
    assert.notEqual(isolatedEntry.filePath, lexicalEntry.filePath);
    assert.match(isolatedEntry.filePath, /workspaces[/\\]router-two[/\\]modules[/\\][a-f0-9]{64}\.yang$/);
    assert(fs.existsSync(isolatedEntry.filePath));
    assert.equal(fs.readFileSync(isolatedEntry.filePath, 'utf8'), fs.readFileSync(lexicalEntry.filePath, 'utf8'));

    const mismatched = registry.importContents(
        [{ content: lexicalSource, expectedName: 'wrong-name', revision: '1999-01-01', source: 'netconf://bad' }],
        { workspaceId: false }
    );
    assert(mismatched.imported[0].diagnostics.some(item => item.code === 'MODULE_NAME_MISMATCH'));
    assert(mismatched.imported[0].diagnostics.some(item => item.code === 'MODULE_REVISION_MISMATCH'));

    const snapshot = registry.createSnapshot({ id: 'router-1-20260718', name: 'Router 1' });
    assert.equal(snapshot.type, 'snapshot');
    assert.equal(snapshot.modules.length, 2);
    assert(fs.existsSync(path.join(repositoryRoot, 'snapshots', snapshot.id, 'manifest.json')));
    const snapshotEntry = registry.repository
        .resolveEntries({ snapshotId: snapshot.id, hashes: [lexicalEntry.hash] })
        .at(0);
    assert(fs.existsSync(snapshotEntry.filePath));
    assert.match(snapshotEntry.filePath, /snapshots[/\\]router-1-20260718[/\\]modules[/\\][a-f0-9]{64}\.yang$/);
    assert.notEqual(snapshotEntry.filePath, lexicalEntry.filePath, 'snapshots must own their module files');
    assert.throws(() => registry.createSnapshot({ id: snapshot.id }), /immutable/, 'snapshots must not be overwritten');
    const isolatedBeforeSnapshotConflict = registry.getWorkspace('router-two');
    assert.throws(
        () =>
            registry.importContents(
                [
                    {
                        content:
                            'module snapshot-conflict { namespace "urn:snapshot:conflict"; prefix sc; revision 2026-07-19; }',
                        expectedName: 'snapshot-conflict'
                    }
                ],
                { workspaceId: 'router-two', snapshotId: snapshot.id }
            ),
        /immutable/u
    );
    assert.deepEqual(
        registry.getWorkspace('router-two'),
        isolatedBeforeSnapshotConflict,
        'a snapshot ID conflict must not partially modify the Profile workspace'
    );

    const source = registry.getModuleSource({ name: 'lexical-demo', revision: '2026-07-18' });
    assert.equal(source.hash, lexicalEntry.hash);
    assert(source.source.includes('quoted // comment'));

    const cleared = registry.clearWorkspace();
    assert.equal(cleared.modules.length, 0);
    assert.equal(registry.listModules().length, 0);
    assert.equal(
        registry.listModules({ workspaceId: 'router-two' }).length,
        1,
        'clearing one workspace must retain another workspace and its files'
    );
    assert(fs.existsSync(isolatedEntry.filePath));
    assert.equal(registry.repository.resolveEntries({ snapshotId: snapshot.id }).length, 2);

    assert.equal(registry.deleteWorkspace(), true);
    assert.equal(registry.getWorkspace(), null);
    assert.equal(registry.listModules({ workspaceId: 'router-two' }).length, 1);
    assert(fs.existsSync(isolatedEntry.filePath), 'deleting one workspace must not remove another workspace module');
    assert.equal(registry.deleteWorkspace(), false);

    const temporaryFiles = [];
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const childPath = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(childPath);
            else if (entry.name.endsWith('.tmp')) temporaryFiles.push(childPath);
        }
    };
    visit(repositoryRoot);
    assert.deepEqual(temporaryFiles, [], 'atomic writes must not leave temporary files behind');

    console.log('YANG repository and lexer tests passed');
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
