const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const TcpAuthProxy = require('../../electron/worker/core/tcpAuthProxy');
const RpkiWorker = require('../../electron/worker/rpki/rpkiWorker');
const {
    TCP_AUTH_FORWARD_CAPABILITY_BYTES,
    TCP_AUTH_FORWARD_HEADER_BYTES,
    TCP_AUTH_FORWARD_VERSION
} = require('../../electron/worker/core/tcpAuthForwardProtocol');

const FORWARD_SOCKET = '/tmp/netnexus-rpki-tcp-auth-test.sock';

function forwardCapability() {
    return Buffer.alloc(TCP_AUTH_FORWARD_CAPABILITY_BYTES, 0x5a);
}

function runtimeProfile(overrides = {}) {
    return {
        id: 'router-a',
        name: 'Router A',
        peer: '192.0.2.1/32',
        keys: [
            {
                id: 'key-1',
                algorithm: 'hmac(sha1)',
                sndId: 1,
                rcvId: 2,
                key: 'top secret key',
                macLength: 12,
                acceptStart: null,
                sendStart: 1_900_000_000,
                sendEnd: 1_900_003_600,
                acceptEnd: null
            }
        ],
        ...overrides
    };
}

function runtimeMd5Profile(key = 'top secret md5 key') {
    return {
        id: 'router-md5',
        name: 'Router MD5',
        peer: '198.51.100.7/32',
        key
    };
}

function executableFs() {
    return {
        lstatSync() {
            return {
                mode: 0o100755,
                isFile: () => true,
                isSymbolicLink: () => false
            };
        }
    };
}

function createSpawnCapture(authType = 'tcp-ao', statusOverrides = {}) {
    const capture = { executable: '', args: [], options: null, stdin: '', killSignals: [] };
    const spawn = (executable, args, options) => {
        capture.executable = executable;
        capture.args = [...args];
        capture.options = options;
        const child = new EventEmitter();
        child.pid = 123;
        capture.child = child;
        capture.respond = status => child.stdout.write(`${JSON.stringify(status)}\n`);
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin.on('data', chunk => {
            capture.stdin += chunk.toString('utf8');
        });
        let exited = false;
        const emitExit = (code, signal) => {
            if (exited) return false;
            exited = true;
            child.emit('exit', code, signal);
            return true;
        };
        capture.exit = (code, signal = null) => setImmediate(() => emitExit(code, signal));
        child.kill = signal => {
            if (exited) return false;
            capture.killSignals.push(signal);
            setImmediate(() => emitExit(0, signal));
            return true;
        };
        setImmediate(() => {
            const status = {
                status: 'ready',
                pid: 123,
                listenPort: 8282,
                forwardTransport: 'unix',
                peerHeaderVersion: TCP_AUTH_FORWARD_VERSION,
                peerHeaderBytes: TCP_AUTH_FORWARD_HEADER_BYTES,
                families: ['ipv4'],
                profileCount: 1,
                keyCount: 1,
                installedKeyCount: 1
            };
            if (authType === 'tcp-md5') {
                status.authentication = 'tcp-md5';
                status.md5Configured = true;
            } else {
                status.aoRequired = true;
                status.rotationIntervalMs = 1000;
            }
            Object.assign(status, statusOverrides);
            child.stdout.write(`${JSON.stringify(status)}\n`);
        });
        return child;
    };
    return { capture, spawn };
}

function createFailedSpawn() {
    return () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => false;
        setImmediate(() => {
            const error = new Error('spawn fixture ENOENT');
            error.code = 'ENOENT';
            child.emit('error', error);
            child.emit('close', -2, null);
        });
        return child;
    };
}

function createRetainedSecretSpawn(trigger) {
    const capture = { payload: null, payloadSnapshot: null };
    const spawn = () => {
        const child = new EventEmitter();
        child.pid = trigger === 'spawn-error' ? undefined : 4242;
        child.stdin = new EventEmitter();
        child.stdin.write = payload => {
            capture.payload = payload;
            capture.payloadSnapshot = Buffer.from(payload);
            // Deliberately retain the original Buffer and never call the completion
            // callback. Terminal startup paths must wipe it independently.
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        let exited = false;
        const emitExit = (code, signal) => {
            if (exited) return;
            exited = true;
            child.emit('exit', code, signal);
            child.emit('close', code, signal);
        };
        child.kill = signal => {
            if (exited) return false;
            setImmediate(() => emitExit(0, signal));
            return true;
        };

        setImmediate(() => {
            if (trigger === 'invalid-status') {
                child.stdout.write('not-json\n');
            } else if (trigger === 'error-status') {
                child.stdout.write('{"status":"error","code":"TEST_ERROR","message":"fixture rejected"}\n');
            } else if (trigger === 'unconfirmed-status') {
                child.stdout.write('{"status":"ready","aoRequired":false}\n');
            } else if (trigger === 'early-exit') {
                emitExit(17, null);
            } else if (trigger === 'spawn-error') {
                child.emit('error', new Error('fixture spawn failure'));
                child.emit('close', -2, null);
            } else if (trigger === 'stdin-error') {
                child.stdin.emit('error', new Error('fixture stdin failure'));
            }
        });
        return child;
    };
    return { capture, spawn };
}

async function assertStartupSecretWiped(trigger, expectedError, authType = 'tcp-ao') {
    const { capture, spawn } = createRetainedSecretSpawn(trigger);
    const proxy = new TcpAuthProxy({
        spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64',
        authType,
        readyTimeoutMs: 250
    });
    // TcpAuthProxy intentionally unrefs its ready timer. Keep this test process alive
    // long enough to exercise the timeout path as well as immediate failures.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(
            proxy.start({
                listenPort: 8282,
                forwardSocket: FORWARD_SOCKET,
                forwardCapability: forwardCapability(),
                profiles: [authType === 'tcp-md5' ? runtimeMd5Profile() : runtimeProfile()]
            }),
            expectedError
        );
    } finally {
        clearTimeout(keepAlive);
    }
    assert(Buffer.isBuffer(capture.payload), `${trigger} did not capture the stdin Buffer`);
    assert.match(capture.payloadSnapshot.toString('utf8'), /top secret (?:md5 )?key/);
    assert(
        capture.payload.every(byte => byte === 0),
        `${trigger} left plaintext bytes in the stdin Buffer`
    );
    await proxy.stop();
}

async function assertReloadErrorDisposition(errorCode, failClosed) {
    const fixture = createSpawnCapture();
    const proxy = new TcpAuthProxy({
        spawn: fixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64'
    });
    await proxy.start({
        listenPort: 8282,
        forwardSocket: FORWARD_SOCKET,
        forwardCapability: forwardCapability(),
        profiles: [runtimeProfile()]
    });
    const reload = proxy.reload({ profiles: [runtimeProfile()] });
    await new Promise(resolve => setImmediate(resolve));
    fixture.capture.respond({
        status: 'error',
        code: errorCode,
        message: `fixture ${errorCode}`,
        requestId: 1
    });
    await assert.rejects(reload, error => {
        assert.equal(error.code, errorCode, 'the helper error was not preserved for the pending reload caller');
        assert.match(error.message, new RegExp(errorCode));
        return true;
    });
    assert.equal(proxy.ready, !failClosed);
    assert.equal(
        fixture.capture.killSignals.includes('SIGTERM'),
        failClosed,
        `${errorCode} used the wrong helper disposition`
    );
    await proxy.stop();
}

async function main() {
    const { capture, spawn } = createSpawnCapture();
    const proxy = new TcpAuthProxy({
        spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64'
    });
    const status = await proxy.start({
        listenPort: 8282,
        forwardSocket: FORWARD_SOCKET,
        forwardCapability: forwardCapability(),
        profiles: [runtimeProfile()]
    });
    assert.equal(status.status, 'ready');
    assert.equal(status.aoRequired, true);
    assert.equal(capture.executable, '/safe/tcp-auth-helper');
    assert.equal(capture.options.shell, false);
    assert.equal(capture.args.includes('top secret key'), false, 'TCP-AO key leaked into argv');
    assert.equal(
        capture.args.includes(forwardCapability().toString('hex')),
        false,
        'TCP-AO forwarding capability leaked into argv'
    );
    const parentPidIndex = capture.args.indexOf('--parent-pid');
    assert.notEqual(parentPidIndex, -1, 'TCP auth helper parent PID argument is missing');
    assert.equal(capture.args[parentPidIndex + 1], String(process.pid));
    const forwardSocketIndex = capture.args.indexOf('--forward-socket');
    assert.notEqual(forwardSocketIndex, -1, 'TCP auth helper Unix socket argument is missing');
    assert.equal(capture.args[forwardSocketIndex + 1], FORWARD_SOCKET);
    assert.equal(capture.args.includes('--forward-port'), false, 'production wrapper exposed the test-only TCP path');

    const config = JSON.parse(capture.stdin);
    assert.equal(config.schemaVersion, 2);
    assert.equal(config.forwardCapability, forwardCapability().toString('hex'));
    assert.equal(config.profiles[0].peer, '192.0.2.1/32');
    assert.equal(config.profiles[0].keys[0].key, 'top secret key');
    assert.equal(config.profiles[0].keys[0].acceptStart, 0);
    assert.equal(config.profiles[0].keys[0].sendStart, 1_900_000_000);
    assert.equal(config.profiles[0].keys[0].acceptEnd, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(config.profiles[0], 'name'), false);

    const reloaded = proxy.reload({
        profiles: [
            runtimeProfile({
                keys: [{ ...runtimeProfile().keys[0], key: 'replacement secret key' }]
            })
        ]
    });
    await new Promise(resolve => setImmediate(resolve));
    capture.respond({
        status: 'reloaded',
        requestId: 1,
        profileCount: 1,
        keyCount: 1,
        installedKeyCount: 1,
        disconnectedConnections: 2,
        activeSocketUpdate: 'update-or-safe-reconnect'
    });
    assert.deepEqual(await reloaded, {
        requestId: 1,
        profileCount: 1,
        keyCount: 1,
        installedKeyCount: 1,
        disconnectedConnections: 2,
        activeSocketUpdate: 'update-or-safe-reconnect'
    });
    const reloadCommand = JSON.parse(capture.stdin.trim().split('\n')[1]);
    assert.deepEqual(
        {
            schemaVersion: reloadCommand.schemaVersion,
            command: reloadCommand.command,
            requestId: reloadCommand.requestId
        },
        { schemaVersion: 1, command: 'reload', requestId: 1 }
    );
    assert.equal(reloadCommand.config.profiles[0].keys[0].key, 'replacement secret key');
    proxy.reloadRequestId = Number.MAX_SAFE_INTEGER;
    const wrappedReload = proxy.reload({ profiles: [runtimeProfile()] });
    await new Promise(resolve => setImmediate(resolve));
    capture.respond({
        status: 'reloaded',
        requestId: 1,
        profileCount: 1,
        keyCount: 1,
        installedKeyCount: 1,
        disconnectedConnections: 0,
        activeSocketUpdate: 'update-or-safe-reconnect'
    });
    assert.equal((await wrappedReload).requestId, 1, 'reload requestId did not safely wrap to 1');
    await proxy.stop();
    assert.equal(proxy.child, null);

    const md5Fixture = createSpawnCapture('tcp-md5');
    const md5Proxy = new TcpAuthProxy({
        spawn: md5Fixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64',
        authType: 'tcp-md5'
    });
    const md5Status = await md5Proxy.start({
        listenPort: 8282,
        forwardSocket: FORWARD_SOCKET,
        forwardCapability: forwardCapability(),
        profiles: [runtimeMd5Profile()]
    });
    assert.equal(md5Status.authentication, 'tcp-md5');
    assert.equal(md5Status.md5Configured, true);
    assert.equal(md5Fixture.capture.args.includes('top secret md5 key'), false, 'TCP-MD5 key leaked into argv');
    const md5Config = JSON.parse(md5Fixture.capture.stdin);
    assert.deepEqual(md5Config, {
        schemaVersion: 3,
        authType: 'tcp-md5',
        forwardCapability: forwardCapability().toString('hex'),
        profiles: [{ peer: '198.51.100.7/32', key: 'top secret md5 key' }]
    });
    const maxMd5Config = md5Proxy.buildConfig([runtimeMd5Profile('m'.repeat(80))], forwardCapability());
    assert.equal(Buffer.byteLength(maxMd5Config.profiles[0].key, 'utf8'), 80);
    assert.throws(() => md5Proxy.buildConfig([runtimeMd5Profile('m'.repeat(81))], forwardCapability()), /1-80字节/);
    assert.throws(() => md5Proxy.buildConfig([runtimeMd5Profile('')], forwardCapability()), /1-80字节/);
    assert.throws(() => md5Proxy.buildConfig([runtimeMd5Profile('bad\0key')], forwardCapability()), /NUL/);
    await md5Proxy.stop();
    assert.equal(md5Proxy.child, null);

    const partialMd5Fixture = createSpawnCapture('tcp-md5', { installedKeyCount: 0 });
    const partialMd5Proxy = new TcpAuthProxy({
        spawn: partialMd5Fixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64',
        authType: 'tcp-md5'
    });
    await assert.rejects(
        partialMd5Proxy.start({
            listenPort: 8282,
            forwardSocket: FORWARD_SOCKET,
            forwardCapability: forwardCapability(),
            profiles: [runtimeMd5Profile()]
        }),
        /未确认TCP MD5认证状态/
    );
    await partialMd5Proxy.stop();

    const md5RuntimeFixture = createSpawnCapture('tcp-md5');
    const md5RuntimeProxy = new TcpAuthProxy({
        spawn: md5RuntimeFixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64',
        authType: 'tcp-md5'
    });
    await md5RuntimeProxy.start({
        listenPort: 8282,
        forwardSocket: FORWARD_SOCKET,
        forwardCapability: forwardCapability(),
        profiles: [runtimeMd5Profile()]
    });
    const md5RuntimeFailurePromise = new Promise(resolve => md5RuntimeProxy.once('unexpectedExit', resolve));
    md5RuntimeFixture.capture.exit(17);
    const md5RuntimeFailure = await md5RuntimeFailurePromise;
    assert.equal(md5RuntimeFailure.code, 'TCP_MD5_HELPER_EXIT');
    assert.deepEqual(md5RuntimeFailure.runtimeFailure, {
        code: 'TCP_MD5_HELPER_EXIT',
        reason: 'TCP-MD5认证进程异常退出，RPKI服务已安全停止'
    });

    const runtimeFixture = createSpawnCapture();
    const runtimeProxy = new TcpAuthProxy({
        spawn: runtimeFixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64'
    });
    await runtimeProxy.start({
        listenPort: 8282,
        forwardSocket: FORWARD_SOCKET,
        forwardCapability: forwardCapability(),
        profiles: [runtimeProfile()]
    });
    const runtimeFailurePromise = new Promise(resolve => runtimeProxy.once('unexpectedExit', resolve));
    runtimeFixture.capture.exit(TcpAuthProxy.TCP_AO_HELPER_EXIT_CODES.KEYS_EXPIRED);
    const runtimeFailure = await runtimeFailurePromise;
    assert.equal(runtimeFailure.code, 'TCP_AO_HELPER_EXIT');
    assert.deepEqual(runtimeFailure.runtimeFailure, {
        code: 'TCP_AO_KEYS_EXPIRED',
        reason: 'TCP-AO发送密钥已过期且没有可用的后继密钥，RPKI服务已安全停止'
    });
    assert.equal(runtimeProxy.child, null);
    assert.equal(
        TcpAuthProxy.runtimeFailureForHelperExit(TcpAuthProxy.TCP_AO_HELPER_EXIT_CODES.CLOCK_ROLLBACK).code,
        'TCP_AO_CLOCK_ROLLBACK'
    );
    assert.equal(
        TcpAuthProxy.runtimeFailureForHelperExit(TcpAuthProxy.TCP_AO_HELPER_EXIT_CODES.CLOCK_UNAVAILABLE).code,
        'TCP_AO_CLOCK_UNAVAILABLE'
    );
    assert.equal(
        TcpAuthProxy.runtimeFailureForHelperExit(TcpAuthProxy.TCP_AO_HELPER_EXIT_CODES.ROTATION_FAILED).code,
        'TCP_AO_ROTATION_FAILED'
    );
    assert.equal(
        TcpAuthProxy.runtimeFailureForHelperExit(TcpAuthProxy.TCP_AO_HELPER_EXIT_CODES.RELOAD_FAILED).code,
        'TCP_AO_RELOAD_FAILED'
    );

    const restartRequiredFixture = createSpawnCapture();
    const restartRequiredProxy = new TcpAuthProxy({
        spawn: restartRequiredFixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64'
    });
    await restartRequiredProxy.start({
        listenPort: 8282,
        forwardSocket: FORWARD_SOCKET,
        forwardCapability: forwardCapability(),
        profiles: [runtimeProfile()]
    });
    const restartRequiredReload = restartRequiredProxy.reload({ profiles: [runtimeProfile({ peer: '192.0.2.2/32' })] });
    await new Promise(resolve => setImmediate(resolve));
    restartRequiredFixture.capture.respond({
        status: 'error',
        code: 'RELOAD_RESTART_REQUIRED',
        message: 'restart required',
        requestId: 1
    });
    await assert.rejects(restartRequiredReload, /运行中不能修改TCP-AO对端CIDR.*先停止服务/);
    assert.equal(restartRequiredProxy.ready, true, 'a deterministic restart-required response killed the helper');
    await restartRequiredProxy.stop();

    await assertReloadErrorDisposition('RELOAD_APPLY_FAILED', false);
    await assertReloadErrorDisposition('RELOAD_ROLLBACK_FAILED', true);
    await assertReloadErrorDisposition('RELOAD_CLOCK_UNAVAILABLE', true);
    await assertReloadErrorDisposition('RELOAD_FUTURE_UNKNOWN_CODE', true);

    const protocolErrorFixture = createSpawnCapture();
    const protocolErrorProxy = new TcpAuthProxy({
        spawn: protocolErrorFixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64'
    });
    await protocolErrorProxy.start({
        listenPort: 8282,
        forwardSocket: FORWARD_SOCKET,
        forwardCapability: forwardCapability(),
        profiles: [runtimeProfile()]
    });
    const invalidStatusReload = protocolErrorProxy.reload({ profiles: [runtimeProfile()] });
    await new Promise(resolve => setImmediate(resolve));
    protocolErrorFixture.capture.respond({ status: 'ready', requestId: 1 });
    await assert.rejects(invalidStatusReload, /未知的热更新状态/);
    assert.equal(protocolErrorProxy.ready, false, 'an unknown reload status did not fail closed');
    await protocolErrorProxy.stop();

    const reloadTimeoutFixture = createSpawnCapture();
    const reloadTimeoutProxy = new TcpAuthProxy({
        spawn: reloadTimeoutFixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64',
        reloadTimeoutMs: 250
    });
    await reloadTimeoutProxy.start({
        listenPort: 8282,
        forwardSocket: FORWARD_SOCKET,
        forwardCapability: forwardCapability(),
        profiles: [runtimeProfile()]
    });
    const keepReloadTimeoutAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(reloadTimeoutProxy.reload({ profiles: [runtimeProfile()] }), /热更新在250ms内没有响应/);
    } finally {
        clearTimeout(keepReloadTimeoutAlive);
    }
    assert.equal(reloadTimeoutProxy.ready, false, 'an indeterminate reload timeout did not fail closed');
    await reloadTimeoutProxy.stop();

    const failedProxy = new TcpAuthProxy({
        spawn: createFailedSpawn(),
        fs: executableFs(),
        helperPath: '/safe/tcp-auth-helper',
        platform: 'linux',
        arch: 'arm64'
    });
    await assert.rejects(
        failedProxy.start({
            listenPort: 8282,
            forwardSocket: FORWARD_SOCKET,
            forwardCapability: forwardCapability(),
            profiles: [runtimeProfile()]
        }),
        /无法启动TCP 认证 helper: spawn fixture ENOENT/
    );
    await failedProxy.stop();
    assert.equal(failedProxy.child, null, 'failed spawn left a helper process handle behind');

    await assertStartupSecretWiped('invalid-status', /无效的启动状态/);
    await assertStartupSecretWiped('error-status', /fixture rejected/);
    await assertStartupSecretWiped('unconfirmed-status', /未确认TCP-AO强制认证状态/);
    await assertStartupSecretWiped('early-exit', /启动前退出/);
    await assertStartupSecretWiped('spawn-error', /无法启动TCP 认证 helper: fixture spawn failure/);
    await assertStartupSecretWiped('stdin-error', /写入TCP 认证 helper配置失败: fixture stdin failure/);
    await assertStartupSecretWiped('timeout', /没有就绪/);
    await assertStartupSecretWiped('invalid-status', /无效的启动状态/, 'tcp-md5');

    // The wrapper checks above use injected process and filesystem adapters and
    // are portable. The worker integration below intentionally creates a real
    // Unix-domain socket and verifies POSIX directory/socket modes, so Windows
    // exercises that transport in rpki_tcp_auth_forward.js only up to its portable
    // protocol checks and must not attempt to bind the /tmp fixture path here.
    if (process.platform === 'win32') {
        console.log('RPKI TCP auth worker Unix socket integration skipped on Windows');
        console.log('RPKI TCP auth proxy wrapper tests passed');
        return;
    }

    const fakeProxy = new EventEmitter();
    const workerRuntimeProfile = runtimeProfile();
    let workerForwardDirectory;
    let workerForwardSocket;
    let workerForwardCapability;
    fakeProxy.start = async options => {
        assert.equal(options.listenPort, 8282);
        assert.equal(typeof options.forwardSocket, 'string');
        assert.equal(options.forwardSocket.endsWith('/r.sock'), true);
        assert.equal(Buffer.isBuffer(options.forwardCapability), true);
        assert.equal(options.forwardCapability.length, TCP_AUTH_FORWARD_CAPABILITY_BYTES);
        assert.equal(options.profiles[0].keys[0].key, 'top secret key');
        workerForwardDirectory = options.forwardSocket.slice(0, -'/r.sock'.length);
        workerForwardSocket = options.forwardSocket;
        workerForwardCapability = options.forwardCapability;
        return {
            status: 'ready',
            listenPort: 8282,
            families: ['ipv4'],
            aoRequired: true
        };
    };
    fakeProxy.stop = async () => {};
    let workerReloadPayload = null;
    fakeProxy.reload = async options => {
        workerReloadPayload = JSON.parse(JSON.stringify(options));
        return {
            requestId: 1,
            profileCount: 1,
            keyCount: 1,
            installedKeyCount: 1,
            disconnectedConnections: 1,
            activeSocketUpdate: 'update-or-safe-reconnect'
        };
    };
    const responses = new Map();
    const worker = Object.create(RpkiWorker.prototype);
    worker.server = null;
    worker.ipv6Server = null;
    worker.tcpAuthProxy = null;
    worker.storageStopping = false;
    worker.rpkiSessionMap = new Map();
    worker.rpkiRouterKeyMap = new Map();
    worker.closingRpkiSessions = new Set();
    worker.pendingTcpAuthSockets = new Set();
    worker.rpkiConfigData = {
        port: 8282,
        authType: 'tcp-ao',
        tcpAo: workerRuntimeProfile
    };
    worker.messageHandler = {
        sendSuccessResponse(messageId, data, msg) {
            responses.set(messageId, { status: 'success', data, msg });
        },
        sendErrorResponse(messageId, msg) {
            responses.set(messageId, { status: 'error', msg });
        },
        sendEvent(eventName, data) {
            responses.set(`event:${eventName}`, data);
        }
    };
    worker.createTcpAuthProxy = () => fakeProxy;
    await worker.startTcpServer('tcp-ao-start');
    assert.equal(responses.get('tcp-ao-start').status, 'success', responses.get('tcp-ao-start').msg);
    assert.equal(worker.server.address(), workerForwardSocket);
    assert.equal(worker.rpkiConfigData.tcpAo.keys[0].key, '<redacted>');
    assert.equal(
        workerRuntimeProfile.keys[0].key,
        '<redacted>',
        'worker retained its original plaintext key reference'
    );
    assert.equal(workerForwardCapability.equals(worker.tcpAuthForwardCapability), true);
    assert.equal(require('node:fs').statSync(workerForwardDirectory).mode & 0o777, 0o700);
    assert.equal(require('node:fs').statSync(workerForwardSocket).mode & 0o777, 0o600);
    const workerReloadProfile = runtimeProfile({
        keys: [{ ...runtimeProfile().keys[0], key: 'worker replacement key' }]
    });
    await worker.reloadTcpAoProfile('tcp-ao-reload', { profile: workerReloadProfile });
    assert.equal(responses.get('tcp-ao-reload').status, 'success', responses.get('tcp-ao-reload').msg);
    assert.equal(workerReloadPayload.profiles[0].keys[0].key, 'worker replacement key');
    assert.equal(workerReloadProfile.keys.length, 0, 'worker reload input retained plaintext key material');
    assert.equal(worker.rpkiConfigData.tcpAo.keys[0].key, '<redacted>');
    const internalServer = worker.server;
    worker.server = null;
    await worker.closeTcpServer(internalServer, 'test internal server');
    await fakeProxy.stop();
    worker.cleanupTcpAuthForwardEndpoint();
    assert.equal(require('node:fs').existsSync(workerForwardDirectory), false);
    assert.equal(
        workerForwardCapability.every(byte => byte === 0),
        true,
        'forward capability was not wiped'
    );

    let fatalExitScheduled = false;
    worker.scheduleFatalExit = () => {
        fatalExitScheduled = true;
    };
    worker.handleTcpAoUnexpectedExit(runtimeFailure);
    assert.equal(fatalExitScheduled, true);
    assert.deepEqual(
        responses.get(`event:${require('../../electron/const/rpkiConst').RPKI_EVT_TYPES.RUNTIME_FAILURE}`),
        {
            code: 'TCP_AO_KEYS_EXPIRED',
            reason: 'TCP-AO发送密钥已过期且没有可用的后继密钥，RPKI服务已安全停止'
        }
    );

    console.log('RPKI TCP auth proxy wrapper tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
