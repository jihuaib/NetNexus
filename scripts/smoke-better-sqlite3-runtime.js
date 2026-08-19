const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { waitForRebuild } = require('./better-sqlite3-rebuild-lock');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CHILD_ARGUMENT = '--run-better-sqlite3-smoke';

function environmentWithOverrides(environment, overrides) {
    const overrideKeys = new Set(Object.keys(overrides).map(key => key.toLowerCase()));
    const output = {};
    for (const [key, value] of Object.entries(environment || {})) {
        if (!overrideKeys.has(key.toLowerCase())) output[key] = value;
    }
    return { ...output, ...overrides };
}

function sourceRuntimePaths(projectRoot) {
    return {
        executable: require(require.resolve('electron', { paths: [projectRoot] })),
        moduleRoot: path.join(projectRoot, 'node_modules', 'better-sqlite3')
    };
}

function packagedLinuxRuntimePaths(context) {
    const projectRoot = path.resolve(context.packager?.projectDir || PROJECT_ROOT);
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const executableName = packageJson.build?.executableName || packageJson.name;
    return {
        executable: path.join(context.appOutDir, executableName),
        moduleRoot: path.join(context.appOutDir, 'resources', 'app', 'node_modules', 'better-sqlite3')
    };
}

function runSmokeChild(environment = process.env) {
    assert.ok(process.versions.electron, 'better-sqlite3 smoke must run with Electron');
    const moduleRoot = environment.NETNEXUS_BETTER_SQLITE3_ROOT;
    assert.ok(moduleRoot, 'NETNEXUS_BETTER_SQLITE3_ROOT is required');
    assert.equal(process.arch, environment.NETNEXUS_BETTER_SQLITE3_EXPECTED_ARCH, 'Electron architecture mismatch');

    const nativeBindingPath = path.join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
    assert.ok(
        fs.statSync(nativeBindingPath).isFile(),
        `better-sqlite3 native binding is missing: ${nativeBindingPath}`
    );
    const nativeBinding = require(nativeBindingPath);
    assert.equal(typeof nativeBinding.Database, 'function', 'better-sqlite3 native binding did not load');

    const Database = require(moduleRoot);
    let database;
    let sqliteVersion;
    try {
        database = new Database(':memory:');
        sqliteVersion = database.prepare('select sqlite_version() as version').get().version;
        database.close();
        database = null;
    } finally {
        if (database?.open) database.close();
    }

    process.stdout.write(
        `better-sqlite3 Electron smoke passed ` +
            `(electron=${process.versions.electron}, abi=${process.versions.modules}, arch=${process.arch}, ` +
            `sqlite=${sqliteVersion}, load/create/close=ok)\n`
    );
}

function verifyBetterSqliteRuntime(options = {}, dependencies = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    if (!options.skipRebuildWait) {
        const wait = dependencies.waitForRebuild || waitForRebuild;
        wait(projectRoot, dependencies.lockDependencies || {});
    }
    const paths = options.executable && options.moduleRoot ? options : sourceRuntimePaths(projectRoot);
    const expectedArch = options.arch || process.arch;
    const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
    const result = spawnSync(paths.executable, [__filename, CHILD_ARGUMENT], {
        cwd: projectRoot,
        env: environmentWithOverrides(dependencies.env || process.env, {
            ELECTRON_RUN_AS_NODE: '1',
            NETNEXUS_BETTER_SQLITE3_ROOT: paths.moduleRoot,
            NETNEXUS_BETTER_SQLITE3_EXPECTED_ARCH: expectedArch
        }),
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
    });

    const write = dependencies.write || (message => process.stdout.write(message));
    if (result.stdout) write(result.stdout);
    if (result.stderr) (dependencies.writeError || (message => process.stderr.write(message)))(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
        throw new Error(`better-sqlite3 Electron smoke failed with ${detail}`);
    }
    return {
        executable: paths.executable,
        moduleRoot: paths.moduleRoot,
        arch: expectedArch,
        output: result.stdout || ''
    };
}

function verifyPackagedBetterSqliteRuntime(context, dependencies = {}) {
    const paths = packagedLinuxRuntimePaths(context);
    return verifyBetterSqliteRuntime(
        {
            projectRoot: context.packager?.projectDir || PROJECT_ROOT,
            arch: context.archName || process.arch,
            ...paths
        },
        dependencies
    );
}

if (process.argv.includes(CHILD_ARGUMENT)) {
    try {
        runSmokeChild();
    } catch (error) {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    }
} else if (require.main === module) {
    try {
        verifyBetterSqliteRuntime();
    } catch (error) {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    CHILD_ARGUMENT,
    PROJECT_ROOT,
    environmentWithOverrides,
    packagedLinuxRuntimePaths,
    runSmokeChild,
    sourceRuntimePaths,
    verifyBetterSqliteRuntime,
    verifyPackagedBetterSqliteRuntime
};
