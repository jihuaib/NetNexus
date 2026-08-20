const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const RpkiSession = require('../../electron/worker/rpki/rpkiSession');
const RpkiWorker = require('../../electron/worker/rpki/rpkiWorker');
const {
    TCP_AUTH_FORWARD_CAPABILITY_BYTES,
    TCP_AUTH_FORWARD_HEADER_BYTES,
    decodeTcpAuthForwardHeader,
    encodeTcpAuthForwardHeader
} = require('../../electron/worker/core/tcpAuthForwardProtocol');

const TEST_TIMEOUT_MS = 3000;

function profile() {
    return {
        id: 'router-a',
        name: 'Router A',
        peer: '192.0.2.0/24',
        keys: [
            {
                id: 'key-1',
                algorithm: 'hmac(sha1)',
                sndId: 1,
                rcvId: 1,
                key: 'worker plaintext test key',
                macLength: 12,
                acceptStart: null,
                sendStart: null,
                sendEnd: null,
                acceptEnd: null
            }
        ]
    };
}

function delay(milliseconds = 10) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, label) {
    const deadline = Date.now() + TEST_TIMEOUT_MS;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await delay();
    }
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
        });
    });
}

async function unusedTcpPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await closeServer(server);
    return port;
}

function connectUnix(socketPath) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        const onError = error => {
            socket.removeListener('connect', onConnect);
            reject(error);
        };
        const onConnect = () => {
            socket.removeListener('error', onError);
            // Rejections by the worker can surface as ECONNRESET on the client.
            socket.on('error', () => {});
            resolve(socket);
        };
        socket.once('error', onError);
        socket.once('connect', onConnect);
    });
}

function waitForSocketClose(socket) {
    if (socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('socket did not close')), TEST_TIMEOUT_MS);
        socket.once('close', () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

async function sendRejected(socketPath, chunks) {
    const socket = await connectUnix(socketPath);
    const closed = waitForSocketClose(socket);
    for (const chunk of chunks) {
        socket.write(chunk);
        await delay();
    }
    socket.end();
    await closed;
}

async function assertTcpBypassClosed(port) {
    await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('loopback bypass check timed out'));
        }, TEST_TIMEOUT_MS);
        socket.once('connect', () => {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error('worker exposed an unauthenticated loopback TCP listener'));
        });
        socket.once('error', error => {
            clearTimeout(timeout);
            if (error.code === 'ECONNREFUSED') resolve();
            else reject(error);
        });
    });
}

function makeWorker(publicPort, proxy) {
    const worker = Object.create(RpkiWorker.prototype);
    const responses = new Map();
    worker.server = null;
    worker.ipv6Server = null;
    worker.tcpAuthProxy = null;
    worker.tcpAuthSocketDirectory = null;
    worker.tcpAuthSocketPath = null;
    worker.tcpAuthSocketIdentity = null;
    worker.tcpAuthForwardCapability = null;
    worker.tcpAuthForwardHeaderTimeoutMs = 75;
    worker.pendingTcpAuthSockets = new Set();
    worker.storageStopping = false;
    worker.rpkiStore = null;
    worker.rpkiDatabasePath = null;
    worker.rpkiSessionMap = new Map();
    worker.rpkiRouterKeyMap = new Map();
    worker.closingRpkiSessions = new Set();
    worker.rpkiConfigData = {
        port: publicPort,
        authType: 'tcp-ao',
        tcpAo: profile()
    };
    worker.messageHandler = {
        sendSuccessResponse(messageId, data, message) {
            responses.set(messageId, { status: 'success', data, message });
        },
        sendErrorResponse(messageId, message) {
            responses.set(messageId, { status: 'error', message });
        },
        sendEvent() {}
    };
    worker.createTcpAuthProxy = () => proxy;
    worker.createdSessions = [];
    worker.createRpkiSession = function createTestSession(socket, remoteAddress, remotePort, localAddress, localPort) {
        const key = RpkiSession.makeKey(localAddress, localPort, remoteAddress, remotePort);
        const session = {
            socket,
            localIp: localAddress,
            localPort,
            remoteIp: remoteAddress,
            remotePort,
            received: [],
            closed: false,
            recvMsg(data) {
                this.received.push(Buffer.from(data));
            },
            closeSession: () => {
                if (session.closed) return Promise.resolve();
                session.closed = true;
                if (worker.rpkiSessionMap.get(key) === session) worker.rpkiSessionMap.delete(key);
                socket.destroy();
                return Promise.resolve();
            }
        };
        const oldSession = worker.rpkiSessionMap.get(key);
        oldSession?.closeSession();
        worker.rpkiSessionMap.set(key, session);
        worker.createdSessions.push(session);
        return session;
    };
    return { worker, responses };
}

function testForwardProtocol() {
    const capability = Buffer.alloc(TCP_AUTH_FORWARD_CAPABILITY_BYTES, 0xa5);
    const ipv4Header = encodeTcpAuthForwardHeader({
        family: 4,
        remoteAddress: '192.0.2.9',
        remotePort: 49152,
        localAddress: '198.51.100.7',
        localPort: 8282,
        capability
    });
    assert.equal(ipv4Header.length, TCP_AUTH_FORWARD_HEADER_BYTES);
    assert.deepEqual(decodeTcpAuthForwardHeader(ipv4Header, capability), {
        family: 4,
        remoteAddress: '192.0.2.9',
        remotePort: 49152,
        localAddress: '198.51.100.7',
        localPort: 8282
    });

    const ipv6Header = encodeTcpAuthForwardHeader({
        family: 6,
        remoteAddress: '2001:db8::9',
        remotePort: 49153,
        localAddress: '2001:db8:1::7',
        localPort: 8282,
        capability
    });
    assert.deepEqual(decodeTcpAuthForwardHeader(ipv6Header, capability), {
        family: 6,
        remoteAddress: '2001:db8::9',
        remotePort: 49153,
        localAddress: '2001:db8:1::7',
        localPort: 8282
    });

    assert.throws(
        () => decodeTcpAuthForwardHeader(ipv4Header, Buffer.alloc(TCP_AUTH_FORWARD_CAPABILITY_BYTES, 0x5a)),
        /内部通道认证失败/
    );
    for (const [offset, value, expected] of [
        [0, 0, /魔数/],
        [4, 2, /版本/],
        [5, 5, /地址族/],
        [7, 0, /声明长度/],
        [12, 1, /保留字段/],
        [16, 1, /IPv4地址填充/]
    ]) {
        const malformed = Buffer.from(ipv4Header);
        malformed[offset] = value;
        assert.throws(() => decodeTcpAuthForwardHeader(malformed, capability), expected);
    }
    assert.throws(() => decodeTcpAuthForwardHeader(ipv4Header.subarray(0, 79), capability), /长度/);
    assert.throws(
        () =>
            encodeTcpAuthForwardHeader({
                family: 6,
                remoteAddress: '::ffff:192.0.2.9',
                remotePort: 49154,
                localAddress: '::1',
                localPort: 8282,
                capability
            }),
        /地址族不匹配/
    );
}

class DelayedSocket extends EventEmitter {
    constructor() {
        super();
        this.localAddress = '198.51.100.10';
        this.localPort = 8282;
        this.remoteAddress = '192.0.2.10';
        this.remotePort = 50000;
        this.destroyed = false;
    }

    destroy() {
        this.destroyed = true;
    }
}

async function testSessionOwnershipRace() {
    const worker = Object.create(RpkiWorker.prototype);
    worker.storageStopping = false;
    worker.rpkiSessionMap = new Map();
    worker.closingRpkiSessions = new Set();
    worker.rpkiConfigData = {};
    worker.messageHandler = { sendEvent() {} };

    const oldSocket = new DelayedSocket();
    const oldSession = worker.attachClientSocket(oldSocket, 'test');
    let oldMessages = 0;
    oldSession.recvMsg = () => {
        oldMessages += 1;
    };

    const newSocket = new DelayedSocket();
    const newSession = worker.attachClientSocket(newSocket, 'test');
    let newMessages = 0;
    newSession.recvMsg = () => {
        newMessages += 1;
    };
    const key = RpkiSession.makeKey('198.51.100.10', 8282, '192.0.2.10', 50000);

    oldSocket.emit('data', Buffer.from([0xde, 0xad]));
    oldSocket.emit('close');
    assert.equal(oldMessages, 0, 'delayed data from the replaced socket reached a session');
    assert.equal(newMessages, 0, 'delayed data from the old socket poisoned the new session');
    assert.equal(worker.rpkiSessionMap.get(key), newSession, 'old close removed the replacement session');
    assert.equal(newSession.closed, false);

    newSocket.emit('data', Buffer.from([0xbe, 0xef]));
    assert.equal(newMessages, 1, 'the replacement socket no longer owns its session');
    await newSession.closeSession();
}

function invalidLengthPdu(length) {
    const pdu = Buffer.alloc(8);
    pdu[0] = 1;
    pdu[1] = 2;
    pdu.writeUInt32BE(length, 4);
    return pdu;
}

function makeLengthTestSession() {
    const socket = {
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    };
    const session = new RpkiSession({ sendEvent() {} }, { removeRpkiSession() {} });
    session.socket = socket;
    session.localIp = '198.51.100.10';
    session.localPort = 8282;
    session.remoteIp = '192.0.2.10';
    session.remotePort = 50000;
    return { session, socket };
}

function testPduLengthBounds() {
    for (const length of [0, 7, RpkiSession.MAX_RPKI_PDU_BYTES + 1]) {
        const { session, socket } = makeLengthTestSession();
        session.recvMsg(invalidLengthPdu(length));
        assert.equal(session.closed, true, `invalid PDU length ${length} did not close the session`);
        assert.equal(socket.destroyed, true, `invalid PDU length ${length} did not destroy the socket`);
        assert.equal(session.messageBuffer.length, 0);
    }
}

async function testWorkerForwarding() {
    const publicPort = await unusedTcpPort();
    let startupOptions;
    const proxy = new EventEmitter();
    proxy.start = options => {
        startupOptions = options;
        return Promise.resolve({ status: 'ready', listenPort: publicPort, families: ['ipv4'], aoRequired: true });
    };
    proxy.stop = async () => {};
    const { worker, responses } = makeWorker(publicPort, proxy);
    const clients = [];
    let forwardDirectory;
    try {
        await worker.startTcpServer('start');
        assert.equal(responses.get('start')?.status, 'success', responses.get('start')?.message);
        assert.equal(startupOptions.forwardSocket, worker.tcpAuthSocketPath);
        assert.equal(startupOptions.forwardCapability, worker.tcpAuthForwardCapability);
        assert.equal(startupOptions.profiles[0].keys[0].key, '<redacted>');
        assert.equal(worker.rpkiConfigData.tcpAo.keys[0].key, '<redacted>');

        forwardDirectory = worker.tcpAuthSocketDirectory;
        assert.equal(fs.statSync(forwardDirectory).mode & 0o777, 0o700);
        assert.equal(fs.statSync(worker.tcpAuthSocketPath).mode & 0o777, 0o600);
        await assertTcpBypassClosed(publicPort);

        const resetQuery = Buffer.from('0102000000000008', 'hex');
        await sendRejected(worker.tcpAuthSocketPath, [resetQuery]);
        assert.equal(worker.createdSessions.length, 0, 'raw loopback RPKI PDU bypassed the peer header');

        const validHeader = encodeTcpAuthForwardHeader({
            family: 4,
            remoteAddress: '192.0.2.55',
            remotePort: 50000,
            localAddress: '198.51.100.10',
            localPort: publicPort,
            capability: worker.tcpAuthForwardCapability
        });
        const wrongTokenHeader = Buffer.from(validHeader);
        wrongTokenHeader.fill(0, 48, 80);
        await sendRejected(worker.tcpAuthSocketPath, [wrongTokenHeader]);
        await sendRejected(worker.tcpAuthSocketPath, [validHeader.subarray(0, 79)]);
        const timedOutClient = await connectUnix(worker.tcpAuthSocketPath);
        timedOutClient.write(validHeader.subarray(0, 1));
        await waitForSocketClose(timedOutClient);
        const wrongPeerHeader = encodeTcpAuthForwardHeader({
            family: 4,
            remoteAddress: '203.0.113.9',
            remotePort: 50001,
            localAddress: '198.51.100.10',
            localPort: publicPort,
            capability: worker.tcpAuthForwardCapability
        });
        await sendRejected(worker.tcpAuthSocketPath, [wrongPeerHeader]);
        const wrongLocalPortHeader = encodeTcpAuthForwardHeader({
            family: 4,
            remoteAddress: '192.0.2.57',
            remotePort: 50002,
            localAddress: '198.51.100.10',
            localPort: publicPort === 65535 ? 65534 : publicPort + 1,
            capability: worker.tcpAuthForwardCapability
        });
        await sendRejected(worker.tcpAuthSocketPath, [wrongLocalPortHeader]);
        assert.equal(worker.createdSessions.length, 0, 'malformed or unauthenticated headers created sessions');

        const client = await connectUnix(worker.tcpAuthSocketPath);
        clients.push(client);
        client.write(Buffer.concat([validHeader, resetQuery]));
        await waitFor(() => worker.createdSessions.length === 1, 'valid forwarded session');
        const firstSession = worker.createdSessions[0];
        assert.deepEqual(
            {
                remoteAddress: firstSession.remoteIp,
                remotePort: firstSession.remotePort,
                localAddress: firstSession.localIp,
                localPort: firstSession.localPort
            },
            {
                remoteAddress: '192.0.2.55',
                remotePort: 50000,
                localAddress: '198.51.100.10',
                localPort: publicPort
            },
            'authenticated peer metadata was not preserved'
        );
        assert.equal(firstSession.received.length, 1);
        assert.deepEqual(firstSession.received[0], resetQuery, 'first RPKI PDU bytes were lost after the peer header');

        const fragmentedHeader = encodeTcpAuthForwardHeader({
            family: 4,
            remoteAddress: '192.0.2.56',
            remotePort: 50001,
            localAddress: '198.51.100.10',
            localPort: publicPort,
            capability: worker.tcpAuthForwardCapability
        });
        const fragmentedClient = await connectUnix(worker.tcpAuthSocketPath);
        clients.push(fragmentedClient);
        fragmentedClient.write(fragmentedHeader.subarray(0, 79));
        await delay(25);
        fragmentedClient.write(Buffer.concat([fragmentedHeader.subarray(79), resetQuery]));
        await waitFor(() => worker.createdSessions.length === 2, 'fragmented forwarded session');
        assert.deepEqual(
            worker.createdSessions[1].received,
            [resetQuery],
            'fragmented header consumed first PDU bytes'
        );
    } finally {
        for (const client of clients) client.destroy();
        for (const session of worker.rpkiSessionMap.values()) await session.closeSession();
        worker.destroyPendingTcpAuthSockets();
        const server = worker.server;
        worker.server = null;
        if (server) await worker.closeTcpServer(server, 'test Unix server');
        worker.cleanupTcpAuthForwardEndpoint();
    }
    assert.equal(fs.existsSync(forwardDirectory), false, 'normal stop left the private socket directory behind');
    assert.equal(
        startupOptions.forwardCapability.every(byte => byte === 0),
        true,
        'normal stop did not wipe capability'
    );
}

async function testStartupFailureCleanup() {
    const publicPort = await unusedTcpPort();
    let startupOptions;
    const proxy = new EventEmitter();
    proxy.start = options => {
        startupOptions = options;
        return Promise.reject(new Error('synthetic helper failure'));
    };
    proxy.stop = async () => {};
    const { worker, responses } = makeWorker(publicPort, proxy);
    await worker.startTcpServer('failed-start');
    assert.equal(responses.get('failed-start')?.status, 'error');
    assert.match(responses.get('failed-start')?.message || '', /synthetic helper failure/);
    assert.equal(fs.existsSync(startupOptions.forwardSocket), false, 'startup failure left the Unix socket behind');
    assert.equal(
        fs.existsSync(startupOptions.forwardSocket.slice(0, -'/r.sock'.length)),
        false,
        'startup failure left the private directory behind'
    );
    assert.equal(
        startupOptions.forwardCapability.every(byte => byte === 0),
        true
    );
    assert.equal(startupOptions.profiles[0].keys[0].key, '<redacted>');
}

async function main() {
    testForwardProtocol();
    await testSessionOwnershipRace();
    testPduLengthBounds();
    if (process.platform === 'win32') {
        console.log('RPKI TCP auth Unix forwarding tests skipped on Windows');
        return;
    }
    await testWorkerForwarding();
    await testStartupFailureCleanup();
    console.log('RPKI TCP auth private forwarding tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
