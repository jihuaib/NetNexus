const { PROJECT_ROOT, normalizePlatform, normalizeArch, verifyRuntime } = require('./libyang-runtime-config');

function optionValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function platformFromContext(context = {}) {
    return normalizePlatform(context.electronPlatformName || context.packager?.platform?.nodeName || process.platform);
}

function archFromContext(context = {}) {
    return normalizeArch(context.arch === undefined ? process.arch : context.arch);
}

function targetArchitecturesFromContext(context = {}) {
    const platform = platformFromContext(context);
    const arch = archFromContext(context);
    return arch === 'universal' && platform === 'darwin' ? ['x64', 'arm64'] : [arch];
}

async function beforePack(context = {}, dependencies = {}) {
    const projectRoot = context.packager?.projectDir || PROJECT_ROOT;
    const platform = platformFromContext(context);
    const targetArchitectures = targetArchitecturesFromContext(context);
    const runtimeVerifier = dependencies.verifyRuntime || verifyRuntime;
    const write = dependencies.write || (message => process.stdout.write(message));
    for (const targetArch of targetArchitectures) {
        const status = runtimeVerifier({ projectRoot, platform, arch: targetArch });
        write(
            `Verified bundled libyang ${status.version} and effective Schema helper contract ` +
                `${status.schemaContractVersion}: ${status.path}, ${status.schemaPath}\n`
        );
    }
}

if (require.main === module) {
    try {
        const status = verifyRuntime({
            projectRoot: PROJECT_ROOT,
            platform: optionValue('--platform') || process.platform,
            arch: optionValue('--arch') || process.arch
        });
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = beforePack;
module.exports.platformFromContext = platformFromContext;
module.exports.archFromContext = archFromContext;
module.exports.targetArchitecturesFromContext = targetArchitecturesFromContext;
