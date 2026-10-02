const assert = require('node:assert/strict');
const BmpClientPersistenceClient = require('../../electron/worker/bmp/bmpClientPersistenceClient');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const { BMP_PERSISTENCE_OP } = require('../../electron/worker/bmp/bmpPersistenceConst');

const SOURCE_A = '0'.repeat(64);
const SOURCE_B = `${'0'.repeat(7)}1${'0'.repeat(56)}`;

function fakeLane() {
    return {
        worker: {},
        workerAlive: true,
        mutations: [],
        sequence: 0,
        committed: 0,
        waiters: [],
        requests: [],
        enqueue(mutation) {
            this.sequence += 1;
            this.mutations.push(mutation);
        },
        getWatermark() {
            const pending = this.sequence - this.committed;
            return {
                queueLength: pending,
                queueBytes: pending * 60,
                inFlightBytes: 0,
                bufferedBytes: pending * 60,
                failed: false
            };
        },
        fence() {
            const target = this.sequence;
            if (this.committed >= target) return Promise.resolve();
            return new Promise(resolve => this.waiters.push({ target, resolve }));
        },
        drain() {
            return this.fence();
        },
        acknowledge(target) {
            this.committed = target;
            const ready = this.waiters.filter(waiter => waiter.target <= this.committed);
            this.waiters = this.waiters.filter(waiter => waiter.target > this.committed);
            ready.forEach(waiter => waiter.resolve());
        },
        async sendRequest(op, data) {
            this.requests.push({ op, data });
            return { duplicate: false, applied: data.mutations?.length || 0 };
        },
        async close() {
            this.closed = true;
        }
    };
}

function mutation(sourceId, sequence) {
    return {
        source: { id: sourceId },
        connection: { id: `connection-${sourceId}`, sourceId },
        sequence,
        eventType: 'synthetic'
    };
}

async function main() {
    assert.equal(new BmpClientPersistenceClient().workerCount, 4);
    assert.equal(
        new BmpClientPersistenceClient({ writerWorkerCount: 999 }).workerCount,
        16,
        'writer count must have a finite hard limit'
    );
    assert.equal(new BmpClientPersistenceClient({ readOnly: true, writerWorkerCount: 16 }).workerCount, 1);
    assert.ok(
        new BmpPersistenceClient({ partitionByClient: true }) instanceof BmpClientPersistenceClient,
        'the existing client API must select the pool facade without requiring callers to change constructors'
    );

    let pauses = 0;
    let resumes = 0;
    const errors = [];
    const pool = new BmpClientPersistenceClient({
        writerWorkerCount: 2,
        highWatermarkBytes: 100,
        lowWatermarkBytes: 40,
        onPause: () => {
            pauses += 1;
        },
        onResume: () => {
            resumes += 1;
        },
        onError: error => errors.push(error)
    });
    const lanes = [fakeLane(), fakeLane()];
    pool.clients = lanes;
    assert.strictEqual(pool.getClient(SOURCE_A), lanes[0]);
    assert.strictEqual(pool.getClient(SOURCE_B), lanes[1]);
    pool.enqueue(mutation(SOURCE_A, 1));
    assert.equal(pauses, 0);
    pool.enqueue(mutation(SOURCE_B, 1));
    assert.equal(
        pauses,
        1,
        'the combined watermark must pause intake even when each lane is individually below its threshold'
    );
    pool.enqueue(mutation(SOURCE_A, 2));
    pool.enqueue(mutation(SOURCE_A, 3));
    pool.enqueue(mutation(SOURCE_B, 2));
    assert.deepEqual(
        lanes[0].mutations.map(entry => entry.sequence),
        [1, 2, 3]
    );
    assert.deepEqual(
        lanes[1].mutations.map(entry => entry.sequence),
        [1, 2]
    );
    assert.equal(pauses, 1, 'a pool pause transition must only notify once');
    assert.equal(pool.getWatermark().bufferedBytes, 300);

    let fenced = false;
    const fence = pool.fence().then(() => {
        fenced = true;
    });
    assert.deepEqual(
        lanes.map(lane => lane.waiters[0].target),
        [3, 2],
        'every FIFO lane must capture its fence target synchronously'
    );
    pool.enqueue(mutation(SOURCE_A, 4));
    lanes[1].acknowledge(2);
    pool.updateBackpressure();
    await Promise.resolve();
    assert.equal(fenced, false, 'one acknowledged writer cannot satisfy a multi-writer fence');
    assert.equal(resumes, 0);
    lanes[0].acknowledge(3);
    pool.updateBackpressure();
    await fence;
    assert.equal(fenced, true, 'writes arriving after fence capture must not starve that fence');
    assert.equal(pool.getWatermark().bufferedBytes, 60);
    assert.equal(resumes, 0, 'resume must wait for the combined low watermark');
    let drained = false;
    const drain = pool.drain().then(() => {
        drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false, 'drain must wait for the remaining writer');
    lanes[0].acknowledge(4);
    pool.updateBackpressure();
    await drain;
    assert.equal(resumes, 1);
    assert.equal(pool.getWatermark().bufferedBytes, 0);

    const refs = {
        sources: [{ id: SOURCE_A }, { id: SOURCE_B }],
        connections: [
            { id: 'a', sourceId: SOURCE_A },
            { id: 'b', sourceId: SOURCE_B }
        ],
        scopes: [
            { id: 'scope-a', sourceId: SOURCE_A },
            { id: 'scope-b', sourceId: SOURCE_B }
        ]
    };
    for (const invalid of [
        { sourceRef: 1, connectionRef: 0, scopeRef: 1 },
        { sourceRef: 1, connectionRef: 1, scopeRef: 0 }
    ]) {
        await assert.rejects(
            pool.sendRequest(BMP_PERSISTENCE_OP.APPLY_BATCH, {
                batchId: 'compact-invalid',
                refs,
                mutations: [{ sourceRef: 0, connectionRef: 0, scopeRef: 0 }, invalid]
            }),
            /another source|source.*match/i
        );
        assert.deepEqual(
            lanes.map(lane => lane.requests.length),
            [0, 0],
            'compact-ref preflight must complete before any lane receives a batch'
        );
    }
    const applied = await pool.sendRequest(BMP_PERSISTENCE_OP.APPLY_BATCH, {
        batchId: 'compact-valid',
        refs,
        mutations: [
            { sourceRef: 0, connectionRef: 0, scopeRef: 0 },
            { sourceRef: 1, connectionRef: 1, scopeRef: 1 }
        ]
    });
    assert.equal(applied.applied, 2);
    assert.deepEqual(
        lanes.map(lane => lane.requests[0].data.mutations[0].sourceRef),
        [0, 1]
    );
    assert.ok(
        lanes.every(lane => lane.requests[0].data.refs === refs),
        'compact batches must retain their source descriptor table across dispatch'
    );

    const failure = new Error('synthetic writer failure');
    pool.handleFailure(failure);
    pool.handleFailure(new Error('duplicate failure'));
    assert.deepEqual(errors, [failure]);
    assert.equal(pool.getWatermark().failed, true);
    assert.throws(() => pool.enqueue(mutation(SOURCE_A, 5)), /synthetic writer failure/);
    await assert.rejects(pool.fence(), /synthetic writer failure/);
    await assert.rejects(pool.drain(), /synthetic writer failure/);
    const closing = pool.close();
    assert.strictEqual(pool.close(), closing, 'close must be idempotent');
    await closing;
    assert.ok(lanes.every(lane => lane.closed));
    console.log(
        'BMP Client persistence pool tests passed: bounded worker count, FIFO, watermarks, captured fence, compact preflight and failure cleanup'
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
