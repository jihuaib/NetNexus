const { parentPort } = require('worker_threads');
const logger = require('../../log/logger');
const BmpPersistenceStore = require('./bmpPersistenceStore');
const { BMP_PERSISTENCE_OP } = require('./bmpPersistenceConst');

let store = null;

function success(messageId, data = null) {
    parentPort.postMessage({ messageId, status: 'success', data });
}

function failure(messageId, error) {
    parentPort.postMessage({
        messageId,
        status: 'error',
        msg: error?.message || String(error),
        data: { code: error?.code || 'BMP_PERSISTENCE_ERROR' }
    });
}

function requireStore() {
    if (!store) {
        throw new Error('BMP persistence store is not open');
    }
    return store;
}

function getLogStatus(currentStore) {
    return {
        logLevel: logger.logLevel,
        sqlTraceEnabled: typeof currentStore.isSqlTraceEnabled === 'function' ? currentStore.isSqlTraceEnabled() : false
    };
}

function handleMessage(message) {
    const { messageId, op, data = {} } = message || {};
    try {
        switch (op) {
            case BMP_PERSISTENCE_OP.OPEN:
                logger.setLevel(data.logLevel);
                if (store) {
                    store.close();
                }
                store = new BmpPersistenceStore(data).open();
                if (typeof store.setLogLevel === 'function') {
                    store.setLogLevel(logger.logLevel);
                }
                success(messageId, { ...store.getStatus(), ...getLogStatus(store) });
                break;
            case BMP_PERSISTENCE_OP.SET_LOG_LEVEL:
                {
                    const currentStore = requireStore();
                    logger.setLevel(data.logLevel);
                    if (typeof currentStore.setLogLevel === 'function') {
                        currentStore.setLogLevel(logger.logLevel);
                    }
                    success(messageId, getLogStatus(currentStore));
                }
                break;
            case BMP_PERSISTENCE_OP.APPLY_BATCH:
                {
                    const result = requireStore().applyBatch(data);
                    success(messageId, { ...result, deltas: result.deltas || [] });
                }
                break;
            case BMP_PERSISTENCE_OP.QUERY_ROUTES:
                success(messageId, requireStore().queryRoutes(data));
                break;
            case BMP_PERSISTENCE_OP.QUERY_ROUTE_SCOPE:
                success(messageId, requireStore().queryRouteScope(data));
                break;
            case BMP_PERSISTENCE_OP.QUERY_SCOPE_SUMMARY:
                success(messageId, requireStore().queryScopeSummary(data));
                break;
            case BMP_PERSISTENCE_OP.QUERY_TOPOLOGY:
                success(messageId, requireStore().queryTopology(data));
                break;
            case BMP_PERSISTENCE_OP.QUERY_STATISTICS_REPORTS:
                success(messageId, requireStore().queryStatisticsReports(data));
                break;
            case BMP_PERSISTENCE_OP.PURGE_SOURCE:
                success(messageId, requireStore().purgeSource(data));
                break;
            case BMP_PERSISTENCE_OP.PURGE_STALE_ROUTES:
                success(messageId, requireStore().purgeStaleRoutes(data));
                break;
            case BMP_PERSISTENCE_OP.QUERY_EVENTS:
                success(messageId, requireStore().queryEvents(data));
                break;
            case BMP_PERSISTENCE_OP.GET_STATUS:
                success(messageId, requireStore().getStatus(data));
                break;
            case BMP_PERSISTENCE_OP.SWEEP:
                success(messageId, requireStore().sweep(data));
                break;
            case BMP_PERSISTENCE_OP.CHECKPOINT:
                success(messageId, requireStore().checkpoint(data.mode));
                break;
            case BMP_PERSISTENCE_OP.CLOSE:
                if (store) {
                    store.close();
                    store = null;
                }
                success(messageId);
                break;
            default:
                throw new Error(`Unknown BMP persistence operation: ${op}`);
        }
    } catch (error) {
        failure(messageId, error);
    }
}

if (!parentPort) {
    throw new Error('BMP persistence worker must run in a worker thread');
}

parentPort.on('message', handleMessage);
