// Stable entry point for the versioned, measured Apple M4 Pro baseline.
// This only compares existing reports; it never runs an ingest benchmark.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const baselinePath = path.join(__dirname, 'baselines', 'bmp_repeated_ingest_1m_m4pro_20261003.json');
const arguments_ = process.argv.slice(2);
const usage =
    'Usage: node scripts/benchmarks/compare_bmp_repeated_ingest_baseline.js measurement.json [comparison.json]';

if (arguments_.length === 1 && arguments_[0] === '--help') {
    console.log(usage);
    console.log(`Baseline: ${baselinePath}`);
} else if (arguments_.length < 1 || arguments_.length > 2 || arguments_[0].startsWith('--')) {
    console.error(usage);
    process.exitCode = 1;
} else {
    const result = spawnSync(
        process.execPath,
        [path.join(__dirname, 'compare_bmp_repeated_ingest_benchmarks.js'), baselinePath, ...arguments_],
        { stdio: 'inherit' }
    );
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Benchmark comparison terminated by ${result.signal}`);
    process.exitCode = result.status === null ? 1 : result.status;
}
