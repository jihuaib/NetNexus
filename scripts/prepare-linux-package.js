const { spawnSync } = require('child_process');

const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);

function optionValue(name, args = process.argv.slice(2)) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
    }
    return value;
}

function normalizeArchitecture(value = process.arch) {
    const architecture = String(value || '').toLowerCase();
    if (architecture === 'amd64' || architecture === 'x86_64') return 'x64';
    if (architecture === 'aarch64') return 'arm64';
    return architecture;
}

function assertNativeLinuxBuild(options = {}) {
    const platform = options.platform || process.platform;
    const hostArch = normalizeArchitecture(options.hostArch || process.arch);
    const targetArch = normalizeArchitecture(options.targetArch || hostArch);

    if (platform !== 'linux') {
        throw new Error(`Linux packages must be built on Linux; current platform is ${platform}`);
    }
    if (!SUPPORTED_ARCHITECTURES.has(targetArch)) {
        throw new Error(`Linux packages support x64 and arm64; received ${targetArch || 'unknown'}`);
    }
    if (hostArch !== targetArch) {
        throw new Error(
            `Linux cross-architecture packaging is not supported: host ${hostArch}, target ${targetArch}. ` +
                `Build x64 and arm64 packages on matching native runners.`
        );
    }
    return { platform, hostArch, targetArch };
}

function runNpmScript(scriptName, scriptArgs = [], dependencies = {}) {
    const spawn = dependencies.spawnSync || spawnSync;
    const result = spawn('npm', ['run', scriptName, ...scriptArgs], {
        cwd: dependencies.cwd || process.cwd(),
        env: dependencies.env || process.env,
        stdio: 'inherit'
    });
    if (result.error) {
        throw new Error(`Unable to run npm script ${scriptName}: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const signal = result.signal ? ` (signal ${result.signal})` : '';
        throw new Error(`npm run ${scriptName} failed with exit code ${result.status}${signal}`);
    }
}

function prepareLinuxPackage(options = {}, dependencies = {}) {
    const target = assertNativeLinuxBuild(options);
    const write = dependencies.write || (message => process.stdout.write(message));

    if (options.checkOnly) {
        write(`Linux packaging host is ready for native ${target.targetArch} configuration.\n`);
        return target;
    }

    runNpmScript('better-sqlite3:rebuild', [], dependencies);
    runNpmScript('better-sqlite3:smoke', [], dependencies);
    runNpmScript('build', [], dependencies);
    runNpmScript('tcp-auth:build', [], dependencies);
    runNpmScript('libyang:ensure', ['--', '--platform', target.platform, '--arch', target.targetArch], dependencies);
    return target;
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        prepareLinuxPackage({
            targetArch: optionValue('--arch', args),
            checkOnly: args.includes('--check')
        });
    } catch (error) {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    SUPPORTED_ARCHITECTURES,
    assertNativeLinuxBuild,
    normalizeArchitecture,
    optionValue,
    prepareLinuxPackage,
    runNpmScript
};
