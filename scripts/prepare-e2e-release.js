const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function getPackCommand() {
    if (process.env.E2E_PACK_COMMAND) {
        return {
            command: process.env.E2E_PACK_COMMAND,
            args: [],
            shell: true
        };
    }

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    if (process.platform === 'darwin') {
        return {
            command: npmCommand,
            args: ['run', process.arch === 'arm64' ? 'pack:mac:arm64' : 'pack:mac'],
            shell: false
        };
    }

    if (process.platform === 'win32') {
        return {
            command: npmCommand,
            args: ['run', 'pack'],
            shell: false
        };
    }

    return {
        command: 'npx',
        args: ['electron-builder', '--linux', process.arch === 'arm64' ? '--arm64' : '--x64', '--dir'],
        shell: false
    };
}

function runCommand(command, args, options = {}) {
    console.log(`[prepare-e2e-release] ${command} ${args.join(' ')}`.trim());

    const result = spawnSync(command, args, {
        cwd: projectRoot,
        env: process.env,
        shell: options.shell || false,
        stdio: 'inherit'
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`command failed with exit code ${result.status}: ${command} ${args.join(' ')}`.trim());
    }
}

function prepareE2eRelease() {
    if (process.env.E2E_TARGET === 'browser' || process.env.E2E_SKIP_PACK === '1') {
        console.log('[prepare-e2e-release] skipped packaged app build');
        return;
    }

    if (process.env.E2E_APP_EXECUTABLE) {
        console.log('[prepare-e2e-release] skipped packaged app build because E2E_APP_EXECUTABLE is set');
        return;
    }

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (process.platform === 'linux') {
        runCommand(npmCommand, ['run', 'build']);
    }

    const { command, args, shell } = getPackCommand();
    runCommand(command, args, { shell });
}

if (require.main === module) {
    try {
        prepareE2eRelease();
    } catch (error) {
        console.error(error.stack || error.message);
        process.exit(1);
    }
}

module.exports = prepareE2eRelease;
