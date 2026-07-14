const { parentPort } = require('worker_threads');
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

function handleMessage(message) {
    const { messageId, op, data = {} } = message || {};
    try {
        switch (op) {
            case BMP_PERSISTENCE_OP.OPEN:
                if (store) {
                    store.close();
                }
                store = new BmpPersistenceStore(data).open();
                success(messageId, store.getStatus());
                break;
            case BMP_PERSISTENCE_OP.APPLY_BATCH:
                success(messageId, requireStore().applyBatch(data));
                break;
            case BMP_PERSISTENCE_OP.QUERY_ROUTES:
                success(messageId, requireStore().queryRoutes(data));
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
