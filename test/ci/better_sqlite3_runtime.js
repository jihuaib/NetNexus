const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { rebuildBetterSqlite3, sourceBuildEnvironment } = require('../../scripts/rebuild-better-sqlite3');
const { lockFilePath, waitForRebuild } = require('../../scripts/better-sqlite3-rebuild-lock');
const { environmentWithOverrides, verifyBetterSqliteRuntime } = require('../../scripts/smoke-better-sqlite3-runtime');

const projectRoot = path.resolve(__dirname, '..', '..');

const sourceEnvironment = sourceBuildEnvironment({
    Path: '/fixture/bin',
    NPM_CONFIG_BUILD_FROM_SOURCE: 'false',
    npm_config_build_from_source: 'untrusted-value'
});
assert.equal(sourceEnvironment.Path, '/fixture/bin');
assert.equal(sourceEnvironment.NPM_CONFIG_BUILD_FROM_SOURCE, undefined);
assert.equal(sourceEnvironment.npm_config_build_from_source, 'better-sqlite3');

const rebuildCalls = [];
const rebuildStatus = rebuildBetterSqlite3(
    {
        projectRoot: '/fixture/project',
        arch: 'aarch64',
        electronVersion: '22.3.27'
    },
    {
        electronRebuildCli: '/fixture/electron-rebuild-cli.js',
        execPath: '/fixture/node',
        env: { npm_config_build_from_source: 'false', KEEP_ME: 'yes' },
        acquireRebuildLock: () => () => {},
        validateRebuildOutput() {},
        verifyBetterSqliteRuntime() {},
        spawnSync(command, args, options) {
            rebuildCalls.push({ command, args, options });
            return { status: 0 };
        },
        write() {}
    }
);
assert.deepEqual(rebuildStatus, {
    projectRoot: path.resolve('/fixture/project'),
    arch: 'arm64',
    electronVersion: '22.3.27'
});
assert.equal(rebuildCalls.length, 1);
assert.equal(rebuildCalls[0].command, '/fixture/node');
assert.deepEqual(rebuildCalls[0].args, [
    '/fixture/electron-rebuild-cli.js',
    '--version',
    '22.3.27',
    '--arch',
    'arm64',
    '--module-dir',
    path.resolve('/fixture/project'),
    '--force',
    '--only',
    'better-sqlite3',
    '--sequential'
]);
assert.equal(rebuildCalls[0].options.env.npm_config_build_from_source, 'better-sqlite3');
assert.equal(rebuildCalls[0].options.env.KEEP_ME, 'yes');
assert.equal(rebuildCalls[0].options.windowsHide, true);

assert.throws(
    () =>
        rebuildBetterSqlite3(
            {
                projectRoot: '/fixture/project',
                arch: 'arm64',
                electronVersion: '22.3.27'
            },
            {
                electronRebuildCli: '/fixture/electron-rebuild-cli.js',
                acquireRebuildLock: () => () => {},
                spawnSync: () => ({ status: null, signal: 'SIGSEGV' }),
                write() {}
            }
        ),
    /signal SIGSEGV/
);

const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-sqlite-rollback-'));
const rollbackRelease = path.join(rollbackRoot, 'node_modules', 'better-sqlite3', 'build', 'Release');
const rollbackBinding = path.join(rollbackRelease, 'better_sqlite3.node');
const rollbackMetadata = path.join(rollbackRelease, '.forge-meta');
fs.mkdirSync(rollbackRelease, { recursive: true });
fs.writeFileSync(rollbackBinding, 'known-good-binding');
fs.writeFileSync(rollbackMetadata, 'arm64--148');
try {
    assert.throws(
        () =>
            rebuildBetterSqlite3(
                {
                    projectRoot: rollbackRoot,
                    arch: 'arm64',
                    electronVersion: '22.3.27',
                    electronRebuildCli: '/fixture/electron-rebuild-cli.js',
                    verify: false
                },
                {
                    spawnSync() {
                        fs.rmSync(rollbackRelease, { recursive: true, force: true });
                        return { status: 1 };
                    },
                    write() {}
                }
            ),
        /exit code 1/
    );
    assert.equal(fs.readFileSync(rollbackBinding, 'utf8'), 'known-good-binding');
    assert.equal(fs.readFileSync(rollbackMetadata, 'utf8'), 'arm64--148');
    assert.equal(fs.existsSync(lockFilePath(rollbackRoot)), false, 'failed rebuild must release its lock');
} finally {
    fs.rmSync(rollbackRoot, { recursive: true, force: true });
}

const overriddenEnvironment = environmentWithOverrides(
    { electron_run_as_node: '0', KEEP_ME: 'yes' },
    { ELECTRON_RUN_AS_NODE: '1' }
);
assert.equal(overriddenEnvironment.electron_run_as_node, undefined);
assert.equal(overriddenEnvironment.ELECTRON_RUN_AS_NODE, '1');
assert.equal(overriddenEnvironment.KEEP_ME, 'yes');

let simulatedLockExists = true;
let simulatedNow = 1_000;
let simulatedSleeps = 0;
waitForRebuild('/fixture/project', {
    fs: {
        existsSync: () => simulatedLockExists,
        statSync: () => ({ mtimeMs: 0 }),
        readFileSync: () => JSON.stringify({ pid: 42, startedAt: 0, token: 'fixture-lock' }),
        unlinkSync: () => {
            simulatedLockExists = false;
        }
    },
    now: () => simulatedNow,
    processIsRunning: () => true,
    sleep(milliseconds) {
        simulatedSleeps += 1;
        simulatedNow += milliseconds;
        simulatedLockExists = false;
    }
});
assert.equal(simulatedSleeps, 1, 'a smoke must wait while a source rebuild owns the lock');

const smokeCalls = [];
const smokeOutput = [];
const smokeStatus = verifyBetterSqliteRuntime(
    {
        projectRoot: '/fixture/project',
        executable: '/fixture/electron',
        moduleRoot: '/fixture/node_modules/better-sqlite3',
        arch: 'arm64'
    },
    {
        env: { ELECTRON_RUN_AS_NODE: '0', KEEP_ME: 'yes' },
        spawnSync(command, args, options) {
            smokeCalls.push({ command, args, options });
            return { status: 0, stdout: 'fixture smoke passed\n', stderr: '' };
        },
        write: message => smokeOutput.push(message)
    }
);
assert.equal(smokeStatus.arch, 'arm64');
assert.equal(smokeCalls.length, 1);
assert.equal(smokeCalls[0].command, '/fixture/electron');
assert.match(smokeCalls[0].args[0], /smoke-better-sqlite3-runtime\.js$/);
assert.equal(smokeCalls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
assert.equal(smokeCalls[0].options.env.NETNEXUS_BETTER_SQLITE3_EXPECTED_ARCH, 'arm64');
assert.equal(smokeCalls[0].options.env.NETNEXUS_BETTER_SQLITE3_ROOT, '/fixture/node_modules/better-sqlite3');
assert.equal(smokeCalls[0].options.env.KEEP_ME, 'yes');
assert.match(smokeOutput.join(''), /fixture smoke passed/);

const actualStatus = verifyBetterSqliteRuntime({ projectRoot });
const rebuiltMetadata = fs
    .readFileSync(path.join(projectRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', '.forge-meta'), 'utf8')
    .trim();
const rebuiltAbi = rebuiltMetadata.split('--').at(-1);
assert.match(actualStatus.output, new RegExp(`abi=${rebuiltAbi}(?:,|\\))`));
assert.match(actualStatus.output, /load\/create\/close=ok/);

console.log('better-sqlite3 source rebuild and Electron runtime smoke tests passed');
