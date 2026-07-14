const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const {
    buildConnectionMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { BMP_PERSISTENCE_OP } = require('../../electron/worker/bmp/bmpPersistenceConst');

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-client-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    let client;
    try {
        const bmpSession = {
            localIp: '127.0.0.1',
            localPort: 11019,
            remoteIp: '192.0.2.20',
            remotePort: 56000,
            sysName: 'client-test',
            getBmpV4TlvDraft: () => 20
        };
        const owner = new BmpBgpSession(bmpSession);
        Object.assign(owner, {
            sessionType: 0,
            sessionRd: '0:0',
            sessionIp: '198.51.100.2',
            sessionAs: 65002
        });
        const route = new BmpBgpRoute(owner, null);
        Object.assign(route, {
            afi: 1,
            safi: 1,
            ribType: 2,
            pathId: 0,
            rd: '0:0',
            ip: '198.51.100.0',
            mask: 24,
            nlriDetail: { prefix: '198.51.100.0', length: 24, pathId: 0, rd: '0:0' }
        });
        route.assignRouteAttr({ origin: 'IGP', asPath: '65002', nextHop: '192.0.2.1' });
        route.markActive(0);

        let pauseCount = 0;
        let resumeCount = 0;
        client = new BmpPersistenceClient({
            dbPath,
            batchSize: 1,
            flushMs: 1000,
            highWatermarkBytes: 1,
            lowWatermarkBytes: 1,
            onPause: () => {
                pauseCount += 1;
            },
            onResume: () => {
                resumeCount += 1;
            }
        });
        const opened = await client.open();
        assert.equal(opened.journalMode, 'wal');

        client.enqueue(buildConnectionMutation(bmpSession, 'connection_open'));
        client.enqueue(
            buildRouteUpsertMutation(bmpSession, owner, route, 1, 1, 2, {
                kind: 'peer',
                state: 'syncing',
                scopeState: 'syncing',
                isNewRoute: true
            })
        );
        assert.equal(pauseCount, 1);
        await client.drain();
        assert.equal(resumeCount, 1);
        assert.equal(client.getWatermark().bufferedBytes, 0);
        assert.equal((await client.queryRoutes({ routeState: 'all' })).total, 1);

        await client.close();
        client = null;

        const offline = new BmpPersistenceClient({ dbPath, readOnly: true });
        await offline.open();
        const routes = await offline.queryRoutes({ routeState: 'all' });
        assert.equal(routes.total, 1);
        assert.equal(routes.list[0].canonicalRouteKey.keyHex.length, 64);
        await offline.close();

        const retryClient = new BmpPersistenceClient({
            dbPath: 'synthetic-retry.sqlite3',
            batchSize: 1,
            batchRetryLimit: 3,
            batchRetryDelayMs: 1
        });
        retryClient.worker = {};
        retryClient.workerAlive = true;
        let applyAttempts = 0;
        let retriedBatchId = null;
        retryClient.sendRequest = async (op, data) => {
            assert.equal(op, BMP_PERSISTENCE_OP.APPLY_BATCH);
            applyAttempts += 1;
            retriedBatchId = retriedBatchId || data.batchId;
            assert.equal(data.batchId, retriedBatchId, 'batch retries must retain the idempotency key');
            if (applyAttempts === 1) {
                throw new Error('synthetic transient write failure');
            }
            return { duplicate: false, applied: 1 };
        };
        retryClient.enqueue({ eventType: 'synthetic' });
        await retryClient.drain();
        assert.equal(applyAttempts, 2);
        assert.equal(retryClient.failure, null);
        retryClient.worker = null;

        let closeClient;
        let closeWorkerTerminated = false;
        const closeWorker = {
            postMessage(message) {
                if (message.op === BMP_PERSISTENCE_OP.CLOSE) {
                    setImmediate(() => closeClient.handleMessage({ messageId: message.messageId, status: 'success' }));
                }
            },
            async terminate() {
                closeWorkerTerminated = true;
            }
        };
        closeClient = new BmpPersistenceClient({ dbPath: 'synthetic-close.sqlite3', readOnly: true });
        closeClient.worker = closeWorker;
        closeClient.workerAlive = true;
        const pendingQuery = closeClient.queryRoutes({});
        const closePromise = closeClient.close();
        await assert.rejects(pendingQuery, /closed/);
        await closePromise;
        assert.equal(closeWorkerTerminated, true);
        await assert.rejects(closeClient.queryRoutes({}), /not running/);

        let failedWorkerTerminated = false;
        const failedClient = new BmpPersistenceClient({ dbPath: 'synthetic-failed.sqlite3' });
        failedClient.worker = {
            postMessage() {},
            async terminate() {
                failedWorkerTerminated = true;
            }
        };
        failedClient.workerAlive = true;
        failedClient.failure = new Error('synthetic permanent failure');
        await failedClient.close({ suppressErrors: true });
        assert.equal(failedWorkerTerminated, true);
        assert.equal(failedClient.worker, null);

        const deadReader = new BmpPersistenceClient({ dbPath, readOnly: true });
        await deadReader.open();
        await deadReader.worker.terminate();
        assert.ok(deadReader.failure);
        await Promise.race([
            deadReader.close({ suppressErrors: true }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('dead persistence reader close timed out')), 500)
            )
        ]);
        assert.equal(deadReader.worker, null);

        const closingReader = new BmpPersistenceClient({ dbPath, readOnly: true });
        await closingReader.open();
        const closingWorker = closingReader.worker;
        const closingPromise = closingReader.close({ suppressErrors: true });
        await closingWorker.terminate();
        await Promise.race([
            closingPromise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('persistence reader exit-during-close timed out')), 500)
            )
        ]);
        assert.equal(closingReader.callbacks.size, 0);
        assert.equal(closingReader.worker, null);

        console.log('BMP persistence client drain/backpressure tests passed');
    } finally {
        await client?.close().catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
