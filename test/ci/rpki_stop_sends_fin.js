const assert = require('assert');
const net = require('net');
const path = require('path');

process.env.NODE_ENV = 'test';

const RpkiWorker = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'rpki', 'rpkiWorker.js'));
const RpkiSession = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'rpki', 'rpkiSession.js'));
const RpkiConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'rpkiConst.js'));

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await delay(20);
    }
    throw new Error(message);
}

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

class CaptureMessageHandler {
    constructor() {
        this.responses = new Map();
        this.events = [];
    }

    sendSuccessResponse(messageId, data = null, msg = '') {
        this.responses.set(messageId, { status: 'success', msg, data });
    }

    sendErrorResponse(messageId, msg = '', data = null) {
        this.responses.set(messageId, { status: 'error', msg, data });
    }

    sendEvent(type, payload = null) {
        this.events.push({ type, payload });
    }
}

function createWorker(port) {
    const worker = Object.create(RpkiWorker.prototype);
    worker.server = null;
    worker.ipv6Server = null;
    worker.socket = null;
    worker.rpkiConfigData = {
        port,
        maxProtocolVersion: RpkiConst.RPKI_PROTOCOL_VERSION.V2
    };
    worker.rpkiSessionMap = new Map();
    worker.rpkiRouterKeyMap = new Map();
    worker.rpkiDatabasePath = null;
    worker.rpkiStore = null;
    worker.cacheSerial = 1;
    worker.serialHistory = [];
    worker.serialHistoryOperationCount = 0;
    worker.maxSerialHistoryEntries = 1024;
    worker.maxSerialHistoryOperations = 200000;
    worker.messageHandler = new CaptureMessageHandler();
    return worker;
}

async function startIpv4Server(worker, port) {
    const server = net.createServer(socket => {
        const sessionKey = RpkiSession.makeKey(
            socket.localAddress,
            socket.localPort,
            socket.remoteAddress,
            socket.remotePort
        );

        worker.createRpkiSession(socket, socket.remoteAddress, socket.remotePort);

        socket.on('data', data => {
            const session = worker.rpkiSessionMap.get(sessionKey);
            if (session) {
                session.recvMsg(data);
            }
        });
        socket.on('end', () => {
            const session = worker.rpkiSessionMap.get(sessionKey);
            if (session) {
                session.closeSession({ destroySocket: false });
            }
        });
        socket.on('close', () => {
            const session = worker.rpkiSessionMap.get(sessionKey);
            if (session) {
                session.closeSession({ destroySocket: false });
            }
        });
        socket.on('error', () => {
            const session = worker.rpkiSessionMap.get(sessionKey);
            if (session) {
                session.closeSession({ destroySocket: false });
            }
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    worker.server = server;
}

async function main() {
    const port = await getFreePort();
    const worker = createWorker(port);
    await startIpv4Server(worker, port);

    const clientEvents = [];
    const client = net.createConnection({ host: '127.0.0.1', port });
    client.on('error', error => clientEvents.push(`error:${error.code || error.message}`));
    const connected = new Promise((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
    });
    const endReceived = new Promise(resolve => {
        client.once('end', () => {
            clientEvents.push('end');
            resolve();
        });
    });
    const closeReceived = new Promise(resolve => {
        client.once('close', hadError => {
            clientEvents.push(`close:${hadError}`);
            resolve();
        });
    });

    try {
        await connected;
        await waitFor(() => worker.rpkiSessionMap.size === 1, 'RPKI session was not registered');

        await worker.stopRpki('stop-rpki');
        const response = worker.messageHandler.responses.get('stop-rpki');

        assert.strictEqual(response?.status, 'success', 'stopRpki should report success');
        assert.strictEqual(worker.rpkiSessionMap.size, 0, 'stopRpki should clear rpkiSessionMap');
        assert.strictEqual(worker.server, null, 'stopRpki should clear server reference');
        assert.ok(
            clientEvents.includes('end'),
            `client should receive FIN/end before stopRpki responds, events=${clientEvents.join(',')}`
        );

        await Promise.race([
            endReceived,
            delay(1500).then(() => {
                throw new Error(`client did not receive FIN/end after stopRpki, events=${clientEvents.join(',')}`);
            })
        ]);
        await Promise.race([closeReceived, delay(1500)]);

        const eventOps = worker.messageHandler.events.map(event => event.payload?.opType).filter(Boolean);
        assert.deepStrictEqual(eventOps, ['add', 'delete'], 'stopRpki should publish add then delete events');
        assert.ok(clientEvents.includes('end'), `client should receive FIN/end, events=${clientEvents.join(',')}`);

        console.log(`RPKI stop FIN test: port=${port}, clientEvents=${clientEvents.join(',')}`);
        console.log('RPKI stop sends FIN test passed');
    } finally {
        client.destroy();
        if (worker.server) {
            await new Promise(resolve => worker.server.close(resolve));
            worker.server = null;
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
