const BMP_PERSISTENCE_OP = Object.freeze({
    OPEN: 'open',
    APPLY_BATCH: 'apply-batch',
    QUERY_ROUTES: 'query-routes',
    QUERY_EVENTS: 'query-events',
    GET_STATUS: 'get-status',
    SWEEP: 'sweep',
    CHECKPOINT: 'checkpoint',
    CLOSE: 'close'
});

module.exports = {
    BMP_PERSISTENCE_OP
};
