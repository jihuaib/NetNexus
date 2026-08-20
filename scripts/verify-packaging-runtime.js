const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const verifyLibyangBeforePack = require('./verify-libyang-runtime');
const { PROJECT_ROOT, normalizeArch, normalizePlatform } = require('./libyang-runtime-config');

const ELF_MACHINE_BY_ARCH = Object.freeze({
    x64: 62,
    arm64: 183
});

function optionValue(name, args = process.argv.slice(2)) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
    }
    return value;
}

function readElfHeader(filePath, fsApi = fs) {
    const header = Buffer.alloc(64);
    const descriptor = fsApi.openSync(filePath, 'r');
    let bytesRead;
    try {
        bytesRead = fsApi.readSync(descriptor, header, 0, header.length, 0);
    } finally {
        fsApi.closeSync(descriptor);
    }
    if (bytesRead < 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        return null;
    }
    const elfClass = header[4];
    const dataEncoding = header[5];
    if (dataEncoding !== 1) {
        throw new Error(`TCP authentication helper ELF must use little-endian encoding: ${filePath}`);
    }
    return {
        elfClass,
        machine: header.readUInt16LE(18)
    };
}

function verifyTcpAuthHelper(options = {}, dependencies = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const platform = normalizePlatform(options.platform);
    const arch = normalizeArch(options.arch);
    if (platform !== 'linux') {
        return null;
    }

    const expectedMachine = ELF_MACHINE_BY_ARCH[arch];
    if (!expectedMachine) {
        throw new Error(
            `Bundled TCP authentication helper validation supports linux-x64 and linux-arm64; received linux-${arch}`
        );
    }

    const runtimeDirectory = path.join(projectRoot, 'resources', 'tcp-auth', `${platform}-${arch}`);
    const fsApi = dependencies.fs || fs;
    let rootStats;
    try {
        rootStats = fsApi.lstatSync(runtimeDirectory);
    } catch (error) {
        throw new Error(
            `Bundled TCP authentication helper is missing for ${platform}-${arch}: ${runtimeDirectory}. ` +
                `Build the target-specific helper before packaging.`
        );
    }
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error(`Bundled TCP authentication helper path must be a regular directory: ${runtimeDirectory}`);
    }

    const helperPath = path.join(runtimeDirectory, 'tcp-auth-helper');
    let helperStats;
    try {
        helperStats = fsApi.lstatSync(helperPath);
    } catch (_error) {
        throw new Error(`Bundled TCP authentication helper executable is missing: ${helperPath}`);
    }
    if (!helperStats.isFile() || helperStats.isSymbolicLink()) {
        throw new Error(`Bundled TCP authentication helper must be a regular non-symlink file: ${helperPath}`);
    }
    if ((helperStats.mode & 0o111) === 0) {
        throw new Error(`Bundled TCP authentication helper is not executable: ${helperPath}`);
    }
    if ((helperStats.mode & 0o022) !== 0) {
        throw new Error(
            `Bundled TCP authentication helper must not be group-writable or world-writable: ${helperPath}`
        );
    }

    const helper = readElfHeader(helperPath, fsApi);
    if (!helper) {
        throw new Error(`Bundled TCP authentication helper is not an ELF executable: ${helperPath}`);
    }
    if (helper.elfClass !== 2 || helper.machine !== expectedMachine) {
        throw new Error(
            `Bundled TCP authentication helper has the wrong ELF architecture for ${platform}-${arch}: ` +
                `${helperPath} (class ${helper.elfClass}, machine ${helper.machine})`
        );
    }

    const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
    const probe = spawnSync(helperPath, ['--version'], {
        cwd: runtimeDirectory,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        env: dependencies.env || process.env
    });
    if (probe.error || probe.status !== 0) {
        const detail = probe.error?.message || probe.stderr || `exit code ${probe.status}`;
        throw new Error(`Bundled TCP authentication helper version probe failed: ${String(detail).trim()}`);
    }
    const versionOutput = `${probe.stdout || ''}\n${probe.stderr || ''}`.trim();
    if (!versionOutput) {
        throw new Error(`Bundled TCP authentication helper --version returned no output: ${helperPath}`);
    }

    return {
        platform,
        arch,
        runtimeDirectory,
        helpers: [helperPath],
        versionOutput
    };
}

async function beforePack(context = {}, dependencies = {}) {
    const libyangVerifier = dependencies.verifyLibyangBeforePack || verifyLibyangBeforePack;
    await libyangVerifier(context, dependencies.libyangDependencies || {});

    const platform = verifyLibyangBeforePack.platformFromContext(context);
    if (platform !== 'linux') return;

    const arch = verifyLibyangBeforePack.archFromContext(context);
    const projectRoot = context.packager?.projectDir || PROJECT_ROOT;
    const tcpAuthVerifier = dependencies.verifyTcpAuthHelper || verifyTcpAuthHelper;
    const status = tcpAuthVerifier({ projectRoot, platform, arch }, dependencies);
    const write = dependencies.write || (message => process.stdout.write(message));
    write(
        `Verified bundled TCP authentication helper for ${status.platform}-${status.arch}: ` +
            `${status.helpers.map(file => path.relative(projectRoot, file)).join(', ')}\n`
    );
}

if (require.main === module) {
    beforePack({
        electronPlatformName: optionValue('--platform') || process.platform,
        arch: optionValue('--arch') || process.arch,
        packager: { projectDir: PROJECT_ROOT }
    }).catch(error => {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    });
}

module.exports = beforePack;
module.exports.ELF_MACHINE_BY_ARCH = ELF_MACHINE_BY_ARCH;
module.exports.readElfHeader = readElfHeader;
module.exports.verifyTcpAuthHelper = verifyTcpAuthHelper;
