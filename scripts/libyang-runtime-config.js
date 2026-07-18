const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, 'resources', 'libyang');
const RELEASE_MANIFEST_PATH = path.join(RUNTIME_ROOT, 'manifest.json');
const ARCH_BY_ELECTRON_BUILDER_VALUE = Object.freeze({
    0: 'ia32',
    1: 'x64',
    2: 'armv7l',
    3: 'arm64',
    4: 'universal'
});

function normalizePlatform(value = process.platform) {
    const platform = String(value || '').toLowerCase();
    if (platform === 'mac' || platform === 'macos' || platform === 'osx') return 'darwin';
    if (platform === 'win' || platform === 'windows') return 'win32';
    return platform;
}

function normalizeArch(value = process.arch) {
    if (typeof value === 'number') return ARCH_BY_ELECTRON_BUILDER_VALUE[value] || String(value);
    const arch = String(value || '').toLowerCase();
    if (arch === 'amd64') return 'x64';
    if (arch === 'aarch64') return 'arm64';
    return arch;
}

function getReleaseManifest(projectRoot = PROJECT_ROOT) {
    const manifestPath = path.join(projectRoot, 'resources', 'libyang', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!/^\d+\.\d+\.\d+$/.test(manifest.libyangVersion || '')) {
        throw new Error(`Invalid libyang release manifest: ${manifestPath}`);
    }
    return manifest;
}

function getRuntimeDirectory(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const platform = normalizePlatform(options.platform);
    const arch = normalizeArch(options.arch);
    return path.join(projectRoot, 'resources', 'libyang', `${platform}-${arch}`);
}

function getRuntimeExecutable(options = {}) {
    const platform = normalizePlatform(options.platform);
    const executableName = platform === 'win32' ? 'yanglint.exe' : 'yanglint';
    return path.join(options.runtimeDirectory || getRuntimeDirectory(options), 'bin', executableName);
}

function getRuntimeSchemaExecutable(options = {}) {
    const platform = normalizePlatform(options.platform);
    const executableName = platform === 'win32' ? 'netnexus-libyang-schema.exe' : 'netnexus-libyang-schema';
    return path.join(options.runtimeDirectory || getRuntimeDirectory(options), 'bin', executableName);
}

function parseYanglintVersion(output) {
    const match = String(output || '').match(/(?:^|\n)\s*yanglint\s+(?:version\s+)?v?(\d+\.\d+\.\d+)\b/i);
    return match ? match[1] : null;
}

function parseSchemaHelperVersion(output) {
    const match = String(output || '').match(
        /(?:^|\n)\s*netnexus-libyang-schema\s+(\d+)\s+\(libyang\s+v?(\d+\.\d+\.\d+)\)\s*(?:\n|$)/i
    );
    return match ? { contractVersion: Number(match[1]), libyangVersion: match[2] } : null;
}

function assertExecutable(executable, platform, label) {
    let stats;
    try {
        stats = fs.lstatSync(executable);
    } catch (_error) {
        throw new Error(`Bundled libyang ${label} is missing: ${executable}`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Bundled ${label} must be a regular non-symlink file: ${executable}`);
    }
    if (platform !== 'win32' && (stats.mode & 0o111) === 0) {
        throw new Error(`Bundled ${label} is not executable: ${executable}`);
    }
}

function executeVersionProbe(executable, args, options) {
    return (options.spawnSync || childProcess.spawnSync)(executable, args, {
        cwd: path.dirname(executable),
        encoding: 'utf8',
        timeout: Number(options.timeoutMs) || 10_000,
        windowsHide: true,
        env: { ...process.env, ...(options.env || {}) }
    });
}

function verifyRuntime(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const platform = normalizePlatform(options.platform);
    const arch = normalizeArch(options.arch);
    const runtimeDirectory = options.runtimeDirectory || getRuntimeDirectory({ projectRoot, platform, arch });
    const executable = options.executable || getRuntimeExecutable({ runtimeDirectory, platform });
    const schemaExecutable = options.schemaExecutable || getRuntimeSchemaExecutable({ runtimeDirectory, platform });
    const expectedVersion = options.expectedVersion || getReleaseManifest(projectRoot).libyangVersion;
    try {
        assertExecutable(executable, platform, 'yanglint');
        assertExecutable(schemaExecutable, platform, 'Schema helper');
    } catch (error) {
        if (/ is missing:/.test(error.message)) {
            throw new Error(
                `Bundled libyang runtime is missing for ${platform}-${arch}: ${error.message}. ` +
                    `Run the platform libyang build script before packaging.`
            );
        }
        throw error;
    }
    const execution = executeVersionProbe(executable, ['--version'], options);
    if (execution.error || execution.status !== 0) {
        const detail = execution.error?.message || execution.stderr || `exit code ${execution.status}`;
        throw new Error(`Bundled yanglint cannot execute: ${String(detail).trim()}`);
    }
    const output = `${execution.stdout || ''}\n${execution.stderr || ''}`;
    const version = parseYanglintVersion(output);
    if (!version) throw new Error(`Unable to read bundled yanglint version from: ${output.trim()}`);
    if (version !== expectedVersion) {
        throw new Error(`Bundled yanglint version ${version} does not match required libyang ${expectedVersion}`);
    }

    const schemaExecution = executeVersionProbe(schemaExecutable, ['--version'], options);
    if (schemaExecution.error || schemaExecution.status !== 0) {
        const detail =
            schemaExecution.error?.message || schemaExecution.stderr || `exit code ${schemaExecution.status}`;
        throw new Error(`Bundled libyang Schema helper cannot execute: ${String(detail).trim()}`);
    }
    const schemaVersion = parseSchemaHelperVersion(`${schemaExecution.stdout || ''}\n${schemaExecution.stderr || ''}`);
    if (!schemaVersion) {
        throw new Error(
            `Unable to read bundled libyang Schema helper version from: ${String(schemaExecution.stdout || '').trim()}`
        );
    }
    if (schemaVersion.contractVersion !== 1) {
        throw new Error(
            `Bundled libyang Schema helper contract ${schemaVersion.contractVersion} does not match required contract 1`
        );
    }
    if (schemaVersion.libyangVersion !== expectedVersion) {
        throw new Error(
            `Bundled libyang Schema helper uses libyang ${schemaVersion.libyangVersion}, expected ${expectedVersion}`
        );
    }
    return {
        available: true,
        required: true,
        engine: 'libyang',
        executable: 'yanglint',
        version,
        path: executable,
        schemaExecutable: 'netnexus-libyang-schema',
        schemaPath: schemaExecutable,
        schemaContractVersion: schemaVersion.contractVersion,
        source: 'bundled',
        platform,
        arch,
        runtimeDirectory
    };
}

module.exports = {
    PROJECT_ROOT,
    RUNTIME_ROOT,
    RELEASE_MANIFEST_PATH,
    normalizePlatform,
    normalizeArch,
    getReleaseManifest,
    getRuntimeDirectory,
    getRuntimeExecutable,
    getRuntimeSchemaExecutable,
    parseYanglintVersion,
    parseSchemaHelperVersion,
    verifyRuntime
};
