const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const BmpConst = require('../../electron/const/bmpConst');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const ProtocolProcessHost = require('../../electron/worker/core/protocolProcessHost');
const { PROTOCOL_PROCESS_SERVICES } = require('../../electron/worker/core/protocolProcessServices');
const { builders } = require('../../scripts/mockBmpClient');

const PEER = { peerAddress: '192.0.2.2', peerAs: 65000, routerId: '192.0.2.1' };
const PREFIX = '203.0.113.0';
const LAST_PREFIX = '203.0.114.0';

function withTimeout(promise, label, milliseconds = 8000) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(label)), milliseconds);
        })
    ]).finally(() => clearTimeout(timer));
}

async function waitUntil(read, predicate, label) {
    const deadline = Date.now() + 8000;
    let latest;
    while (Date.now() < deadline) {
        latest = await read();
        if (predicate(latest)) return latest;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`${label}; last value: ${JSON.stringify(latest)}`);
}

function createRequester(host) {
    const pending = new Map();
    let sequence = 0;
    host.on('message', message => {
        const callback = pending.get(message.messageId);
        if (!callback) return;
        pending.delete(message.messageId);
        if (message.status === 'success') callback.resolve(message.data);
        else callback.reject(new Error(message.msg || 'BMP request failed'));
    });
    const rejectAll = error => {
        for (const callback of pending.values()) callback.reject(error);
        pending.clear();
    };
    host.on('error', rejectAll);
    host.on('exit', (code, signal) => rejectAll(new Error(`BMP exited: code=${code}, signal=${signal}`)));
    return (op, data = null) => {
        const messageId = `bmp-ingest-threads-${++sequence}`;
        const request = new Promise((resolve, reject) => {
            pending.set(messageId, { resolve, reject });
            host.postMessage({ messageId, op, data });
        });
        return withTimeout(request, `BMP request timed out: ${op}`).finally(() => pending.delete(messageId));
    };
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function routeMessage(prefix, nextHop) {
    return builders.routeMonitoringMessage(PEER, builders.ipv4Update([prefix], { nextHop }));
}

function connectionMessages(sysName, nextHop) {
    return Buffer.concat([
        builders.initiationMessage({ sysName }),
        builders.bmpMessage(BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, builders.peerUpPayload(PEER)),
        routeMessage(PREFIX, nextHop),
        builders.routeMonitoringMessage(PEER, builders.endOfRibUpdate())
    ]);
}

function connectSocket(port, sockets) {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    return withTimeout(
        new Promise((resolve, reject) => {
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
        }),
        'TCP connection timed out'
    );
}

function waitForClose(socket) {
    if (socket.destroyed) return Promise.resolve();
    return withTimeout(new Promise(resolve => socket.once('close', resolve)), 'TCP connection was not closed', 3000);
}

async function sendConnection(port, sockets, sysName, nextHop) {
    const socket = await connectSocket(port, sockets);
    const bytes = connectionMessages(sysName, nextHop);
    // Deliberately split a BMP header between TCP writes. A parser slot must
    // retain this connection's partial frame independently of the other slot.
    await new Promise((resolve, reject) =>
        socket.write(bytes.subarray(0, 3), error => (error ? reject(error) : resolve()))
    );
    await new Promise((resolve, reject) =>
        socket.write(bytes.subarray(3), error => (error ? reject(error) : resolve()))
    );
    return socket;
}

async function testParserPool() {
    const results = new Map();
    const closed = [];
    const errors = [];
    const pool = new BmpIngestClientPool({
        threadCount: 2,
        config: { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 },
        onResult(record, message) {
            assert.equal(message.threadId, record.threadId);
            if (!results.has(record.token)) results.set(record.token, []);
            results.get(record.token).push(message);
        },
        onClosed: record => closed.push(record.token),
        onError: error => errors.push(error)
    });
    const makeSession = index => ({
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 52000 + index,
        persistenceConnectionId: `pool-connection-${index}`,
        persistenceConnectionGeneration: 100 + index,
        persistenceOpenedAtMs: Date.now(),
        socket: {
            destroyed: false,
            pause() {},
            resume() {},
            destroy() {
                this.destroyed = true;
            }
        }
    });
    const attach = session =>
        pool.attach(session, {
            sessionKey: `127.0.0.1|11019|192.0.2.10|${session.remotePort}`,
            metadata: {
                localIp: session.localIp,
                localPort: session.localPort,
                remoteIp: session.remoteIp,
                remotePort: session.remotePort
            }
        });
    try {
        await pool.open();
        assert.equal(pool.getStatus().ingestWorkerCount, 2);
        const recordA = attach(makeSession(1));
        const recordB = attach(makeSession(2));
        assert.ok(recordA && recordB);
        assert.notEqual(recordA.threadId, recordB.threadId);
        assert.equal(pool.hasCapacity(), false);
        assert.equal(attach(makeSession(3)), null);
        const bytesA = connectionMessages('pool-client-a', '192.0.2.11');
        assert.equal(pool.send(recordA, bytesA.subarray(0, 3)), true);
        assert.equal(pool.send(recordB, connectionMessages('pool-client-b', '192.0.2.22')), true);
        await pool.fence();
        assert.notEqual(
            results.get(recordA.token).at(-1).snapshot.session.sysName,
            'pool-client-a',
            'a partial BMP header must not be parsed as a complete message'
        );
        assert.equal(
            results.get(recordB.token).at(-1).snapshot.session.sysName,
            'pool-client-b',
            'one slot partial frame must not block or corrupt another slot'
        );
        assert.equal(pool.send(recordA, bytesA.subarray(3)), true);
        await pool.fence();
        assert.equal(results.get(recordA.token).at(-1).snapshot.session.sysName, 'pool-client-a');

        assert.equal(pool.send(recordA, routeMessage(LAST_PREFIX, '192.0.2.11')), true);
        const closingA = pool.closeSession(recordA);
        assert.strictEqual(pool.closeSession(recordA), closingA);
        assert.equal(
            pool.hasCapacity(),
            false,
            'a closing slot must remain reserved until its FIFO close is acknowledged'
        );
        assert.equal(attach(makeSession(3)), null);
        assert.equal(pool.send(recordA, routeMessage(PREFIX, '192.0.2.99')), false);
        await closingA;
        assert.equal(pool.hasCapacity(), true);
        assert.deepEqual(closed, [recordA.token]);
        const mutationsA = results
            .get(recordA.token)
            .flatMap(message => message.actions || [])
            .filter(action => action.op === 'mutation')
            .map(action => action.mutation);
        const lastRouteIndex = mutationsA.findIndex(mutation => mutation.route?.prefix === LAST_PREFIX);
        const closeIndex = mutationsA.findIndex(mutation => mutation.eventType === 'connection_close');
        assert.ok(
            lastRouteIndex >= 0 && closeIndex > lastRouteIndex,
            'the last accepted route must precede connection_close'
        );

        const recordC = attach(makeSession(3));
        assert.ok(recordC);
        assert.equal(recordC.index, recordA.index);
        assert.equal(recordC.threadId, recordA.threadId);
        assert.notEqual(recordC.token, recordA.token);
        assert.equal(pool.send(recordA, bytesA), false, 'an old connection record must not write into a reused slot');
        await pool.closeSession(recordA);
        assert.equal(pool.getStatus().activeClientCount, 2, 'an old close must not close the new slot owner');
        assert.equal(pool.send(recordC, connectionMessages('pool-client-c', '192.0.2.33')), true);
        await pool.fence();
        assert.equal(results.get(recordC.token).at(-1).snapshot.session.sysName, 'pool-client-c');
        await pool.close();
        assert.equal(pool.getStatus().ingestWorkerCount, 0);
        assert.equal(pool.getStatus().activeClientCount, 0);
        assert.equal(pool.hasCapacity(), false);
        assert.equal(errors.length, 0);
    } finally {
        await pool.close().catch(() => {});
    }
}

async function main(testOptions = {}) {
    await testParserPool();
    if (testOptions.poolOnly || process.env.NETNEXUS_BMP_INGEST_POOL_ONLY === '1') {
        console.log(
            'BMP ingest parser pool tests passed: real threads, partial frames, close FIFO, slot limits and reuse'
        );
        return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-ingest-threads-'));
    const dbPath = path.join(directory, 'bmp.sqlite3');
    const port = await getFreePort();
    const host = new ProtocolProcessHost(path.join(__dirname, '../../electron/worker/bmp/bmpWorker.js'), {
        serviceName: PROTOCOL_PROCESS_SERVICES.BMP,
        utilityProcess: testOptions.utilityProcess
    });
    const request = createRequester(host);
    const sockets = new Set();
    let offline;
    let started = false;
    const status = () => request(BmpConst.BMP_REQ_TYPES.GET_PERSISTENCE_STATUS);
    const clients = () => request(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST);
    const routes = sourceId =>
        request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, {
            sourceId,
            routeState: 'all',
            pageSize: 100
        });
    try {
        await request(BmpConst.BMP_REQ_TYPES.START_BMP, {
            port,
            threadCount: 2,
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
            pathMarkingTlvType: BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
            persistenceEnabled: true,
            persistenceDbPath: dbPath,
            persistenceBatchSize: 64,
            persistenceFlushMs: 5
        });
        started = true;
        const initial = await status();
        assert.equal(initial.ingestWorkerCount, 2);
        assert.equal(initial.writerWorkerCount, 2, 'parser and SQLite Writer counts must use the same threadCount');
        assert.equal(initial.clientLimit, 2);
        assert.equal(initial.activeClientCount, 0);
        assert.equal(initial.ingestThreadIds.length, 2);
        assert.equal(new Set(initial.ingestThreadIds).size, 2);
        assert.ok(initial.ingestThreadIds.every(id => Number.isInteger(id) && id > 0));

        const [socketA, socketB] = await Promise.all([
            sendConnection(port, sockets, 'ingest-client-a', '192.0.2.11'),
            sendConnection(port, sockets, 'ingest-client-b', '192.0.2.22')
        ]);
        const originalPortA = socketA.localPort;
        const onlineClients = await waitUntil(
            clients,
            rows =>
                ['ingest-client-a', 'ingest-client-b'].every(name =>
                    rows.some(row => row.sysName === name && row.isOnline)
                ),
            'two parser connections must publish their topology'
        );
        const clientA = onlineClients.find(row => row.sysName === 'ingest-client-a');
        const clientB = onlineClients.find(row => row.sysName === 'ingest-client-b');
        assert.ok(clientA && clientB);
        const sourceA = clientA.persistentSourceId;
        const sourceB = clientB.persistentSourceId;
        assert.notEqual(sourceA, sourceB);
        const rowsA = await waitUntil(
            () => routes(sourceA),
            rows => rows.total === 1,
            'client A route missing'
        );
        const rowsB = await waitUntil(
            () => routes(sourceB),
            rows => rows.total === 1,
            'client B route missing'
        );
        assert.equal(rowsA.list[0].nextHop, '192.0.2.11');
        assert.equal(rowsB.list[0].nextHop, '192.0.2.22');
        assert.notEqual(rowsA.list[0].persistentScopeId, rowsB.list[0].persistentScopeId);
        const full = await status();
        assert.equal(full.activeClientCount, 2);
        assert.equal(full.clientThreads.length, 2);
        const threadA = full.clientThreads.find(row => row.remotePort === socketA.localPort);
        const threadB = full.clientThreads.find(row => row.remotePort === socketB.localPort);
        assert.ok(threadA && threadB, 'parser diagnostics must identify each accepted TCP connection');
        assert.notEqual(
            threadA.threadId,
            threadB.threadId,
            'simultaneous connections must have exclusive parser workers'
        );

        const rejected = await connectSocket(port, sockets);
        await waitForClose(rejected);
        assert.equal(rejected.destroyed, true, 'a third connection must be rejected immediately, not queued');
        assert.equal((await status()).activeClientCount, 2);
        assert.equal((await status()).clientDatabaseCount, 2, 'a rejected TCP connection must not create client data');

        const socketAClosed = waitForClose(socketA);
        socketA.end(
            Buffer.concat([
                routeMessage(LAST_PREFIX, '192.0.2.11'),
                builders.routeMonitoringMessage(PEER, builders.endOfRibUpdate())
            ])
        );
        await socketAClosed;
        await waitUntil(status, value => value.activeClientCount === 1, 'disconnect did not release the parser slot');
        const disconnectedA = await waitUntil(
            () => routes(sourceA),
            rows => rows.total === 2 && rows.list.every(row => row.routeState === 'stale'),
            'FIFO close lost the last TCP data or connection_close'
        );
        assert.ok(disconnectedA.list.some(row => row.ip === '203.0.114.0'));
        assert.equal((await routes(sourceB)).list[0].routeState, 'active', 'client A close must not stale client B');

        const socketC = await sendConnection(port, sockets, 'ingest-client-c', '192.0.2.44');
        const withClientC = await waitUntil(
            clients,
            rows => rows.some(row => row.sysName === 'ingest-client-c' && row.isOnline),
            'a new client did not acquire the released parser slot'
        );
        const sourceC = withClientC.find(row => row.sysName === 'ingest-client-c').persistentSourceId;
        await waitUntil(
            () => routes(sourceC),
            rows => rows.total === 1,
            'new client C route missing'
        );
        assert.equal((await status()).clientDatabaseCount, 3, 'threadCount must not cap historical client databases');
        const socketCClosed = waitForClose(socketC);
        socketC.end();
        await socketCClosed;
        await waitUntil(status, value => value.activeClientCount === 1, 'client C did not release its slot');

        const replacementA = await sendConnection(port, sockets, 'ingest-client-a', '192.0.2.33');
        assert.notEqual(replacementA.localPort, originalPortA);
        const replacementClients = await waitUntil(
            clients,
            rows => rows.some(row => row.sysName === 'ingest-client-a' && row.isOnline),
            'client A reconnect did not become online'
        );
        const replacementClientA = replacementClients.find(row => row.sysName === 'ingest-client-a');
        assert.equal(replacementClientA.persistentSourceId, sourceA);
        assert.notEqual(replacementClientA.persistentConnectionId, clientA.persistentConnectionId);
        const refreshedA = await waitUntil(
            () => routes(sourceA),
            rows => rows.total === 1 && rows.list[0].routeState === 'active' && rows.list[0].nextHop === '192.0.2.33',
            'reconnect EOR must remove only the previous client A routes'
        );
        assert.equal(refreshedA.list[0].ip, '203.0.113.0');
        assert.equal((await routes(sourceB)).list[0].nextHop, '192.0.2.22');
        const replacementStatus = await status();
        assert.equal(replacementStatus.activeClientCount, 2);
        assert.equal(replacementStatus.clientDatabaseCount, 3);
        assert.equal(
            replacementStatus.clientThreads.find(row => row.remotePort === replacementA.localPort).threadId,
            threadA.threadId,
            'the released fixed parser worker must be reusable'
        );

        const bClosed = waitForClose(socketB);
        const replacementClosed = waitForClose(replacementA);
        await request(BmpConst.BMP_REQ_TYPES.STOP_BMP);
        started = false;
        await Promise.all([bClosed, replacementClosed]);
        await host.terminate();
        if (host.runtimeKind === 'child-process') {
            assert.equal(host.exitSignal, null);
            assert.equal(host.exitCode, 0, 'all parser/Writer workers must close cleanly in Node-fork fallback');
        }
        offline = new BmpPersistenceClient({ dbPath, readOnly: true, partitionByClient: true });
        await offline.open();
        const persisted = await offline.queryRoutes({ routeState: 'all', pageSize: 100 });
        assert.equal(persisted.total, 3, 'STOP must drain every parser and client Writer before offline reads');
        assert.equal(
            persisted.list.every(row => row.routeState === 'stale'),
            true
        );
        assert.deepEqual(
            new Set(persisted.list.map(row => row.persistentSourceId)),
            new Set([sourceA, sourceB, sourceC])
        );
        console.log(
            'BMP ingest thread E2E passed: exclusive parser slots, bounded admission, FIFO close, reuse, reconnect/EOR and STOP drain'
        );
    } finally {
        for (const socket of sockets) socket.destroy();
        await offline?.close({ suppressErrors: true }).catch(() => {});
        if (started) await request(BmpConst.BMP_REQ_TYPES.STOP_BMP).catch(() => {});
        await host.terminate().catch(() => {});
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

if (require.main === module)
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = main;
