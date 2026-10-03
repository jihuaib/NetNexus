const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const { getAddrFamilyType } = require('../../electron/utils/bgpUtils');
const RouteUpdateAggregator = require('../../electron/utils/routeUpdateAggregator');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const { BMP_PERSISTENCE_OP } = require('../../electron/worker/bmp/bmpPersistenceConst');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function context(sourceId = 'committed-client-a', kind = 'peer', options = {}) {
    const source = Object.freeze({ id: sourceId });
    const connection = Object.freeze({ id: options.connectionId || `${sourceId}-connection`, sourceId });
    const scope = Object.freeze({
        id: options.scopeId || `${sourceId}-${kind}-scope`,
        sourceId,
        ownerKey: `${sourceId}-${kind}-owner`,
        kind,
        afi: options.afi || 1,
        safi: options.safi || 1,
        ribType: kind === 'loc-rib' ? 'loc-rib' : 'pre-adj-rib-in',
        epoch: 1,
        state: 'ready'
    });
    return { source, connection, scope };
}

function mutation(descriptors, eventType = 'upsert', route = { id: 'same-nlri' }) {
    return { ...descriptors, eventType, route };
}

function encodedBatch(mutations) {
    // Use the real writer encoder, including its compact descriptor refs.
    const client = new BmpPersistenceClient({ includeCommittedDeltas: false });
    return client.makeBatch(mutations.map(value => ({ mutation: value })));
}

function makeWorker(enabled = false) {
    const worker = Object.create(BmpWorker.prototype);
    const events = [];
    const enqueued = [];
    const assuranceCalls = [];
    Object.assign(worker, {
        bmpStopping: false,
        routeUpdateAggregator: new RouteUpdateAggregator(),
        routeUpdateFlushTimer: null,
        routeUpdateFlushIntervalMs: 1000,
        messageHandler: { sendEvent: (eventName, data) => events.push({ eventName, data }) },
        routeAssuranceService: {
            enabled,
            invalidate: reason => assuranceCalls.push(['invalidate', reason]),
            applyCommittedDelta: delta => assuranceCalls.push(['delta', delta])
        },
        scheduleRouteAssuranceRebuild: () => assuranceCalls.push(['rebuild'])
    });
    for (const method of ['enqueueRouteUpdateEvent', 'enqueueInstanceRouteUpdateEvent']) {
        worker[method] = update => {
            enqueued.push({ method, update });
            BmpWorker.prototype[method].call(worker, update);
        };
    }
    return { worker, events, enqueued, assuranceCalls };
}

function updates(events) {
    return events.flatMap(event => event.data.data.updates.map(update => ({ eventName: event.eventName, update })));
}

function assertScopeUpdate(record, descriptors, reset = false) {
    const { source, connection, scope } = descriptors;
    const { eventName, update } = record;
    assert.equal(
        eventName,
        scope.kind === 'peer' ? BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE : BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE
    );
    assert.equal(update.type, BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE);
    assert.equal(update.sourceId, source.id);
    assert.equal(update.persistentSourceId, source.id);
    assert.equal(update.scopeId, scope.id);
    assert.equal(update.persistentScopeId, scope.id);
    assert.equal(update.ownerKey, scope.ownerKey);
    assert.equal(update.persistentOwnerKey, scope.ownerKey);
    assert.equal(update.af, getAddrFamilyType(scope.afi, scope.safi));
    assert.equal(update.ribType, scope.ribType);
    assert.deepEqual(update.client, {
        sourceId: source.id,
        persistentSourceId: source.id,
        connectionId: connection.id,
        persistentConnectionId: connection.id
    });
    assert.equal(update.changedCount, 0, 'a committed refresh must not count received routes twice');
    assert.equal(update.reason, 'persistence-commit');
    assert.equal(update.assuranceIncremental, true);
    assert.equal(Boolean(update.projectionReset), reset);
    for (const field of ['route', 'routes', 'delta', 'deltas', 'session', 'instance']) {
        assert.equal(Object.hasOwn(update, field), false, `refresh must not allocate full ${field}`);
    }
}

function testCompactBatchAllocationAndRawCompatibility() {
    for (const enabled of [false, true]) {
        for (const kind of ['peer', 'loc-rib']) {
            const harness = makeWorker(enabled);
            const descriptors = context('shared-descriptor-client', kind);
            const route = { id: 'shared-route-payload' };
            for (const field of ['attrJson', 'routeJson', 'payloadJson']) {
                Object.defineProperty(route, field, {
                    get() {
                        throw new Error(`refresh must not inspect route.${field}`);
                    }
                });
            }
            const batch = encodedBatch(Array.from({ length: 5000 }, () => mutation(descriptors, 'refresh', route)));
            assert.equal(batch.refs.scopes.length, 1);
            assert.equal(batch.includeDeltas, false);
            harness.worker.handleCommittedPersistenceResult({ applied: 5000 }, batch);
            assert.equal(harness.enqueued.length, 1, '5000 refreshes with shared refs need only one scope event');
            harness.worker.flushRouteUpdateEvents();
            assert.equal(updates(harness.events).length, 1);
            assertScopeUpdate(updates(harness.events)[0], descriptors);
            assert.deepEqual(harness.assuranceCalls, [], 'notification alone must not invalidate the RA projection');

            harness.events.length = 0;
            harness.worker.handleCommittedPersistenceResult({ applied: 1 }, { mutations: [mutation(descriptors)] });
            harness.worker.flushRouteUpdateEvents();
            assert.equal(updates(harness.events).length, 1, 'unencoded descriptor batches must also refresh');
            assertScopeUpdate(updates(harness.events)[0], descriptors);
            harness.worker.clearRouteUpdateAggregation();
        }
    }
}

function testMutationTypesAndEorOnlyFinalBatch() {
    const routeEvents = ['upsert', 'announce', 'replace', 'refresh', 'delete', 'withdraw', 'purge'];
    const scopeEvents = ['scope_open', 'scope_stale', 'scope_eor', 'scope_timeout'];
    for (const kind of ['peer', 'loc-rib']) {
        const harness = makeWorker();
        const descriptors = context('lifecycle-client', kind);
        for (const eventType of [...routeEvents, ...scopeEvents]) {
            harness.events.length = 0;
            const value = mutation(descriptors, eventType);
            if (scopeEvents.includes(eventType)) delete value.route;
            harness.worker.handleCommittedPersistenceResult({ applied: 1 }, encodedBatch([value]));
            harness.worker.flushRouteUpdateEvents();
            assert.equal(updates(harness.events).length, 1, `${kind} ${eventType} must notify after commit`);
            assertScopeUpdate(updates(harness.events)[0], descriptors, scopeEvents.includes(eventType));
        }
        harness.events.length = 0;
        harness.worker.handleCommittedPersistenceResult(
            { applied: 2 },
            encodedBatch([mutation(descriptors), mutation(descriptors, 'scope_eor', undefined)])
        );
        harness.worker.flushRouteUpdateEvents();
        assert.equal(updates(harness.events).length, 1);
        assertScopeUpdate(updates(harness.events)[0], descriptors, true);

        harness.events.length = 0;
        harness.worker.handleCommittedPersistenceResult(
            { applied: 4 },
            encodedBatch(
                ['source_update', 'connection_open', 'connection_close', 'statistics'].map(type =>
                    mutation(descriptors, type)
                )
            )
        );
        harness.worker.flushRouteUpdateEvents();
        assert.deepEqual(harness.events, [], 'non-route metadata mutations must not create spurious route events');
        harness.worker.clearRouteUpdateAggregation();
    }
}

function testSourcesConnectionsFamiliesAndReceivedCount() {
    const harness = makeWorker();
    const peerA = context('client-a', 'peer', { scopeId: 'opaque-same-scope' });
    const reconnectA = { ...peerA, connection: Object.freeze({ id: 'client-a-new-connection', sourceId: 'client-a' }) };
    const peerB = context('client-b', 'peer', { scopeId: 'opaque-same-scope', afi: 2 });
    const evpnA = context('client-a', 'loc-rib', { scopeId: 'evpn-scope', afi: 25, safi: 70 });
    const flowB = context('client-b', 'loc-rib', { scopeId: 'flow-scope', safi: 133 });
    const contexts = [peerA, reconnectA, peerB, evpnA, flowB];
    const batch = encodedBatch(contexts.flatMap(value => [mutation(value), mutation(value, 'withdraw')]));
    harness.worker.handleCommittedPersistenceResult({ applied: 10 }, batch);
    harness.worker.flushRouteUpdateEvents();
    const result = updates(harness.events);
    assert.equal(result.length, 5, 'source, connection and scope must all participate in aggregation identity');
    for (const descriptors of contexts) {
        const record = result.find(
            value =>
                value.update.sourceId === descriptors.source.id &&
                value.update.scopeId === descriptors.scope.id &&
                value.update.client.connectionId === descriptors.connection.id
        );
        assert.ok(record);
        assertScopeUpdate(record, descriptors);
    }

    harness.events.length = 0;
    harness.worker.enqueueRouteUpdateEvent({
        type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
        sourceId: peerA.source.id,
        scopeId: peerA.scope.id,
        client: { sourceId: peerA.source.id, connectionId: peerA.connection.id },
        changedCount: 42,
        assuranceIncremental: true
    });
    harness.worker.handleCommittedPersistenceResult({ applied: 42 }, encodedBatch([mutation(peerA)]));
    harness.worker.flushRouteUpdateEvents();
    const merged = updates(harness.events);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].update.changedCount, 42, 'coalesced receive and commit notifications must not double-count');
    assert.equal(merged[0].update.reason, 'persistence-commit');
    harness.worker.clearRouteUpdateAggregation();
}

function testDescriptorTransitionsAndProjectionRebuild() {
    const harness = makeWorker(true);
    const descriptors = context('changing-scope-client');
    const next = {
        ...descriptors,
        scope: Object.freeze({ ...descriptors.scope, epoch: 2, state: 'refreshing' })
    };
    const eor = mutation(next, 'scope_eor');
    delete eor.route;
    const batch = encodedBatch([mutation(descriptors), eor]);
    assert.equal(batch.refs.scopes.length, 2, 'one stable scope can have multiple descriptor versions in a batch');
    harness.worker.handleCommittedPersistenceResult({ requiresProjectionRebuild: true }, batch);
    harness.worker.flushRouteUpdateEvents();
    assert.equal(updates(harness.events).length, 1, 'descriptor versions of the same scope must aggregate correctly');
    assertScopeUpdate(updates(harness.events)[0], descriptors, true);
    assert.deepEqual(harness.assuranceCalls, [['invalidate', 'client-database-batch-replayed'], ['rebuild']]);
    assert.equal(descriptors.scope.epoch, 1, 'notification generation must not mutate shared descriptors');
    assert.equal(next.scope.epoch, 2);

    harness.events.length = 0;
    const mismatched = [
        { ...mutation(descriptors), scope: { ...descriptors.scope, sourceId: 'foreign-client' } },
        { ...mutation(descriptors), connection: { ...descriptors.connection, sourceId: 'foreign-client' } },
        { ...mutation(descriptors), scope: { ...descriptors.scope, kind: 'unsupported' } },
        { eventType: 'upsert', scopeRef: 999, sourceRef: 999, connectionRef: 999 }
    ];
    harness.worker.handleCommittedPersistenceResult({ applied: 4 }, encodedBatch(mismatched));
    harness.worker.flushRouteUpdateEvents();
    assert.deepEqual(harness.events, [], 'invalid or foreign descriptors must not send a refresh to another client');
    harness.worker.clearRouteUpdateAggregation();
}

async function testTrailingCommitAndNonBlockingPageQueries() {
    for (const kind of ['peer', 'loc-rib']) {
        const harness = makeWorker();
        const descriptors = context('last-batch-client', kind);
        const gate = deferred();
        let committed = 70233;
        let observedBatch;
        const client = new BmpPersistenceClient({
            includeCommittedDeltas: false,
            onCommittedBatch: (result, batch) => {
                observedBatch = batch;
                harness.worker.handleCommittedPersistenceResult(result, batch);
            }
        });
        const value = mutation(descriptors, 'refresh');
        const batch = client.makeBatch([{ mutation: value }]);
        client.mutationSequence = 1;
        client.inFlight = { entries: [{ mutation: value, sequence: 1 }], bytes: 320, batch };
        client.sendRequest = (op, request) => {
            assert.equal(op, BMP_PERSISTENCE_OP.APPLY_BATCH);
            assert.equal(request, batch);
            return gate.promise;
        };
        let fenceCalls = 0;
        harness.worker.persistence = {
            queryRouteScope() {
                throw new Error('page queries should use the independent reader');
            },
            fence() {
                fenceCalls += 1;
                return new Promise(() => {});
            }
        };
        harness.worker.persistenceReader = {
            async queryRouteScope(query) {
                assert.equal(query.routeQuery.sourceId, descriptors.source.id);
                assert.equal(query.routeQuery.scopeId, descriptors.scope.id);
                return {
                    routes: { list: [], total: committed },
                    summary: { active: committed, stale: 0, total: committed }
                };
            }
        };
        const enqueue = kind === 'peer' ? 'enqueueRouteUpdateEvent' : 'enqueueInstanceRouteUpdateEvent';
        harness.worker[enqueue]({
            type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
            sourceId: descriptors.source.id,
            scopeId: descriptors.scope.id,
            client: { sourceId: descriptors.source.id, connectionId: descriptors.connection.id },
            changedCount: 100000,
            assuranceIncremental: true
        });
        harness.worker.flushRouteUpdateEvents();
        assert.equal(harness.events.length, 1);
        client.sendInFlightBatch();
        const lookup = { sourceId: descriptors.source.id, scopeId: descriptors.scope.id };
        assert.equal((await harness.worker.queryRouteScope(lookup)).total, 70233);
        assert.equal(fenceCalls, 0, 'route page queries must remain non-blocking while the writer is behind');
        assert.equal(client.committedMutationSequence, 0);
        harness.events.length = 0;
        committed = 100000;
        gate.resolve({ applied: 1 });
        await client.fence();
        harness.worker.flushRouteUpdateEvents();
        assert.equal(observedBatch, batch, 'the successful commit callback must retain the original compact batch');
        assert.equal(client.getQueueLength(), 0);
        assert.equal(client.inFlight, null);
        assert.equal(
            updates(harness.events).length,
            1,
            'the final commit must notify without any subsequent receive/EOR'
        );
        assertScopeUpdate(updates(harness.events)[0], descriptors);
        assert.equal((await harness.worker.queryRouteScope(lookup)).total, 100000);
        assert.equal(fenceCalls, 0);
        harness.worker.clearRouteUpdateAggregation();
    }
}

async function testFailedCommitAndRuntimeGuards() {
    const harness = makeWorker();
    const descriptors = context();
    const failure = new Error('simulated final batch transaction failure');
    const errors = [];
    const client = new BmpPersistenceClient({
        onCommittedBatch: (result, batch) => harness.worker.handleCommittedPersistenceResult(result, batch),
        onError: error => errors.push(error)
    });
    const value = mutation(descriptors);
    client.mutationSequence = 1;
    client.inFlight = {
        entries: [{ mutation: value, sequence: 1 }],
        bytes: 320,
        batch: client.makeBatch([{ mutation: value }])
    };
    client.sendRequest = () => Promise.reject(failure);
    client.sendInFlightBatch();
    await assert.rejects(client.fence(), error => error === failure);
    harness.worker.flushRouteUpdateEvents();
    assert.deepEqual(harness.events, [], 'failed transactions must never produce committed-route notifications');
    assert.deepEqual(errors, [failure]);
    assert.equal(client.committedMutationSequence, 0);

    const clients = [];
    Object.assign(harness.worker, {
        bmpConfigData: { persistenceDbPath: '/unused/unit-test.sqlite3', threadCount: 2 },
        createPersistenceClient(options) {
            const fake = {
                options,
                open: async () => ({ schemaVersion: 1, journalMode: 'wal', dbPath: options.dbPath })
            };
            clients.push(fake);
            return fake;
        },
        schedulePersistenceSweep() {}
    });
    await harness.worker.initializePersistence();
    const oldWriter = clients[0];
    const batch = encodedBatch([mutation(descriptors)]);
    oldWriter.options.onCommittedBatch({ applied: 1 }, batch);
    harness.worker.flushRouteUpdateEvents();
    assert.equal(updates(harness.events).length, 1, 'initializePersistence must forward the batch to the worker');
    harness.events.length = 0;
    harness.worker.bmpStopping = true;
    oldWriter.options.onCommittedBatch({ applied: 1 }, batch);
    harness.worker.flushRouteUpdateEvents();
    assert.deepEqual(harness.events, [], 'stopping a runtime must suppress late commits');
    harness.worker.bmpStopping = false;
    await harness.worker.initializePersistence();
    oldWriter.options.onCommittedBatch({ applied: 1 }, batch);
    harness.worker.flushRouteUpdateEvents();
    assert.deepEqual(harness.events, [], 'a replaced persistence client must not notify the new runtime');
    clients[2].options.onCommittedBatch({ applied: 1 }, batch);
    harness.worker.flushRouteUpdateEvents();
    assert.equal(updates(harness.events).length, 1);
    harness.worker.clearRouteUpdateAggregation();
}

async function main() {
    testCompactBatchAllocationAndRawCompatibility();
    testMutationTypesAndEorOnlyFinalBatch();
    testSourcesConnectionsFamiliesAndReceivedCount();
    testDescriptorTransitionsAndProjectionRebuild();
    await testTrailingCommitAndNonBlockingPageQueries();
    await testFailedCommitAndRuntimeGuards();
    console.log('BMP committed route refresh, compact refs and non-blocking page tests passed');
}

if (require.main === module)
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { main };
