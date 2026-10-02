const assert = require('node:assert/strict');
const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const SOURCE_ID = 'a'.repeat(64);

function createFixture() {
    const trace = [];
    const posted = [];
    const queued = [];
    const persistedRoutes = new Set();
    const responses = [];
    const worker = Object.create(BmpWorker.prototype);
    const session = {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '192.0.2.1',
        remotePort: 40179,
        persistenceConnectionId: 'closing-connection',
        persistenceConnectionGeneration: 1,
        persistenceOpenedAtMs: 1000,
        getPersistentSourceId: () => SOURCE_ID,
        getClientInfo: () => ({ persistentSourceId: SOURCE_ID, remoteIp: '192.0.2.1' }),
        socket: {
            destroyed: false,
            destroy() {
                this.destroyed = true;
            },
            pause() {},
            resume() {}
        }
    };
    const sessionKey = BmpSession.makeKey(session.localIp, session.localPort, session.remoteIp, session.remotePort);
    Object.assign(worker, {
        bmpSessionMap: new Map([[sessionKey, session]]),
        clientDataDeleteInProgress: new Set(),
        clientDeleteRemoteIpGates: new Map(),
        persistenceFailure: null,
        routeUpdateAggregator: { deleteSource: () => trace.push('invalidate-source') },
        invalidateRouteAssurance: () => {},
        messageHandler: {
            sendEvent() {},
            sendSuccessResponse(messageId, data) {
                responses.push({ messageId, status: 'success', data });
            },
            sendErrorResponse(messageId, msg) {
                responses.push({ messageId, status: 'error', msg });
            }
        },
        persistence: {
            enqueue(mutation) {
                trace.push(`enqueue-${mutation.op}`);
                queued.push(mutation);
            },
            async fence() {
                trace.push('db-fence');
                for (const mutation of queued.splice(0)) {
                    if (mutation.op === 'route-upsert') persistedRoutes.add(mutation.prefix);
                }
            },
            async purgeSource(query) {
                assert.equal(query.sourceId, SOURCE_ID);
                trace.push('purge-source');
                const routes = persistedRoutes.size;
                persistedRoutes.clear();
                return { routes };
            }
        }
    });
    session.bmpWorker = worker;
    const pool = new BmpIngestClientPool({
        threadCount: 1,
        onResult: (record, result) => worker.handleIngestResult(record, result),
        onClosed: record => worker.handleIngestClosed(record),
        onError: error => trace.push(`ingest-error:${error.message}`)
    });
    const slot = {
        index: 0,
        threadId: 7,
        alive: true,
        record: null,
        worker: {
            postMessage(message) {
                posted.push(message);
                if (message.op === 'close') trace.push('ingest-close-request');
            }
        }
    };
    pool.slots = [slot];
    worker.ingestPool = pool;
    const record = pool.attach(session, { sessionKey });
    assert.ok(record);
    session.ingestRecord = record;
    session.closeSession = () => pool.closeSession(record);
    const acknowledge = (op, actions = [], error = null) => {
        const message = posted.find(item => item.op === op && !item.acknowledged);
        assert.ok(message, `${op} was not posted`);
        message.acknowledged = true;
        pool.handleMessage(slot, {
            op: 'result',
            requestId: message.requestId,
            token: message.token,
            actions,
            snapshot: null,
            closed: op === 'close',
            error
        });
    };
    acknowledge('attach');
    assert.equal(pool.send(record, Buffer.alloc(128)), true);
    return { worker, session, pool, record, trace, posted, queued, persistedRoutes, responses, acknowledge };
}

async function testDeleteDrainsPendingParserClose(alreadyClosing) {
    const fixture = createFixture();
    const { worker, session, pool, record, trace, posted, queued, persistedRoutes, responses, acknowledge } = fixture;
    if (alreadyClosing) session.closeSession();
    else session.socket.destroyed = true; // A real socket can be destroyed before its close callback runs.

    const deletion = worker.deleteClientData('delete', { persistentSourceId: SOURCE_ID, remoteIp: session.remoteIp });
    assert.equal(record.closing, true);
    assert.equal(record.pendingBytes, 128);
    assert.equal(pool.hasCapacity(), false, 'the parser slot must remain reserved until final close ACK');
    assert.equal(posted.filter(message => message.op === 'close').length, 1, 'close must be FIFO and idempotent');
    assert.equal(
        posted.some(message => message.op === 'barrier'),
        false,
        'a destroyed parser requires close, not barrier'
    );
    assert.equal(trace.includes('db-fence'), false, 'SQLite fence ran before the parser finished');
    assert.equal(trace.includes('purge-source'), false);
    assert.equal(worker.clientDeleteRemoteIpGates.get(session.remoteIp), 1);

    acknowledge('data', [{ op: 'mutation', mutation: { op: 'route-upsert', prefix: '203.0.113.0/24' } }]);
    assert.equal(record.pendingBytes, 0);
    assert.equal(trace.includes('db-fence'), false, 'the raw-data ACK alone must not release a pending close');
    acknowledge('close', [{ op: 'mutation', mutation: { op: 'connection-close' } }]);
    await deletion;

    assert.deepEqual(trace, [
        'ingest-close-request',
        'enqueue-route-upsert',
        'enqueue-connection-close',
        'db-fence',
        'purge-source',
        'invalidate-source'
    ]);
    assert.equal(queued.length, 0);
    assert.equal(persistedRoutes.size, 0, 'late raw data recreated the deleted client');
    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 'success');
    assert.equal(responses[0].data.routes, 1, 'the late raw route must be committed before it is purged');
    assert.equal(worker.bmpSessionMap.size, 0);
    assert.equal(pool.hasCapacity(), true);
    assert.equal(worker.clientDataDeleteInProgress.size, 0);
    assert.equal(worker.clientDeleteRemoteIpGates.size, 0);
}

async function testLiveClientCannotDelete() {
    const { worker, session, posted, trace, responses, acknowledge } = createFixture();
    await worker.deleteClientData('live-delete', { persistentSourceId: SOURCE_ID, remoteIp: session.remoteIp });
    assert.equal(responses[0].status, 'error');
    assert.match(responses[0].msg, /在线BMP客户端不能删除/);
    assert.equal(
        posted.some(message => message.op === 'close'),
        false
    );
    assert.deepEqual(trace, []);
    assert.equal(worker.clientDeleteRemoteIpGates.size, 0);
    acknowledge('data');
}

async function testFailedCloseNeverPurges() {
    const { worker, session, trace, responses, acknowledge } = createFixture();
    session.socket.destroyed = true;
    const deletion = worker.deleteClientData('failed-delete', {
        persistentSourceId: SOURCE_ID,
        remoteIp: session.remoteIp
    });
    acknowledge('data');
    acknowledge('close', [], { message: 'parser close failed', code: 'BMP_INGEST_ERROR' });
    await deletion;
    assert.equal(responses[0].status, 'error');
    assert.match(responses[0].msg, /parser close failed/);
    assert.equal(trace.includes('db-fence'), false);
    assert.equal(trace.includes('purge-source'), false, 'failed ingest drain must never permit client deletion');
    assert.equal(worker.clientDataDeleteInProgress.size, 0);
    assert.equal(worker.clientDeleteRemoteIpGates.size, 0);
}

async function main() {
    await testDeleteDrainsPendingParserClose(false);
    await testDeleteDrainsPendingParserClose(true);
    await testLiveClientCannotDelete();
    await testFailedCloseNeverPurges();
    console.log('BMP ingest deletion fence tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
