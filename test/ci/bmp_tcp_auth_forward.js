const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const TcpAuthForwardingServer = require('../../electron/worker/core/tcpAuthForwardingServer');
const {
    TCP_AUTH_FORWARD_CAPABILITY_BYTES,
    encodeTcpAuthForwardHeader
} = require('../../electron/worker/core/tcpAuthForwardProtocol');

const TEST_TIMEOUT_MS = 3000;

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
            // Header rejection may be reported to the client as ECONNRESET.
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
            reject(new Error('plaintext BMP listener check timed out'));
        }, TEST_TIMEOUT_MS);
        socket.once('connect', () => {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error('TCP-AO mode exposed an unauthenticated BMP listener'));
        });
        socket.once('error', error => {
            clearTimeout(timeout);
            if (error.code === 'ECONNREFUSED') resolve();
            else reject(error);
        });
    });
}

function tcpAoProfile() {
    return {
        id: 'bmp-router-a',
        name: 'BMP Router A',
        peer: '192.0.2.0/24',
        keys: [
            {
                id: 'bmp-key-1',
                algorithm: 'hmac(sha1)',
                sndId: 1,
                rcvId: 1,
                key: 'bmp worker plaintext test key',
                macLength: 12,
                acceptStart: null,
                sendStart: null,
                sendEnd: null,
                acceptEnd: null
            }
        ]
    };
}

function makeWorker(publicPort, proxy) {
    const BmpWorker = loadBmpWorkerClass(__dirname, module);
    const worker = Object.create(BmpWorker.prototype);
    const responses = new Map();
    const events = [];
    const createdSessions = [];
    let plainListenerFactoryCalls = 0;

    worker.server = null;
    worker.ipv6Server = null;
    worker.tcpAuthForwardingServer = null;
    worker.tcpAoRuntimeFailure = null;
    worker.bmpStopping = false;
    worker.bmpConfigData = {
        port: publicPort,
        authType: 'tcp-ao',
        tcpAoProfiles: [tcpAoProfile()]
    };
    worker.bmpSessionMap = new Map();
    worker.clientDeleteRemoteIpGates = new Map();
    worker.persistenceFailure = null;
    worker.persistence = null;
    worker.bmpSocketsPaused = false;
    worker.routeAssuranceService = null;
    worker.messageHandler = {
        sendSuccessResponse(messageId, data, message) {
            responses.set(messageId, { status: 'success', data, message });
        },
        sendErrorResponse(messageId, message) {
            responses.set(messageId, { status: 'error', message });
        },
        sendEvent(type, payload) {
            events.push({ type, payload });
        }
    };

    const createBmpSession = BmpWorker.prototype.createBmpSession;
    worker.createBmpSession = function createTestBmpSession(...args) {
        const session = createBmpSession.apply(this, args);
        if (!session) return session;
        session.received = [];
        session.recvMsg = data => session.received.push(Buffer.from(data));
        createdSessions.push(session);
        return session;
    };
    worker.startPlainTcpServers = async () => {
        plainListenerFactoryCalls += 1;
        throw new Error('TCP-AO mode must not create plaintext BMP listeners');
    };
    worker.createTcpAuthForwardingServer = () =>
        new TcpAuthForwardingServer({
            serviceName: 'BMP',
            directoryPrefix: 'nn-bmp-ao-ci-',
            headerTimeoutMs: 75,
            createProxy: () => proxy
        });

    return {
        worker,
        responses,
        events,
        createdSessions,
        getPlainListenerFactoryCalls: () => plainListenerFactoryCalls
    };
}

async function testBmpTcpAoForwarding() {
    const publicPort = await unusedTcpPort();
    let startupOptions = null;
    let reloadOptions = null;
    const proxy = new EventEmitter();
    proxy.start = async options => {
        startupOptions = options;
        return {
            status: 'ready',
            listenPort: publicPort,
            families: ['ipv4'],
            aoRequired: true
        };
    };
    proxy.reload = async options => {
        reloadOptions = JSON.parse(JSON.stringify(options));
        return {
            requestId: 1,
            profileCount: 1,
            keyCount: 1,
            installedKeyCount: 1,
            disconnectedConnections: 0,
            activeSocketUpdate: 'update-or-safe-reconnect'
        };
    };
    proxy.stop = async () => {};

    const { worker, responses, createdSessions, getPlainListenerFactoryCalls } = makeWorker(publicPort, proxy);
    const clients = [];
    let forwardDirectory = null;
    let forwardCapability = null;
    try {
        await worker.startTcpServer('start');
        assert.equal(responses.get('start')?.status, 'success', responses.get('start')?.message);
        assert.ok(startupOptions, 'BMP AO forwarding server did not start its helper proxy');
        assert.equal(getPlainListenerFactoryCalls(), 0, 'AO mode invoked the plaintext listener factory');
        assert.equal(worker.server, null, 'AO mode created an IPv4 plaintext BMP listener');
        assert.equal(worker.ipv6Server, null, 'AO mode created an IPv6 plaintext BMP listener');
        await assertTcpBypassClosed(publicPort);

        forwardDirectory = path.dirname(startupOptions.forwardSocket);
        forwardCapability = startupOptions.forwardCapability;
        assert.equal(fs.statSync(forwardDirectory).mode & 0o777, 0o700);
        assert.equal(fs.statSync(startupOptions.forwardSocket).mode & 0o777, 0o600);
        assert.equal(forwardCapability.length, TCP_AUTH_FORWARD_CAPABILITY_BYTES);

        const reloadProfile = tcpAoProfile();
        reloadProfile.keys[0].key = 'bmp replacement runtime key';
        await worker.reloadTcpAoProfiles('reload', { profiles: [reloadProfile] });
        assert.equal(responses.get('reload')?.status, 'success', responses.get('reload')?.message);
        assert.equal(reloadOptions.profiles[0].keys[0].key, 'bmp replacement runtime key');
        assert.equal(reloadProfile.keys.length, 0, 'BMP worker reload input retained plaintext key material');
        assert.equal(worker.bmpConfigData.tcpAoProfiles[0].keys[0].key, '<redacted>');

        const validHeader = encodeTcpAuthForwardHeader({
            family: 4,
            remoteAddress: '192.0.2.55',
            remotePort: 50000,
            localAddress: '198.51.100.8',
            localPort: publicPort,
            capability: forwardCapability
        });

        const wrongCapability = Buffer.from(validHeader);
        wrongCapability[48] ^= 0xff;
        await sendRejected(startupOptions.forwardSocket, [wrongCapability]);

        const wrongAddress = encodeTcpAuthForwardHeader({
            family: 4,
            remoteAddress: '203.0.113.9',
            remotePort: 50001,
            localAddress: '198.51.100.8',
            localPort: publicPort,
            capability: forwardCapability
        });
        await sendRejected(startupOptions.forwardSocket, [wrongAddress]);

        const wrongPort = encodeTcpAuthForwardHeader({
            family: 4,
            remoteAddress: '192.0.2.56',
            remotePort: 50002,
            localAddress: '198.51.100.8',
            localPort: publicPort === 65535 ? 65534 : publicPort + 1,
            capability: forwardCapability
        });
        await sendRejected(startupOptions.forwardSocket, [wrongPort]);
        await sendRejected(startupOptions.forwardSocket, [validHeader.subarray(0, validHeader.length - 1)]);
        assert.equal(createdSessions.length, 0, 'an invalid forwarding header reached the BMP attach path');

        const trailingBmpBytes = Buffer.from([3, 0, 0, 0, 6, 4]);
        const client = await connectUnix(startupOptions.forwardSocket);
        clients.push(client);
        client.write(validHeader.subarray(0, 11));
        await delay(15);
        client.write(validHeader.subarray(11, 63));
        await delay(15);
        client.write(Buffer.concat([validHeader.subarray(63), trailingBmpBytes]));
        await waitFor(() => createdSessions.length === 1, 'authenticated BMP session');

        const session = createdSessions[0];
        assert.deepEqual(
            {
                remoteAddress: session.remoteIp,
                remotePort: session.remotePort,
                localAddress: session.localIp,
                localPort: session.localPort
            },
            {
                remoteAddress: '192.0.2.55',
                remotePort: 50000,
                localAddress: '198.51.100.8',
                localPort: publicPort
            },
            'BMP session did not use the authenticated public endpoint metadata'
        );
        assert.equal(session.transport, 'tcp-ao');
        assert.equal(session.authentication, 'tcp-ao');
        assert.equal(session.tcpAoProfileId, 'bmp-router-a');
        assert.equal(session.tcpAoProfileName, 'BMP Router A');
        assert.equal(session.tcpAoPeer, '192.0.2.0/24');
        assert.deepEqual(
            session.received,
            [trailingBmpBytes],
            'trailing BMP bytes were lost after the fragmented header'
        );

        const expectedKey = BmpSession.makeKey('198.51.100.8', publicPort, '192.0.2.55', 50000);
        assert.equal(
            worker.bmpSessionMap.get(expectedKey),
            session,
            'authenticated endpoint did not own the BMP session'
        );
    } finally {
        for (const session of Array.from(worker.bmpSessionMap.values())) session.closeSession();
        for (const client of clients) client.destroy();
        await worker.closeTcpServers();
    }

    assert.equal(fs.existsSync(forwardDirectory), false, 'normal stop left the private forwarding directory behind');
    assert.equal(
        forwardCapability.every(byte => byte === 0),
        true,
        'normal stop did not wipe the forwarding capability'
    );
}

async function main() {
    if (process.platform === 'win32') {
        console.log('BMP TCP auth private forwarding tests skipped on Windows (Unix sockets are Linux-only)');
        return;
    }
    await testBmpTcpAoForwarding();
    console.log('BMP TCP auth private forwarding tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
