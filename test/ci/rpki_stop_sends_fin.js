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
    worker.storageMutationQueue = Promise.resolve();
    worker.storageStopping = false;
    worker.activeImportClients = new Set();
    worker.closingRpkiSessions = new Set();
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

        const shutdownOrder = [];
        const listeningServer = worker.server;
        listeningServer.once('close', () => shutdownOrder.push('server-close'));
        let snapshotStartedResolve;
        const snapshotStarted = new Promise(resolve => {
            snapshotStartedResolve = resolve;
        });
        worker.createDataSnapshot = async () => {
            worker.activeDataSnapshots = 1;
            snapshotStartedResolve();
            await delay(30);
            return { cacheSerial: 1, routerKeys: [] };
        };
        worker.iterateRoas = () => [];
        worker.iterateAspas = () => [];
        worker.closeDataSnapshot = async () => {
            await delay(30);
            worker.activeDataSnapshots = 0;
            shutdownOrder.push('snapshot-close');
        };
        worker.rpkiDatabasePath = '/controlled/rpki.sqlite3';
        worker.rpkiStore = {
            close() {
                assert.strictEqual(worker.activeDataSnapshots, 0, 'SQLite store must close after active snapshots');
                shutdownOrder.push('store-close');
            }
        };
        const originalSuccessResponse = worker.messageHandler.sendSuccessResponse.bind(worker.messageHandler);
        worker.messageHandler.sendSuccessResponse = (messageId, data, msg) => {
            if (messageId === 'stop-rpki') shutdownOrder.push('stop-response');
            originalSuccessResponse(messageId, data, msg);
        };

        const session = worker.rpkiSessionMap.values().next().value;
        session.sendResetQueryResponse();
        await snapshotStarted;
        await worker.stopRpki('stop-rpki');
        const response = worker.messageHandler.responses.get('stop-rpki');

        assert.strictEqual(response?.status, 'success', 'stopRpki should report success');
        assert.strictEqual(worker.rpkiSessionMap.size, 0, 'stopRpki should clear rpkiSessionMap');
        assert.strictEqual(worker.server, null, 'stopRpki should clear server reference');
        assert.ok(
            shutdownOrder.indexOf('server-close') < shutdownOrder.indexOf('stop-response'),
            'STOP response must wait for the TCP listener close callback'
        );
        assert.ok(
            shutdownOrder.indexOf('snapshot-close') < shutdownOrder.indexOf('store-close'),
            'SQLite snapshot finally must settle before the main store closes'
        );
        assert.ok(
            shutdownOrder.indexOf('store-close') < shutdownOrder.indexOf('stop-response'),
            'STOP response must wait for the SQLite store to close'
        );
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

        const unlistenedWorker = createWorker(port);
        unlistenedWorker.server = net.createServer();
        await unlistenedWorker.stopRpki('stop-unlistened');
        assert.strictEqual(
            unlistenedWorker.messageHandler.responses.get('stop-unlistened')?.status,
            'success',
            'STOP should tolerate an unlistened server'
        );

        const alreadyClosedWorker = createWorker(port);
        alreadyClosedWorker.server = listeningServer;
        await alreadyClosedWorker.stopRpki('stop-already-closed');
        assert.strictEqual(
            alreadyClosedWorker.messageHandler.responses.get('stop-already-closed')?.status,
            'success',
            'STOP should tolerate an already-closed server'
        );

        const controlledWorker = createWorker(port);
        const controlledOrder = [];
        let releaseImportTermination;
        const importTerminationGate = new Promise(resolve => {
            releaseImportTermination = resolve;
        });
        controlledWorker.activeImportClients.add({
            async terminate() {
                controlledOrder.push('import-terminate-start');
                await importTerminationGate;
                controlledOrder.push('import-terminate-done');
            }
        });
        let releaseStorageQueue;
        controlledWorker.storageMutationQueue = new Promise(resolve => {
            releaseStorageQueue = () => {
                controlledOrder.push('storage-drain');
                resolve();
            };
        });
        controlledWorker.rpkiDatabasePath = '/controlled/pending.sqlite3';
        controlledWorker.rpkiStore = {
            close() {
                controlledOrder.push('store-close');
            }
        };
        const controlledSuccess = controlledWorker.messageHandler.sendSuccessResponse.bind(
            controlledWorker.messageHandler
        );
        controlledWorker.messageHandler.sendSuccessResponse = (messageId, data, msg) => {
            if (messageId === 'stop-controlled') controlledOrder.push('stop-response');
            controlledSuccess(messageId, data, msg);
        };

        const controlledStop = controlledWorker.stopRpki('stop-controlled');
        await waitFor(
            () => controlledOrder.includes('import-terminate-start'),
            'STOP did not terminate the active import client'
        );
        assert.strictEqual(controlledWorker.storageStopping, true, 'STOP must close the storage request gate first');
        await controlledWorker.getRoaList('query-during-stop', { page: 1, pageSize: 1 });
        assert.match(
            controlledWorker.messageHandler.responses.get('query-during-stop')?.msg || '',
            /正在停止/,
            'new DB requests must be rejected while STOP drains work'
        );
        assert.strictEqual(
            controlledWorker.messageHandler.responses.has('stop-controlled'),
            false,
            'STOP must not respond while import termination is pending'
        );

        releaseImportTermination();
        await waitFor(
            () => controlledOrder.includes('import-terminate-done'),
            'active import termination did not finish'
        );
        assert.strictEqual(
            controlledWorker.messageHandler.responses.has('stop-controlled'),
            false,
            'STOP must not respond while the accepted storage queue is pending'
        );
        releaseStorageQueue();
        await controlledStop;
        assert.deepStrictEqual(
            controlledOrder,
            ['import-terminate-start', 'import-terminate-done', 'storage-drain', 'store-close', 'stop-response'],
            'STOP must terminate imports, drain storage, close SQLite, then respond'
        );

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
