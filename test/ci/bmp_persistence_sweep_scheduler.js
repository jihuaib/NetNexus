const assert = require('node:assert/strict');

const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

function deferred() {
    let resolve;
    const promise = new Promise(pendingResolve => {
        resolve = pendingResolve;
    });
    return { promise, resolve };
}

function waitFor(label, predicate, timeoutMs = 2000) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (predicate()) {
                resolve();
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(`Timed out waiting for ${label}`));
                return;
            }
            setTimeout(poll, 10);
        };
        poll();
    });
}

function makeWorker(persistence) {
    const worker = Object.create(BmpWorker.prototype);
    worker.persistence = persistence;
    worker.bmpConfigData = {
        persistenceRefreshTimeoutMs: 50,
        persistenceRefreshTimeoutFloorMs: 0,
        persistenceSweepMaxPasses: 1,
        persistenceSweepTimeBudgetMs: 100,
        persistenceSweepCatchupDelayMs: 25
    };
    worker.persistenceSweepTimer = null;
    worker.persistenceSweepCatchupTimer = null;
    worker.persistenceSweepRequestTimer = null;
    worker.persistenceSweepDeadlineTimer = null;
    worker.persistenceSweepRunning = false;
    worker.persistenceSweepPendingMaintenance = false;
    worker.persistenceSweepPendingSources = new Set();
    worker.persistenceSweepRequestSources = new Set();
    worker.invalidateRouteAssurance = () => {};
    worker.emitPersistenceSweepRouteUpdates = () => {};
    return worker;
}

async function verifyBusySweepPreservesLifecycleSources() {
    const firstFence = deferred();
    const fenceEntered = deferred();
    const sweepCalls = [];
    let fenceCount = 0;
    const persistence = {
        async fence() {
            fenceCount += 1;
            if (fenceCount === 1) {
                fenceEntered.resolve();
                await firstFence.promise;
            }
        },
        async getStatus() {
            return { logicalSize: 0 };
        },
        async sweep(options) {
            sweepCalls.push({ mode: options.mode, sourceId: options.sourceId });
            return { hasMore: false, nextRefreshStartedMs: null, nextRefreshSourceId: null };
        }
    };
    const worker = makeWorker(persistence);

    const maintenance = worker.runPersistenceSweep({ mode: 'maintenance' });
    await fenceEntered.promise;
    await worker.runPersistenceSweep({ mode: 'lifecycle', sourceId: 'source-b' });
    await worker.runPersistenceSweep({ mode: 'lifecycle', sourceId: 'source-c' });
    firstFence.resolve();
    await maintenance;

    await waitFor('queued lifecycle sweeps', () => sweepCalls.length === 3);
    assert.deepEqual(sweepCalls, [
        { mode: 'maintenance', sourceId: null },
        { mode: 'lifecycle', sourceId: 'source-b' },
        { mode: 'lifecycle', sourceId: 'source-c' }
    ]);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(sweepCalls.length, 3, 'a null refresh deadline must not create a 25 ms sweep loop');
    worker.clearPersistenceSweepTimer();
}

async function verifyDeadlineRetainsItsSource() {
    const sweepCalls = [];
    const persistence = {
        async fence() {},
        async getStatus() {
            return { logicalSize: 0 };
        },
        async sweep(options) {
            sweepCalls.push({ mode: options.mode, sourceId: options.sourceId });
            if (sweepCalls.length === 1) {
                return {
                    hasMore: false,
                    nextRefreshStartedMs: Date.now() - 100,
                    nextRefreshSourceId: 'source-a'
                };
            }
            return { hasMore: false, nextRefreshStartedMs: null, nextRefreshSourceId: null };
        }
    };
    const worker = makeWorker(persistence);

    await worker.runPersistenceSweep({ mode: 'lifecycle', sourceId: 'source-b' });
    await waitFor('the source-scoped refresh deadline', () => sweepCalls.length === 2);
    assert.deepEqual(sweepCalls, [
        { mode: 'lifecycle', sourceId: 'source-b' },
        { mode: 'lifecycle', sourceId: 'source-a' }
    ]);
    worker.clearPersistenceSweepTimer();
}

async function main() {
    await verifyBusySweepPreservesLifecycleSources();
    await verifyDeadlineRetainsItsSource();
    console.log('BMP persistence sweep scheduler tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
