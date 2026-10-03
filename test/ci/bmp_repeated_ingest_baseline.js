const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..', '..');
const baselinePath = path.join(
    projectRoot,
    'scripts',
    'benchmarks',
    'baselines',
    'bmp_repeated_ingest_1m_m4pro_20261003.json'
);
const comparePath = path.join(projectRoot, 'scripts', 'benchmarks', 'compare_bmp_repeated_ingest_baseline.js');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

// This is a historical measurement, not a claim that today's source/runtime
// matches it. Preserve all recorded samples and fingerprints; add a new dated
// baseline when the explicitly reviewed measurement protocol changes.
assert.equal(
    crypto.createHash('sha256').update(JSON.stringify(baseline)).digest('hex'),
    'b7a6d86b7db318bcd9de5d2ecb2bb0030514a071494fae989b1748f0cd375e69',
    'the versioned measured report must not be silently rewritten'
);
assert.equal(Object.prototype.hasOwnProperty.call(baseline, 'directory'), false, 'do not retain personal temp paths');
assert.equal(baseline.label, 'bmp-review-routekey-delivery');
assert.equal(baseline.routeCount, 1_000_000);
assert.equal(baseline.rounds, 3);
assert.equal(baseline.packetRoutes, 50);
assert.equal(baseline.attributeGroups, 100);
assert.equal(baseline.analysisEnabled, false);
assert.equal(
    baseline.method,
    'loopback TCP until distinct final marker committed; one independent fresh database/process per kind/round'
);
assert.deepEqual(baseline.settings, {
    threadCount: 1,
    persistenceBatchSize: 5000,
    persistenceFlushMs: 20,
    persistenceReadFenceTimeoutMs: 30000,
    persistenceSweepIntervalMs: 3600000,
    logLevel: 'off'
});
assert.equal(baseline.system.platform, 'darwin');
assert.equal(baseline.system.arch, 'arm64');
assert.equal(baseline.system.cpu, 'Apple M4 Pro');
assert.equal(baseline.system.versions.node, '16.17.1');
assert.equal(baseline.system.versions.electron, '22.3.27');
assert.equal(baseline.system.versions.modules, '110');
assert.deepEqual(baseline.fixtures, {
    peer: { bytes: 6380000, sha256: '88fc63276f4fb06d506d65f31e1f0f725d954361c102013ebff5ead52c6ac339' },
    'loc-rib': { bytes: 6620000, sha256: '995cc3ea40d012ab87a1eceb0ab65205a0cde4cf4d3ebf82d45fba6a511001a0' }
});
assert.equal(Object.keys(baseline.fingerprints).length, 5);
for (const fingerprint of Object.values(baseline.fingerprints)) assert.match(fingerprint, /^[0-9a-f]{64}$/);
assert.equal(
    baseline.fingerprints['scripts/benchmarks/bmp_repeated_ingest_benchmark.js'],
    '25c0e28d748a50e54023781ad9181615d2355dba2d7c88b71bb49d4d3c0004e6'
);

const startedAt = Date.parse(baseline.startedAt);
const finishedAt = Date.parse(baseline.finishedAt);
assert.ok(Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt > startedAt);
assert.equal(baseline.results.length, 12);
assert.equal(baseline.summary.length, 4);
assert.equal(new Set(baseline.results.map(row => `${row.kind}/${row.phase}/${row.round}`)).size, 12);
assert.equal(new Set(baseline.summary.map(row => `${row.kind}/${row.phase}`)).size, 4);
const expectedMedians = {
    'peer/first': 22277.999,
    'peer/repeat': 9658.896,
    'loc-rib/first': 23757.853,
    'loc-rib/repeat': 11591.024
};
for (const kind of ['peer', 'loc-rib']) {
    for (let round = 0; round < baseline.rounds; round += 1) {
        const samples = ['first', 'repeat'].map(phase => {
            const row = baseline.results.find(
                sample => sample.kind === kind && sample.phase === phase && sample.round === round
            );
            assert.ok(row, `${kind}/${phase}/${round} must be present`);
            assert.equal(row.label, baseline.label);
            assert.equal(row.routes, baseline.routeCount);
            assert.ok(Number.isFinite(row.milliseconds) && row.milliseconds > 0);
            assert.equal(row.routesPerSecond, Math.round((row.routes * 1000) / row.milliseconds));
            assert.equal(row.persistedTotal, baseline.routeCount + (phase === 'first' ? 1 : 2));
            assert.equal(row.fixtureBytes, baseline.fixtures[kind].bytes);
            const sampleAt = Date.parse(row.sampleLastSeenAt);
            assert.ok(Number.isFinite(sampleAt) && sampleAt >= startedAt && sampleAt <= finishedAt);
            return sampleAt;
        });
        assert.ok(samples[1] > samples[0], `${kind}/${round} repeat must advance the stored sample observation time`);
    }
    for (const phase of ['first', 'repeat']) {
        const timings = baseline.results
            .filter(row => row.kind === kind && row.phase === phase)
            .map(row => row.milliseconds)
            .sort((left, right) => left - right);
        const summary = baseline.summary.find(row => row.kind === kind && row.phase === phase);
        assert.ok(summary);
        assert.deepEqual(summary, {
            kind,
            phase,
            medianMs: timings[1],
            routesPerSecond: Math.round((baseline.routeCount * 1000) / timings[1]),
            minMs: timings[0],
            maxMs: timings[2]
        });
        assert.equal(summary.medianMs, expectedMedians[`${kind}/${phase}`]);
    }
}

function compare(measurementPath) {
    const result = spawnSync(process.execPath, [comparePath, measurementPath], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
}

const unchanged = compare(baselinePath);
assert.equal(unchanged.status, 0, unchanged.stderr);
const comparison = JSON.parse(unchanged.stdout);
assert.equal(comparison.rows.length, 4);
for (const row of comparison.rows) {
    assert.equal(row.baselineMedianMs, expectedMedians[`${row.kind}/${row.phase}`]);
    assert.equal(row.optimizedMedianMs, row.baselineMedianMs);
    assert.equal(row.durationReductionPercent, 0);
    assert.equal(row.throughputIncreasePercent, 0);
}

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-baseline-check-'));
try {
    for (const changedField of ['fixtures', 'settings', 'system', 'benchmark']) {
        const changed = JSON.parse(JSON.stringify(baseline));
        if (changedField === 'fixtures') changed.fixtures.peer.sha256 = '0'.repeat(64);
        if (changedField === 'settings') changed.settings.threadCount = 2;
        if (changedField === 'system') changed.system.versions.electron = 'different-runtime';
        if (changedField === 'benchmark')
            changed.fingerprints['scripts/benchmarks/bmp_repeated_ingest_benchmark.js'] = '0'.repeat(64);
        const changedPath = path.join(tempDirectory, `${changedField}.json`);
        fs.writeFileSync(changedPath, JSON.stringify(changed));
        const rejected = compare(changedPath);
        assert.notEqual(rejected.status, 0, `${changedField} mismatch must be rejected before comparing performance`);
        assert.match(
            rejected.stderr,
            changedField === 'benchmark' ? /benchmark implementation changed/ : /benchmark configuration\/data changed/
        );
    }
} finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
}

console.log('BMP versioned repeated-ingest baseline integrity and comparison entry tests passed');
