const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const BmpConst = require('../../electron/const/bmpConst');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const { buildScenario, parseArgs } = require('../../scripts/mockBmpClient');

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

function createRequester(worker) {
    const pending = new Map();
    let sequence = 0;
    worker.on('message', message => {
        const callback = pending.get(message.messageId);
        if (!callback) {
            return;
        }
        pending.delete(message.messageId);
        if (message.status === 'success') {
            callback.resolve(message);
        } else {
            callback.reject(new Error(message.msg || 'BMP worker request failed'));
        }
    });
    worker.on('error', error => {
        pending.forEach(callback => callback.reject(error));
        pending.clear();
    });
    return (op, data = null) => {
        sequence += 1;
        const messageId = `bmp-persistence-e2e-${sequence}`;
        return new Promise((resolve, reject) => {
            pending.set(messageId, { resolve, reject });
            worker.postMessage({ messageId, op, data });
        });
    };
}

function sendScenario(port, messages) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setNoDelay(true);
        socket.once('error', reject);
        socket.once('connect', async () => {
            try {
                for (const message of messages) {
                    if (!socket.write(message.data)) {
                        await new Promise(drainResolve => socket.once('drain', drainResolve));
                    }
                }
                socket.end();
            } catch (error) {
                reject(error);
            }
        });
        socket.once('close', hadError => {
            if (!hadError) {
                resolve();
            }
        });
    });
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-worker-e2e-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const port = await getFreePort();
    const worker = new Worker(path.join(__dirname, '..', '..', 'electron', 'worker', 'bmp', 'bmpWorker.js'));
    const request = createRequester(worker);
    let offlineClient;
    try {
        await request(BmpConst.BMP_REQ_TYPES.START_BMP, {
            port,
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
            pathMarkingTlvType: BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
            enableAuth: false,
            persistenceEnabled: true,
            persistenceDbPath: dbPath,
            persistenceBatchSize: 64,
            persistenceFlushMs: 5,
            persistenceHighWatermarkBytes: 4 * 1024 * 1024,
            persistenceLowWatermarkBytes: 2 * 1024 * 1024
        });

        const options = parseArgs([
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--routes',
            '1',
            '--interval',
            '0',
            '--once',
            '--no-dump-packets'
        ]);
        await sendScenario(port, buildScenario(options));

        const liveStatus = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTENCE_STATUS);
        assert.equal(liveStatus.data.ready, true);
        assert.equal(liveStatus.data.journalMode, 'wal');
        const liveRoutes = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, {
            routeState: 'all',
            pageSize: 5000
        });
        assert.ok(liveRoutes.data.total > 10, `expected persisted routes, got ${liveRoutes.data.total}`);
        assert.equal(
            liveRoutes.data.list.every(route => route.persistentRouteId.length === 64),
            true
        );
        const persistedTotal = liveRoutes.data.total;

        await request(BmpConst.BMP_REQ_TYPES.STOP_BMP);
        await worker.terminate();

        offlineClient = new BmpPersistenceClient({ dbPath, readOnly: true });
        await offlineClient.open();
        const offlineRoutes = await offlineClient.queryRoutes({ routeState: 'all', pageSize: 5000 });
        assert.equal(offlineRoutes.total, persistedTotal);
        assert.ok((await offlineClient.queryEvents({ pageSize: 5000 })).total > persistedTotal);
        await offlineClient.close();
        offlineClient = null;

        console.log(`BMP worker persistence E2E passed: routes=${persistedTotal}`);
    } finally {
        await offlineClient?.close().catch(() => {});
        await worker.terminate().catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
