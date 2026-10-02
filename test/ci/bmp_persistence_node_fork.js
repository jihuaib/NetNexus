const runBmpPersistenceE2e = require('./bmp_persistence_worker_e2e');

async function main() {
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
