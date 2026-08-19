const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { acquireRebuildLock } = require('./better-sqlite3-rebuild-lock');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_BUILD_PACKAGE = 'better-sqlite3';

function normalizeArchitecture(value = process.arch) {
    const architecture = String(value || '').toLowerCase();
    if (architecture === 'amd64' || architecture === 'x86_64') return 'x64';
    if (architecture === 'aarch64') return 'arm64';
    return architecture;
}

function sourceBuildEnvironment(environment = process.env) {
    const output = {};
    for (const [key, value] of Object.entries(environment)) {
        if (key.toLowerCase() !== 'npm_config_build_from_source') {
            output[key] = value;
        }
    }
    output.npm_config_build_from_source = SOURCE_BUILD_PACKAGE;
    return output;
}

function readElectronVersion(projectRoot, fsApi = fs) {
    const packagePath = path.join(projectRoot, 'node_modules', 'electron', 'package.json');
    return JSON.parse(fsApi.readFileSync(packagePath, 'utf8')).version;
}

function resolveElectronRebuildCli(projectRoot) {
    return require.resolve('electron-rebuild/lib/src/cli.js', { paths: [projectRoot] });
}

function runtimeFilePaths(projectRoot) {
    const releaseDirectory = path.join(projectRoot, 'node_modules', 'better-sqlite3', 'build', 'Release');
    return [path.join(releaseDirectory, 'better_sqlite3.node'), path.join(releaseDirectory, '.forge-meta')];
}

function snapshotRuntimeFiles(projectRoot, fsApi = fs) {
    return runtimeFilePaths(projectRoot).map(filePath => {
        try {
            const stats = fsApi.statSync(filePath);
            return { filePath, contents: fsApi.readFileSync(filePath), mode: stats.mode };
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            return { filePath, contents: null, mode: null };
        }
    });
}

function restoreRuntimeFiles(snapshot, fsApi = fs) {
    for (const entry of snapshot) {
        if (entry.contents === null) {
            fsApi.rmSync(entry.filePath, { force: true });
            continue;
        }
        fsApi.mkdirSync(path.dirname(entry.filePath), { recursive: true });
        fsApi.writeFileSync(entry.filePath, entry.contents, { mode: entry.mode });
        fsApi.chmodSync(entry.filePath, entry.mode);
    }
}

function validateRebuildOutput(projectRoot, fsApi = fs) {
    const bindingPath = runtimeFilePaths(projectRoot)[0];
    let stats;
    try {
        stats = fsApi.statSync(bindingPath);
    } catch (error) {
        throw new Error(`better-sqlite3 source rebuild did not produce ${bindingPath}: ${error.message}`);
    }
    if (!stats.isFile() || stats.size === 0) {
        throw new Error(`better-sqlite3 source rebuild produced an invalid binding: ${bindingPath}`);
    }
    return bindingPath;
}

function rebuildBetterSqlite3(options = {}, dependencies = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const arch = normalizeArchitecture(options.arch || process.arch);
    const electronVersion = options.electronVersion || readElectronVersion(projectRoot, dependencies.fs || fs);
    const electronRebuildCli =
        dependencies.electronRebuildCli || options.electronRebuildCli || resolveElectronRebuildCli(projectRoot);
    const executable = dependencies.execPath || process.execPath;
    const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
    const write = dependencies.write || (message => process.stdout.write(message));
    const fsApi = dependencies.fs || fs;
    const args = [
        electronRebuildCli,
        '--version',
        electronVersion,
        '--arch',
        arch,
        '--module-dir',
        projectRoot,
        '--force',
        '--only',
        SOURCE_BUILD_PACKAGE,
        '--sequential'
    ];

    const acquireLock = dependencies.acquireRebuildLock || acquireRebuildLock;
    const releaseLock = acquireLock(projectRoot, dependencies.lockDependencies || {});
    const snapshot = snapshotRuntimeFiles(projectRoot, fsApi);
    try {
        write(`Rebuilding ${SOURCE_BUILD_PACKAGE} from source for Electron ${electronVersion} (${arch})...\n`);
        const result = spawnSync(executable, args, {
            cwd: projectRoot,
            env: sourceBuildEnvironment(dependencies.env || process.env),
            stdio: 'inherit',
            windowsHide: true
        });
        if (result.error) {
            throw new Error(`Unable to start electron-rebuild for ${SOURCE_BUILD_PACKAGE}: ${result.error.message}`);
        }
        if (result.status !== 0) {
            const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
            throw new Error(`${SOURCE_BUILD_PACKAGE} source rebuild failed with ${detail}`);
        }

        const validate = dependencies.validateRebuildOutput || validateRebuildOutput;
        validate(projectRoot, fsApi);
        if (options.verify !== false) {
            const verifier =
                dependencies.verifyBetterSqliteRuntime ||
                require('./smoke-better-sqlite3-runtime').verifyBetterSqliteRuntime;
            verifier({ projectRoot, arch, skipRebuildWait: true }, dependencies.smokeDependencies || {});
        }
    } catch (error) {
        try {
            restoreRuntimeFiles(snapshot, fsApi);
        } catch (restoreError) {
            throw new Error(
                `${error.message}; additionally failed to restore the previous better-sqlite3 runtime: ${restoreError.message}`
            );
        }
        throw error;
    } finally {
        releaseLock();
    }

    return { projectRoot, arch, electronVersion };
}

if (require.main === module) {
    try {
        rebuildBetterSqlite3();
    } catch (error) {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    PROJECT_ROOT,
    SOURCE_BUILD_PACKAGE,
    normalizeArchitecture,
    restoreRuntimeFiles,
    rebuildBetterSqlite3,
    resolveElectronRebuildCli,
    runtimeFilePaths,
    snapshotRuntimeFiles,
    sourceBuildEnvironment,
    validateRebuildOutput
};
