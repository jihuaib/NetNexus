const { createSqliteDatabaseVersionCheck } = require('../../utils/sqliteDatabaseVersionCheck');
const { getClientWorkerIndex, listClientDatabases } = require('./bmpClientPersistencePaths');

const {
    validateExpectedVersion,
    inspectDatabaseVersion,
    assertUnchanged,
    resetInspectedDatabase,
    resetDatabaseIfVersionChanged
} = createSqliteDatabaseVersionCheck({
    name: 'BMP',
    errorCode: 'BMP_PERSISTENCE_DATABASE_VERSION_CHECK_FAILED'
});

function prepareBmpDatabaseVersions(dbPath, options = {}) {
    const { expectedVersion, workerIndex, workerCount = 1 } = options;
    validateExpectedVersion(expectedVersion);
    const ownedOnly = workerIndex !== undefined;
    if (
        ownedOnly &&
        (!Number.isSafeInteger(workerCount) ||
            workerCount < 1 ||
            !Number.isSafeInteger(workerIndex) ||
            workerIndex < 0 ||
            workerIndex >= workerCount)
    ) {
        throw new Error('BMP database version check writer lane is invalid');
    }
    const clients = listClientDatabases(dbPath).filter(
        client => !ownedOnly || getClientWorkerIndex(client.sourceId, workerCount) === workerIndex
    );
    const paths = [...(!ownedOnly || workerIndex === 0 ? [dbPath] : []), ...clients.map(client => client.dbPath)];
    // Inspect the entire selected set before deleting anything, so an unreadable
    // or unsafe sibling cannot cause a partial version-reset pass.
    const inspections = paths.map(databasePath => inspectDatabaseVersion(databasePath, expectedVersion));
    for (const inspection of inspections) assertUnchanged(inspection.result.dbPath, inspection.artifacts);
    const checkedDatabases = inspections.map(resetInspectedDatabase);
    return {
        expectedVersion,
        checkedDatabases,
        resetCount: checkedDatabases.filter(database => database.reset).length,
        deletedFiles: checkedDatabases.flatMap(database => database.deletedFiles)
    };
}

module.exports = { resetDatabaseIfVersionChanged, prepareBmpDatabaseVersions };
