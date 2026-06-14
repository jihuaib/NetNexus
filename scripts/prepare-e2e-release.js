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

if (process.env.E2E_TARGET === 'browser' || process.env.E2E_SKIP_PACK === '1') {
    console.log('[prepare-e2e-release] skipped packaged app build');
    process.exit(0);
}

const { command, args, shell } = getPackCommand();
console.log(`[prepare-e2e-release] building packaged app: ${command} ${args.join(' ')}`.trim());

const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    shell,
    stdio: 'inherit'
});

if (result.error) {
    throw result.error;
}

process.exit(result.status || 0);
