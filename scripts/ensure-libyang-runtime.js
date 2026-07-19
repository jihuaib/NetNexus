const childProcess = require('child_process');
const path = require('path');
const { PROJECT_ROOT, normalizeArch, normalizePlatform, verifyRuntime } = require('./libyang-runtime-config');

function isTruthyEnv(value) {
    return ['1', 'true', 'yes', 'on'].includes(
        String(value || '')
            .trim()
            .toLowerCase()
    );
}

function optionValue(name, args = process.argv.slice(2)) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
    }
    return value;
}

function resolveBuildCommand(options = {}) {
    const projectRoot = options.projectRoot || PROJECT_ROOT;
    const platform = normalizePlatform(options.platform);
    const arch = normalizeArch(options.arch);

    if (platform === 'win32') {
        if (arch !== 'x64') {
            throw new Error(`Bundled libyang builds on Windows support x64 only; received win32-${arch}`);
        }
        return {
            command: 'powershell.exe',
            args: [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                path.join(projectRoot, 'scripts', 'build-libyang-runtime.ps1')
            ]
        };
    }

    if (platform === 'darwin' || platform === 'linux') {
        return {
            command: 'bash',
            args: [
                path.join(projectRoot, 'scripts', 'build-libyang-runtime.sh'),
                '--platform',
                platform,
                '--arch',
                arch
            ]
        };
    }

    throw new Error(`Bundled libyang builds are not supported on platform ${platform || 'unknown'}`);
}

function ensureLibyangRuntime(options = {}, dependencies = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const platform = normalizePlatform(options.platform);
    const arch = normalizeArch(options.arch);
    const env = options.env || process.env;
    const runtimeVerifier = dependencies.verifyRuntime || verifyRuntime;
    const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
    const write = dependencies.write || (message => process.stdout.write(message));
    const verifyOptions = { projectRoot, platform, arch };

    if (isTruthyEnv(env.NETNEXUS_SKIP_LIBYANG_BUILD)) {
        write(`Skipping bundled libyang setup for ${platform}-${arch} (NETNEXUS_SKIP_LIBYANG_BUILD).\n`);
        return null;
    }

    const force = options.force === true || isTruthyEnv(env.NETNEXUS_FORCE_LIBYANG_BUILD);
    if (!force) {
        try {
            const status = runtimeVerifier(verifyOptions);
            write(`Bundled libyang ${status.version} for ${platform}-${arch} is current; skipping rebuild.\n`);
            return status;
        } catch (error) {
            write(`Bundled libyang for ${platform}-${arch} requires a build: ${error.message}\n`);
        }
    } else {
        write(`Rebuilding bundled libyang for ${platform}-${arch}.\n`);
    }

    const invocation = resolveBuildCommand({ projectRoot, platform, arch });
    const result = spawnSync(invocation.command, invocation.args, {
        cwd: projectRoot,
        env,
        stdio: 'inherit',
        windowsHide: true
    });
    if (result.error) {
        throw new Error(`Unable to start the bundled libyang build: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const signal = result.signal ? ` (signal ${result.signal})` : '';
        throw new Error(`Bundled libyang build failed with exit code ${result.status}${signal}`);
    }

    const status = runtimeVerifier(verifyOptions);
    write(`Bundled libyang ${status.version} for ${platform}-${arch} is ready.\n`);
    return status;
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        ensureLibyangRuntime({
            force: args.includes('--force'),
            platform: optionValue('--platform', args),
            arch: optionValue('--arch', args)
        });
    } catch (error) {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    ensureLibyangRuntime,
    isTruthyEnv,
    optionValue,
    resolveBuildCommand
};
