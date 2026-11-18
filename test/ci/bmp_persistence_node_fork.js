const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const runBmpPersistenceE2e = require('./bmp_persistence_worker_e2e');

async function testPartialSnapshot() {
    const complete = Array.from({ length: 55 }, (_, index) => ({
        persistentRouteId: `route-${index}`,
        persistentConnectionId: 'new-connection',
        scopeKind: index % 2 ? 'peer' : 'loc-rib'
    }));
    const snapshots = [
        complete.slice(0, 44),
        complete.slice(0, 54).concat({ ...complete[54], persistentConnectionId: 'old-connection' }),
        complete
    ];
    let reads = 0;
    const result = await runBmpPersistenceE2e.waitForScenarioRoutes(
        async (op, query) => {
            assert.equal(op, BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES);
            assert.equal(query.routeState, 'active');
            const list = snapshots[reads++];
            assert.ok(list, 'must finish on the complete snapshot');
            return { data: { total: list.length, list } };
        },
        routes => routes.every(route => route.persistentConnectionId === 'new-connection'),
        { routeState: 'active' }
    );
    assert.equal(reads, 3, 'partial commits and a partially refreshed connection must not complete the wait');
    assert.deepEqual(result.data.list, complete);
    await assert.rejects(
        runBmpPersistenceE2e.waitForScenarioRoutes(async () => ({ data: { total: 56, list: complete } })),
        /expected exactly 55 persisted BMP routes, got 56/
    );
}

async function main() {
    await testPartialSnapshot();
    await runBmpPersistenceE2e({
        utilityProcess: null,
        expectedRuntimeKind: 'child-process',
        assertCleanExit: true,
        rounds: 2
    });
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = main;
