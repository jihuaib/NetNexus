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

// Chunk flow control for streaming reads. The client hands over a
// SharedArrayBuffer with two Int32 slots: [0] = chunks consumed by the
// client, [1] = cancel flag. The worker may run at most `window` chunks ahead
// of the consumer and blocks with Atomics.wait otherwise, so a slow consumer
// never causes an unbounded backlog of posted messages.
const STREAM_CONSUMED_INDEX = 0;
const STREAM_CANCEL_INDEX = 1;

function streamChunks(messageId, control, produce) {
    const state = control?.buffer instanceof SharedArrayBuffer ? new Int32Array(control.buffer) : null;
    const window = Math.max(1, Number(control?.window) || 4);
    let produced = 0;
    const emit = chunk => {
        if (state) {
            for (;;) {
                if (Atomics.load(state, STREAM_CANCEL_INDEX) !== 0) {
                    return false;
                }
                const consumed = Atomics.load(state, STREAM_CONSUMED_INDEX);
                if (produced - consumed < window) {
                    break;
                }
                Atomics.wait(state, STREAM_CONSUMED_INDEX, consumed, 1000);
            }
        }
        parentPort.postMessage({ messageId, status: 'chunk', data: chunk });
        produced += 1;
        return true;
    };
    return produce(emit);
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
                    success(
                        messageId,
                        data.includeDeltas === false ? result : { ...result, deltas: result.deltas || [] }
                    );
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
            case BMP_PERSISTENCE_OP.STREAM_ROUTE_ASSURANCE_ROWS:
                success(
                    messageId,
                    streamChunks(messageId, data.control, emit =>
                        requireStore().streamRouteAssuranceRows(data.query || {}, emit)
                    )
                );
                break;
            case BMP_PERSISTENCE_OP.PURGE_STALE_ROUTES:
                success(messageId, requireStore().purgeStaleRoutes(data));
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
