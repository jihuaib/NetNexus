const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Both kinds go through the production TCP/parser/writer path. The benchmark
// itself validates exact counts, first/last/middle contents and lastSeen refresh.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-repeat-tcp-test-'));
const output = path.join(directory, 'results.json');
const electron = process.versions.electron ? process.execPath : require('electron');
const child = spawnSync(
    electron,
    [
        path.resolve(__dirname, '../../scripts/benchmarks/bmp_repeated_ingest_benchmark.js'),
        '--routes=5000',
        '--rounds=1',
        '--label=ci',
        `--output=${output}`
    ],
    {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 120000
    }
);
assert.equal(child.error, undefined, child.error?.message);
assert.equal(child.signal, null, child.stderr);
assert.equal(child.status, 0, child.stdout + child.stderr);
const report = JSON.parse(fs.readFileSync(output, 'utf8'));
assert.equal(report.routeCount, 5000);
assert.equal(report.results.length, 4);
assert.equal(report.summary.length, 4);
for (const kind of ['peer', 'loc-rib']) {
    const rows = report.results.filter(row => row.kind === kind);
    assert.deepEqual(
        rows.map(row => row.phase),
        ['first', 'repeat']
    );
    assert.deepEqual(
        rows.map(row => row.persistedTotal),
        [5001, 5002]
    );
    assert.ok(Date.parse(rows[1].sampleLastSeenAt) > Date.parse(rows[0].sampleLastSeenAt));
    assert.match(report.fixtures[kind].sha256, /^[a-f0-9]{64}$/);
}
console.log('BMP repeated TCP ingest passed: peer and Loc-RIB contents/counts/lastSeen preserved');
