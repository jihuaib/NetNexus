const assert = require('node:assert/strict');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const worker = Object.create(BmpWorker.prototype);
const calls = [];
Object.assign(worker, {
    enqueuePersistenceMutation(mutation) {
        calls.push(['mutation', mutation]);
        return true;
    },
    enqueueRouteUpdateEvent(update) {
        calls.push(['route-update', update]);
    },
    enqueueInstanceRouteUpdateEvent(update) {
        calls.push(['instance-route-update', update]);
    },
    messageHandler: {
        sendEvent(name, payload) {
            calls.push(['event', name, payload]);
        }
    }
});

const source = { id: 'a'.repeat(64), metadata: { transport: 'tcp' } };
const connection = { id: 'connection', generation: 1 };
const scope = { id: 'scope', epoch: 1, state: 'syncing' };
const first = {
    eventType: 'upsert',
    source,
    connection,
    scope,
    route: { id: 'route-one', attrJson: '{}', routeJson: '{}', nlriJson: null }
};
const second = { ...first, route: { ...first.route, id: 'route-two' } };
const statistics = { eventType: 'statistics', statistics: { raw: new Uint8Array([1, 2]) } };
const update = { raw: new Uint8Array([3, 4]) };
const payload = { raw: new Uint8Array([5, 6]) };

worker.handleIngestResult(
    { session: {} },
    {
        snapshot: null,
        actions: [
            { op: 'mutation', mutation: first },
            { op: 'route-update', update },
            { op: 'mutation', mutation: statistics },
            { op: 'mutation', mutation: second },
            { op: 'event', eventName: 'sample', data: payload }
        ]
    }
);
assert.deepEqual(
    calls.map(call => call[0]),
    ['mutation', 'route-update', 'mutation', 'mutation', 'event'],
    'FIFO action order is unchanged'
);
assert.equal(calls[0][1], first, 'received route DTO is handed off without another copy');
assert.equal(calls[3][1], second);
assert.equal(calls[0][1].source, calls[3][1].source);
assert.equal(calls[0][1].connection, calls[3][1].connection);
assert.equal(calls[0][1].scope, calls[3][1].scope);
assert.equal(Buffer.isBuffer(calls[1][1].raw), true);
assert.equal(Buffer.isBuffer(calls[2][1].statistics.raw), true);
assert.equal(Buffer.isBuffer(calls[4][2].raw), true);
assert.equal(Buffer.isBuffer(update.raw), false, 'restoration does not mutate the incoming event');
assert.equal(Buffer.isBuffer(statistics.statistics.raw), false);
assert.equal(Buffer.isBuffer(payload.raw), false);

const failure = new Error('database queue rejected');
worker.persistenceFailure = failure;
worker.enqueuePersistenceMutation = () => false;
assert.throws(
    () => worker.handleIngestResult({ session: {} }, { actions: [{ op: 'mutation', mutation: first }] }),
    error => error === failure,
    'failed enqueue still prevents parser ACK success'
);
console.log('bmp_ingest_dto_handoff passed');
