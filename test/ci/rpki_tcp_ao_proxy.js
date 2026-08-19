const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const TcpAoProxy = require('../../electron/worker/rpki/tcpAoProxy');
const RpkiWorker = require('../../electron/worker/rpki/rpkiWorker');
const {
    TCP_AO_FORWARD_CAPABILITY_BYTES,
    TCP_AO_FORWARD_HEADER_BYTES,
    TCP_AO_FORWARD_VERSION
} = require('../../electron/worker/rpki/tcpAoForwardProtocol');

const FORWARD_SOCKET = '/tmp/netnexus-rpki-tcp-ao-test.sock';

function forwardCapability() {
    return Buffer.alloc(TCP_AO_FORWARD_CAPABILITY_BYTES, 0x5a);
}

function runtimeProfile() {
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
        ]
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

function createSpawnCapture() {
    const capture = { executable: '', args: [], options: null, stdin: '' };
    const spawn = (executable, args, options) => {
        capture.executable = executable;
        capture.args = [...args];
        capture.options = options;
        const child = new EventEmitter();
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
            setImmediate(() => emitExit(0, signal));
            return true;
        };
        setImmediate(() => {
            child.stdout.write(
                `${JSON.stringify({
                    status: 'ready',
                    pid: 123,
                    listenPort: 8282,
                    forwardTransport: 'unix',
                    peerHeaderVersion: TCP_AO_FORWARD_VERSION,
                    peerHeaderBytes: TCP_AO_FORWARD_HEADER_BYTES,
                    families: ['ipv4'],
                    profileCount: 1,
                    keyCount: 1,
                    aoRequired: true,
                    rotationIntervalMs: 1000
                })}\n`
            );
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
        child.stdin.end = payload => {
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

async function assertStartupSecretWiped(trigger, expectedError) {
    const { capture, spawn } = createRetainedSecretSpawn(trigger);
    const proxy = new TcpAoProxy({
        spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-ao-helper',
        platform: 'linux',
        arch: 'arm64',
        readyTimeoutMs: 250
    });
    // TcpAoProxy intentionally unrefs its ready timer. Keep this test process alive
    // long enough to exercise the timeout path as well as immediate failures.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(
            proxy.start({
                listenPort: 8282,
                forwardSocket: FORWARD_SOCKET,
                forwardCapability: forwardCapability(),
                profiles: [runtimeProfile()]
            }),
            expectedError
        );
    } finally {
        clearTimeout(keepAlive);
    }
    assert(Buffer.isBuffer(capture.payload), `${trigger} did not capture the stdin Buffer`);
    assert.match(capture.payloadSnapshot.toString('utf8'), /top secret key/);
    assert(
        capture.payload.every(byte => byte === 0),
        `${trigger} left plaintext bytes in the stdin Buffer`
    );
    await proxy.stop();
}

async function main() {
    const { capture, spawn } = createSpawnCapture();
    const proxy = new TcpAoProxy({
        spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-ao-helper',
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
    assert.equal(capture.executable, '/safe/tcp-ao-helper');
    assert.equal(capture.options.shell, false);
    assert.equal(capture.args.includes('top secret key'), false, 'TCP-AO key leaked into argv');
    assert.equal(
        capture.args.includes(forwardCapability().toString('hex')),
        false,
        'TCP-AO forwarding capability leaked into argv'
    );
    const parentPidIndex = capture.args.indexOf('--parent-pid');
    assert.notEqual(parentPidIndex, -1, 'TCP-AO helper parent PID argument is missing');
    assert.equal(capture.args[parentPidIndex + 1], String(process.pid));
    const forwardSocketIndex = capture.args.indexOf('--forward-socket');
    assert.notEqual(forwardSocketIndex, -1, 'TCP-AO helper Unix socket argument is missing');
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
    await proxy.stop();
    assert.equal(proxy.child, null);

    const runtimeFixture = createSpawnCapture();
    const runtimeProxy = new TcpAoProxy({
        spawn: runtimeFixture.spawn,
        fs: executableFs(),
        helperPath: '/safe/tcp-ao-helper',
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
    runtimeFixture.capture.exit(TcpAoProxy.TCP_AO_HELPER_EXIT_CODES.KEYS_EXPIRED);
    const runtimeFailure = await runtimeFailurePromise;
    assert.equal(runtimeFailure.code, 'TCP_AO_HELPER_EXIT');
    assert.deepEqual(runtimeFailure.runtimeFailure, {
        code: 'TCP_AO_KEYS_EXPIRED',
        reason: 'TCP-AO发送密钥已过期且没有可用的后继密钥，RPKI服务已安全停止'
    });
    assert.equal(runtimeProxy.child, null);
    assert.equal(
        TcpAoProxy.runtimeFailureForHelperExit(TcpAoProxy.TCP_AO_HELPER_EXIT_CODES.CLOCK_ROLLBACK).code,
        'TCP_AO_CLOCK_ROLLBACK'
    );
    assert.equal(
        TcpAoProxy.runtimeFailureForHelperExit(TcpAoProxy.TCP_AO_HELPER_EXIT_CODES.CLOCK_UNAVAILABLE).code,
        'TCP_AO_CLOCK_UNAVAILABLE'
    );
    assert.equal(
        TcpAoProxy.runtimeFailureForHelperExit(TcpAoProxy.TCP_AO_HELPER_EXIT_CODES.ROTATION_FAILED).code,
        'TCP_AO_ROTATION_FAILED'
    );

    const failedProxy = new TcpAoProxy({
        spawn: createFailedSpawn(),
        fs: executableFs(),
        helperPath: '/safe/tcp-ao-helper',
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
        /无法启动TCP-AO helper: spawn fixture ENOENT/
    );
    await failedProxy.stop();
    assert.equal(failedProxy.child, null, 'failed spawn left a helper process handle behind');

    await assertStartupSecretWiped('invalid-status', /无效的启动状态/);
    await assertStartupSecretWiped('error-status', /fixture rejected/);
    await assertStartupSecretWiped('unconfirmed-status', /未确认AO强制认证状态/);
    await assertStartupSecretWiped('early-exit', /启动前退出/);
    await assertStartupSecretWiped('spawn-error', /无法启动TCP-AO helper: fixture spawn failure/);
    await assertStartupSecretWiped('stdin-error', /写入TCP-AO helper配置失败: fixture stdin failure/);
    await assertStartupSecretWiped('timeout', /没有就绪/);

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
        assert.equal(options.forwardCapability.length, TCP_AO_FORWARD_CAPABILITY_BYTES);
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
    const responses = new Map();
    const worker = Object.create(RpkiWorker.prototype);
    worker.server = null;
    worker.ipv6Server = null;
    worker.tcpAoProxy = null;
    worker.storageStopping = false;
    worker.rpkiSessionMap = new Map();
    worker.closingRpkiSessions = new Set();
    worker.pendingTcpAoSockets = new Set();
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
    worker.createTcpAoProxy = () => fakeProxy;
    await worker.startTcpServer('tcp-ao-start');
    assert.equal(responses.get('tcp-ao-start').status, 'success', responses.get('tcp-ao-start').msg);
    assert.equal(worker.server.address(), workerForwardSocket);
    assert.equal(worker.rpkiConfigData.tcpAo.keys[0].key, '<redacted>');
    assert.equal(
        workerRuntimeProfile.keys[0].key,
        '<redacted>',
        'worker retained its original plaintext key reference'
    );
    assert.equal(workerForwardCapability.equals(worker.tcpAoForwardCapability), true);
    assert.equal(require('node:fs').statSync(workerForwardDirectory).mode & 0o777, 0o700);
    assert.equal(require('node:fs').statSync(workerForwardSocket).mode & 0o777, 0o600);
    const internalServer = worker.server;
    worker.server = null;
    await worker.closeTcpServer(internalServer, 'test internal server');
    await fakeProxy.stop();
    worker.cleanupTcpAoForwardEndpoint();
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

    console.log('RPKI TCP-AO proxy wrapper tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
