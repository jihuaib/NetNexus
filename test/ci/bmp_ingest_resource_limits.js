const assert = require('node:assert/strict');
const net = require('node:net');
const BmpConst = require('../../electron/const/bmpConst');
const Pool = require('../../electron/worker/bmp/bmpIngestClientPool');
const { builders } = require('../../scripts/mockBmpClient');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const BmpWorker = loadBmpWorkerClass(__dirname, module);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('resource-limit test timed out');
        await sleep(10);
    }
}

function fakeSession() {
    return {
        persistenceConnectionId: 'fixture-connection',
        getPersistentSourceId: () => null,
        socket: {
            destroyed: false,
            destroy() {
                this.destroyed = true;
            },
            pause() {},
            resume() {}
        }
    };
}

function checkAggregateBudget() {
    const posted = [];
    const closed = [];
    const pool = new Pool({ threadCount: 2, maxRetainedBufferBytes: 16, onClosed: record => closed.push(record) });
    pool.slots = Array.from({ length: 2 }, (_, index) => ({
        index,
        alive: true,
        threadId: index + 1,
        record: null,
        worker: {
            postMessage(message) {
                posted.push({ index, message });
            }
        }
    }));
    const reply = (postedMessage, bufferedMessageBytes = 0) => {
        pool.handleMessage(pool.slots[postedMessage.index], {
            op: 'result',
            requestId: postedMessage.message.requestId,
            token: postedMessage.message.token,
            snapshot: { bufferedMessageBytes },
            actions: []
        });
    };
    const first = pool.attach(fakeSession());
    reply(posted.at(-1));
    const second = pool.attach(fakeSession());
    reply(posted.at(-1));
    pool.send(first, Buffer.from([1]));
    reply(posted.at(-1), 10);
    pool.send(second, Buffer.from([1]));
    reply(posted.at(-1), 10);
    assert.equal(pool.failure, null, 'a resource rejection must not fail the parser pool');
    assert.equal(first.closing, false, 'another client remains usable');
    assert.equal(second.closing, true);
    assert.equal(second.session.socket.destroyed, true);
    assert.equal(posted.at(-1).message.op, 'close');
    reply(posted.at(-1));
    assert.equal(closed.length, 1);
    assert.equal(pool.getStatus().retainedBufferBytes, 10);
    assert.equal(pool.hasCapacity(), true, 'close ACK releases the rejected slot');
}

async function checkInitializationDeadline() {
    const worker = Object.create(BmpWorker.prototype);
    const failures = [];
    const sockets = [];
    Object.assign(worker, {
        bmpSessionMap: new Map(),
        clientDeleteRemoteIpGates: new Map(),
        bmpConfigData: { threadCount: 2 },
        clientInitializationTimeoutMs: 120,
        messageHandler: { sendEvent() {} },
        enqueuePersistenceMutation: () => true,
        invalidateRouteAssurance() {},
        requestPersistenceSweep: () => true
    });
    const pool = new Pool({
        threadCount: 2,
        onResult: (record, result) => worker.handleIngestResult(record, result),
        onClosed: record => worker.handleIngestClosed(record),
        onError: error => failures.push(error)
    });
    await pool.open();
    worker.ingestPool = pool;
    const server = net.createServer(socket => worker.attachClientSocket(socket, 'tcp'));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const connect = async () => {
        const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
        socket.on('error', () => {});
        sockets.push(socket);
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        return socket;
    };
    try {
        await connect();
        await connect();
        await until(() => pool.getStatus().activeClientCount === 2);
        await until(() => pool.getStatus().activeClientCount === 0);
        assert.equal(worker.bmpSessionMap.size, 0, 'silent clients leave no mirror');
        assert.deepEqual(failures, []);

        const valid = await connect();
        valid.write(builders.initiationMessage({ sysName: 'deadline-fixture' }));
        await until(() => Array.from(worker.bmpSessionMap.values()).some(session => session.getPersistentSourceId()));
        const mirror = Array.from(worker.bmpSessionMap.values())[0];
        assert.equal(mirror.initializationTimer, null, 'valid identity cancels the initialization deadline');
        await sleep(worker.clientInitializationTimeoutMs * 2);
        assert.equal(valid.destroyed, false, 'initialized quiet feeds are not subject to an idle timeout');
        assert.equal(pool.getStatus().activeClientCount, 1);
        assert.deepEqual(failures, []);
    } finally {
        for (const session of worker.bmpSessionMap.values()) worker.clearClientInitializationTimer(session);
        sockets.forEach(socket => socket.destroy());
        await pool.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function main() {
    checkAggregateBudget();
    await checkInitializationDeadline();
    console.log('BMP ingest retained-buffer budget and initialization deadline tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
