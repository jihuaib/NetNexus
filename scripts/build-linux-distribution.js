const childProcess = require('node:child_process');

const { buildLinuxDeb } = require('./build-linux-deb');
const { assertNativeLinuxBuild, optionValue } = require('./prepare-linux-package');

function builderArguments(args, arch) {
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--arch') {
            index++;
            continue;
        }
        if (args[index] === '--publish') {
            index++;
            continue;
        }
        if (args[index].startsWith('--publish=')) continue;
        throw new Error(`Unsupported Linux distribution argument: ${args[index]}`);
    }
    return ['--linux', `--${arch}`, '--dir'];
}

function buildLinuxDistribution(options = {}, dependencies = {}) {
    const target = assertNativeLinuxBuild({
        platform: options.platform,
        hostArch: options.hostArch,
        targetArch: options.arch
    });
    const projectRoot = options.projectRoot || process.cwd();
    const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
    const electronBuilderCli = dependencies.electronBuilderCli || require.resolve('electron-builder/cli.js');
    const result = spawnSync(
        process.execPath,
        [electronBuilderCli, ...builderArguments(options.args || [], target.targetArch)],
        {
            cwd: projectRoot,
            env: options.env || process.env,
            stdio: 'inherit'
        }
    );
    if (result.error) throw new Error(`Unable to start electron-builder: ${result.error.message}`);
    if (result.status !== 0) {
        const signal = result.signal ? ` (signal ${result.signal})` : '';
        throw new Error(`electron-builder unpacked Linux build failed with exit code ${result.status}${signal}`);
    }

    const debBuilder = dependencies.buildLinuxDeb || buildLinuxDeb;
    return debBuilder({ projectRoot, platform: target.platform, hostArch: target.hostArch, arch: target.targetArch });
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        buildLinuxDistribution({ arch: optionValue('--arch', args), args });
    } catch (error) {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    builderArguments,
    buildLinuxDistribution
};
