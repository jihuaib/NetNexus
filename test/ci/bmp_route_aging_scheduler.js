const assert = require('node:assert/strict');

const BmpRouteAgingScheduler = require('../../electron/worker/bmp/bmpRouteAgingScheduler');

function nextImmediate() {
    return new Promise(resolve => setImmediate(resolve));
}

function deferred() {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
}

async function withTimeout(promise, label, timeoutMs = 1000) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function testValidationAndBatchYield() {
    const scheduler = new BmpRouteAgingScheduler({ batchSize: 2, timeBudgetMs: 100 });
    assert.throws(() => scheduler.schedule({ key: 'missing-map' }), /key and route Map/);
    assert.throws(() => scheduler.schedule({ routeMap: new Map() }), /key and route Map/);

    const routeMap = new Map(Array.from({ length: 6 }, (_, index) => [`route-${index}`, { ribEpoch: 0 }]));
    const complete = deferred();
    scheduler.schedule({
        key: 'scope:batch',
        routeMap,
        targetEpoch: 1,
        onComplete: (deleted, detail) => complete.resolve({ deleted, detail })
    });

    await nextImmediate();
    assert.equal(routeMap.size, 4, 'one event-loop turn must process only one configured batch');
    const result = await withTimeout(complete.promise, 'batched aging');
    assert.equal(result.deleted, 6);
    assert.equal(result.detail.reason, 'completed');
    assert.equal(result.detail.aborted, false);
    assert.deepEqual(scheduler.getStatus(), { jobs: 0, ready: 0 });
}

async function testTimeBudgetYield() {
    const scheduler = new BmpRouteAgingScheduler({ batchSize: 100, timeBudgetMs: 1 });
    const routeMap = new Map(Array.from({ length: 5 }, (_, index) => [`route-${index}`, { ribEpoch: 0 }]));
    const complete = deferred();
    scheduler.schedule({
        key: 'scope:budget',
        routeMap,
        targetEpoch: 1,
        isEligible: () => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 3) {
                // Simulate route cleanup work that consumes the current slice.
            }
            return true;
        },
        onComplete: deleted => complete.resolve(deleted)
    });

    await nextImmediate();
    assert.ok(routeMap.size > 0, 'time budget must yield before a large batch is exhausted');
    assert.ok(routeMap.size < 5, 'each slice must still make forward progress');
    assert.equal(await withTimeout(complete.promise, 'time-budgeted aging'), 5);
}

async function testFixedScopeReplacementAndAcceleration() {
    const scheduler = new BmpRouteAgingScheduler({ batchSize: 10, timeBudgetMs: 100 });
    const routeMap = new Map([
        ['epoch-0', { ribEpoch: 0 }],
        ['epoch-1', { ribEpoch: 1 }],
        ['epoch-2', { ribEpoch: 2 }]
    ]);
    let ownerEpoch = 1;
    const replaced = deferred();
    assert.equal(
        scheduler.schedule({
            key: 'scope:replace',
            routeMap,
            targetEpoch: 1,
            delayMs: 100,
            isCurrent: epoch => ownerEpoch === epoch,
            onComplete: (deleted, detail) => replaced.resolve({ deleted, detail })
        }),
        true
    );

    ownerEpoch = 2;
    const current = deferred();
    assert.equal(
        scheduler.schedule({
            key: 'scope:replace',
            routeMap,
            targetEpoch: 2,
            isCurrent: epoch => ownerEpoch === epoch,
            onComplete: (deleted, detail) => current.resolve({ deleted, detail })
        }),
        true,
        'a newer epoch must replace the fixed scope job'
    );
    const oldResult = await replaced.promise;
    assert.equal(oldResult.deleted, 0);
    assert.equal(oldResult.detail.reason, 'replaced');
    assert.equal(oldResult.detail.aborted, true);

    const newResult = await withTimeout(current.promise, 'replacement aging');
    assert.equal(newResult.deleted, 2);
    assert.deepEqual([...routeMap.keys()], ['epoch-2']);

    const acceleratedMap = new Map([['old', { ribEpoch: 0 }]]);
    const accelerated = deferred();
    assert.equal(
        scheduler.schedule({
            key: 'scope:accelerate',
            routeMap: acceleratedMap,
            targetEpoch: 1,
            delayMs: 100,
            onComplete: deleted => accelerated.resolve(deleted)
        }),
        true
    );
    assert.equal(
        scheduler.schedule({
            key: 'scope:accelerate',
            routeMap: acceleratedMap,
            targetEpoch: 1,
            delayMs: 0
        }),
        false,
        'rescheduling the same epoch must reuse the scope job'
    );
    assert.equal(await withTimeout(accelerated.promise, 'accelerated aging'), 1);
}

async function testEpochAndRouteReplacementGuards() {
    const scheduler = new BmpRouteAgingScheduler({ batchSize: 10, timeBudgetMs: 100 });
    const original = { ribEpoch: 0, name: 'old' };
    const replacement = { ribEpoch: 1, name: 'new' };
    const routeMap = new Map([
        ['same-key', original],
        ['another-old-route', { ribEpoch: 0 }]
    ]);
    let ownerEpoch = 1;
    const complete = deferred();
    scheduler.schedule({
        key: 'scope:owner',
        routeMap,
        targetEpoch: 1,
        isCurrent: epoch => ownerEpoch === epoch,
        onDelete: (_route, routeKey) => {
            if (routeKey === 'same-key') {
                routeMap.set(routeKey, replacement);
                ownerEpoch = 2;
            }
        },
        onComplete: (deleted, detail) => complete.resolve({ deleted, detail })
    });

    const result = await withTimeout(complete.promise, 'epoch owner guard');
    assert.equal(result.deleted, 0);
    assert.equal(result.detail.reason, 'owner-changed');
    assert.equal(result.detail.aborted, true);
    assert.equal(routeMap.get('same-key'), replacement, 'old owner must not delete a replacement by key');
    assert.equal(routeMap.has('another-old-route'), true, 'old owner must stop before further deletion');

    const identityMap = new Map([['same-key', original]]);
    const identityComplete = deferred();
    scheduler.schedule({
        key: 'scope:identity',
        routeMap: identityMap,
        targetEpoch: 1,
        onDelete: (_route, routeKey) => identityMap.set(routeKey, replacement),
        onComplete: (deleted, detail) => identityComplete.resolve({ deleted, detail })
    });
    const identityResult = await withTimeout(identityComplete.promise, 'route identity guard');
    assert.equal(identityResult.deleted, 0);
    assert.equal(identityResult.detail.reason, 'completed');
    assert.equal(identityMap.get('same-key'), replacement);
}

async function testExhaustionAndCancellation() {
    const scheduler = new BmpRouteAgingScheduler({ batchSize: 10, timeBudgetMs: 100 });
    const routeMap = new Map(Array.from({ length: 5 }, (_, index) => [`route-${index}`, { ribEpoch: 0 }]));
    const exhausted = deferred();
    scheduler.schedule({
        key: 'scope:exhausted',
        routeMap,
        targetEpoch: 1,
        isExhausted: (_epoch, deleted) => deleted >= 2,
        onComplete: (deleted, detail) => exhausted.resolve({ deleted, detail })
    });
    const exhaustedResult = await withTimeout(exhausted.promise, 'exhausted aging');
    assert.equal(exhaustedResult.deleted, 2);
    assert.equal(exhaustedResult.detail.reason, 'exhausted');
    assert.equal(exhaustedResult.detail.aborted, false);
    assert.equal(routeMap.size, 3);

    const cancelledResults = [];
    for (const key of ['peer:one', 'peer:two', 'other:one']) {
        scheduler.schedule({
            key,
            routeMap: new Map([['old', { ribEpoch: 0 }]]),
            targetEpoch: 1,
            delayMs: 1000,
            onComplete: (deleted, detail) => cancelledResults.push({ key, deleted, detail })
        });
    }
    assert.equal(scheduler.cancel('other:one'), true);
    assert.equal(scheduler.cancel('other:one'), false);
    assert.equal(scheduler.cancelByPrefix('peer:'), 2);
    assert.equal(cancelledResults.length, 3);
    for (const result of cancelledResults) {
        assert.equal(result.deleted, 0);
        assert.equal(result.detail.reason, 'cancelled');
        assert.equal(result.detail.aborted, true);
    }
    assert.deepEqual(scheduler.getStatus(), { jobs: 0, ready: 0 });
}

async function testCallbackErrorIsolation() {
    const errors = [];
    const scheduler = new BmpRouteAgingScheduler({
        batchSize: 10,
        timeBudgetMs: 100,
        onError: (error, key, phase) => errors.push({ message: error.message, key, phase })
    });
    const routeMap = new Map([
        ['eligibility-error', { ribEpoch: 0, name: 'eligibility-error' }],
        ['delete-error', { ribEpoch: 0, name: 'delete-error' }],
        ['success', { ribEpoch: 0, name: 'success' }]
    ]);
    const complete = deferred();
    scheduler.schedule({
        key: 'scope:errors',
        routeMap,
        targetEpoch: 1,
        isEligible: route => {
            if (route.name === 'eligibility-error') {
                throw new Error('eligibility failed');
            }
            return true;
        },
        onDelete: (_route, key) => {
            if (key === 'delete-error') {
                throw new Error('delete callback failed');
            }
        },
        onComplete: (deleted, detail) => {
            complete.resolve({ deleted, detail });
            throw new Error('completion callback failed');
        }
    });

    const result = await withTimeout(complete.promise, 'callback error isolation');
    assert.equal(result.deleted, 1);
    assert.equal(result.detail.reason, 'completed');
    assert.deepEqual(
        errors.map(error => error.phase),
        ['isEligible', 'onDelete', 'onComplete']
    );
    assert.deepEqual([...routeMap.keys()], ['eligibility-error', 'delete-error']);
    assert.deepEqual(scheduler.getStatus(), { jobs: 0, ready: 0 });

    const reporterFailureComplete = deferred();
    const reporterFailureScheduler = new BmpRouteAgingScheduler({
        onError: () => {
            throw new Error('reporter failed');
        }
    });
    reporterFailureScheduler.schedule({
        key: 'scope:reporter-error',
        routeMap: new Map([
            ['bad', { ribEpoch: 0, name: 'bad' }],
            ['good', { ribEpoch: 0, name: 'good' }]
        ]),
        targetEpoch: 1,
        isEligible: route => {
            if (route.name === 'bad') {
                throw new Error('synthetic route error');
            }
            return true;
        },
        onComplete: deleted => reporterFailureComplete.resolve(deleted)
    });
    assert.equal(await withTimeout(reporterFailureComplete.promise, 'error reporter isolation'), 1);
}

async function main() {
    await testValidationAndBatchYield();
    await testTimeBudgetYield();
    await testFixedScopeReplacementAndAcceleration();
    await testEpochAndRouteReplacementGuards();
    await testExhaustionAndCancellation();
    await testCallbackErrorIsolation();
    console.log('BMP route aging scheduler tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
