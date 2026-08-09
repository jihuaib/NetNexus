const path = require('path');
const { spawn } = require('child_process');
const { resolveLocalUiRoot } = require('./local-ui-source');

const projectRoot = path.resolve(__dirname, '..');
const requestedScript = process.argv[2];
const supportedScripts = new Set(['dev', 'build']);

if (!supportedScripts.has(requestedScript)) {
    console.error('Usage: node scripts/run-with-local-ui.js <dev|build> [NetNexusUI path]');
    process.exit(1);
}

const requestedUiRoot = process.argv[3] || path.join('..', 'NetNexusUI');
let localUiRoot;
try {
    localUiRoot = resolveLocalUiRoot(projectRoot, requestedUiRoot);
} catch (error) {
    console.error(error.message);
    console.error('Place NetNexusUI next to NetNexus, or pass its path after --.');
    process.exit(1);
}

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
    console.error('Run this command through npm (for example: npm run dev:ui).');
    process.exit(1);
}

console.log(`Using local NetNexusUI source: ${localUiRoot}`);
const child = spawn(process.execPath, [npmCliPath, 'run', requestedScript], {
    cwd: projectRoot,
    env: {
        ...process.env,
        NETNEXUS_UI_SOURCE: localUiRoot
    },
    shell: false,
    stdio: 'inherit'
});

child.on('error', error => {
    console.error(`Unable to start npm run ${requestedScript}: ${error.message}`);
    process.exitCode = 1;
});

child.on('exit', code => {
    process.exitCode = code === null ? 1 : code;
});
