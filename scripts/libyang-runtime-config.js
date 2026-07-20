const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, 'resources', 'libyang');
const RELEASE_MANIFEST_PATH = path.join(RUNTIME_ROOT, 'manifest.json');
const IANA_MODULE_DIRECTORY_RELATIVE_PATH = path.join('resources', 'libyang', 'iana');
const IANA_MODULE_MANIFEST_RELATIVE_PATH = path.join(IANA_MODULE_DIRECTORY_RELATIVE_PATH, 'manifest.json');
const IANA_MODULE_REGISTRY_SOURCE = 'https://www.iana.org/assignments/yang-parameters/';
const PINNED_IANA_MODULE_FILES = Object.freeze([
    'ietf-interfaces@2018-02-20.yang',
    'ietf-ip@2018-02-22.yang',
    'ietf-netconf-acm@2018-02-14.yang',
    'ietf-network-instance@2019-01-21.yang',
    'ietf-restconf@2017-01-26.yang',
    'ietf-subscribed-notifications@2019-09-09.yang',
    'ietf-yang-patch@2017-02-22.yang',
    'ietf-yang-push@2019-09-09.yang'
]);
const REQUIRED_RUNTIME_IETF_MODULES = Object.freeze([
    'ietf-datastores',
    'ietf-inet-types',
    'ietf-yang-schema-mount',
    'ietf-yang-types'
]);
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

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getPinnedIanaModuleManifest(projectRoot = PROJECT_ROOT) {
    const manifestPath = path.join(projectRoot, IANA_MODULE_MANIFEST_RELATIVE_PATH);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`Pinned IANA YANG manifest is missing or invalid: ${manifestPath}: ${error.message}`);
    }
    if (
        manifest.schemaVersion !== 1 ||
        manifest.source !== IANA_MODULE_REGISTRY_SOURCE ||
        !/^\d{4}-\d{2}-\d{2}$/.test(manifest.retrievedAt || '') ||
        !Array.isArray(manifest.modules)
    ) {
        throw new Error(`Pinned IANA YANG manifest has an invalid contract: ${manifestPath}`);
    }
    const moduleFiles = manifest.modules.map(module => module?.file);
    if (JSON.stringify(moduleFiles) !== JSON.stringify(PINNED_IANA_MODULE_FILES)) {
        throw new Error(`Pinned IANA YANG manifest must list the exact supported module set: ${manifestPath}`);
    }
    for (const module of manifest.modules) {
        if (!/^[a-f0-9]{64}$/.test(module?.sha256 || '')) {
            throw new Error(`Pinned IANA YANG module ${module?.file || 'unknown'} has an invalid SHA-256`);
        }
    }
    return manifest;
}

function assertRegularNonSymlinkFile(filePath, label) {
    let stats;
    try {
        stats = fs.lstatSync(filePath);
    } catch (error) {
        throw new Error(`${label} is missing: ${filePath}: ${error.message}`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
    }
}

function assertSha256(filePath, expectedSha256, label) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) {
        throw new Error(`${label} metadata has an invalid SHA-256`);
    }
    const actualSha256 = sha256File(filePath);
    if (actualSha256 !== expectedSha256) {
        throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
    }
    return actualSha256;
}

function getRuntimeYangModuleDirectory(runtimeDirectory) {
    return path.join(path.resolve(runtimeDirectory), 'share', 'yang', 'modules', 'libyang');
}

function collectRequiredRuntimeIetfModules(runtimeDirectory) {
    const moduleDirectory = getRuntimeYangModuleDirectory(runtimeDirectory);
    let entries;
    try {
        entries = fs.readdirSync(moduleDirectory, { withFileTypes: true });
    } catch (error) {
        throw new Error(`Bundled libyang YANG module directory is missing: ${moduleDirectory}: ${error.message}`);
    }
    return REQUIRED_RUNTIME_IETF_MODULES.map(moduleName => {
        const candidates = entries
            .filter(entry => entry.name === `${moduleName}.yang` || entry.name.startsWith(`${moduleName}@`))
            .filter(entry => entry.name.endsWith('.yang'))
            .map(entry => entry.name)
            .sort();
        if (candidates.length !== 1) {
            throw new Error(
                `Bundled RFC 8639/RFC 8641 dependency ${moduleName} must resolve to exactly one YANG file in ` +
                    `${moduleDirectory}; found ${candidates.length}`
            );
        }
        const file = candidates[0];
        const filePath = path.join(moduleDirectory, file);
        assertRegularNonSymlinkFile(filePath, `Bundled RFC 8639/RFC 8641 dependency ${moduleName}`);
        return { file, sha256: sha256File(filePath) };
    });
}

function verifyPinnedIanaModules(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const sourceDirectory = path.join(projectRoot, IANA_MODULE_DIRECTORY_RELATIVE_PATH);
    const manifest = getPinnedIanaModuleManifest(projectRoot);
    const actualSourceFiles = fs
        .readdirSync(sourceDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.yang'))
        .map(entry => entry.name)
        .sort();
    if (JSON.stringify(actualSourceFiles) !== JSON.stringify([...PINNED_IANA_MODULE_FILES].sort())) {
        throw new Error(`Pinned IANA YANG source directory contains an unexpected module set: ${sourceDirectory}`);
    }

    const modules = manifest.modules.map(module => {
        const sourcePath = path.join(sourceDirectory, module.file);
        assertRegularNonSymlinkFile(sourcePath, `Pinned IANA YANG module ${module.file}`);
        const sourceSha256 = sha256File(sourcePath);
        if (sourceSha256 !== module.sha256) {
            throw new Error(
                `Pinned IANA YANG module ${module.file} SHA-256 mismatch: expected ${module.sha256}, ` +
                    `got ${sourceSha256}`
            );
        }

        if (options.runtimeDirectory) {
            const runtimePath = path.join(getRuntimeYangModuleDirectory(options.runtimeDirectory), module.file);
            assertRegularNonSymlinkFile(runtimePath, `Bundled IANA YANG module ${module.file}`);
            assertSha256(runtimePath, module.sha256, `Bundled IANA YANG module ${module.file}`);
        }
        return { file: module.file, sha256: module.sha256 };
    });
    return {
        source: manifest.source,
        retrievedAt: manifest.retrievedAt,
        modules
    };
}

function getBuildInputPaths(platform = process.platform) {
    const normalizedPlatform = normalizePlatform(platform);
    const common = [
        'resources/libyang/manifest.json',
        IANA_MODULE_MANIFEST_RELATIVE_PATH,
        ...PINNED_IANA_MODULE_FILES.map(file => path.join(IANA_MODULE_DIRECTORY_RELATIVE_PATH, file)),
        'scripts/libyang-runtime-config.js',
        'scripts/netnexus-libyang-schema.c',
        'scripts/verify-libyang-iana-modules.js',
        'scripts/write-libyang-runtime-manifest.js'
    ];
    if (normalizedPlatform === 'darwin' || normalizedPlatform === 'linux') {
        return [...common, 'scripts/build-libyang-runtime.sh', 'scripts/libyang-schema-exporter/CMakeLists.txt'];
    }
    if (normalizedPlatform === 'win32') {
        return [
            ...common,
            'resources/libyang/NOTICE.pthreads',
            'scripts/build-libyang-runtime.ps1',
            'scripts/libyang-vcpkg/vcpkg.json',
            'scripts/netnexus-libyang-windows.manifest.in'
        ];
    }
    throw new Error(`Bundled libyang builds are not supported on platform ${normalizedPlatform}`);
}

function computeBuildInputHash(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const platform = normalizePlatform(options.platform);
    const arch = normalizeArch(options.arch);
    const digest = crypto.createHash('sha256');
    digest.update(`netnexus-libyang-build-input-v3\0${platform}\0${arch}\0`);
    for (const relativePath of getBuildInputPaths(platform)) {
        const filePath = path.join(projectRoot, relativePath);
        digest.update(relativePath.replaceAll(path.sep, '/'));
        digest.update('\0');
        digest.update(fs.readFileSync(filePath));
        digest.update('\0');
    }
    return digest.digest('hex');
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

function readRuntimeManifest(runtimeDirectory) {
    const manifestPath = path.join(runtimeDirectory, 'runtime.json');
    let runtime;
    try {
        runtime = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`Bundled libyang runtime metadata is missing or invalid: ${manifestPath}: ${error.message}`);
    }
    return { manifestPath, runtime };
}

function verifyRuntimeBuildContract(options) {
    const { manifestPath, runtime } = readRuntimeManifest(options.runtimeDirectory);
    if (runtime.schemaVersion !== 3) {
        throw new Error(`Bundled libyang runtime metadata has an unsupported schema version: ${manifestPath}`);
    }
    if (runtime.version !== options.expectedVersion) {
        throw new Error(
            `Bundled libyang runtime metadata version ${runtime.version || 'unknown'} does not match required ` +
                `libyang ${options.expectedVersion}`
        );
    }
    if (normalizePlatform(runtime.platform) !== options.platform || normalizeArch(runtime.arch) !== options.arch) {
        throw new Error(
            `Bundled libyang runtime metadata targets ${runtime.platform || 'unknown'}-${runtime.arch || 'unknown'}, ` +
                `expected ${options.platform}-${options.arch}`
        );
    }
    const expectedBuildInputHash = computeBuildInputHash(options);
    if (runtime.buildInputHash !== expectedBuildInputHash) {
        throw new Error(
            `Bundled libyang runtime build inputs changed for ${options.platform}-${options.arch}; rebuild is required`
        );
    }
    const ianaModules = verifyPinnedIanaModules({
        projectRoot: options.projectRoot,
        runtimeDirectory: options.runtimeDirectory
    });
    if (JSON.stringify(runtime.ianaYangModules) !== JSON.stringify(ianaModules.modules)) {
        throw new Error(`Bundled libyang runtime metadata does not match the pinned IANA YANG module set`);
    }
    const requiredDependencies = collectRequiredRuntimeIetfModules(options.runtimeDirectory);
    if (JSON.stringify(runtime.requiredIetfYangModules) !== JSON.stringify(requiredDependencies)) {
        throw new Error(`Bundled libyang runtime metadata does not match the RFC 8639/RFC 8641 dependency closure`);
    }
    assertSha256(options.executable, runtime.sha256, 'Bundled yanglint');
    assertSha256(options.schemaExecutable, runtime.schemaSha256, 'Bundled libyang Schema helper');
    return runtime;
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
    verifyRuntimeBuildContract({
        projectRoot,
        platform,
        arch,
        runtimeDirectory,
        expectedVersion,
        executable,
        schemaExecutable
    });
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
    if (schemaVersion.contractVersion !== 2) {
        throw new Error(
            `Bundled libyang Schema helper contract ${schemaVersion.contractVersion} does not match required contract 2`
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
    IANA_MODULE_DIRECTORY_RELATIVE_PATH,
    IANA_MODULE_MANIFEST_RELATIVE_PATH,
    IANA_MODULE_REGISTRY_SOURCE,
    PINNED_IANA_MODULE_FILES,
    REQUIRED_RUNTIME_IETF_MODULES,
    normalizePlatform,
    normalizeArch,
    getReleaseManifest,
    getPinnedIanaModuleManifest,
    verifyPinnedIanaModules,
    collectRequiredRuntimeIetfModules,
    getBuildInputPaths,
    computeBuildInputHash,
    getRuntimeDirectory,
    getRuntimeExecutable,
    getRuntimeSchemaExecutable,
    parseYanglintVersion,
    parseSchemaHelperVersion,
    verifyRuntime
};
