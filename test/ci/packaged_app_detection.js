const assert = require('node:assert/strict');
const path = require('node:path');

const { isLikelyLinuxAppExecutable } = require('../../scripts/e2e-support/packaged-app');

const executableFs = {
    statSync() {
        return { mode: 0o755 };
    }
};

const releaseRoot = path.join(path.parse(process.cwd()).root, 'workspace', 'release');
const x64Executable = path.join(releaseRoot, 'linux-unpacked', 'net-nexus');
const arm64Executable = path.join(releaseRoot, 'linux-arm64-unpacked', 'net-nexus');
const nestedTcpAuthHelper = path.join(
    releaseRoot,
    'linux-unpacked',
    'resources',
    'tcp-auth',
    'linux-x64',
    'tcp-auth-helper'
);

assert.equal(isLikelyLinuxAppExecutable(x64Executable, 'net-nexus', executableFs), true);
assert.equal(isLikelyLinuxAppExecutable(arm64Executable, 'net-nexus', executableFs), true);
assert.equal(
    isLikelyLinuxAppExecutable(nestedTcpAuthHelper, 'tcp-auth-helper', executableFs),
    false,
    'nested native helpers must never be detected as the packaged Electron executable'
);
assert.equal(
    isLikelyLinuxAppExecutable(
        path.join(releaseRoot, 'linux-unpacked', 'chrome-sandbox'),
        'chrome-sandbox',
        executableFs
    ),
    false
);

console.log('Packaged Electron executable detection tests passed');
