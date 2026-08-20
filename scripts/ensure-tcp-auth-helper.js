const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT, normalizeArch, normalizePlatform } = require('./libyang-runtime-config');
const { verifyTcpAuthHelper } = require('./verify-packaging-runtime');

const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);

function resolveHelperPaths(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const platform = normalizePlatform(options.platform);
    const arch = normalizeArch(options.arch);
    return {
        projectRoot,
        platform,
        arch,
        buildScript: path.join(projectRoot, 'scripts', 'build-tcp-auth-helper.sh'),
        sourceFile: path.join(projectRoot, 'scripts', 'tcp-auth-helper.c'),
        helperPath: path.join(projectRoot, 'resources', 'tcp-auth', `${platform}-${arch}`, 'tcp-auth-helper')
    };
}

function requiredFileStats(filePath, description, fsApi = fs) {
    let stats;
    try {
        stats = fsApi.lstatSync(filePath);
    } catch (error) {
        throw new Error(`TCP authentication helper ${description} is missing: ${filePath}`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`TCP authentication helper ${description} must be a regular non-symlink file: ${filePath}`);
    }
    return stats;
}

function getBuildReason(paths, fsApi = fs) {
    const inputStats = [
        [paths.sourceFile, 'source'],
        [paths.buildScript, 'build script']
    ].map(([filePath, description]) => [filePath, requiredFileStats(filePath, description, fsApi)]);

    let helperStats;
    try {
        helperStats = fsApi.lstatSync(paths.helperPath);
    } catch (_error) {
        return 'the native executable is missing';
    }
    if (!helperStats.isFile() || helperStats.isSymbolicLink()) {
        return 'the native executable is not a regular file';
    }

    const newerInput = inputStats.find(([, stats]) => stats.mtimeMs > helperStats.mtimeMs);
    return newerInput ? `${path.basename(newerInput[0])} is newer than the native executable` : '';
}

function ensureTcpAuthHelper(options = {}, dependencies = {}) {
    const paths = resolveHelperPaths(options);
    if (paths.platform !== 'linux') return null;
    if (!SUPPORTED_ARCHITECTURES.has(paths.arch)) {
        throw new Error(`TCP authentication helper supports native Linux x64 and arm64; received linux-${paths.arch}`);
    }

    const fsApi = dependencies.fs || fs;
    const verifier = dependencies.verifyTcpAuthHelper || verifyTcpAuthHelper;
    const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
    const write = dependencies.write || (message => process.stdout.write(message));
    const verifyOptions = {
        projectRoot: paths.projectRoot,
        platform: paths.platform,
        arch: paths.arch
    };

    let buildReason = options.force === true ? 'a rebuild was explicitly requested' : getBuildReason(paths, fsApi);
    if (!buildReason) {
        try {
            const status = verifier(verifyOptions, { fs: fsApi });
            write(`TCP authentication helper for linux-${paths.arch} is current; skipping rebuild.\n`);
            return status;
        } catch (error) {
            buildReason = `validation failed: ${error.message}`;
        }
    }

    write(`TCP authentication helper for linux-${paths.arch} requires a build: ${buildReason}.\n`);
    const result = spawnSync('bash', [paths.buildScript], {
        cwd: paths.projectRoot,
        env: options.env || process.env,
        stdio: 'inherit',
        windowsHide: true
    });
    if (result.error) {
        throw new Error(`Unable to start the TCP authentication helper build: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const signal = result.signal ? ` (signal ${result.signal})` : '';
        throw new Error(`TCP authentication helper build failed with exit code ${result.status}${signal}`);
    }

    const status = verifier(verifyOptions, { fs: fsApi });
    write(`TCP authentication helper for linux-${paths.arch} is ready.\n`);
    return status;
}

if (require.main === module) {
    try {
        ensureTcpAuthHelper({ force: process.argv.slice(2).includes('--force') });
    } catch (error) {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    SUPPORTED_ARCHITECTURES,
    ensureTcpAuthHelper,
    getBuildReason,
    requiredFileStats,
    resolveHelperPaths
};
