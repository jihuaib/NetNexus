const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS_ROOT = path.join(ROOT, 'docs');
const VITEPRESS_BIN = path.join(DOCS_ROOT, 'node_modules', 'vitepress', 'bin', 'vitepress.js');
const SUPPORTED_COMMANDS = new Set(['install', 'dev', 'build', 'preview']);
const command = process.argv[2];
const commandArgs = process.argv.slice(3);
const nodeMajor = Number(process.versions.node.split('.')[0]);

if (!SUPPORTED_COMMANDS.has(command)) {
    console.error('usage: node scripts/run-docs-site.js <install|dev|build|preview>');
    process.exit(1);
}

function runNode(args) {
    const result = spawnSync(process.execPath, args, {
        cwd: ROOT,
        env: process.env,
        stdio: 'inherit'
    });

    if (result.error) throw result.error;
    return typeof result.status === 'number' ? result.status : 1;
}

function runWithDocsNode(args) {
    if (nodeMajor >= 22) return runNode(args);

    const npmCli = process.env.npm_execpath;
    if (!npmCli) {
        console.error('npm execution path is unavailable; run this command through npm scripts.');
        return 1;
    }

    return runNode([npmCli, 'exec', '--yes', '--package=node@22', '--', 'node', ...args]);
}

function installDocsDependencies() {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) {
        console.error('npm execution path is unavailable; run this command through npm scripts.');
        return 1;
    }

    console.log('Installing isolated VitePress dependencies in docs/node_modules ...');
    return runWithDocsNode([npmCli, 'ci', '--prefix', DOCS_ROOT]);
}

if (command === 'install') {
    process.exit(installDocsDependencies());
}

if (!fs.existsSync(VITEPRESS_BIN)) {
    const installStatus = installDocsDependencies();
    if (installStatus !== 0) process.exit(installStatus);
}

const vitepressArgs = [VITEPRESS_BIN, command, DOCS_ROOT, ...commandArgs];
let commandStatus;

if (nodeMajor >= 22) {
    commandStatus = runNode(vitepressArgs);
} else {
    console.log(`VitePress requires a newer Node.js runtime; using an isolated Node.js 22 runtime for ${command}.`);
    commandStatus = runWithDocsNode(vitepressArgs);
}

process.exit(commandStatus);
