const { parentPort, workerData, threadId } = require('worker_threads');
const logger = require('../../log/logger');
const BmpSession = require('./bmpSession');
const { createIngestSnapshot, cloneIngestValue } = require('./bmpIngestSnapshot');

if (!parentPort) throw new Error('BMP ingest worker must run in a worker thread');

const config = workerData?.config || {};
logger.setLevel(config.logLevel);
let context = null;
let actions = [];

function emitAction(action) {
    actions.push(action);
    return true;
}

function markSocketDestroyed(current) {
    if (current.socket.destroyed) return;
    current.socket.destroyed = true;
    current.closed = true;
    // A termination/invalid header can close the session in the middle of a
    // received chunk. Never parse subsequent frames from that closed stream.
    current.session.messageBuffer = Buffer.alloc(0);
    emitAction({ op: 'session-close' });
}

function closeContext(current) {
    if (!current || current.closeStarted) return;
    current.closeStarted = true;
    current.sessionClose();
    current.closed = true;
}

const facade = {
    bmpConfigData: config,
    persistence: {},
    enqueuePersistenceMutation(mutation) {
        if (context?.failure) return false;
        return emitAction({ op: 'mutation', mutation });
    },
    enqueueRouteUpdateEvent(update) {
        return emitAction({ op: 'route-update', update });
    },
    enqueueInstanceRouteUpdateEvent(update) {
        return emitAction({ op: 'instance-route-update', update });
    },
    requestPersistenceSweep(sourceId) {
        return emitAction({ op: 'sweep', sourceId });
    },
    invalidateRouteAssurance(reason) {
        return emitAction({ op: 'assurance-invalidated', reason });
    },
    requestNotificationPeerRoutePurge(query) {
        return emitAction({ op: 'notification-purge', query });
    },
    removeBmpSessionByKey(sessionKey, expectedSession) {
        if (!context || context.sessionKey !== sessionKey || (expectedSession && context.session !== expectedSession)) {
            return null;
        }
        closeContext(context);
        return context.session;
    },
    handlePersistenceFailure(error) {
        if (!context || context.failure) return;
        context.failure = error instanceof Error ? error : new Error(String(error));
        closeContext(context);
    }
};

const messageHandler = {
    sendEvent(eventName, payload = {}) {
        // A later frame in this same data batch can mutate peer capability arrays.
        // Preserve the event's state at emission, like the original IPC send did.
        return emitAction({ op: 'event', eventName, data: cloneIngestValue(payload) });
    }
};

const METADATA_FIELDS = [
    'localIp',
    'localPort',
    'remoteIp',
    'remotePort',
    'transport',
    'authentication',
    'authProfileId',
    'authProfileName',
    'authPeer',
    'tcpAoProfileId',
    'tcpAoProfileName',
    'tcpAoPeer',
    'tcpMd5ProfileId',
    'tcpMd5ProfileName',
    'tcpMd5Peer'
];

function attach(message) {
    if (context && !context.closed) {
        if (message.token === context.token && message.sessionKey === context.sessionKey) return;
        throw new Error('BMP ingest worker already owns an active connection');
    }
    if (message.token === null || message.token === undefined || !message.sessionKey) {
        throw new Error('BMP ingest attach requires token and sessionKey');
    }
    if (!Number.isSafeInteger(message.connectionGeneration) || message.connectionGeneration <= 0) {
        throw new Error('BMP ingest connection generation must be assigned by the parent');
    }
    if (typeof message.connectionId !== 'string' || !message.connectionId) {
        throw new Error('BMP ingest connection ID must be assigned by the parent');
    }
    if (!Number.isFinite(message.openedAtMs) || message.openedAtMs <= 0) {
        throw new Error('BMP ingest connection open time must be assigned by the parent');
    }

    const session = new BmpSession(messageHandler, facade);
    const metadata = cloneIngestValue(message.metadata || {});
    for (const key of METADATA_FIELDS) {
        if (metadata[key] !== undefined) session[key] = metadata[key];
    }
    session.localIp = metadata.localIp ?? metadata.localAddress ?? session.localIp;
    session.remoteIp = metadata.remoteIp ?? metadata.remoteAddress ?? session.remoteIp;
    session.persistenceConnectionId = message.connectionId;
    session.persistenceConnectionGeneration = message.connectionGeneration;
    session.persistenceOpenedAtMs = message.openedAtMs;

    const current = {
        token: message.token,
        sessionKey: message.sessionKey,
        session,
        socket: { destroyed: false },
        sessionClose: session.closeSession.bind(session),
        closeStarted: false,
        closed: false,
        failure: null
    };
    current.socket.destroy = () => markSocketDestroyed(current);
    session.socket = current.socket;
    session.closeSession = () => closeContext(current);
    context = current;
}

function result(message, error = null) {
    const matches = context && (message.token === undefined || message.token === context.token);
    const response = {
        op: 'result',
        token: message.token,
        requestId: message.requestId,
        actions,
        snapshot: matches ? createIngestSnapshot(context.session) : null,
        closed: matches ? context.closed : true,
        threadId
    };
    const failure = error || (matches && context.failure);
    if (failure)
        response.error = { message: failure.message || String(failure), code: failure.code || 'BMP_INGEST_ERROR' };
    parentPort.postMessage(response);
}

function handleMessage(message = {}) {
    actions = [];
    if (message.op === 'log-level') {
        logger.setLevel(message.level);
        if (message.requestId !== undefined) result(message);
        return;
    }
    if (message.op === 'shutdown') {
        try {
            closeContext(context);
            result(message);
        } catch (error) {
            result(message, error);
        } finally {
            parentPort.close();
        }
        return;
    }
    try {
        if (message.op === 'attach') {
            attach(message);
        } else {
            if (!context || message.token !== context.token) {
                const error = new Error('BMP ingest message does not match the owned connection');
                error.code = 'BMP_INGEST_TOKEN_MISMATCH';
                result(message, error);
                return;
            }
            switch (message.op) {
                case 'data':
                    if (!context.closed) {
                        if (!(message.data instanceof Uint8Array)) throw new Error('BMP ingest data must be binary');
                        context.session.recvMsg(
                            Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength)
                        );
                    }
                    break;
                case 'close':
                    closeContext(context);
                    break;
                case 'barrier':
                    break;
                default:
                    throw new Error(`Unknown BMP ingest operation: ${message.op}`);
            }
        }
        result(message);
    } catch (error) {
        // Refusing an attach or a stale token must not close the current owner.
        if (message.op !== 'attach' && context?.token === message.token) {
            context.failure = context.failure || error;
            try {
                closeContext(context);
            } catch (_closeError) {
                markSocketDestroyed(context);
            }
        }
        result(message, error);
    }
}

parentPort.on('message', handleMessage);
parentPort.postMessage({ op: 'ready', threadId });
