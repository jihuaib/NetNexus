// node scripts/benchmarks/compare_bmp_repeated_ingest_benchmarks.js baseline.json optimized.json [comparison.json]
const assert = require('node:assert/strict');
const fs = require('node:fs');

const [baselinePath, optimizedPath, outputPath] = process.argv.slice(2);
assert.ok(baselinePath && optimizedPath, 'two benchmark result paths are required');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const optimized = JSON.parse(fs.readFileSync(optimizedPath, 'utf8'));
for (const key of [
    'routeCount',
    'rounds',
    'packetRoutes',
    'attributeGroups',
    'settings',
    'analysisEnabled',
    'fixtures',
    'system'
]) {
    assert.deepEqual(optimized[key], baseline[key], `benchmark configuration/data changed: ${key}`);
}
const benchmarkFile = 'scripts/benchmarks/bmp_repeated_ingest_benchmark.js';
assert.equal(
    optimized.fingerprints[benchmarkFile],
    baseline.fingerprints[benchmarkFile],
    'benchmark implementation changed'
);
assert.equal(optimized.summary.length, baseline.summary.length);
const report = {
    method: baseline.method,
    routeCount: baseline.routeCount,
    rounds: baseline.rounds,
    packetRoutes: baseline.packetRoutes,
    attributeGroups: baseline.attributeGroups,
    analysisEnabled: baseline.analysisEnabled,
    settings: baseline.settings,
    fixtures: baseline.fixtures,
    system: baseline.system,
    baselineLabel: baseline.label,
    optimizedLabel: optimized.label,
    baselineFingerprints: baseline.fingerprints,
    optimizedFingerprints: optimized.fingerprints,
    rows: baseline.summary.map(before => {
        const after = optimized.summary.find(row => row.kind === before.kind && row.phase === before.phase);
        assert.ok(after, `missing optimized result ${before.kind}/${before.phase}`);
        assert.ok(before.medianMs > 0 && after.medianMs > 0);
        return {
            kind: before.kind,
            phase: before.phase,
            baselineMedianMs: before.medianMs,
            optimizedMedianMs: after.medianMs,
            durationReductionPercent: +(100 * (1 - after.medianMs / before.medianMs)).toFixed(2),
            throughputIncreasePercent: +(100 * (before.medianMs / after.medianMs - 1)).toFixed(2),
            baselineRoutesPerSecond: before.routesPerSecond,
            optimizedRoutesPerSecond: after.routesPerSecond,
            baselineRangeMs: [before.minMs, before.maxMs],
            optimizedRangeMs: [after.minMs, after.maxMs]
        };
    }),
    baseline,
    optimized
};
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ rows: report.rows, resultPath: outputPath || null }, null, 2));
