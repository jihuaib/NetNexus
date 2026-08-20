const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function projectPath(relativePath) {
    return path.join(PROJECT_ROOT, relativePath);
}

function read(relativePath) {
    return fs.readFileSync(projectPath(relativePath), 'utf8');
}

const retiredSharedPaths = [
    'electron/worker/core/tcpAoForwardingServer.js',
    'electron/worker/rpki/tcpAoForwardProtocol.js',
    'electron/worker/rpki/tcpAoProxy.js',
    'scripts/build-tcp-ao-helper.sh',
    'scripts/ensure-tcp-ao-helper.js',
    'scripts/tcp-ao-helper.c',
    'scripts/test-tcp-ao-helper-native.c',
    'scripts/test-tcp-ao-helper.sh'
];

const sharedPaths = [
    'electron/worker/core/tcpAuthForwardingServer.js',
    'electron/worker/core/tcpAuthForwardProtocol.js',
    'electron/worker/core/tcpAuthProxy.js',
    'scripts/build-tcp-auth-helper.sh',
    'scripts/ensure-tcp-auth-helper.js',
    'scripts/tcp-auth-helper.c',
    'scripts/test-tcp-auth-helper-native.c',
    'scripts/test-tcp-auth-helper.sh'
];

for (const relativePath of retiredSharedPaths) {
    assert.equal(fs.existsSync(projectPath(relativePath)), false, `retired shared path still exists: ${relativePath}`);
}
for (const relativePath of sharedPaths) {
    assert.equal(fs.existsSync(projectPath(relativePath)), true, `renamed shared path is missing: ${relativePath}`);
}

const packageJson = JSON.parse(read('package.json'));
assert.equal(packageJson.scripts['tcp-auth:ensure'], 'node scripts/ensure-tcp-auth-helper.js');
assert.equal(packageJson.scripts['tcp-auth:build'], 'bash scripts/build-tcp-auth-helper.sh');
assert.equal(packageJson.scripts['tcp-auth:test:native'], 'bash scripts/test-tcp-auth-helper.sh');
assert.equal(Object.prototype.hasOwnProperty.call(packageJson.scripts, 'tcp-ao:ensure'), false);
assert.equal(Object.prototype.hasOwnProperty.call(packageJson.scripts, 'tcp-ao:build'), false);
assert.equal(Object.prototype.hasOwnProperty.call(packageJson.scripts, 'tcp-ao:test:native'), false);

const linuxResources = packageJson.build?.linux?.extraResources || [];
assert.equal(
    linuxResources.some(
        resource => resource.from === 'resources/tcp-auth/linux-${arch}' && resource.to === 'tcp-auth/linux-${arch}'
    ),
    true
);
assert.equal(
    linuxResources.some(resource => String(resource.from).includes('resources/tcp-ao')),
    false
);

const sharedRuntimeSource = [
    'electron/worker/core/tcpAuthForwardingServer.js',
    'electron/worker/core/tcpAuthForwardProtocol.js',
    'electron/worker/core/tcpAuthProxy.js',
    'electron/worker/bmp/bmpWorker.js',
    'electron/worker/rpki/rpkiWorker.js'
]
    .map(read)
    .join('\n');
assert.doesNotMatch(sharedRuntimeSource, /\bTcpAo(?:ForwardingServer|Proxy)\b/);
assert.doesNotMatch(sharedRuntimeSource, /tcpAoForwardProtocol|TCP_AO_FORWARD_/);

const sharedTestSource = [
    'test/ci/bmp_tcp_auth_forward.js',
    'test/ci/rpki_tcp_auth_forward.js',
    'test/ci/rpki_tcp_auth_proxy.js',
    'test/ci/tcp_md5_apps.js'
]
    .map(read)
    .join('\n');
assert.doesNotMatch(sharedTestSource, /\bTcpAo(?:ForwardingServer|Proxy)\b/);
assert.doesNotMatch(sharedTestSource, /tcpAoForwardProtocol|TCP_AO_FORWARD_/);

const nativeHelperSource = read('scripts/tcp-auth-helper.c');
assert.doesNotMatch(nativeHelperSource, /\bao_profile_config\b|NETNEXUS_TCP_AO_HELPER_VERSION/);

for (const relativePath of ['src/view/bmp/BmpConfig.vue', 'src/view/rpki/RpkiConfig.vue']) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /(?:class=["'][^"']*|\.)tcp-ao-(?:profile|selection|settings)/);
}

console.log('Shared TCP authentication naming tests passed');
