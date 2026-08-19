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
const nestedTcpAoHelper = path.join(releaseRoot, 'linux-unpacked', 'resources', 'tcp-ao', 'linux-x64', 'tcp-ao-helper');

assert.equal(isLikelyLinuxAppExecutable(x64Executable, 'net-nexus', executableFs), true);
assert.equal(isLikelyLinuxAppExecutable(arm64Executable, 'net-nexus', executableFs), true);
assert.equal(
    isLikelyLinuxAppExecutable(nestedTcpAoHelper, 'tcp-ao-helper', executableFs),
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
