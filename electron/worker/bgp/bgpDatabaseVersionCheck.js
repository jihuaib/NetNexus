const { createSqliteDatabaseVersionCheck } = require('../../utils/sqliteDatabaseVersionCheck');

const { resetDatabaseIfVersionChanged } = createSqliteDatabaseVersionCheck({
    name: 'BGP',
    errorCode: 'BGP_ROUTE_DATABASE_VERSION_CHECK_FAILED'
});

module.exports = { resetDatabaseIfVersionChanged };
