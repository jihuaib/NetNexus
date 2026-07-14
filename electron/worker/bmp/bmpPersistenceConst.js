const BMP_PERSISTENCE_OP = Object.freeze({
    OPEN: 'open',
    SET_LOG_LEVEL: 'set-log-level',
    APPLY_BATCH: 'apply-batch',
    QUERY_ROUTES: 'query-routes',
    QUERY_ROUTE_SCOPE: 'query-route-scope',
    QUERY_SCOPE_SUMMARY: 'query-scope-summary',
    QUERY_TOPOLOGY: 'query-topology',
    QUERY_STATISTICS_REPORTS: 'query-statistics-reports',
    PURGE_STALE_ROUTES: 'purge-stale-routes',
    QUERY_EVENTS: 'query-events',
    GET_STATUS: 'get-status',
    SWEEP: 'sweep',
    CHECKPOINT: 'checkpoint',
    CLOSE: 'close'
});

module.exports = {
    BMP_PERSISTENCE_OP
};
