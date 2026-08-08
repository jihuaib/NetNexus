const bmpBrowserMockScript = `
(function installBmpApiMocks() {
    const unifiedCallbacks = [];

    window.__bmpE2eEmit = (type, data) => {
        unifiedCallbacks.forEach(callback => callback({ type, data }));
    };

    window.commonApi = {
        onUnifiedEvent: callback => {
            unifiedCallbacks.push(callback);
            return () => {
                const index = unifiedCallbacks.indexOf(callback);
                if (index >= 0) {
                    unifiedCallbacks.splice(index, 1);
                }
            };
        },
        notifyRendererReady: () => {},
        openDeveloperOptions: () => {},
        openSoftwareInfo: () => {}
    };

    window.__bmpMonitorRequests = [];
    window.__bmpEventScopes = new Set();
    const matchesClientKey = (client, clientKey) => {
        if (!client || typeof clientKey !== 'string') return false;
        if (clientKey.startsWith('source:')) {
            const sourceId = client.persistentSourceId || client.sourceId || '';
            return 'source:' + String(sourceId).trim().toLowerCase() === clientKey.toLowerCase();
        }
        if (clientKey.startsWith('connection:')) {
            return (
                'connection:' +
                    [client.localIp, client.localPort, client.remoteIp, client.remotePort]
                        .map(value => String(value ?? ''))
                        .join('|') ===
                clientKey
            );
        }
        return false;
    };
    window.windowApi = {
        openMonitor: async (monitorId, options) => {
            window.__bmpMonitorRequests.push({ monitorId, options: options || null });
            return { status: 'success', msg: 'monitor opened', data: { monitorId, reused: false } };
        },
        subscribeEventScope: async scopeId => {
            window.__bmpEventScopes.add(scopeId);
            return { status: 'success', data: { scopeId } };
        },
        unsubscribeEventScope: async scopeId => {
            window.__bmpEventScopes.delete(scopeId);
            return { status: 'success', data: { scopeId } };
        }
    };

    window.bmpApi = {
        saveBmpConfig: config => window.__bmpE2eCall('saveBmpConfig', config),
        loadBmpConfig: () => window.__bmpE2eCall('loadBmpConfig'),
        startBmp: config => window.__bmpE2eCall('startBmp', config),
        stopBmp: () => window.__bmpE2eCall('stopBmp'),
        getClientList: () => window.__bmpE2eCall('getClientList'),
        getClient: async clientKey => {
            const result = await window.__bmpE2eCall('getClientList');
            if (result?.status !== 'success') return result;
            const client = (Array.isArray(result.data) ? result.data : []).find(item =>
                matchesClientKey(item, clientKey)
            );
            return { ...result, data: client || null };
        },
        deleteClientData: request => window.__bmpE2eCall('deleteClientData', structuredClone(request)),
        getBgpSessions: client => window.__bmpE2eCall('getBgpSessions', client),
        getBgpRoutes: (client, session, af, ribType, page, pageSize, routeState, prefixFilter) =>
            window.__bmpE2eCall('getBgpRoutes', {
                client,
                session,
                af,
                ribType,
                page,
                pageSize,
                routeState,
                prefixFilter
            }),
        getBgpRouteDetail: (client, session, af, ribType, routeKey) =>
            window.__bmpE2eCall('getBgpRouteDetail', {
                client,
                session,
                af,
                ribType,
                routeKey
            }),
        getBgpInstances: client => window.__bmpE2eCall('getBgpInstances', client),
        getBgpInstanceRoutes: (client, instance, page, pageSize, routeState, prefixFilter) =>
            window.__bmpE2eCall('getBgpInstanceRoutes', {
                client,
                instance,
                page,
                pageSize,
                routeState,
                prefixFilter
            }),
        getBgpInstanceRouteDetail: (client, instance, routeKey) =>
            window.__bmpE2eCall('getBgpInstanceRouteDetail', {
                client,
                instance,
                routeKey
            }),
        getRouteLens: (query, routeState = 'active') => window.__bmpE2eCall('getRouteLens', query, routeState),
        getRouteAssurance: (filters = {}) => window.__bmpE2eCall('getRouteAssurance', filters),
        setRouteAssuranceEnabled: (enabled, filters = {}) =>
            window.__bmpE2eCall('setRouteAssuranceEnabled', enabled, filters),
        purgeStaleBgpRoutes: (client, session, af, ribType) =>
            window.__bmpE2eCall('purgeStaleBgpRoutes', {
                client,
                session,
                af,
                ribType
            }),
        purgeStaleBgpInstanceRoutes: (client, instance) =>
            window.__bmpE2eCall('purgeStaleBgpInstanceRoutes', {
                client,
                instance
            }),
        getBgpStatisticsReports: client => window.__bmpE2eCall('getBgpStatisticsReports', client),
        getBgpInstanceStatisticsReports: client => window.__bmpE2eCall('getBgpInstanceStatisticsReports', client),
        getPersistenceStatus: () => window.__bmpE2eCall('getPersistenceStatus'),
        getPersistedRouteEvents: query =>
            window.__bmpE2eCall('getPersistedRouteEvents', structuredClone(query || {}))
    };
})();
`;

const BmpE2eController = (() => {
    const fs = require('fs');
    const net = require('net');
    const os = require('os');
    const path = require('path');
    const { spawn } = require('child_process');
    const { loadBmpWorkerClassFromFile } = require('../bmp-worker-loader');
    const { findPackagedElectronExecutable, findPackagedElectronRoot } = require('./packaged-app');

    const projectRoot = path.join(__dirname, '..', '..');
    const workspaceElectronRoot = path.join(projectRoot, 'electron');
    const electronRoot = process.env.E2E_TARGET === 'browser' ? workspaceElectronRoot : findPackagedElectronRoot();
    const BmpConst = require(path.join(electronRoot, 'const', 'bmpConst'));
    const BgpConst = require(path.join(electronRoot, 'const', 'bgpConst'));
    const BmpSession = require(path.join(electronRoot, 'worker', 'bmp', 'bmpSession'));
    const RouteUpdateAggregator = require(path.join(electronRoot, 'utils', 'routeUpdateAggregator'));
    const BmpRouteAssuranceService = require(path.join(electronRoot, 'utils', 'bmpRouteAssuranceService'));
    const persistenceStorePath = path.join(electronRoot, 'worker', 'bmp', 'bmpPersistenceStore.js');
    const persistenceElectronExecutable =
        process.env.E2E_TARGET === 'browser' ? require('electron') : findPackagedElectronExecutable();

    function runPersistenceBridge() {
        const BmpPersistenceStore = require(process.argv[1]);
        let store = null;
        let pendingMutations = [];
        let batchSequence = 0;
        let committedThrough = 0;
        let flushTimer = null;

        function reviveIpcBuffers(value) {
            if (Buffer.isBuffer(value) || value === null || typeof value !== 'object') {
                return value;
            }
            if (Array.isArray(value)) {
                return value.map(reviveIpcBuffers);
            }
            if (value.type === 'Buffer' && Array.isArray(value.data)) {
                return Buffer.from(value.data);
            }
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveIpcBuffers(item)]));
        }

        function send(message, callback) {
            if (process.connected) {
                process.send(message, callback);
            } else if (callback) {
                callback();
            }
        }

        function respond(requestId, data = null) {
            send({ type: 'response', requestId, status: 'success', data });
        }

        function fail(requestId, error) {
            send({
                type: 'response',
                requestId,
                status: 'error',
                fatal: error?.bmpPersistenceFatal === true,
                error: {
                    message: error?.message || String(error),
                    code: error?.code || 'BMP_E2E_PERSISTENCE_ERROR'
                }
            });
        }

        function requireStore() {
            if (!store) {
                throw new Error('BMP E2E persistence store is not open');
            }
            return store;
        }

        function flushPendingMutations() {
            if (pendingMutations.length === 0) {
                return null;
            }
            const entries = pendingMutations;
            pendingMutations = [];
            batchSequence += 1;
            try {
                const includeDeltas = entries.some(entry => entry.includeDeltas !== false);
                const result = requireStore().applyBatch({
                    batchId: `bmp-e2e-${process.pid}-${Date.now()}-${batchSequence}`,
                    createdAtMs: Date.now(),
                    mutations: entries.map(entry => entry.mutation),
                    includeDeltas
                });
                const serializableResult = includeDeltas ? { ...result, deltas: result.deltas || [] } : result;
                committedThrough = entries[entries.length - 1].sequence;
                send({
                    type: 'committed',
                    committedThrough,
                    result: serializableResult
                });
                return serializableResult;
            } catch (error) {
                pendingMutations = [...entries, ...pendingMutations];
                error.bmpPersistenceFatal = true;
                throw error;
            }
        }

        function scheduleMutationFlush() {
            if (flushTimer) {
                return;
            }
            // Mirror the production persistence client's short batch timer. Interactive
            // read-replica queries intentionally do not fence, so the writer must commit
            // queued mutations independently instead of relying on a later query to flush.
            flushTimer = setTimeout(() => {
                flushTimer = null;
                try {
                    flushPendingMutations();
                } catch (error) {
                    send({
                        type: 'failure',
                        error: {
                            message: error?.message || String(error),
                            code: error?.code || 'BMP_E2E_PERSISTENCE_ERROR'
                        }
                    });
                }
            }, 5);
        }

        function invokeStore(method, data) {
            const currentStore = requireStore();
            flushPendingMutations();
            switch (method) {
                case 'fence':
                case 'drain':
                    return { committedThrough };
                case 'queryRoutes':
                case 'queryRouteScope':
                case 'queryScopeSummary':
                case 'queryTopology':
                case 'queryStatisticsReports':
                case 'purgeSource':
                case 'purgeStaleRoutes':
                case 'queryEvents':
                case 'sweep':
                    return currentStore[method](data || {});
                case 'getStatus': {
                    const status = currentStore.getStatus({ ...(data || {}), includeCounts: true });
                    const countQueries = {
                        sources: 'SELECT COUNT(*) AS count FROM bmp_sources',
                        connections: 'SELECT COUNT(*) AS count FROM bmp_connections',
                        scopes: 'SELECT COUNT(*) AS count FROM bmp_rib_scopes',
                        currentRoutes: 'SELECT COALESCE(SUM(route_count), 0) AS count FROM bmp_scope_route_counts',
                        routeEvents: 'SELECT COUNT(*) AS count FROM bmp_route_events',
                        statisticsSamples: 'SELECT COUNT(*) AS count FROM bmp_statistics_samples',
                        statisticsLatest: 'SELECT COUNT(*) AS count FROM bmp_statistics_latest',
                        routeAttributes: 'SELECT COUNT(*) AS count FROM bmp_route_attributes',
                        ingestBatches: 'SELECT COUNT(*) AS count FROM bmp_ingest_batches'
                    };
                    const e2eTableCounts = Object.fromEntries(
                        Object.entries(countQueries).map(([name, sql]) => [
                            name,
                            currentStore.db.prepare(sql).get().count
                        ])
                    );
                    return {
                        ...status,
                        e2eTableCounts,
                        e2eForeignKeyViolations: currentStore.db.pragma('foreign_key_check')
                    };
                }
                case 'checkpoint':
                    return currentStore.checkpoint(data?.mode);
                case 'setLogLevel':
                    if (typeof currentStore.setLogLevel === 'function') {
                        currentStore.setLogLevel(data?.logLevel);
                    }
                    return {
                        logLevel: data?.logLevel || 'off',
                        sqlTraceEnabled:
                            typeof currentStore.isSqlTraceEnabled === 'function'
                                ? currentStore.isSqlTraceEnabled()
                                : false
                    };
                default:
                    throw new Error(`Unsupported BMP E2E persistence method: ${method}`);
            }
        }

        process.on('message', rawMessage => {
            const message = reviveIpcBuffers(rawMessage);
            const { type, requestId } = message || {};
            try {
                if (type === 'open') {
                    if (store) {
                        store.close();
                    }
                    store = new BmpPersistenceStore(message.options || {}).open();
                    respond(requestId, store.getStatus());
                    return;
                }
                if (type === 'enqueue') {
                    pendingMutations.push({
                        sequence: message.sequence,
                        mutation: message.mutation,
                        includeDeltas: message.includeDeltas
                    });
                    scheduleMutationFlush();
                    return;
                }
                if (type === 'request') {
                    respond(requestId, invokeStore(message.method, message.data));
                    return;
                }
                if (type === 'close') {
                    if (flushTimer) {
                        clearTimeout(flushTimer);
                        flushTimer = null;
                    }
                    flushPendingMutations();
                    if (store) {
                        store.close();
                        store = null;
                    }
                    send({ type: 'response', requestId, status: 'success', data: null }, () => process.exit(0));
                    return;
                }
                throw new Error(`Unsupported BMP E2E persistence message: ${type}`);
            } catch (error) {
                fail(requestId, error);
            }
        });
    }

    const persistenceBridgeSource = `(${runPersistenceBridge.toString()})();`;

    function reviveIpcBuffers(value) {
        if (Buffer.isBuffer(value) || value === null || typeof value !== 'object') {
            return value;
        }
        if (Array.isArray(value)) {
            return value.map(reviveIpcBuffers);
        }
        if (value.type === 'Buffer' && Array.isArray(value.data)) {
            return Buffer.from(value.data);
        }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveIpcBuffers(item)]));
    }

    class E2eBmpPersistenceClient {
        constructor(options = {}) {
            this.options = options;
            this.dbPath = options.dbPath;
            this.readOnly = options.readOnly === true;
            this.logLevel = options.logLevel || 'off';
            this.onPause = typeof options.onPause === 'function' ? options.onPause : null;
            this.onResume = typeof options.onResume === 'function' ? options.onResume : null;
            this.onError = typeof options.onError === 'function' ? options.onError : null;
            this.onCommittedBatch = typeof options.onCommittedBatch === 'function' ? options.onCommittedBatch : null;
            this.includeCommittedDeltas =
                typeof options.includeCommittedDeltas === 'function'
                    ? options.includeCommittedDeltas
                    : options.includeCommittedDeltas !== false;
            this.worker = null;
            this.workerAlive = false;
            this.closing = false;
            this.failure = null;
            this.closePromise = null;
            this.exitPromise = null;
            this.callbacks = new Map();
            this.requestSequence = 0;
            this.mutationSequence = 0;
            this.committedMutationSequence = 0;
            this.queuedMutationBytes = new Map();
            this.stderr = '';
            this.paused = false;
        }

        async open() {
            if (this.worker) {
                return this.getStatus();
            }
            const child = spawn(persistenceElectronExecutable, ['-e', persistenceBridgeSource, persistenceStorePath], {
                cwd: projectRoot,
                env: {
                    ...process.env,
                    ELECTRON_RUN_AS_NODE: '1',
                    NODE_ENV: 'test'
                },
                serialization: 'json',
                stdio: ['ignore', 'ignore', 'pipe', 'ipc']
            });
            this.worker = child;
            this.workerAlive = true;
            child.stderr.on('data', chunk => {
                this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8000);
            });
            child.on('message', message => this.handleMessage(reviveIpcBuffers(message)));
            child.once('error', error => this.handleFailure(error));
            this.exitPromise = new Promise(resolve => {
                let settled = false;
                const settle = (code, signal) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    this.workerAlive = false;
                    const error = new Error(
                        `BMP E2E persistence bridge exited code=${code} signal=${signal || 'none'}${
                            this.stderr ? `: ${this.stderr.trim()}` : ''
                        }`
                    );
                    this.rejectCallbacks(error);
                    if (!this.closing) {
                        this.handleFailure(error);
                    }
                    resolve({ code, signal });
                };
                child.once('exit', settle);
                child.once('close', settle);
            });

            return this.sendRequest('open', {
                options: {
                    dbPath: this.dbPath,
                    readOnly: this.readOnly,
                    logLevel: this.logLevel
                }
            });
        }

        handleMessage(message) {
            if (message?.type === 'failure') {
                const error = new Error(message.error?.message || 'BMP E2E persistence bridge failed');
                error.code = message.error?.code;
                this.handleFailure(error);
                return;
            }
            if (message?.type === 'committed') {
                this.markCommitted(message.committedThrough);
                if (this.onCommittedBatch) {
                    try {
                        const callbackResult = this.onCommittedBatch(message.result);
                        if (callbackResult && typeof callbackResult.catch === 'function') {
                            callbackResult.catch(error => this.onError?.(error));
                        }
                    } catch (error) {
                        this.onError?.(error);
                    }
                }
                return;
            }

            const callback = this.callbacks.get(message?.requestId);
            if (!callback) {
                return;
            }
            clearTimeout(callback.timer);
            this.callbacks.delete(message.requestId);
            if (message.status === 'success') {
                callback.resolve(message.data);
                return;
            }
            const error = new Error(message.error?.message || 'BMP E2E persistence request failed');
            error.code = message.error?.code;
            if (message.fatal === true) {
                callback.reject(error);
                this.handleFailure(error);
                return;
            }
            callback.reject(error);
        }

        handleFailure(error) {
            if (this.failure || this.closing) {
                return;
            }
            this.failure = error instanceof Error ? error : new Error(String(error));
            this.rejectCallbacks(this.failure);
            this.onError?.(this.failure);
        }

        rejectCallbacks(error) {
            this.callbacks.forEach(callback => {
                clearTimeout(callback.timer);
                callback.reject(error);
            });
            this.callbacks.clear();
        }

        sendRequest(type, payload = {}, options = {}) {
            if (!this.worker || !this.workerAlive) {
                return Promise.reject(this.failure || new Error('BMP E2E persistence bridge is not running'));
            }
            if (this.failure) {
                return Promise.reject(this.failure);
            }
            if (this.closing && options.allowDuringClosing !== true) {
                return Promise.reject(new Error('BMP E2E persistence bridge is closing'));
            }

            this.requestSequence += 1;
            const requestId = `bmp-e2e-store-${process.pid}-${Date.now()}-${this.requestSequence}`;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.callbacks.delete(requestId);
                    reject(new Error(`BMP E2E persistence ${type} request timed out`));
                }, 30000);
                this.callbacks.set(requestId, { resolve, reject, timer });
                this.worker.send({ type, requestId, ...payload }, error => {
                    if (!error) {
                        return;
                    }
                    const callback = this.callbacks.get(requestId);
                    if (callback) {
                        clearTimeout(callback.timer);
                        this.callbacks.delete(requestId);
                        callback.reject(error);
                    }
                });
            });
        }

        enqueue(mutation) {
            if (this.readOnly) {
                throw new Error('Cannot enqueue writes on a read-only BMP E2E persistence client');
            }
            if (!this.worker || !this.workerAlive || this.closing) {
                throw new Error('BMP E2E persistence bridge is not accepting writes');
            }
            if (this.failure) {
                throw this.failure;
            }
            this.mutationSequence += 1;
            const sequence = this.mutationSequence;
            this.queuedMutationBytes.set(sequence, Buffer.byteLength(JSON.stringify(mutation), 'utf8'));
            const includeDeltas =
                typeof this.includeCommittedDeltas === 'function'
                    ? this.includeCommittedDeltas({ mutations: [mutation] }) !== false
                    : this.includeCommittedDeltas;
            this.worker.send({ type: 'enqueue', sequence, mutation, includeDeltas }, error => {
                if (error) {
                    this.handleFailure(error);
                }
            });
        }

        markCommitted(sequence) {
            const committedThrough = Number(sequence) || 0;
            this.committedMutationSequence = Math.max(this.committedMutationSequence, committedThrough);
            for (const queuedSequence of this.queuedMutationBytes.keys()) {
                if (queuedSequence <= this.committedMutationSequence) {
                    this.queuedMutationBytes.delete(queuedSequence);
                }
            }
        }

        async fence() {
            if (this.readOnly || this.committedMutationSequence >= this.mutationSequence) {
                return;
            }
            const result = await this.request('fence');
            this.markCommitted(result?.committedThrough);
        }

        drain() {
            return this.fence();
        }

        request(method, data = {}) {
            return this.sendRequest('request', { method, data });
        }

        queryRoutes(query = {}) {
            return this.request('queryRoutes', query);
        }

        queryRouteScope(query = {}) {
            return this.request('queryRouteScope', query);
        }

        queryScopeSummary(query = {}) {
            return this.request('queryScopeSummary', query);
        }

        queryTopology(query = {}) {
            return this.request('queryTopology', query);
        }

        queryStatisticsReports(query = {}) {
            return this.request('queryStatisticsReports', query);
        }

        async purgeStaleRoutes(query = {}) {
            await this.fence();
            return this.request('purgeStaleRoutes', query);
        }

        async purgeSource(query = {}) {
            await this.fence();
            return this.request('purgeSource', query);
        }

        queryEvents(query = {}) {
            return this.request('queryEvents', query);
        }

        getStatus(options = {}) {
            return this.request('getStatus', options);
        }

        sweep(options = {}) {
            return this.request('sweep', options);
        }

        checkpoint(mode = 'PASSIVE') {
            return this.request('checkpoint', { mode });
        }

        async setLogLevel(level) {
            const result = await this.request('setLogLevel', { logLevel: level || 'off' });
            this.logLevel = result?.logLevel || 'off';
            return result;
        }

        getWatermark() {
            const queueBytes = Array.from(this.queuedMutationBytes.values()).reduce((total, bytes) => total + bytes, 0);
            return {
                queueLength: this.queuedMutationBytes.size,
                queueBytes,
                inFlightBytes: 0,
                bufferedBytes: queueBytes,
                paused: false,
                failed: Boolean(this.failure)
            };
        }

        close(options = {}) {
            if (!this.closePromise) {
                this.closePromise = this.closeInternal(options);
            }
            return this.closePromise;
        }

        async closeInternal(options = {}) {
            if (!this.worker) {
                return;
            }
            const child = this.worker;
            let closeError = null;
            this.closing = true;
            try {
                if (this.workerAlive && !this.failure) {
                    await this.sendRequest('close', {}, { allowDuringClosing: true });
                }
            } catch (error) {
                closeError = error;
            }
            const waitForExit = timeout => {
                let timer = null;
                return Promise.race([
                    this.exitPromise.then(() => true),
                    new Promise(resolve => {
                        timer = setTimeout(() => resolve(false), timeout);
                    })
                ]).finally(() => clearTimeout(timer));
            };
            try {
                let exited = await waitForExit(2000);
                if (!exited && this.workerAlive) {
                    child.kill('SIGKILL');
                    exited = await waitForExit(2000);
                }
                if (!exited) {
                    closeError ||= new Error('BMP E2E persistence bridge did not exit after SIGKILL');
                }
            } finally {
                this.worker = null;
                this.workerAlive = false;
                this.rejectCallbacks(closeError || new Error('BMP E2E persistence bridge closed'));
            }
            if (closeError && options.suppressErrors !== true) {
                throw closeError;
            }
        }
    }

    const BMP_EVENT_TYPE_TO_RENDERER_TYPE = {
        [BmpConst.BMP_EVT_TYPES.INITIATION]: 'bmp:initiation',
        [BmpConst.BMP_EVT_TYPES.SESSION_UPDATE]: 'bmp:sessionUpdate',
        [BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE]: 'bmp:routeUpdate',
        [BmpConst.BMP_EVT_TYPES.TERMINATION]: 'bmp:termination',
        [BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE]: 'bmp:instanceUpdate',
        [BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE]: 'bmp:instanceRouteUpdate',
        [BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT]: 'bmp:statisticsReport'
    };

    function successResponse(data = null, msg = '') {
        return { status: 'success', msg, data };
    }

    function errorResponse(msg = '', data = null) {
        return { status: 'error', msg, data };
    }

    function delay(ms) {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }

    function u16(value) {
        return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
    }

    function u32(value) {
        return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
    }

    function ip(ipAddress) {
        return Buffer.from(ipAddress.split('.').map(part => parseInt(part, 10)));
    }

    function bgpPacket(type, body) {
        return Buffer.concat([
            Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
            u16(BgpConst.BGP_HEAD_LEN + body.length),
            Buffer.from([type]),
            body
        ]);
    }

    function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE) {
        if (value.length > 255) {
            return Buffer.concat([
                Buffer.from([flags | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH, typeCode]),
                u16(value.length),
                value
            ]);
        }

        return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
    }

    function asPathAttr(asns = [65000]) {
        return pathAttr(
            BgpConst.BGP_PATH_ATTR.AS_PATH,
            Buffer.concat([
                Buffer.from([BgpConst.BGP_AS_PATH_TYPE.AS_SEQUENCE, asns.length]),
                Buffer.concat(asns.map(asn => u16(asn)))
            ])
        );
    }

    function labeledUnicastNlri(prefix, label) {
        const rawLabel = (label << 4) | 1;
        const labelBytes = Buffer.from([(rawLabel >> 16) & 0xff, (rawLabel >> 8) & 0xff, rawLabel & 0xff]);
        return Buffer.concat([Buffer.from([48]), labelBytes, ip(prefix).subarray(0, 3)]);
    }

    function labeledUnicastUpdate(prefix, { nextHop = '0.0.0.0', label = 777 } = {}) {
        const mpReachValue = Buffer.concat([
            u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
            Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST, 4]),
            ip(nextHop),
            Buffer.from([0]),
            labeledUnicastNlri(prefix, label)
        ]);
        const attrs = Buffer.concat([
            pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
            asPathAttr([65000]),
            pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL)
        ]);
        return bgpPacket(BgpConst.BGP_PACKET_TYPE.UPDATE, Buffer.concat([u16(0), u16(attrs.length), attrs]));
    }

    function bmpMessage(type, payload, version = BmpConst.BMP_VERSION.V4) {
        return Buffer.concat([
            Buffer.from([version]),
            u32(BmpConst.BMP_HEADER_LENGTH + payload.length),
            Buffer.from([type]),
            payload
        ]);
    }

    function peerHeader({
        flags = BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
        peerType = BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        rd = Buffer.alloc(BgpConst.BGP_RD_LEN),
        peerAddress = '192.0.2.2',
        peerAs = 65000,
        routerId = '192.0.2.1',
        timestamp = Math.floor(Date.now() / 1000),
        timestampMs = 0
    } = {}) {
        const address = peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB ? Buffer.alloc(4) : ip(peerAddress);
        return Buffer.concat([
            Buffer.from([peerType, flags]),
            rd,
            Buffer.alloc(12),
            address,
            u32(peerAs),
            ip(routerId),
            u32(timestamp),
            u32(timestampMs)
        ]);
    }

    function indexedTlv(type, index, value) {
        return Buffer.concat([u16(type), u16(value.length), u16(index), value]);
    }

    function routeMonitoringMessage(peer, bgpMessage, { vrfName = null } = {}) {
        const tlvs = [];
        if (vrfName) {
            tlvs.push(indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME, 0, Buffer.from(vrfName)));
        }
        tlvs.push(indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE, 0, bgpMessage));
        return bmpMessage(BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING, Buffer.concat([peerHeader(peer), ...tlvs]));
    }

    function lazyLocRibLabelRouteMessage({ prefix, label, vrfName }) {
        return routeMonitoringMessage(
            {
                flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
                peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB
            },
            labeledUnicastUpdate(prefix, { label }),
            { vrfName }
        );
    }

    function loadBmpWorkerClass() {
        const filePath = path.join(electronRoot, 'worker', 'bmp', 'bmpWorker.js');
        return loadBmpWorkerClassFromFile(filePath, module, 'E2E loading');
    }

    class CaptureMessageHandler {
        constructor(onEvent) {
            this.responses = new Map();
            this.onEvent = onEvent;
        }

        sendSuccessResponse(messageId, data = null, msg = '') {
            this.responses.set(messageId, successResponse(data, msg));
        }

        sendErrorResponse(messageId, msg = '', data = null) {
            this.responses.set(messageId, errorResponse(msg, data));
        }

        sendEvent(eventName, payload = null) {
            if (typeof this.onEvent !== 'function') {
                return;
            }

            const type = BMP_EVENT_TYPE_TO_RENDERER_TYPE[eventName];
            if (!type) {
                return;
            }

            this.onEvent({
                type,
                data: successResponse(payload?.data ?? null, payload?.msg || '')
            });
        }
    }

    class BmpE2eController {
        constructor(options = {}) {
            this.savedConfig = null;
            this.server = null;
            this.mockClient = null;
            this.mockClientExitPromise = null;
            this.lastMockClientExit = null;
            this.mockClientOutput = '';
            this.timeline = [];
            this.lastRouteQuerySnapshot = null;
            this.eventListeners = new Set();
            this.preserveArtifacts = options.preserveArtifacts === true;
            this.captureRawBmp = options.captureRawBmp === true;
            this.rawCaptureStreams = new Map();
            this.rawCaptureSequence = 0;
            const persistenceParent = options.artifactDirectory ? path.resolve(options.artifactDirectory) : os.tmpdir();
            fs.mkdirSync(persistenceParent, { recursive: true });
            this.persistenceTempDir = fs.mkdtempSync(path.join(persistenceParent, 'netnexus-bmp-e2e-'));
            this.persistenceDbPath = path.join(this.persistenceTempDir, 'bmp.sqlite3');
            this.cleanedUp = false;
            this.worker = this.createWorker();
            this.record('controller initialized', {
                persistenceDbPath: this.persistenceDbPath,
                captureRawBmp: this.captureRawBmp,
                preserveArtifacts: this.preserveArtifacts
            });
        }

        static async getFreePort() {
            const server = net.createServer();
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const { port } = server.address();
            await new Promise(resolve => server.close(resolve));
            return port;
        }

        createWorker() {
            const BmpWorker = loadBmpWorkerClass();
            const worker = Object.create(BmpWorker.prototype);
            const hasPersistenceFactory = typeof worker.createPersistenceClient === 'function';

            worker.server = null;
            worker.ipv6Server = null;
            worker.socket = null;
            worker.bmpConfigData = null;
            worker.bmpSessionMap = new Map();
            worker.clientDataDeleteInProgress = new Set();
            worker.clientDeleteRemoteIpGates = new Map();
            worker.routeAssuranceService = new BmpRouteAssuranceService({ enabled: false });
            worker.routeAssuranceFilters = {};
            worker.routeAssuranceRebuildScheduled = false;
            worker.routeUpdateAggregator = new RouteUpdateAggregator();
            worker.routeUpdateFlushTimer = null;
            worker.routeUpdateFlushIntervalMs = 100;
            worker.persistence = null;
            worker.persistenceReader = null;
            worker.persistenceFailure = null;
            worker.bmpSocketsPaused = false;
            worker.persistenceSweepTimer = null;
            worker.persistenceSweepCatchupTimer = null;
            worker.persistenceSweepRequestTimer = null;
            worker.persistenceSweepDeadlineTimer = null;
            worker.persistenceSweepRunning = false;
            worker.persistenceSweepPendingMaintenance = false;
            worker.persistenceSweepPendingSources = new Set();
            worker.persistenceSweepRequestSources = new Set();
            worker.messageHandler = new CaptureMessageHandler(event => this.emitEvent(event));
            worker.createPersistenceClient = options => new E2eBmpPersistenceClient(options);
            if (!hasPersistenceFactory) {
                worker.initializePersistence = () => this.initializeWorkerPersistence(worker);
            }

            return worker;
        }

        async initializeWorkerPersistence(worker) {
            worker.persistenceFailure = null;
            worker.bmpSocketsPaused = false;
            worker.bmpConfigData.persistenceEnabled = true;
            if (!worker.bmpConfigData.persistenceDbPath) {
                throw new Error('BMP persistence database path is missing');
            }

            worker.persistence = worker.createPersistenceClient({
                dbPath: worker.bmpConfigData.persistenceDbPath,
                logLevel: worker.bmpConfigData.logLevel,
                batchSize: worker.bmpConfigData.persistenceBatchSize,
                batchBytes: worker.bmpConfigData.persistenceBatchBytes,
                flushMs: worker.bmpConfigData.persistenceFlushMs,
                highWatermarkBytes: worker.bmpConfigData.persistenceHighWatermarkBytes,
                lowWatermarkBytes: worker.bmpConfigData.persistenceLowWatermarkBytes,
                onPause: () => worker.pauseBmpSockets?.(),
                onResume: () => worker.resumeBmpSockets?.(),
                onError: error => worker.handlePersistenceFailure?.(error),
                onCommittedBatch: result => worker.handleCommittedPersistenceResult?.(result),
                includeCommittedDeltas: () => worker.routeAssuranceService?.enabled === true
            });
            const status = await worker.persistence.open();
            const reader = worker.createPersistenceClient({
                dbPath: worker.bmpConfigData.persistenceDbPath,
                readOnly: true,
                logLevel: worker.bmpConfigData.logLevel,
                onError: error => worker.handlePersistenceReaderFailure?.(reader, error)
            });
            try {
                await reader.open();
                worker.persistenceReader = reader;
            } catch (error) {
                await reader.close({ suppressErrors: true }).catch(() => {});
                worker.persistenceReader = null;
                this.record('BMP persistence read replica unavailable', { error: error.message });
            }
            worker.schedulePersistenceSweep?.();
            return status;
        }

        onEvent(listener) {
            this.eventListeners.add(listener);
            return () => this.eventListeners.delete(listener);
        }

        record(message, data = null) {
            const line = {
                at: new Date().toISOString(),
                message
            };
            if (data !== null && data !== undefined) {
                line.data = data;
            }
            this.timeline.push(line);
        }

        summarizeClient(client) {
            if (!client) {
                return null;
            }

            return {
                hostName: client.hostName,
                sysName: client.sysName,
                localAddress: client.localAddress,
                localPort: client.localPort,
                remoteAddress: client.remoteAddress,
                remotePort: client.remotePort,
                bmpVersion: client.bmpVersion
            };
        }

        summarizeSession(session) {
            if (!session) {
                return null;
            }

            return {
                sessionIp: session.sessionIp,
                sessionAs: session.sessionAs,
                sessionRouterId: session.sessionRouterId,
                state: session.state,
                ribTypes: session.ribTypes,
                enabledAddrFamilyTypes: session.enabledAddrFamilyTypes
            };
        }

        summarizeInstance(instance) {
            if (!instance) {
                return null;
            }

            return {
                instancePeerKey: instance.instancePeerKey,
                instanceRouterId: instance.instanceRouterId,
                instanceName: instance.instanceName,
                instanceType: instance.instanceType,
                vrfTableNames: instance.vrfTableNames,
                routeSummary: instance.routeSummary
            };
        }

        summarizeRoute(route) {
            if (!route) {
                return null;
            }

            const routeIdentity = route.ip === null || route.ip === undefined ? '' : String(route.ip);
            const prefix =
                net.isIP(routeIdentity) && route.mask !== null && route.mask !== undefined
                    ? `${routeIdentity}/${route.mask}`
                    : routeIdentity;

            return {
                prefix,
                ip: route.ip,
                mask: route.mask,
                rd: route.rd,
                pathId: route.pathId,
                nextHop: route.nextHop,
                asPath: route.asPath,
                med: route.med,
                localPref: route.localPref,
                labels: route.labels,
                routeType: route.routeType,
                nlriIdentity: route.nlriDetail?.prefix,
                addrFamilyType: route.addrFamilyType,
                routeState: route.routeState,
                pathStatusText: route.pathStatusText,
                pathStatusReasonText: route.pathStatusReasonText,
                parseStatus: route.parseStatus,
                routeKey: route.routeKey
            };
        }

        summarizeRouteList(routes = [], sampleSize = 12) {
            return {
                sampleSize: Math.min(routes.length, sampleSize),
                omitted: Math.max(0, routes.length - sampleSize),
                routes: routes.slice(0, sampleSize).map(route => this.summarizeRoute(route))
            };
        }

        summarizeWorkerRequest(methodName, data) {
            if (!data) {
                return null;
            }

            switch (methodName) {
                case 'getBgpRoutes':
                    return {
                        client: this.summarizeClient(data.client),
                        session: this.summarizeSession(data.session),
                        af: data.af,
                        ribType: data.ribType,
                        page: data.page,
                        pageSize: data.pageSize,
                        routeState: data.routeState,
                        prefixFilter: data.prefixFilter || ''
                    };
                case 'getBgpRouteDetail':
                    return {
                        client: this.summarizeClient(data.client),
                        session: this.summarizeSession(data.session),
                        af: data.af,
                        ribType: data.ribType,
                        routeKey: data.routeKey,
                        route: this.summarizeRoute(data.route)
                    };
                case 'getBgpInstanceRoutes':
                    return {
                        client: this.summarizeClient(data.client),
                        instance: this.summarizeInstance(data.instance),
                        page: data.page,
                        pageSize: data.pageSize,
                        routeState: data.routeState,
                        prefixFilter: data.prefixFilter || ''
                    };
                case 'getBgpInstanceRouteDetail':
                    return {
                        client: this.summarizeClient(data.client),
                        instance: this.summarizeInstance(data.instance),
                        routeKey: data.routeKey,
                        route: this.summarizeRoute(data.route)
                    };
                case 'getPersistedRouteEvents':
                    return {
                        groupByRoute: data.groupByRoute === true,
                        prefixExact: data.prefixExact,
                        prefix: data.prefix,
                        prefixLength: data.prefixLength,
                        scopeKind: data.scopeKind,
                        ribType: data.ribType,
                        scopeId: data.scopeId,
                        routeId: data.routeId,
                        routeKey: data.routeKey,
                        toEventId: data.toEventId,
                        pageSize: data.pageSize,
                        cursor: data.cursor || null,
                        includeTotal: data.includeTotal
                    };
                case 'getRouteLens':
                    return {
                        query: data.query,
                        routeState: data.routeState
                    };
                case 'getRouteAssurance':
                    return {
                        ...data
                    };
                case 'setRouteAssuranceEnabled':
                    return {
                        enabled: Boolean(data.enabled),
                        filters: data.filters || {}
                    };
                case 'getBgpSessions':
                case 'getBgpInstances':
                case 'purgeStaleBgpRoutes':
                case 'purgeStaleBgpInstanceRoutes':
                case 'getBgpStatisticsReports':
                case 'getBgpInstanceStatisticsReports':
                    return {
                        client: this.summarizeClient(data.client || data),
                        session: this.summarizeSession(data.session),
                        instance: this.summarizeInstance(data.instance)
                    };
                default:
                    return data;
            }
        }

        summarizeResponse(methodName, response) {
            if (!response || response.status !== 'success') {
                return {
                    status: response?.status || 'missing',
                    msg: response?.msg || ''
                };
            }
            const data = response.data;
            if (Array.isArray(data)) {
                return { status: response.status, count: data.length };
            }
            if (data && Array.isArray(data.list)) {
                const summary = {
                    status: response.status,
                    list: data.list.length,
                    total: data.total,
                    summary: data.summary
                };

                if (methodName === 'getBgpRoutes' || methodName === 'getBgpInstanceRoutes') {
                    summary.queriedRoutes = this.summarizeRouteList(data.list);
                }

                return summary;
            }
            if (methodName === 'getBgpRouteDetail' || methodName === 'getBgpInstanceRouteDetail') {
                return {
                    status: response.status,
                    msg: response.msg || '',
                    route: this.summarizeRoute(data),
                    communities: data?.communities
                };
            }
            if (methodName === 'getRouteLens') {
                const stageCounts = Object.fromEntries(
                    Object.entries(data?.stages || {}).map(([stage, routes]) => [
                        stage,
                        Array.isArray(routes) ? routes.length : 0
                    ])
                );
                const routeSamples = Object.fromEntries(
                    Object.entries(data?.stages || {}).map(([stage, routes]) => [
                        stage,
                        (Array.isArray(routes) ? routes : [])
                            .slice(0, 3)
                            .map(entry => this.summarizeRoute(entry?.route || entry))
                    ])
                );

                return {
                    status: response.status,
                    query: data?.query,
                    summary: data?.summary,
                    stageCounts,
                    routeSamples,
                    policyDiffs: {
                        inbound: data?.policyDiffs?.inbound?.length || 0,
                        outbound: data?.policyDiffs?.outbound?.length || 0
                    },
                    insights: data?.insights?.length || 0
                };
            }
            if (methodName === 'getRouteAssurance') {
                return {
                    status: response.status,
                    filters: data?.filters,
                    funnel: data?.funnel,
                    summary: data?.summary,
                    facets: {
                        clients: data?.facets?.clients?.length || 0,
                        vrfs: data?.facets?.vrfs?.length || 0,
                        addressFamilies: data?.facets?.addressFamilies?.length || 0,
                        categories: data?.facets?.categories?.length || 0
                    },
                    issueCount: data?.issues?.length || 0,
                    issues: (data?.issues || []).slice(0, 10).map(issue => ({
                        category: issue.category,
                        evidenceType: issue.evidenceType,
                        displayPrefix: issue.nlri?.displayPrefix,
                        stagePresence: issue.stagePresence
                    })),
                    pagination: data?.pagination
                };
            }
            return {
                status: response.status,
                msg: response.msg || '',
                hasData: data !== null && data !== undefined
            };
        }

        emitEvent(event) {
            this.record('renderer event emitted', {
                type: event.type,
                status: event.data?.status,
                hasData: event.data?.data !== null && event.data?.data !== undefined
            });
            this.eventListeners.forEach(listener => listener(event));
        }

        normalizeConfig(config = {}) {
            const draft =
                Number(config.bmpV4TlvDraft) === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                    ? BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                    : BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20;
            const defaultPathMarkingTlvType =
                draft === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                    ? BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.PATH_MARKING
                    : BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING;
            const configuredPathMarkingTlvType = Number(config.pathMarkingTlvType);

            return {
                ...config,
                port: Number(config.port),
                listenHost: config.listenHost || process.env.NETNEXUS_BMP_E2E_LISTEN_HOST || '127.0.0.1',
                bmpV4TlvDraft: draft,
                logLevel: config.logLevel || 'off',
                persistenceEnabled: true,
                persistenceDbPath: this.persistenceDbPath,
                persistenceSweepIntervalMs: 60 * 60 * 1000,
                pathMarkingTlvType:
                    Number.isInteger(configuredPathMarkingTlvType) &&
                    configuredPathMarkingTlvType >= 1 &&
                    configuredPathMarkingTlvType <= 0x3fff
                        ? configuredPathMarkingTlvType
                        : defaultPathMarkingTlvType
            };
        }

        async call(method, ...args) {
            this.record(`renderer API call: ${method}`);
            switch (method) {
                case 'saveBmpConfig':
                    return this.saveBmpConfig(args[0]);
                case 'loadBmpConfig':
                    return this.loadBmpConfig();
                case 'startBmp':
                    return this.startBmp(args[0]);
                case 'stopBmp':
                    return this.stopBmp();
                case 'getClientList':
                    return this.invokeWorkerAsync('getClientList', null);
                case 'getBgpSessions':
                    return this.invokeWorkerAsync('getBgpSessions', args[0]);
                case 'deleteClientData':
                    return this.invokeWorkerAsync('deleteClientData', args[0]);
                case 'getBgpRoutes':
                    return this.invokeWorkerAsync('getBgpRoutes', args[0]);
                case 'getBgpRouteDetail':
                    return this.invokeWorkerAsync('getBgpRouteDetail', args[0]);
                case 'getBgpInstances':
                    return this.invokeWorkerAsync('getBgpInstances', args[0]);
                case 'getBgpInstanceRoutes':
                    return this.invokeWorkerAsync('getBgpInstanceRoutes', args[0]);
                case 'getBgpInstanceRouteDetail':
                    return this.invokeWorkerAsync('getBgpInstanceRouteDetail', args[0]);
                case 'getPersistenceStatus':
                    return this.invokeWorkerAsync('getPersistenceStatus', null);
                case 'getPersistedRouteEvents':
                    return this.invokeWorkerAsync('getPersistedRouteEvents', args[0] || {});
                case 'getRouteLens':
                    return this.invokeWorkerAsync('getRouteLens', {
                        query: args[0],
                        routeState: args[1]
                    });
                case 'getRouteAssurance':
                    return this.invokeWorkerAsync('getRouteAssurance', args[0] || {});
                case 'setRouteAssuranceEnabled':
                    return this.invokeWorkerAsync('setRouteAssuranceEnabled', {
                        enabled: Boolean(args[0]),
                        filters: args[1] || {}
                    });
                case 'purgeStaleBgpRoutes':
                    return this.invokeWorkerAsync('purgeStaleBgpRoutes', args[0]);
                case 'purgeStaleBgpInstanceRoutes':
                    return this.invokeWorkerAsync('purgeStaleBgpInstanceRoutes', args[0]);
                case 'getBgpStatisticsReports':
                    return this.invokeWorkerAsync('getBgpStatisticsReports', args[0]);
                case 'getBgpInstanceStatisticsReports':
                    return this.invokeWorkerAsync('getBgpInstanceStatisticsReports', args[0]);
                default:
                    return errorResponse(`Unsupported BMP E2E method: ${method}`);
            }
        }

        saveBmpConfig(config) {
            this.savedConfig = this.normalizeConfig(config);
            this.record('BMP config saved', {
                port: this.savedConfig.port,
                bmpV4TlvDraft: this.savedConfig.bmpV4TlvDraft,
                pathMarkingTlvType: this.savedConfig.pathMarkingTlvType
            });
            return successResponse(null, 'BMP配置文件保存成功');
        }

        loadBmpConfig() {
            this.record('BMP config loaded', {
                exists: !!this.savedConfig
            });
            return successResponse(this.savedConfig, this.savedConfig ? 'BMP配置文件加载成功' : 'BMP配置文件不存在');
        }

        async startBmp(config) {
            if (this.server) {
                return errorResponse('bmp协议已经启动');
            }

            this.savedConfig = this.normalizeConfig(config);
            this.worker.bmpConfigData = this.savedConfig;
            this.record('starting BMP TCP server', {
                port: this.savedConfig.port,
                persistenceDbPath: this.savedConfig.persistenceDbPath
            });

            try {
                const persistenceStatus = await this.worker.initializePersistence();
                this.record('BMP persistence initialized', {
                    dbPath: persistenceStatus.dbPath,
                    schemaVersion: persistenceStatus.schemaVersion,
                    journalMode: persistenceStatus.journalMode
                });
            } catch (error) {
                await this.closePersistence({ suppressErrors: true });
                this.worker.bmpConfigData = null;
                this.record('BMP persistence initialization failed', { error: error.message });
                return errorResponse(`BMP持久化初始化失败: ${error.message}`);
            }

            const server = net.createServer(socket => {
                const sessionKey = BmpSession.makeKey(
                    socket.localAddress,
                    socket.localPort,
                    socket.remoteAddress,
                    socket.remotePort
                );
                this.record('BMP mock TCP client connected', {
                    localAddress: socket.localAddress,
                    localPort: socket.localPort,
                    remoteAddress: socket.remoteAddress,
                    remotePort: socket.remotePort
                });
                this.worker.createBmpSession(socket, socket.remoteAddress, socket.remotePort);

                let rawCapture = null;
                if (this.captureRawBmp) {
                    this.rawCaptureSequence += 1;
                    const remotePart = String(socket.remoteAddress || 'unknown').replace(/[^0-9a-z._-]/giu, '-');
                    const capturePath = path.join(
                        this.persistenceTempDir,
                        `bmp-connection-${String(this.rawCaptureSequence).padStart(3, '0')}-${remotePart}.bin`
                    );
                    rawCapture = fs.createWriteStream(capturePath, { flags: 'wx', mode: 0o600 });
                    this.rawCaptureStreams.set(socket, rawCapture);
                    this.record('BMP raw capture started', { capturePath, remoteAddress: socket.remoteAddress });
                }

                socket.on('data', data => {
                    rawCapture?.write(data);
                    this.record('BMP TCP data received', {
                        bytes: data.length
                    });
                    const session = this.worker.bmpSessionMap.get(sessionKey);
                    if (session) {
                        session.recvMsg(data);
                    }
                });
                const closeCapture = () => {
                    const stream = this.rawCaptureStreams.get(socket);
                    if (!stream) return;
                    this.rawCaptureStreams.delete(socket);
                    stream.end();
                };
                socket.on('end', () => {
                    closeCapture();
                    this.worker.removeBmpSessionByKey(sessionKey);
                });
                socket.on('close', () => {
                    closeCapture();
                    this.worker.removeBmpSessionByKey(sessionKey);
                });
                socket.on('error', () => {
                    closeCapture();
                    this.worker.removeBmpSessionByKey(sessionKey);
                });
            });
            this.server = server;
            this.worker.server = server;
            server.once('close', () => {
                if (this.server === server) {
                    this.server = null;
                }
                if (this.worker.server === server) {
                    this.worker.server = null;
                }
            });

            try {
                await new Promise((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(this.savedConfig.port, this.savedConfig.listenHost, resolve);
                });
                this.record('BMP TCP server started', {
                    port: this.savedConfig.port,
                    listenHost: this.savedConfig.listenHost
                });
                return successResponse(null, 'bmp协议启动成功');
            } catch (error) {
                if (this.server === server) {
                    this.server = null;
                }
                if (this.worker.server === server) {
                    this.worker.server = null;
                }
                await this.closePersistence({ suppressErrors: true });
                this.worker.bmpConfigData = null;
                this.record('BMP TCP server start failed', {
                    error: error.message
                });
                return errorResponse(`bmp协议启动失败: ${error.message}`);
            }
        }

        async closePersistence(options = {}) {
            this.worker.clearPersistenceSweepTimer?.();
            const writer = this.worker.persistence;
            const reader = this.worker.persistenceReader;
            if (!writer && !reader) {
                return;
            }

            let closeError = null;
            try {
                if (writer) {
                    await writer.drain();
                }
            } catch (error) {
                closeError = error;
            } finally {
                this.worker.persistence = null;
                this.worker.persistenceReader = null;
                if (reader) {
                    try {
                        await reader.close({ suppressErrors: true });
                    } catch (error) {
                        closeError ||= error;
                    }
                }
                if (writer) {
                    try {
                        await writer.close({ suppressErrors: options.suppressErrors === true });
                    } catch (error) {
                        closeError ||= error;
                    }
                }
                this.worker.persistenceFailure = null;
                this.worker.bmpSocketsPaused = false;
            }

            this.record('BMP persistence closed', {
                dbPath: this.persistenceDbPath,
                success: !closeError
            });
            if (closeError && options.suppressErrors !== true) {
                throw closeError;
            }
        }

        async stopBmp() {
            this.record('stopping BMP server');
            this.worker.clearRouteUpdateAggregation?.();
            this.worker.clearPersistenceSweepTimer?.();

            for (const session of this.worker.bmpSessionMap.values()) {
                session.closeSession();
            }
            this.worker.bmpSessionMap.clear();

            const server = this.server || this.worker.server;
            this.server = null;
            this.worker.server = null;
            if (server) {
                await new Promise(resolve => server.close(resolve));
            }

            let persistenceError = null;
            try {
                await this.closePersistence();
            } catch (error) {
                persistenceError = error;
                this.record('BMP persistence close failed', { error: error.message });
            }
            this.worker.bmpConfigData = null;

            this.emitEvent({
                type: 'bmp:termination',
                data: successResponse(null)
            });

            return persistenceError
                ? errorResponse(`BMP已停止，但持久化未能安全关闭: ${persistenceError.message}`)
                : successResponse(null, 'bmp协议停止成功，持久化队列已落盘');
        }

        async invokeWorkerAsync(methodName, data) {
            const messageId = `${methodName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            this.worker.messageHandler.responses.delete(messageId);
            await this.worker[methodName](messageId, data);
            const response = this.worker.messageHandler.responses.get(messageId);
            this.worker.messageHandler.responses.delete(messageId);
            this.record(`worker query: ${methodName}`, {
                request: this.summarizeWorkerRequest(methodName, data),
                response: this.summarizeResponse(methodName, response)
            });
            return response || errorResponse(`${methodName} did not return a response`);
        }

        async startMockClient({ routes = 12, interval = 0, waitForCompletion = true, recordOutput = true } = {}) {
            if (!this.savedConfig?.port) {
                throw new Error('BMP server has not been started');
            }

            await this.stopMockClient();
            this.mockClientOutput = '';
            this.lastMockClientExit = null;
            this.mockClientExitPromise = null;
            this.record('starting mockBmpClient script', {
                routes,
                interval,
                waitForCompletion,
                port: this.savedConfig.port
            });

            const scriptPath = path.join(projectRoot, 'scripts', 'mockBmpClient.js');
            this.mockClient = spawn(
                process.execPath,
                [
                    scriptPath,
                    '--host',
                    '127.0.0.1',
                    '--port',
                    String(this.savedConfig.port),
                    '--routes',
                    String(routes),
                    '--interval',
                    String(interval),
                    '--no-dump-packets'
                ],
                {
                    cwd: projectRoot,
                    stdio: ['pipe', 'pipe', 'pipe']
                }
            );

            this.mockClientExitPromise = new Promise(resolve => {
                const child = this.mockClient;
                child.once('exit', (code, signal) => {
                    const exitInfo = {
                        code,
                        signal,
                        output: this.mockClientOutput
                    };
                    this.lastMockClientExit = exitInfo;
                    if (this.mockClient === child) {
                        this.mockClient = null;
                    }
                    this.record('mockBmpClient exited', { code, signal });
                    resolve(exitInfo);
                });
            });

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(
                        new Error(
                            `BMP mock client timed out waiting for ${
                                waitForCompletion ? 'scenario completion' : 'TCP connection'
                            }:\n${this.mockClientOutput}`
                        )
                    );
                }, 10000);
                const readyMarker = waitForCompletion
                    ? 'mock data sent; keeping BMP TCP connection open'
                    : 'connected to BMP server';

                const handleOutput = chunk => {
                    const text = chunk.toString();
                    this.mockClientOutput += text;
                    if (recordOutput) {
                        text.split(/\r?\n/)
                            .filter(Boolean)
                            .forEach(line => this.record('mockBmpClient output', { line }));
                    }
                    if (this.mockClientOutput.includes(readyMarker)) {
                        clearTimeout(timeout);
                        resolve();
                    }
                };

                this.mockClient.stdout.on('data', handleOutput);
                this.mockClient.stderr.on('data', handleOutput);
                this.mockClient.once('error', error => {
                    clearTimeout(timeout);
                    reject(error);
                });
                this.mockClient.once('exit', code => {
                    if (!this.mockClientOutput.includes(readyMarker)) {
                        clearTimeout(timeout);
                        reject(new Error(`BMP mock client exited with code ${code}:\n${this.mockClientOutput}`));
                    }
                });
            });
        }

        getMockClientProgress() {
            let routesSent = 0;
            const routePattern = /sent ipv4-route-(\d+) \(/gu;
            let match = routePattern.exec(this.mockClientOutput);
            while (match) {
                routesSent = Math.max(routesSent, Number(match[1]) || 0);
                match = routePattern.exec(this.mockClientOutput);
            }

            const scenarioComplete = this.mockClientOutput.includes('mock data sent; keeping BMP TCP connection open');
            const processRunning = Boolean(
                this.mockClient && this.mockClient.exitCode === null && this.mockClient.signalCode === null
            );
            return {
                connected: this.mockClientOutput.includes('connected to BMP server'),
                routesSent,
                scenarioComplete,
                processRunning,
                ingestRunning: processRunning && !scenarioComplete
            };
        }

        async getPersistenceSnapshot() {
            const writer = this.worker.persistence;
            if (!writer) {
                throw new Error('BMP persistence writer is not running');
            }

            const status = await writer.getStatus({ includeCounts: true });
            const watermark = writer.getWatermark();
            const snapshot = {
                enqueuedMutations: writer.mutationSequence,
                committedMutations: writer.committedMutationSequence,
                queueLength: watermark.queueLength,
                queueBytes: watermark.queueBytes,
                tableCounts: status.e2eTableCounts || {}
            };
            this.record('BMP persistence snapshot', snapshot);
            return snapshot;
        }

        async injectLazyLocRibLabelRoute({ prefix = '10.250.0.0', label = 777, vrfName = 'global-lazy-label' } = {}) {
            const bmpSession = Array.from(this.worker.bmpSessionMap.values())[0];
            if (!bmpSession) {
                throw new Error('BMP worker has no active session');
            }

            const message = lazyLocRibLabelRouteMessage({ prefix, label, vrfName });
            this.record('injecting lazy Loc-RIB label route', {
                prefix,
                label,
                vrfName,
                bytes: message.length
            });
            bmpSession.recvMsg(message);
            return { prefix, label, vrfName };
        }

        async waitForMockData({ routes = 12, timeout = 10000 } = {}) {
            const deadline = Date.now() + timeout;
            this.record('waiting for BMP worker data', {
                expectedRoutes: routes,
                timeout
            });

            while (Date.now() < deadline) {
                const clients = await this.invokeWorkerAsync('getClientList', null);
                if (clients.status === 'success' && clients.data.length > 0) {
                    const client = clients.data[0];
                    const sessions = await this.invokeWorkerAsync('getBgpSessions', client);
                    const instances = await this.invokeWorkerAsync('getBgpInstances', client);

                    if (
                        sessions.status === 'success' &&
                        sessions.data.length >= 3 &&
                        instances.status === 'success' &&
                        instances.data.length >= 1
                    ) {
                        const ipv4Session = sessions.data.find(session => session.sessionIp === '192.0.2.2');
                        const locRibInstance = instances.data.find(instance =>
                            Array.isArray(instance.vrfTableNames) ? instance.vrfTableNames.includes('global') : false
                        );

                        if (ipv4Session && locRibInstance) {
                            const routeResult = await this.invokeWorkerAsync('getBgpRoutes', {
                                client,
                                session: ipv4Session,
                                af: ipv4Session.enabledAddrFamilyTypes[0],
                                ribType: ipv4Session.ribTypes[0],
                                page: 1,
                                pageSize: 25,
                                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
                            });
                            const locRibRouteResult = await this.invokeWorkerAsync('getBgpInstanceRoutes', {
                                client,
                                instance: locRibInstance,
                                page: 1,
                                pageSize: 25,
                                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
                            });

                            if (
                                routeResult.status === 'success' &&
                                routeResult.data.total >= routes &&
                                locRibRouteResult.status === 'success' &&
                                locRibRouteResult.data.total >= Math.max(8, Math.min(25, routes))
                            ) {
                                this.lastRouteQuerySnapshot = {
                                    adjRib: {
                                        client: this.summarizeClient(client),
                                        session: this.summarizeSession(ipv4Session),
                                        af: ipv4Session.enabledAddrFamilyTypes[0],
                                        ribType: ipv4Session.ribTypes[0],
                                        page: 1,
                                        pageSize: 25,
                                        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                                        prefixFilter: '',
                                        total: routeResult.data.total,
                                        routes: routeResult.data.list.map(route => this.summarizeRoute(route))
                                    },
                                    locRib: {
                                        client: this.summarizeClient(client),
                                        instance: this.summarizeInstance(locRibInstance),
                                        page: 1,
                                        pageSize: 25,
                                        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                                        prefixFilter: '',
                                        total: locRibRouteResult.data.total,
                                        routes: locRibRouteResult.data.list.map(route => this.summarizeRoute(route))
                                    }
                                };

                                this.record('BMP worker data ready', {
                                    clients: clients.data.length,
                                    sessions: sessions.data.length,
                                    instances: instances.data.length,
                                    sessionRoutes: routeResult.data.total,
                                    locRibRoutes: locRibRouteResult.data.total,
                                    sessionRouteSample: this.summarizeRouteList(routeResult.data.list),
                                    locRibRouteSample: this.summarizeRouteList(locRibRouteResult.data.list)
                                });
                                return { client, ipv4Session, locRibInstance };
                            }
                        }
                    }
                }

                await delay(100);
            }

            throw new Error(`Timed out waiting for BMP mock data:\n${this.mockClientOutput}`);
        }

        async stopMockClient() {
            if (!this.mockClient) {
                return;
            }

            const child = this.mockClient;
            this.mockClient = null;

            if (child.exitCode !== null || child.signalCode !== null) {
                return;
            }

            await new Promise(resolve => {
                const timeout = setTimeout(resolve, 1000);
                child.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                if (child.stdin && !child.stdin.destroyed) {
                    child.stdin.write('disconnect\n');
                    child.stdin.end();
                } else {
                    child.kill('SIGTERM');
                }
            });
            this.record('mockBmpClient stopped');
        }

        async disconnectMockClient({ timeout = 5000 } = {}) {
            if (!this.mockClient) {
                throw new Error('BMP mock client has not been started');
            }

            const child = this.mockClient;
            if (child.exitCode === null && child.signalCode === null) {
                if (child.stdin && !child.stdin.destroyed) {
                    child.stdin.write('disconnect\n');
                    child.stdin.end();
                } else {
                    child.kill('SIGINT');
                }
            }

            const exitInfo = await this.waitForMockClientExit({ timeout });
            await this.waitForNoLiveClients({ timeout });
            return exitInfo;
        }

        async waitForMockClientExit({ timeout = 5000 } = {}) {
            if (this.lastMockClientExit) {
                return this.lastMockClientExit;
            }

            if (!this.mockClientExitPromise) {
                throw new Error('BMP mock client has not been started');
            }

            return Promise.race([
                this.mockClientExitPromise,
                new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`Timed out waiting for BMP mock client exit:\n${this.mockClientOutput}`));
                    }, timeout);
                })
            ]);
        }

        async waitForNoLiveClients({ timeout = 5000 } = {}) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const result = await this.invokeWorkerAsync('getClientList', null);
                if (
                    result.status === 'success' &&
                    Array.isArray(result.data) &&
                    result.data.every(client => client?.isOnline !== true)
                ) {
                    return true;
                }
                await delay(50);
            }
            throw new Error('Timed out waiting for all BMP clients to become offline');
        }

        async cleanup() {
            if (this.cleanedUp) {
                return;
            }
            this.cleanedUp = true;
            try {
                await this.stopBmp();
            } finally {
                try {
                    await this.stopMockClient();
                } finally {
                    try {
                        await this.closePersistence({ suppressErrors: true });
                    } finally {
                        for (const stream of this.rawCaptureStreams.values()) {
                            stream.end();
                        }
                        this.rawCaptureStreams.clear();
                        if (!this.preserveArtifacts) {
                            fs.rmSync(this.persistenceTempDir, { recursive: true, force: true });
                        }
                    }
                }
            }
        }
    }

    return BmpE2eController;
})();

module.exports = {
    BmpE2eController,
    bmpBrowserMockScript
};
