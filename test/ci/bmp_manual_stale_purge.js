const assert = require('node:assert/strict');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const SOURCE = 'manual-source-a';
const SCOPE = 'manual-scope-a';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function scopeInfo(sourceId = SOURCE, scopeId = SCOPE, kind = 'peer') {
    return {
        sourceId,
        scopeId,
        ownerKey: 'manual-owner',
        scopeKind: kind,
        afi: 1,
        safi: 1,
        ribType: kind === 'loc-rib' ? 'loc-rib' : 'pre-adj-rib-in'
    };
}

function compactResult(purged, hasMore, scope = scopeInfo()) {
    const result = {
        purged,
        hasMore,
        nextCursor: null,
        affectedScopes: purged > 0 ? [{ ...scope, deletedRoutes: purged }] : []
    };
    // Both RA modes must use only the lightweight result. An accidental route
    // expansion or per-NLRI delta path fails immediately instead of being hidden.
    for (const field of ['routes', 'deltas'])
        Object.defineProperty(result, field, {
            get() {
                throw new Error(`manual purge must not inspect ${field}`);
            }
        });
    return result;
}

function makeWorker(enabled = false) {
    const worker = Object.create(BmpWorker.prototype);
    const calls = [];
    const responses = [];
    Object.assign(worker, {
        bmpRuntimeStarted: true,
        bmpStopping: false,
        persistenceFailure: null,
        staleScopePurgeTasks: new Map(),
        routeAssuranceService: new BmpRouteAssuranceService({ enabled }),
        ingestPool: {
            async fence(sourceId) {
                calls.push(['ingest-fence', sourceId]);
            }
        },
        persistence: {
            async fence(sourceId) {
                calls.push(['writer-fence', sourceId]);
            },
            async purgeStaleRoutes(query, options) {
                calls.push(['purge', query, options]);
                return compactResult(0, false);
            }
        },
        enqueueRouteUpdateEvent: update => calls.push(['peer-update', update]),
        enqueueInstanceRouteUpdateEvent: update => calls.push(['instance-update', update]),
        scheduleRouteAssuranceRebuild: () => calls.push(['schedule-rebuild']),
        messageHandler: {
            sendSuccessResponse: (messageId, data) => responses.push({ messageId, status: 'success', data }),
            sendErrorResponse: (messageId, msg) => responses.push({ messageId, status: 'error', msg })
        }
    });
    return { worker, calls, responses };
}

async function testCompactBatchesAndProgress() {
    for (const enabled of [false, true]) {
        for (const kind of ['peer', 'loc-rib']) {
            const { worker, calls, responses } = makeWorker(enabled);
            const scope = scopeInfo(SOURCE, SCOPE, kind);
            const secondBatch = deferred();
            const secondStarted = deferred();
            let batches = 0;
            worker.persistence.purgeStaleRoutes = async (query, options) => {
                calls.push(['purge', query, options]);
                if (++batches === 1) return compactResult(20000, true, scope);
                secondStarted.resolve();
                return secondBatch.promise;
            };
            const summary = { active: 7, stale: 0, total: 7 };
            const observedSummaries = [];
            const lookup = {
                ...scope,
                bgpSession: { setRouteSummary: (...args) => observedSummaries.push(args) },
                bgpInstance: { setRouteSummary: value => observedSummaries.push(value) }
            };
            worker.getBgpSessionRouteScope = () => lookup;
            worker.getBgpInstanceRouteScope = () => lookup;
            worker.readPersistence = async (...args) => {
                calls.push(['summary', ...args]);
                return summary;
            };
            const request =
                kind === 'peer'
                    ? worker.purgeStaleBgpRoutes('request', {})
                    : worker.purgeStaleBgpInstanceRoutes('request', {});
            await secondStarted.promise;
            const eventName = kind === 'peer' ? 'peer-update' : 'instance-update';
            const firstEvent = calls.find(call => call[0] === eventName)?.[1];
            assert.equal(firstEvent.changedCount, 20000, 'first batch must refresh views before the task finishes');
            assert.equal(firstEvent.sourceId, SOURCE);
            assert.equal(firstEvent.scopeId, SCOPE);
            assert.equal(firstEvent.reason, 'manual-stale-purge');
            assert.equal(firstEvent.projectionReset, true);
            assert.equal(responses.length, 0, 'do not claim completion after only the first batch');
            await assert.rejects(worker.purgeStaleScope(lookup), { code: 'BMP_STALE_PURGE_IN_PROGRESS' });
            assert.equal(batches, 2, 'duplicate clicks must not start a second deletion loop');
            secondBatch.resolve(compactResult(3, false, scope));
            await request;
            assert.deepEqual(responses, [{ messageId: 'request', status: 'success', data: { deleted: 20003 } }]);
            assert.equal(worker.staleScopePurgeTasks.size, 0);
            assert.deepEqual(
                calls.filter(call => call[0].endsWith('-fence')),
                [
                    ['ingest-fence', SOURCE],
                    ['writer-fence', SOURCE]
                ]
            );
            for (const [, query, options] of calls.filter(call => call[0] === 'purge')) {
                assert.deepEqual(query, {
                    sourceId: SOURCE,
                    scopeId: SCOPE,
                    includeDetails: false,
                    routeLimit: 20000,
                    reason: 'manual-stale-purge'
                });
                assert.deepEqual(options, { fence: false });
            }
            assert.deepEqual(
                calls.filter(call => call[0] === eventName).map(call => call[1].changedCount),
                [20000, 3]
            );
            assert.deepEqual(
                calls.find(call => call[0] === 'summary'),
                ['summary', 'queryScopeSummary', { sourceId: SOURCE, scopeId: SCOPE }, { fence: false }]
            );
            assert.equal(observedSummaries.length, 1);
            assert.equal(worker.routeAssuranceService.state, enabled ? 'dirty' : 'disabled');
            assert.equal(calls.filter(call => call[0] === 'schedule-rebuild').length, enabled ? 2 : 0);
        }
    }
}

async function testIndependentScopesAndFailureRelease() {
    const { worker } = makeWorker();
    const first = deferred();
    const started = deferred();
    worker.persistence.purgeStaleRoutes = async query => {
        if (query.scopeId === SCOPE) {
            started.resolve();
            return first.promise;
        }
        return compactResult(1, false, scopeInfo(query.sourceId, query.scopeId, 'loc-rib'));
    };
    const request = worker.purgeStaleScope(scopeInfo());
    await started.promise;
    assert.equal(await worker.purgeStaleScope(scopeInfo('manual-source-b', 'manual-scope-b', 'loc-rib')), 1);
    assert.equal(worker.staleScopePurgeTasks.size, 1, 'another client/scope must not share the cleanup lock');
    first.reject(new Error('simulated database failure'));
    await assert.rejects(request, /simulated database failure/);
    assert.equal(worker.staleScopePurgeTasks.size, 0);
    worker.persistence.purgeStaleRoutes = async () => compactResult(0, false);
    assert.equal(await worker.purgeStaleScope(scopeInfo()), 0, 'a failed cleanup must release its scope lock');
}

async function testCancellationBoundaries() {
    for (const stage of ['ingest-fence', 'writer-fence', 'purge']) {
        const { worker, calls } = makeWorker(true);
        const gate = deferred();
        const started = deferred();
        const blocked = async sourceId => {
            calls.push([stage, sourceId]);
            started.resolve();
            return gate.promise;
        };
        if (stage === 'ingest-fence') worker.ingestPool.fence = blocked;
        if (stage === 'writer-fence') worker.persistence.fence = blocked;
        if (stage === 'purge') worker.persistence.purgeStaleRoutes = blocked;
        const request = worker.purgeStaleScope(scopeInfo());
        await started.promise;
        worker.bmpStopping = true;
        gate.resolve(stage === 'purge' ? compactResult(1, false) : undefined);
        await assert.rejects(request, { code: 'BMP_STALE_PURGE_CANCELLED' });
        assert.equal(worker.staleScopePurgeTasks.size, 0);
        assert.equal(
            calls.some(call => call[0].endsWith('-update')),
            false,
            'old runtime must not emit batch updates'
        );
    }
    const { worker, calls } = makeWorker();
    worker.bmpRuntimeStarted = false;
    await assert.rejects(worker.purgeStaleScope(scopeInfo()), { code: 'BMP_STALE_PURGE_CANCELLED' });
    assert.deepEqual(calls, []);
}

async function testOldFinallyCannotUnlockNewRuntime() {
    const { worker } = makeWorker();
    const oldGate = deferred();
    const oldStarted = deferred();
    const newGate = deferred();
    const newStarted = deferred();
    worker.persistence.purgeStaleRoutes = async () => {
        oldStarted.resolve();
        return oldGate.promise;
    };
    const oldRequest = worker.purgeStaleScope(scopeInfo());
    await oldStarted.promise;
    worker.persistence = {
        async fence() {},
        async purgeStaleRoutes() {
            newStarted.resolve();
            return newGate.promise;
        }
    };
    const newRequest = worker.purgeStaleScope(scopeInfo());
    await newStarted.promise;
    oldGate.resolve(compactResult(1, false));
    await assert.rejects(oldRequest, { code: 'BMP_STALE_PURGE_CANCELLED' });
    assert.equal(worker.staleScopePurgeTasks.size, 1, 'old finally must keep the new runtime lock');
    await assert.rejects(worker.purgeStaleScope(scopeInfo()), { code: 'BMP_STALE_PURGE_IN_PROGRESS' });
    newGate.resolve(compactResult(0, false));
    assert.equal(await newRequest, 0);
    assert.equal(worker.staleScopePurgeTasks.size, 0);
}

async function testSummaryCannotCrossRuntime() {
    const { worker, responses } = makeWorker();
    const summaryGate = deferred();
    const summaryStarted = deferred();
    let appliedSummary = false;
    worker.getBgpSessionRouteScope = () => ({
        ...scopeInfo(),
        bgpSession: {
            setRouteSummary() {
                appliedSummary = true;
            }
        }
    });
    worker.readPersistence = async () => {
        summaryStarted.resolve();
        return summaryGate.promise;
    };
    const request = worker.purgeStaleBgpRoutes('summary-request', {});
    await summaryStarted.promise;
    worker.persistence = { async fence() {} };
    summaryGate.resolve({ active: 0, stale: 0, total: 0 });
    await request;
    assert.equal(appliedSummary, false);
    assert.equal(responses[0].status, 'error');
    assert.match(responses[0].msg, /运行实例已改变/);
}

function testCommittedStreamOverflowRequiresRebuild() {
    const { worker, calls } = makeWorker(true);
    const service = worker.routeAssuranceService;
    service.dataMode = 'stream';
    service.groupRefreshDelayMs = 60000;
    service.groupRefreshLoader = async () => [];
    service.cache.set('existing-matrix', { analysis: {} });
    let applied = 0;
    const originalApply = service.applyCommittedDelta.bind(service);
    service.applyCommittedDelta = delta => {
        applied += 1;
        return originalApply(delta);
    };
    worker.handleCommittedPersistenceResult({
        deltas: Array.from({ length: 6000 }, (_, index) => ({
            action: 'delete',
            committed: true,
            projectionChanged: true,
            sourceId: SOURCE,
            previous: { afi: 1, safi: 1, ip: `10.${Math.floor(index / 256)}.${index % 256}.0`, mask: 24 }
        }))
    });
    assert.equal(applied, 5001, 'stop applying an overflowing batch once a full rebuild is required');
    assert.equal(service.state, 'dirty');
    assert.equal(service.cache.size, 0, 'the old matrix cannot be served after its incremental queue was discarded');
    assert.equal(service.pendingGroupRefreshes.size, 0);
    assert.equal(service.groupRefreshTimer, null);
    assert.equal(service.lastInvalidationReason, 'committed-delta-rebuild-required');
    assert.equal(calls.filter(call => call[0] === 'schedule-rebuild').length, 1);
}

function testRebuildWaitsUntilManualPurgeCompletes() {
    const { worker, calls } = makeWorker(true);
    worker.routeAssuranceService.state = 'dirty';
    worker.staleScopePurgeTasks.set('scope-task', {});
    let bootstraps = 0;
    worker.bootstrapRouteAssurance = async () => {
        bootstraps += 1;
    };
    worker.runRouteAssuranceRebuild();
    assert.equal(bootstraps, 0);
    assert.equal(calls.filter(call => call[0] === 'schedule-rebuild').length, 1);
    worker.staleScopePurgeTasks.clear();
    worker.runRouteAssuranceRebuild();
    assert.equal(bootstraps, 1);
}

async function main() {
    await testCompactBatchesAndProgress();
    await testIndependentScopesAndFailureRelease();
    await testCancellationBoundaries();
    await testOldFinallyCannotUnlockNewRuntime();
    await testSummaryCannotCrossRuntime();
    testCommittedStreamOverflowRequiresRebuild();
    testRebuildWaitsUntilManualPurgeCompletes();
    console.log('BMP manual stale purge and Route Assurance rebuild tests passed');
}

if (require.main === module)
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { main };
