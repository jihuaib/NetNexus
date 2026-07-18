const net = require('net');
const util = require('util');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const BmpSession = require('./bmpSession');
const SshTunnel = require('../shared/sshTunnel');
const { getAfiAndSafi, getAddrFamilyType } = require('../../utils/bgpUtils');
const BmpBgpSession = require('./bmpBgpSession');
const BmpBgpInstance = require('./bmpBgpInstance');
const BmpBgpRoute = require('./bmpBgpRoute');
const BmpConst = require('../../const/bmpConst');
const RouteUpdateAggregator = require('../../utils/routeUpdateAggregator');
const BmpRouteAssuranceService = require('../../utils/bmpRouteAssuranceService');
const {
    splitSessionStatisticsReport,
    getSessionStatisticsEntityIdentityParts,
    getSessionStatisticsReportIdentityParts
} = require('../../utils/bmpStatistics');
const {
    MAX_RESULT_LIMIT: MAX_ROUTE_LENS_RESULT_LIMIT,
    buildBmpRouteLensFromPersistedRoutes,
    parseRouteLensQuery
} = require('../../utils/bmpRouteLens');
const BmpPersistenceClient = require('./bmpPersistenceClient');

class BmpWorker {
    constructor() {
        this.server = null;
        this.ipv6Server = null;
        this.socket = null;

        this.bmpConfigData = null; // bmp配置数据
        this.sshTunnel = null; // SSH隧道（用于MD5认证）

        this.bmpSessionMap = new Map(); // bmp会话map
        this.routeAssuranceService = new BmpRouteAssuranceService({ enabled: false });
        this.routeAssuranceFilters = {};
        this.routeAssuranceRebuildScheduled = false;
        this.routeUpdateAggregator = new RouteUpdateAggregator();
        this.routeUpdateFlushTimer = null;
        this.routeUpdateFlushIntervalMs = 1000;
        this.persistence = null;
        this.persistenceReader = null;
        this.persistenceFailure = null;
        this.bmpSocketsPaused = false;
        this.persistenceSweepTimer = null;
        this.persistenceSweepCatchupTimer = null;
        this.persistenceSweepRequestTimer = null;
        this.persistenceSweepDeadlineTimer = null;
        this.persistenceSweepRunning = false;
        this.persistenceSweepPending = false;
        this.clientDataDeleteInProgress = new Set();
        this.clientDeleteRemoteIpGates = new Map();

        // 创建消息处理器
        this.messageHandler = new WorkerMessageHandler({
            onLogLevelChange: logLevel => this.handleLogLevelChange(logLevel)
        });
        // 初始化消息处理器
        this.messageHandler.init();
        // 注册消息处理器
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.START_BMP, this.startBmp.bind(this));
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.STOP_BMP, this.stopBmp.bind(this));
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST, this.getClientList.bind(this));
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.DELETE_CLIENT_DATA,
            this.deleteClientData.bind(this)
        );
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, this.getBgpSessions.bind(this));
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES, this.getBgpRoutes.bind(this));
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTE_DETAIL,
            this.getBgpRouteDetail.bind(this)
        );
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, this.getBgpInstances.bind(this));
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES,
            this.getBgpInstanceRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTE_DETAIL,
            this.getBgpInstanceRouteDetail.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.PURGE_STALE_BGP_ROUTES,
            this.purgeStaleBgpRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.PURGE_STALE_BGP_INSTANCE_ROUTES,
            this.purgeStaleBgpInstanceRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_STATISTICS_REPORTS,
            this.getBgpStatisticsReports.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_STATISTICS_REPORTS,
            this.getBgpInstanceStatisticsReports.bind(this)
        );
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_ROUTE_LENS, this.getRouteLens.bind(this));
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_ROUTE_ASSURANCE,
            this.getRouteAssurance.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.SET_ROUTE_ASSURANCE_ENABLED,
            this.setRouteAssuranceEnabled.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_PERSISTENCE_STATUS,
            this.getPersistenceStatus.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES,
            this.getPersistedRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTE_EVENTS,
            this.getPersistedRouteEvents.bind(this)
        );
    }

    createBmpSession(socket, clientAddress, clientPort) {
        if (this.clientDeleteRemoteIpGates.has(String(clientAddress || ''))) {
            socket.destroy();
            return null;
        }
        if (this.persistenceFailure || this.persistence?.failure) {
            socket.destroy();
            return null;
        }
        const sessionKey = BmpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);
        this.removeBmpSessionByKey(sessionKey);

        const bmpSession = new BmpSession(this.messageHandler, this);
        this.bmpSessionMap.set(sessionKey, bmpSession);

        bmpSession.socket = socket;
        bmpSession.localIp = socket.localAddress;
        bmpSession.localPort = socket.localPort;
        bmpSession.remoteIp = clientAddress;
        bmpSession.remotePort = clientPort;

        if (this.bmpSocketsPaused || this.persistence?.paused) {
            socket.pause();
        }

        return bmpSession;
    }

    removeBmpSessionByKey(sessionKey) {
        const bmpSession = this.bmpSessionMap.get(sessionKey);
        if (!bmpSession) {
            return null;
        }

        this.bmpSessionMap.delete(sessionKey);
        bmpSession.closeSession();
        const clientInfo = bmpSession.getClientInfo();
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.TERMINATION, { data: clientInfo });
        return bmpSession;
    }

    enqueueRouteUpdateEvent(update) {
        if (!update?.assuranceIncremental) {
            this.invalidateRouteAssurance('route-update-without-delta');
        }
        this.routeUpdateAggregator.enqueueRouteUpdate(update);
        this.scheduleRouteUpdateFlush();
    }

    enqueueInstanceRouteUpdateEvent(update) {
        if (!update?.assuranceIncremental) {
            this.invalidateRouteAssurance('instance-route-update-without-delta');
        }
        this.routeUpdateAggregator.enqueueInstanceRouteUpdate(update);
        this.scheduleRouteUpdateFlush();
    }

    scheduleRouteUpdateFlush() {
        if (this.routeUpdateFlushTimer) {
            return;
        }

        this.routeUpdateFlushTimer = setTimeout(() => {
            this.flushRouteUpdateEvents();
        }, this.routeUpdateFlushIntervalMs);
        this.routeUpdateFlushTimer.unref?.();
    }

    flushRouteUpdateEvents() {
        if (this.routeUpdateFlushTimer) {
            clearTimeout(this.routeUpdateFlushTimer);
            this.routeUpdateFlushTimer = null;
        }

        const routeUpdates = this.routeUpdateAggregator.flushRouteUpdates();
        const instanceRouteUpdates = this.routeUpdateAggregator.flushInstanceRouteUpdates();

        if (routeUpdates.length > 0) {
            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, {
                data: { batch: true, updates: routeUpdates }
            });
        }
        if (instanceRouteUpdates.length > 0) {
            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE, {
                data: { batch: true, updates: instanceRouteUpdates }
            });
        }
    }

    clearRouteUpdateAggregation() {
        if (this.routeUpdateFlushTimer) {
            clearTimeout(this.routeUpdateFlushTimer);
            this.routeUpdateFlushTimer = null;
        }
        this.routeUpdateAggregator.clear();
    }

    invalidateRouteAssurance(reason = 'bmp-data-change') {
        const revision = this.routeAssuranceService?.invalidate?.(reason, { prepareBootstrap: true }) ?? null;
        this.scheduleRouteAssuranceRebuild();
        return revision;
    }

    scheduleRouteAssuranceRebuild() {
        if (this.routeAssuranceRebuildScheduled || !this.routeAssuranceService?.enabled) {
            return;
        }
        this.routeAssuranceRebuildScheduled = true;
        setImmediate(() => {
            this.routeAssuranceRebuildScheduled = false;
            if (!this.routeAssuranceService?.enabled || this.routeAssuranceService.state !== 'dirty') {
                return;
            }
            this.routeAssuranceService
                .bootstrapFromPersistedRoutes(
                    this.createPersistedRoutePageLoader(this.routeAssuranceFilters),
                    this.routeAssuranceFilters
                )
                .catch(error => logger.error(`Route Assurance rebuild failed: ${error.message}`));
        });
    }

    applyRouteAssuranceMutation(mutation) {
        try {
            return this.routeAssuranceService?.applyMutation?.(mutation) ?? false;
        } catch (error) {
            logger.error(`Route Assurance incremental update failed: ${error.message}`);
            this.invalidateRouteAssurance('incremental-update-error');
            return false;
        }
    }

    enqueuePersistenceMutation(mutation) {
        if (!this.persistence || !mutation || this.persistenceFailure) {
            return false;
        }
        try {
            this.persistence.enqueue(mutation);
            return true;
        } catch (error) {
            logger.error(`BMP persistence enqueue failed: ${error.message}`);
            this.handlePersistenceFailure(error);
            return false;
        }
    }

    pauseBmpSockets() {
        this.bmpSocketsPaused = true;
        this.bmpSessionMap.forEach(session => {
            if (session.socket && !session.socket.destroyed) {
                session.socket.pause();
            }
        });
    }

    resumeBmpSockets() {
        if (this.persistenceFailure || this.persistence?.failure || this.persistence?.paused) {
            return;
        }
        this.bmpSocketsPaused = false;
        this.bmpSessionMap.forEach(session => {
            if (session.socket && !session.socket.destroyed) {
                session.socket.resume();
            }
        });
    }

    handlePersistenceFailure(error) {
        if (this.persistenceFailure) {
            return;
        }
        this.persistenceFailure = error instanceof Error ? error : new Error(String(error));
        logger.error(`BMP persistence failed closed: ${this.persistenceFailure.message}`);
        this.clearPersistenceSweepTimer();
        this.pauseBmpSockets();
        const servers = [this.server, this.ipv6Server];
        this.server = null;
        this.ipv6Server = null;
        servers.forEach(server => {
            if (server) {
                try {
                    server.close(closeError => {
                        if (closeError && closeError.code !== 'ERR_SERVER_NOT_RUNNING') {
                            logger.error(
                                `Failed to close BMP listener after persistence failure: ${closeError.message}`
                            );
                        }
                    });
                } catch (closeError) {
                    if (closeError.code !== 'ERR_SERVER_NOT_RUNNING') {
                        logger.error(`Failed to close BMP listener after persistence failure: ${closeError.message}`);
                    }
                }
            }
        });
        this.bmpSessionMap.forEach(session => {
            if (session.socket && !session.socket.destroyed) {
                session.socket.destroy();
            }
        });
    }

    handlePersistenceReaderFailure(reader, error) {
        if (!reader || (!reader.failure && reader.workerAlive)) {
            return false;
        }
        logger.error(`BMP persistence reader failed: ${error.message}`);
        if (this.persistenceReader === reader) {
            this.persistenceReader = null;
        }
        if (!reader.closing) {
            reader.close({ suppressErrors: true }).catch(() => {});
        }
        return true;
    }

    async readPersistence(method, query = {}, options = {}) {
        if (!this.persistence || typeof this.persistence[method] !== 'function') {
            throw new Error('BMP持久化未打开');
        }
        if (options.fence !== false) {
            await this.persistence.fence();
        }

        let result;
        if (this.persistenceReader && typeof this.persistenceReader[method] === 'function') {
            const reader = this.persistenceReader;
            try {
                result = await reader[method](query);
            } catch (error) {
                if (!this.handlePersistenceReaderFailure(reader, error)) {
                    throw error;
                }
            }
        }
        if (result === undefined) {
            result = await this.persistence[method](query);
        }
        return result;
    }

    handleCommittedPersistenceResult(result) {
        const deltas = Array.isArray(result?.deltas) ? result.deltas : [];
        if (!this.routeAssuranceService?.enabled || deltas.length === 0) {
            return;
        }
        try {
            deltas.forEach(delta => {
                if (!delta?.projectionChanged || !['upsert', 'delete'].includes(delta.action)) {
                    return;
                }
                const scope = delta.scope || delta.mutation?.scope || null;
                const source = delta.source || delta.mutation?.source || null;
                this.routeAssuranceService.applyCommittedDelta({
                    ...delta,
                    scope,
                    source,
                    scopeKind: delta.scopeKind || scope?.kind,
                    ribType: delta.ribType || scope?.ribType,
                    afi: delta.afi ?? scope?.afi,
                    safi: delta.safi ?? scope?.safi,
                    route: delta.action === 'upsert' ? delta.current : delta.previous
                });
            });
        } catch (error) {
            logger.error(`Route Assurance committed delta failed: ${error.message}`);
            this.invalidateRouteAssurance('committed-delta-error');
        }
    }

    createPersistedRoutePageLoader(filters = {}) {
        const routeState = filters.routeState || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
        return cursor =>
            this.readPersistence(
                'queryRoutes',
                {
                    routeState,
                    pageSize: 5000,
                    includeTotal: false,
                    cursor
                },
                { fence: false }
            );
    }

    async handleLogLevelChange(logLevel) {
        if (this.bmpConfigData) {
            this.bmpConfigData.logLevel = logLevel;
        }

        const clients = [
            ['writer', this.persistence],
            ['reader', this.persistenceReader]
        ];
        await Promise.all(
            clients.map(async ([role, client]) => {
                if (!client || typeof client.setLogLevel !== 'function') {
                    return;
                }
                try {
                    await client.setLogLevel(logLevel);
                } catch (error) {
                    logger.warn(`同步 BMP SQLite ${role} 日志级别失败: ${error.message}`);
                }
            })
        );
    }

    createPersistenceClient(options) {
        return new BmpPersistenceClient(options);
    }

    async initializePersistence() {
        this.persistenceFailure = null;
        this.bmpSocketsPaused = false;
        // SQLite is the BMP RIB. It is no longer an optional projection of an
        // in-memory route map, so ingestion must fail closed if it cannot open.
        this.bmpConfigData.persistenceEnabled = true;
        if (!this.bmpConfigData.persistenceDbPath) {
            throw new Error('BMP persistence database path is missing');
        }

        this.persistence = this.createPersistenceClient({
            dbPath: this.bmpConfigData.persistenceDbPath,
            logLevel: this.bmpConfigData.logLevel,
            batchSize: this.bmpConfigData.persistenceBatchSize,
            batchBytes: this.bmpConfigData.persistenceBatchBytes,
            flushMs: this.bmpConfigData.persistenceFlushMs,
            highWatermarkBytes: this.bmpConfigData.persistenceHighWatermarkBytes,
            lowWatermarkBytes: this.bmpConfigData.persistenceLowWatermarkBytes,
            onPause: bytes => {
                logger.warn(`BMP persistence high watermark reached (${bytes} bytes); pausing sockets`);
                this.pauseBmpSockets();
            },
            onResume: bytes => {
                logger.info(`BMP persistence queue recovered (${bytes} bytes); resuming sockets`);
                this.resumeBmpSockets();
            },
            onError: error => {
                this.handlePersistenceFailure(error);
            },
            includeCommittedDeltas: () => this.routeAssuranceService?.enabled === true,
            onCommittedBatch: result => this.handleCommittedPersistenceResult(result)
        });
        const status = await this.persistence.open();
        const persistenceReader = this.createPersistenceClient({
            dbPath: this.bmpConfigData.persistenceDbPath,
            readOnly: true,
            logLevel: this.bmpConfigData.logLevel,
            onError: error => this.handlePersistenceReaderFailure(persistenceReader, error)
        });
        try {
            await persistenceReader.open();
            this.persistenceReader = persistenceReader;
        } catch (error) {
            logger.warn(`BMP persistence read replica unavailable; using writer for reads: ${error.message}`);
            await persistenceReader.close({ suppressErrors: true }).catch(() => {});
            this.persistenceReader = null;
        }
        this.schedulePersistenceSweep();
        logger.info(
            `BMP persistence opened schema=${status.schemaVersion} journal=${status.journalMode} path=${status.dbPath}`
        );
        return status;
    }

    schedulePersistenceSweep() {
        this.clearPersistenceSweepTimer();
        if (!this.persistence) {
            return;
        }
        const intervalMs = Math.max(1000, Number(this.bmpConfigData?.persistenceSweepIntervalMs) || 30000);
        this.persistenceSweepTimer = setInterval(() => this.runPersistenceSweep(), intervalMs);
        this.persistenceSweepTimer.unref?.();
    }

    clearPersistenceSweepTimer() {
        if (this.persistenceSweepTimer) {
            clearInterval(this.persistenceSweepTimer);
            this.persistenceSweepTimer = null;
        }
        if (this.persistenceSweepCatchupTimer) {
            clearTimeout(this.persistenceSweepCatchupTimer);
            this.persistenceSweepCatchupTimer = null;
        }
        if (this.persistenceSweepRequestTimer) {
            clearTimeout(this.persistenceSweepRequestTimer);
            this.persistenceSweepRequestTimer = null;
        }
        if (this.persistenceSweepDeadlineTimer) {
            clearTimeout(this.persistenceSweepDeadlineTimer);
            this.persistenceSweepDeadlineTimer = null;
        }
        this.persistenceSweepPending = false;
    }

    getPersistenceRefreshTimeoutMs() {
        const configuredFloor = Number(this.bmpConfigData?.persistenceRefreshTimeoutFloorMs);
        const allowTestFloor = process.env.NODE_ENV === 'test' || process.env.NETNEXUS_E2E === '1';
        const floorMs = allowTestFloor && Number.isFinite(configuredFloor) ? Math.max(0, configuredFloor) : 60000;
        return Math.max(floorMs, Number(this.bmpConfigData?.persistenceRefreshTimeoutMs) || 30 * 60 * 1000);
    }

    schedulePersistenceRefreshDeadline(refreshStartedMs, refreshTimeoutMs = this.getPersistenceRefreshTimeoutMs()) {
        if (this.persistenceSweepDeadlineTimer) {
            clearTimeout(this.persistenceSweepDeadlineTimer);
            this.persistenceSweepDeadlineTimer = null;
        }
        const startedAtMs = Number(refreshStartedMs);
        if (!this.persistence || !Number.isFinite(startedAtMs)) {
            return;
        }
        const delayMs = Math.min(0x7fffffff, Math.max(25, startedAtMs + refreshTimeoutMs - Date.now()));
        this.persistenceSweepDeadlineTimer = setTimeout(() => {
            this.persistenceSweepDeadlineTimer = null;
            this.runPersistenceSweep();
        }, delayMs);
        this.persistenceSweepDeadlineTimer.unref?.();
    }

    requestPersistenceSweep() {
        if (!this.persistence || this.persistenceSweepRequestTimer) {
            return false;
        }
        this.persistenceSweepRequestTimer = setTimeout(() => {
            this.persistenceSweepRequestTimer = null;
            this.runPersistenceSweep();
        }, 250);
        this.persistenceSweepRequestTimer.unref?.();
        return true;
    }

    async runPersistenceSweep() {
        if (!this.persistence) {
            return;
        }
        if (this.persistenceSweepRunning) {
            this.persistenceSweepPending = true;
            return;
        }
        this.persistenceSweepRunning = true;
        let shouldCatchUp = false;
        let routeProjectionChanged = false;
        let sweepCompleted = false;
        let nextRefreshStartedMs = null;
        const affectedScopes = new Map();
        const refreshTimeoutMs = this.getPersistenceRefreshTimeoutMs();
        try {
            // Scope EOR/timeout mutations determine which epoch is safe to age.
            // Fence the writer queue before calculating retention candidates.
            await this.persistence.fence();
            const now = Date.now();
            const staleRetentionMs = Math.max(
                60000,
                Number(this.bmpConfigData?.persistenceStaleRetentionMs) || 24 * 60 * 60 * 1000
            );
            const eventRetentionMs = Math.max(
                60000,
                Number(this.bmpConfigData?.persistenceEventRetentionMs) || 7 * 24 * 60 * 60 * 1000
            );
            const routeLimit = Number(this.bmpConfigData?.persistenceSweepRouteLimit) || 5000;
            const eventLimit = Number(this.bmpConfigData?.persistenceSweepEventLimit) || 20000;
            const maxPasses = Math.max(1, Number(this.bmpConfigData?.persistenceSweepMaxPasses) || 16);
            const timeBudgetMs = Math.max(100, Number(this.bmpConfigData?.persistenceSweepTimeBudgetMs) || 1000);
            const maxDbBytes = Math.max(
                256 * 1024 * 1024,
                Number(this.bmpConfigData?.persistenceMaxDbBytes) || 20 * 1024 * 1024 * 1024
            );
            const storageStatus = await this.persistence.getStatus();
            const storagePressure = storageStatus.logicalSize >= maxDbBytes;
            if (storagePressure) {
                logger.warn(
                    `BMP persistence logical size ${storageStatus.logicalSize} exceeds limit ${maxDbBytes}; ` +
                        'temporarily shortening history retention until space is reusable'
                );
            }
            const sweepStartedAt = Date.now();
            for (let pass = 0; pass < maxPasses; pass += 1) {
                const result = await this.persistence.sweep({
                    staleBeforeMs: storagePressure ? now : now - staleRetentionMs,
                    refreshTimeoutBeforeMs: now - refreshTimeoutMs,
                    eventsBeforeMs: storagePressure ? now : now - eventRetentionMs,
                    routeLimit,
                    eventLimit,
                    auxiliaryLimit: eventLimit
                });
                routeProjectionChanged =
                    routeProjectionChanged ||
                    Number(result.routes || 0) > 0 ||
                    Number(result.refreshTimeoutScopes || 0) > 0 ||
                    Number(result.reconnectTimeoutScopes || 0) > 0;
                nextRefreshStartedMs = result.nextRefreshStartedMs ?? null;
                (Array.isArray(result.affectedScopes) ? result.affectedScopes : []).forEach(scope => {
                    if (!scope?.scopeId) {
                        return;
                    }
                    const existing = affectedScopes.get(scope.scopeId);
                    if (existing) {
                        existing.deletedRoutes += Number(scope.deletedRoutes || 0);
                    } else {
                        affectedScopes.set(scope.scopeId, {
                            ...scope,
                            deletedRoutes: Number(scope.deletedRoutes || 0)
                        });
                    }
                });
                shouldCatchUp = result.hasMore === true;
                if (!shouldCatchUp || Date.now() - sweepStartedAt >= timeBudgetMs) {
                    break;
                }
            }
            sweepCompleted = true;
        } catch (error) {
            logger.error(`BMP persistence sweep failed: ${error.message}`);
        } finally {
            this.persistenceSweepRunning = false;
            if (sweepCompleted) {
                this.schedulePersistenceRefreshDeadline(nextRefreshStartedMs, refreshTimeoutMs);
            }
            if (routeProjectionChanged) {
                this.invalidateRouteAssurance('persistence-sweep');
            }
            if (affectedScopes.size > 0) {
                this.emitPersistenceSweepRouteUpdates(Array.from(affectedScopes.values()));
            }
            const rerunRequested = this.persistenceSweepPending;
            this.persistenceSweepPending = false;
            if ((shouldCatchUp || rerunRequested) && this.persistence && !this.persistenceSweepCatchupTimer) {
                const delayMs = rerunRequested
                    ? 25
                    : Math.max(250, Number(this.bmpConfigData?.persistenceSweepCatchupDelayMs) || 1000);
                this.persistenceSweepCatchupTimer = setTimeout(() => {
                    this.persistenceSweepCatchupTimer = null;
                    this.runPersistenceSweep();
                }, delayMs);
                this.persistenceSweepCatchupTimer.unref?.();
            }
        }
    }

    emitPersistenceSweepRouteUpdates(scopes) {
        scopes.forEach(scope => {
            const update = {
                type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                persistentSourceId: scope.sourceId,
                sourceId: scope.sourceId,
                persistentOwnerKey: scope.ownerKey || null,
                ownerKey: scope.ownerKey || null,
                persistentScopeId: scope.scopeId,
                scopeId: scope.scopeId,
                af: getAddrFamilyType(Number(scope.afi), Number(scope.safi)),
                ribType: scope.ribType,
                changedCount: Number(scope.deletedRoutes || 0),
                reason: scope.reason || 'persistence-sweep',
                projectionReset: true,
                assuranceIncremental: true
            };
            if (scope.scopeKind === 'loc-rib') {
                this.enqueueInstanceRouteUpdateEvent(update);
            } else {
                this.enqueueRouteUpdateEvent(update);
            }
        });
    }

    async startTcpServer(messageId) {
        try {
            this.server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv4 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv4 localAddress: ${socket.localAddress}:${socket.localPort}`);
                const sessionKey = BmpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const bmpSession = this.bmpSessionMap.get(sessionKey);
                    if (!bmpSession) {
                        logger.error(`ipv4 Client ${clientAddress}:${clientPort} not found in bmpSessionMap`);
                        socket.destroy();
                        return;
                    }
                    bmpSession.recvMsg(data);
                });

                socket.on('end', () => {
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} end`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                socket.on('close', () => {
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} close`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                socket.on('error', err => {
                    logger.error(`ipv4 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                // 创建BMP会话
                this.createBmpSession(socket, clientAddress, clientPort);
            });

            this.ipv6Server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv6 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv6 localAddress: ${socket.localAddress}:${socket.localPort}`);
                const sessionKey = BmpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const bmpSession = this.bmpSessionMap.get(sessionKey);
                    if (!bmpSession) {
                        logger.error(`ipv6 Client ${clientAddress}:${clientPort} not found in bmpSessionMap`);
                        socket.destroy();
                        return;
                    }
                    bmpSession.recvMsg(data);
                });

                socket.on('end', () => {
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} end`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                socket.on('close', () => {
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} close`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                socket.on('error', err => {
                    logger.error(`ipv6 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                // 创建BMP会话
                this.createBmpSession(socket, clientAddress, clientPort);
            });

            // 启动ipv4服务器并监听端口
            const listenPormise = util.promisify(this.server.listen).bind(this.server);
            await listenPormise({ port: this.bmpConfigData.port, host: '0.0.0.0' });
            logger.info(`TCP Server listening on port ${this.bmpConfigData.port} at 0.0.0.0`);

            // 启动ipv6服务器并监听端口
            const ipv6ListenPormise = util.promisify(this.ipv6Server.listen).bind(this.ipv6Server);
            await ipv6ListenPormise({ port: this.bmpConfigData.port, host: '::', ipv6Only: true });
            logger.info(`TCP Server listening on port ${this.bmpConfigData.port} at ::`);

            logger.info(`bmp协议启动成功`);
            this.messageHandler.sendSuccessResponse(messageId, null, 'bmp协议启动成功');
        } catch (err) {
            await this.closeTcpServers();
            logger.error(`Error starting TCP server: ${err.message}`);
            this.messageHandler.sendErrorResponse(messageId, 'bmp协议启动失败');
        }
    }

    async closeTcpServers() {
        const servers = [this.server, this.ipv6Server];
        this.server = null;
        this.ipv6Server = null;
        await Promise.all(
            servers.map(
                server =>
                    new Promise(resolve => {
                        if (!server || !server.listening) {
                            resolve();
                            return;
                        }
                        try {
                            server.close(error => {
                                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
                                    logger.error(`Failed to close BMP listener: ${error.message}`);
                                }
                                resolve();
                            });
                        } catch (error) {
                            if (error.code !== 'ERR_SERVER_NOT_RUNNING') {
                                logger.error(`Failed to close BMP listener: ${error.message}`);
                            }
                            resolve();
                        }
                    })
            )
        );
    }

    async startBmp(messageId, bmpConfigData) {
        this.bmpConfigData = bmpConfigData;
        this.bmpConfigData.bmpV4TlvDraft =
            Number(this.bmpConfigData.bmpV4TlvDraft) === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                ? BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                : BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20;
        const defaultPathMarkingTlvType =
            this.bmpConfigData.bmpV4TlvDraft === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                ? BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.PATH_MARKING
                : BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING;
        const pathMarkingTlvType = Number(this.bmpConfigData.pathMarkingTlvType);
        this.bmpConfigData.pathMarkingTlvType =
            Number.isInteger(pathMarkingTlvType) && pathMarkingTlvType >= 1 && pathMarkingTlvType <= 0x3fff
                ? pathMarkingTlvType
                : defaultPathMarkingTlvType;

        // 设置日志级别
        if (this.bmpConfigData.logLevel) {
            logger.setLevel(this.bmpConfigData.logLevel);
            logger.info(`Worker log level set to: ${this.bmpConfigData.logLevel}`);
        }
        logger.info(`BMPv4 TLV draft set to draft-${this.bmpConfigData.bmpV4TlvDraft}`);
        logger.info(`BMP Path Marking TLV type set to ${this.bmpConfigData.pathMarkingTlvType}`);

        try {
            await this.initializePersistence();
        } catch (error) {
            logger.error(`Failed to initialize BMP persistence: ${error.message}`);
            if (this.persistenceReader) {
                await this.persistenceReader.close().catch(() => {});
                this.persistenceReader = null;
            }
            if (this.persistence) {
                await this.persistence.close().catch(() => {});
                this.persistence = null;
            }
            this.messageHandler.sendErrorResponse(messageId, `BMP持久化初始化失败: ${error.message}`);
            return;
        }

        // 如果启用了 MD5 认证，使用 SSH 隧道启动远端代理。
        if (bmpConfigData.enableAuth && bmpConfigData.md5Password) {
            try {
                logger.info('TCP MD5 authentication enabled, creating SSH tunnel...');

                // 提取SSH服务器地址
                const sshHost = bmpConfigData.serverAddress;

                // 创建SSH隧道
                this.sshTunnel = new SshTunnel();
                await this.sshTunnel.connect({
                    host: sshHost,
                    username: bmpConfigData.sshUsername,
                    password: bmpConfigData.sshPassword
                });

                logger.info('Using TCP MD5 proxy');
                const proxyConfig = bmpConfigData.md5Password;

                // 启动远程代理
                // 代理监听 bmpConfigData.port (路由器连接这个端口)
                // 然后转发到 Windows BMP 服务器
                const localPort = parseInt(bmpConfigData.localPort);

                // 获取 Windows 客户端 IP（从 SSH 连接）
                let windowsIp = 'localhost';
                try {
                    const whoamiOutput = await this.sshTunnel.execCommand('echo $SSH_CLIENT');
                    const sshClientInfo = whoamiOutput.trim().split(' ');
                    if (sshClientInfo.length > 0) {
                        windowsIp = sshClientInfo[0]; // SSH 客户端 IP
                        logger.info(`Detected Windows client IP: ${windowsIp}`);
                    }
                } catch (error) {
                    logger.warn(`Could not detect Windows IP, using localhost: ${error.message}`);
                }

                await this.sshTunnel.startProxy(
                    'bmp', // 协议类型
                    bmpConfigData.peerIP, // BMP路由器IP（peer IP）
                    proxyConfig, // MD5密码
                    bmpConfigData.port, // Linux监听端口（路由器连接）
                    `${windowsIp}:${localPort}` // 转发到 Windows 的 localPort
                );

                logger.info('SSH tunnel and proxy started successfully');
                logger.info(`BMP router should connect to: ${sshHost}:${bmpConfigData.port}`);
                logger.info(`Proxy will forward to localhost:${localPort}`);

                // 启动本地TCP服务器 - 直接监听 localPort
                const originalPort = this.bmpConfigData.port;
                this.bmpConfigData.port = localPort;

                // 启动本地TCP服务器
                await this.startTcpServer(messageId);

                // 恢复原始端口配置
                this.bmpConfigData.port = originalPort;

                logger.info('Local BMP server started, waiting for connections from proxy');
            } catch (error) {
                logger.error(`Failed to setup SSH tunnel: ${error.message}`);
                this.messageHandler.sendErrorResponse(messageId, `SSH隧道连接失败: ${error.message}`);
                return;
            }
        } else {
            // 直接TCP模式
            await this.startTcpServer(messageId);
        }
    }

    async stopBmp(messageId) {
        logger.info('Stopping BMP server...');
        this.clearRouteUpdateAggregation();
        this.clearPersistenceSweepTimer();
        this.pauseBmpSockets();

        // 停止SSH隧道和代理
        if (this.sshTunnel) {
            try {
                // 停止远程代理
                if (this.bmpConfigData) {
                    const localPort = this.bmpConfigData.localPort;
                    const _sshHost = this.bmpConfigData.serverAddress;

                    const proxyConfig = this.bmpConfigData.md5Password;

                    // 获取 Windows 客户端 IP（与 startProxy 保持一致）
                    let windowsIp = 'localhost';
                    try {
                        const whoamiOutput = await this.sshTunnel.execCommand('echo $SSH_CLIENT');
                        const sshClientInfo = whoamiOutput.trim().split(' ');
                        if (sshClientInfo.length > 0) {
                            windowsIp = sshClientInfo[0];
                        }
                    } catch (error) {
                        // Ignore error, use localhost as fallback
                    }

                    await this.sshTunnel.stopProxy(
                        'bmp',
                        this.bmpConfigData.peerIP,
                        proxyConfig,
                        this.bmpConfigData.port,
                        `${windowsIp}:${localPort}`
                    );
                }
                // 断开SSH连接
                await this.sshTunnel.disconnect();
            } catch (error) {
                logger.error(`Error stopping SSH tunnel: ${error.message}`);
            }
            this.sshTunnel = null;
        }

        // Stop accepting new connections immediately, but do not wait for the
        // listeners to close until the existing long-lived BMP sockets have
        // been destroyed below. net.Server.close() only completes after all
        // active connections are closed.
        const tcpServersClosed = this.closeTcpServers();

        // 发送全局终止事件通知前端
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.TERMINATION, { data: null });

        // 清空会话
        this.bmpSessionMap.forEach((session, _) => {
            session.closeSession();
        });
        this.bmpSessionMap.clear();
        await tcpServersClosed;
        this.routeAssuranceService?.setEnabled?.(false);

        let persistenceError = null;
        const persistenceWriter = this.persistence;
        const persistenceReader = this.persistenceReader;
        try {
            if (persistenceWriter) {
                await persistenceWriter.drain();
                await this.runPersistenceSweep();
            }
        } catch (error) {
            persistenceError = error;
            logger.error(`BMP persistence drain failed: ${error.message}`);
        } finally {
            this.clearPersistenceSweepTimer();
            this.clearRouteUpdateAggregation();
            this.persistenceReader = null;
            this.persistence = null;
            if (persistenceReader) {
                await persistenceReader.close({ suppressErrors: true }).catch(() => {});
            }
            if (persistenceWriter) {
                await persistenceWriter.close({ suppressErrors: true }).catch(() => {});
            }
            this.bmpConfigData = null;
        }

        if (!persistenceError) {
            this.messageHandler.sendSuccessResponse(messageId, null, 'bmp协议停止成功，持久化队列已落盘');
        } else {
            this.messageHandler.sendErrorResponse(
                messageId,
                `BMP已停止，但持久化队列未能确认安全落盘: ${persistenceError.message}`
            );
        }
    }

    async getPersistenceStatus(messageId) {
        if (!this.persistence) {
            this.messageHandler.sendSuccessResponse(
                messageId,
                { ready: false, enabled: this.bmpConfigData?.persistenceEnabled !== false, running: true },
                'BMP持久化未打开'
            );
            return;
        }
        try {
            let status;
            if (this.persistenceReader) {
                const reader = this.persistenceReader;
                try {
                    status = await reader.getStatus();
                } catch (error) {
                    if (!this.handlePersistenceReaderFailure(reader, error)) {
                        throw error;
                    }
                }
            }
            if (!status) {
                status = await this.persistence.getStatus();
            }
            this.messageHandler.sendSuccessResponse(
                messageId,
                { ...status, enabled: true, running: true, watermark: this.persistence.getWatermark() },
                '获取BMP持久化状态成功'
            );
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async getPersistedRoutes(messageId, data = {}) {
        if (!this.persistence) {
            this.messageHandler.sendErrorResponse(messageId, 'BMP持久化未打开');
            return;
        }
        try {
            const result = await this.readPersistence('queryRoutes', data);
            this.messageHandler.sendSuccessResponse(messageId, result, '查询持久化路由成功');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async getPersistedRouteEvents(messageId, data = {}) {
        if (!this.persistence) {
            this.messageHandler.sendErrorResponse(messageId, 'BMP持久化未打开');
            return;
        }
        try {
            const result = await this.readPersistence('queryEvents', data);
            this.messageHandler.sendSuccessResponse(messageId, result, '查询BMP路由事件成功');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    getPersistentSourceId(value = {}) {
        return value?.persistentSourceId || value?.sourceId || null;
    }

    makeClientEndpointKey(value = {}) {
        return [value.localIp, value.localPort, value.remoteIp, value.remotePort]
            .map(item => String(item ?? ''))
            .join('|');
    }

    findLiveBmpSession(client = {}) {
        const sourceId = this.getPersistentSourceId(client);
        if (sourceId) {
            for (const bmpSession of this.bmpSessionMap.values()) {
                if (bmpSession.getPersistentSourceId?.() === sourceId) {
                    return bmpSession;
                }
            }
        }
        const key = this.makeClientEndpointKey(client);
        for (const bmpSession of this.bmpSessionMap.values()) {
            if (this.makeClientEndpointKey(bmpSession) === key) {
                return bmpSession;
            }
        }
        return null;
    }

    findTopologyClient(topology, client = {}) {
        const clients = Array.isArray(topology?.clients) ? topology.clients : [];
        const sourceId = this.getPersistentSourceId(client);
        if (sourceId) {
            return clients.find(item => this.getPersistentSourceId(item) === sourceId) || null;
        }
        const key = this.makeClientEndpointKey(client);
        return clients.find(item => this.makeClientEndpointKey(item) === key) || null;
    }

    async queryClientTopology(client = null) {
        const sourceId = this.getPersistentSourceId(client || {});
        const topology = await this.readPersistence('queryTopology', sourceId ? { sourceId } : {}, { fence: false });
        return {
            topology,
            client: client ? this.findTopologyClient(topology, client) : null
        };
    }

    async getClientList(messageId) {
        try {
            const { topology } = await this.queryClientTopology();
            const clients = new Map();
            (topology?.clients || []).forEach(client => {
                const { sessions: _sessions, instances: _instances, ...clientInfo } = client;
                const key = this.getPersistentSourceId(clientInfo) || this.makeClientEndpointKey(clientInfo);
                clients.set(key, clientInfo);
            });
            this.bmpSessionMap.forEach(bmpSession => {
                const live = bmpSession.getClientInfo();
                const key = this.getPersistentSourceId(live) || this.makeClientEndpointKey(live);
                clients.set(key, {
                    ...(clients.get(key) || {}),
                    ...live,
                    connectionState: 'open',
                    isOnline: true
                });
            });
            const clientList = Array.from(clients.values()).sort(
                (left, right) => Number(Boolean(right.isOnline)) - Number(Boolean(left.isOnline))
            );
            this.messageHandler.sendSuccessResponse(messageId, clientList, '获取客户端列表成功');
        } catch (error) {
            logger.error(`Error getting BMP clients: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async deleteClientData(messageId, client = {}) {
        const sourceId = String(this.getPersistentSourceId(client) || '').trim();
        const remoteIp = typeof client?.remoteIp === 'string' ? client.remoteIp.trim() : '';

        if (!sourceId) {
            this.messageHandler.sendErrorResponse(messageId, '删除BMP客户端数据需要稳定sourceId');
            return;
        }
        if (!remoteIp) {
            this.messageHandler.sendErrorResponse(messageId, 'BMP客户端缺少远端IP，无法安全删除');
            return;
        }
        if (!this.persistence) {
            this.messageHandler.sendErrorResponse(messageId, '请先启动 BMP 服务后删除离线客户端');
            return;
        }
        if (this.clientDataDeleteInProgress.has(sourceId)) {
            this.messageHandler.sendErrorResponse(messageId, '该BMP客户端数据正在删除');
            return;
        }
        if (this.findLiveBmpSession({ persistentSourceId: sourceId })) {
            this.messageHandler.sendErrorResponse(messageId, '在线BMP客户端不能删除，请先断开连接');
            return;
        }

        this.clientDataDeleteInProgress.add(sourceId);
        this.clientDeleteRemoteIpGates.set(remoteIp, (this.clientDeleteRemoteIpGates.get(remoteIp) || 0) + 1);
        try {
            const persistence = this.persistence;
            await persistence.fence();
            if (this.persistence !== persistence) {
                throw new Error('BMP服务状态已变化，请重试');
            }
            if (this.findLiveBmpSession({ persistentSourceId: sourceId })) {
                throw new Error('在线BMP客户端不能删除，请先断开连接');
            }

            const result = await persistence.purgeSource({ sourceId });
            this.routeUpdateAggregator.deleteSource(sourceId);
            this.invalidateRouteAssurance('client-data-delete');
            this.messageHandler.sendSuccessResponse(messageId, result, 'BMP客户端关联数据删除成功');
        } catch (error) {
            logger.error(`Error deleting BMP client data: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        } finally {
            this.clientDataDeleteInProgress.delete(sourceId);
            const gateCount = (this.clientDeleteRemoteIpGates.get(remoteIp) || 1) - 1;
            if (gateCount > 0) {
                this.clientDeleteRemoteIpGates.set(remoteIp, gateCount);
            } else {
                this.clientDeleteRemoteIpGates.delete(remoteIp);
            }
        }
    }

    async getRouteLens(messageId, data = {}) {
        try {
            const parsedQuery = parseRouteLensQuery(data.query);
            const query = {
                routeState: data.routeState || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
                pageSize: MAX_ROUTE_LENS_RESULT_LIMIT + 1,
                includeTotal: true
            };
            if (parsedQuery.mode === 'covering') {
                query.prefixCidrs = parsedQuery.indexKeys.map(key => key.slice('cidr:'.length));
            } else if (parsedQuery.mode === 'exact') {
                query.prefixFilter = parsedQuery.normalized;
            } else {
                query.routeIdentityText = parsedQuery.normalized;
            }
            const rows = await this.readPersistence('queryRoutes', query, { fence: false });
            const result = buildBmpRouteLensFromPersistedRoutes(rows, data);
            this.messageHandler.sendSuccessResponse(messageId, result, '路由追踪查询成功');
        } catch (error) {
            logger.error(`Error getting Route Lens: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async getRouteAssurance(messageId, data = {}) {
        try {
            if (!this.routeAssuranceService) {
                this.routeAssuranceService = new BmpRouteAssuranceService({ enabled: false });
            }
            if (!this.routeAssuranceService.enabled) {
                throw new Error('路由矩阵分析未开启');
            }
            const analysisFilters = this.getRouteAssuranceAnalysisFilters(data);
            const persistedQuery = {
                ...analysisFilters,
                category: data.category,
                page: data.page,
                pageSize: data.pageSize
            };
            this.routeAssuranceFilters = analysisFilters;
            let result;
            try {
                result = await this.routeAssuranceService.queryPersistedAsync(persistedQuery);
            } catch (error) {
                const needsBootstrap =
                    error?.code === 'BMP_ROUTE_ASSURANCE_PERSISTED_SNAPSHOT_MISS' ||
                    this.routeAssuranceService.state === 'dirty';
                if (!needsBootstrap) {
                    throw error;
                }
                await this.routeAssuranceService.bootstrapFromPersistedRoutes(
                    this.createPersistedRoutePageLoader(analysisFilters),
                    analysisFilters
                );
                result = this.routeAssuranceService.queryPersisted(persistedQuery);
            }
            this.messageHandler.sendSuccessResponse(messageId, result, '路由保障矩阵查询成功');
        } catch (error) {
            logger.error(`Error getting Route Assurance: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async setRouteAssuranceEnabled(messageId, data = {}) {
        try {
            if (!this.routeAssuranceService) {
                this.routeAssuranceService = new BmpRouteAssuranceService({ enabled: false });
            }
            const enabled = Boolean(data.enabled);
            this.routeAssuranceFilters = enabled ? { ...(data.filters || {}) } : {};
            let status;
            if (enabled) {
                this.routeAssuranceFilters = this.getRouteAssuranceAnalysisFilters(data.filters || {});
                // Establish one consistency boundary before enabling incremental deltas. The
                // paged snapshot then reads committed WAL state without chasing a continuously
                // growing writer queue on every page.
                await this.persistence.fence();
                status = await this.routeAssuranceService.bootstrapFromPersistedRoutes(
                    this.createPersistedRoutePageLoader(this.routeAssuranceFilters),
                    this.routeAssuranceFilters
                );
            } else {
                status = this.routeAssuranceService.setEnabled(false);
            }
            this.messageHandler.sendSuccessResponse(
                messageId,
                status,
                status.enabled ? '路由矩阵分析已开启' : '路由矩阵分析已关闭'
            );
        } catch (error) {
            logger.error(`Error setting Route Assurance state: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    getRouteAssuranceAnalysisFilters(filters = {}) {
        return Object.fromEntries(
            ['client', 'vrf', 'af', 'query', 'routeState']
                .filter(key => filters[key] !== undefined)
                .map(key => [key, filters[key]])
        );
    }

    normalizePersistedSession(session = {}) {
        const routeScopes = Array.isArray(session.routeScopes) ? session.routeScopes : [];
        const enabledAddressFamilies = Array.isArray(session.enabledAddressFamilies)
            ? session.enabledAddressFamilies
            : [];
        const enabledAddrFamilyTypes = Array.from(
            new Set(enabledAddressFamilies.map(item => getAddrFamilyType(Number(item.afi), Number(item.safi))))
        );
        return {
            ...session,
            enabledAddressFamilies,
            enabledAddrFamilyTypes,
            routeScopes,
            isOnline: session.isOnline === true
        };
    }

    buildLiveSessionTopology(bmpSession, bgpSession, persisted = null) {
        const ownerKey = BmpBgpSession.makeKey(
            bgpSession.sessionType,
            bgpSession.sessionRd,
            bgpSession.sessionIp,
            bgpSession.sessionAs,
            bgpSession.sessionRdRaw
        );
        let routeScopes = Array.isArray(persisted?.routeScopes)
            ? persisted.routeScopes.map(scope => ({ ...scope }))
            : [];
        if (routeScopes.length === 0) {
            routeScopes = Array.from(bgpSession.routeScopes.values(), scope => {
                const routeSummary = bgpSession.getRouteSummary(scope.afi, scope.safi, scope.ribType);
                const scopeId = bmpSession.getPersistenceScopeId(
                    bgpSession,
                    scope.afi,
                    scope.safi,
                    scope.ribType,
                    'peer'
                );
                return {
                    persistentScopeId: scopeId,
                    scopeId,
                    persistentSourceId: bmpSession.getPersistentSourceId?.() || null,
                    persistentOwnerKey: ownerKey,
                    ownerKey,
                    afi: Number(scope.afi),
                    safi: Number(scope.safi),
                    addrFamilyType: getAddrFamilyType(Number(scope.afi), Number(scope.safi)),
                    ribType: scope.ribType,
                    scopeState: bmpSession.getPersistenceScopeState(bgpSession, scope.afi, scope.safi, scope.ribType),
                    connectionState: 'open',
                    isOnline: true,
                    routeSummary
                };
            });
        }
        routeScopes.forEach(scope => {
            bgpSession.setRouteSummary(scope.afi, scope.safi, scope.ribType, scope.routeSummary || scope);
        });
        const sourceId = bmpSession.getPersistentSourceId?.() || this.getPersistentSourceId(persisted || {});
        return this.normalizePersistedSession({
            ...(persisted || {}),
            ...bgpSession.getSessionInfo(),
            persistentSourceId: sourceId,
            sourceId,
            persistentOwnerKey: ownerKey,
            ownerKey,
            persistentConnectionId: bmpSession.persistenceConnectionId || null,
            connectionId: bmpSession.persistenceConnectionId || null,
            connectionState: 'open',
            isOnline: bgpSession.sessionState === BmpConst.BMP_SESSION_STATE.PEER_UP,
            routeScopes
        });
    }

    async getBgpSessions(messageId, client) {
        try {
            const { client: persistedClient } = await this.queryClientTopology(client);
            const peerMap = new Map();
            (persistedClient?.sessions || []).forEach(session => {
                const normalized = this.normalizePersistedSession(session);
                peerMap.set(normalized.persistentOwnerKey || normalized.ownerKey, normalized);
            });

            const bmpSession = this.findLiveBmpSession(client);
            if (bmpSession) {
                for (const bgpSession of bmpSession.bgpSessionMap.values()) {
                    const ownerKey = BmpBgpSession.makeKey(
                        bgpSession.sessionType,
                        bgpSession.sessionRd,
                        bgpSession.sessionIp,
                        bgpSession.sessionAs,
                        bgpSession.sessionRdRaw
                    );
                    peerMap.set(ownerKey, this.buildLiveSessionTopology(bmpSession, bgpSession, peerMap.get(ownerKey)));
                }
            }
            this.messageHandler.sendSuccessResponse(messageId, Array.from(peerMap.values()), '获取对等体列表成功');
        } catch (error) {
            logger.error(`Error getting BGP sessions: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    getStatisticsSessionKey(session = {}) {
        return getSessionStatisticsEntityIdentityParts(session)
            .map(value => String(value ?? ''))
            .join('|');
    }

    getStatisticsInstanceKey(instance = {}) {
        return [instance.instanceType, instance.instanceRdRaw || instance.instanceRd]
            .map(value => String(value ?? ''))
            .join('|');
    }

    getStatisticsReportKey(kind, report = {}) {
        if (kind === 'instance') {
            return this.getStatisticsInstanceKey(report.instance);
        }
        return getSessionStatisticsReportIdentityParts(report)
            .map(value => String(value ?? ''))
            .join('|');
    }

    findStatisticsTopologyEntity(kind, report, topologyClient) {
        const items = kind === 'instance' ? topologyClient?.instances : topologyClient?.sessions;
        if (!Array.isArray(items)) {
            return null;
        }
        const expectedKey =
            kind === 'instance'
                ? this.getStatisticsInstanceKey(report.instance)
                : this.getStatisticsSessionKey(report.session);
        return (
            items.find(item => {
                const candidateKey =
                    kind === 'instance' ? this.getStatisticsInstanceKey(item) : this.getStatisticsSessionKey(item);
                return candidateKey === expectedKey;
            }) || null
        );
    }

    normalizeStatisticsReport(kind, report, currentClient, topologyClient) {
        const entityField = kind === 'instance' ? 'instance' : 'session';
        const topologyEntity = this.findStatisticsTopologyEntity(kind, report, topologyClient);
        const reportEntity = report?.[entityField] || {};
        const entityIsOnline =
            typeof topologyEntity?.isOnline === 'boolean'
                ? topologyEntity.isOnline
                : typeof currentClient?.isOnline === 'boolean'
                  ? currentClient.isOnline
                  : reportEntity.isOnline;
        const entityConnectionState =
            topologyEntity?.connectionState || currentClient?.connectionState || reportEntity.connectionState || null;

        return {
            ...(report || {}),
            client: {
                ...(report?.client || {}),
                ...(currentClient || {})
            },
            [entityField]: {
                ...reportEntity,
                ...(topologyEntity || {}),
                connectionState: entityConnectionState,
                isOnline: entityIsOnline
            }
        };
    }

    async collectStatisticsReports(client, kind) {
        let topologyClient = null;
        let persistedReports = [];

        if (this.persistence) {
            const topologyResult = await this.queryClientTopology(client);
            topologyClient = topologyResult.client;
            const sourceId = this.getPersistentSourceId(topologyClient || client);
            if (sourceId) {
                persistedReports = await this.readPersistence(
                    'queryStatisticsReports',
                    { sourceId, kind },
                    { fence: false }
                );
            }
        }

        const bmpSession = this.findLiveBmpSession(client);
        const currentClient = bmpSession
            ? {
                  ...(topologyClient || {}),
                  ...bmpSession.getClientInfo(),
                  connectionState: 'open',
                  isOnline: true
              }
            : topologyClient || client || {};
        const normalizeReports = reports =>
            kind === 'session'
                ? Array.from(reports || []).flatMap(report => splitSessionStatisticsReport(report))
                : Array.from(reports || []);
        const reportMap = new Map();
        normalizeReports(persistedReports).forEach(report => {
            const key = this.getStatisticsReportKey(kind, report);
            if (!reportMap.has(key)) {
                reportMap.set(key, report);
            }
        });

        const liveReports =
            kind === 'instance'
                ? bmpSession?.bgpInstanceStatisticsReportMap?.values?.()
                : bmpSession?.bgpStatisticsReportMap?.values?.();
        if (liveReports) {
            for (const report of normalizeReports(liveReports)) {
                reportMap.set(this.getStatisticsReportKey(kind, report), report);
            }
        }

        return Array.from(reportMap.values(), report =>
            this.normalizeStatisticsReport(kind, report, currentClient, topologyClient)
        );
    }

    async getBgpStatisticsReports(messageId, client) {
        try {
            const reports = await this.collectStatisticsReports(client, 'session');
            this.messageHandler.sendSuccessResponse(messageId, reports, '获取BGP统计报表成功');
        } catch (error) {
            logger.error(`Error getting BGP statistics reports: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async getBgpInstanceStatisticsReports(messageId, client) {
        try {
            const reports = await this.collectStatisticsReports(client, 'instance');
            this.messageHandler.sendSuccessResponse(messageId, reports, '获取BGP实例统计报表成功');
        } catch (error) {
            logger.error(`Error getting BGP instance statistics reports: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    getBmpSessionByClient(client) {
        const bmpSessionKey = BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort);
        return {
            bmpSessionKey,
            bmpSession: this.findLiveBmpSession(client) || this.bmpSessionMap.get(bmpSessionKey)
        };
    }

    getRouteKey(routeKey, routeInfo) {
        if (routeKey) {
            return routeKey;
        }

        if (!routeInfo) {
            return '';
        }

        return BmpBgpRoute.makeKey(routeInfo.pathId, routeInfo.rd, routeInfo.ip, routeInfo.mask, routeInfo.rdRaw);
    }

    getBgpSessionRouteScope(client, session, af, ribType) {
        const { afi, safi } = getAfiAndSafi(af);
        const persistedScope =
            (Array.isArray(session?.routeScopes)
                ? session.routeScopes.find(
                      scope =>
                          Number(scope.afi) === Number(afi) &&
                          Number(scope.safi) === Number(safi) &&
                          String(scope.ribType) === String(ribType)
                  )
                : null) || null;
        const persistedScopeId =
            session?.persistentScopeId ||
            session?.scopeId ||
            persistedScope?.persistentScopeId ||
            persistedScope?.scopeId;
        const { bmpSessionKey, bmpSession } = this.getBmpSessionByClient(client);
        if (persistedScopeId) {
            let bgpSession = null;
            if (bmpSession) {
                const bgpSessionKey = BmpBgpSession.makeKey(
                    session.sessionType,
                    session.sessionRd,
                    session.sessionIp,
                    session.sessionAs,
                    session.sessionRdRaw
                );
                bgpSession = bmpSession.bgpSessionMap.get(bgpSessionKey) || null;
            }
            return { bmpSession, bgpSession, scopeId: persistedScopeId, afi, safi, ribType };
        }
        if (!bmpSession) {
            return { error: 'BMP会话不存在', log: `BMP会话 ${bmpSessionKey} 不存在` };
        }

        const bgpSessionKey = BmpBgpSession.makeKey(
            session.sessionType,
            session.sessionRd,
            session.sessionIp,
            session.sessionAs,
            session.sessionRdRaw
        );
        const bgpSession = bmpSession.bgpSessionMap.get(bgpSessionKey);
        if (!bgpSession) {
            return { error: 'BGP会话不存在', log: `BMP会话 ${bmpSessionKey} 不存在BGP会话 ${bgpSessionKey}` };
        }

        const afKey = `${afi}|${safi}`;
        const hasAddressFamily =
            bgpSession.routeScopes?.has?.(`${afi}|${safi}|${ribType}`) ||
            bgpSession.enabledAddressFamilies?.some(
                item => Number(item.afi) === Number(afi) && Number(item.safi) === Number(safi)
            );
        if (!hasAddressFamily) {
            return { error: '地址族不存在', log: `BGP会话 ${bgpSessionKey} 不存在地址族 ${afKey}` };
        }
        if (
            Array.isArray(bgpSession.ribTypes) &&
            bgpSession.ribTypes.length > 0 &&
            !bgpSession.ribTypes.some(item => String(item) === String(ribType))
        ) {
            return { error: 'ribType不存在', log: `BGP会话 ${bgpSessionKey} 不存在 ribType ${ribType}` };
        }

        const scopeId = bmpSession.getPersistenceScopeId(bgpSession, afi, safi, ribType, 'peer');
        return { bmpSession, bgpSession, scopeId, afi, safi, ribType };
    }

    getBgpInstanceRouteScope(client, instance) {
        const { afi, safi } = getAfiAndSafi(instance.addrFamilyType);
        const persistedScopeId = instance?.persistentScopeId || instance?.scopeId;
        const { bmpSessionKey, bmpSession } = this.getBmpSessionByClient(client);
        if (persistedScopeId) {
            let bgpInstance = null;
            if (bmpSession) {
                const bgpInstKey = BmpBgpInstance.makeKey(
                    instance.instanceType,
                    instance.instanceRd,
                    afi,
                    safi,
                    instance.instanceRdRaw
                );
                bgpInstance = bmpSession.bgpInstanceMap.get(bgpInstKey) || null;
            }
            return { bmpSession, bgpInstance, scopeId: persistedScopeId, afi, safi, ribType: 'loc-rib' };
        }
        if (!bmpSession) {
            return { error: 'BMP会话不存在', log: `BMP会话 ${bmpSessionKey} 不存在` };
        }

        const bgpInstKey = BmpBgpInstance.makeKey(
            instance.instanceType,
            instance.instanceRd,
            afi,
            safi,
            instance.instanceRdRaw
        );
        const bgpInstance = bmpSession.bgpInstanceMap.get(bgpInstKey);
        if (!bgpInstance) {
            return { error: 'BGP实例不存在', log: `BMP会话 ${bmpSessionKey} 不存在BGP实例 ${bgpInstKey}` };
        }

        const scopeId = bmpSession.getPersistenceScopeId(bgpInstance, afi, safi, 'loc-rib', 'loc-rib');
        return { bmpSession, bgpInstance, scopeId, afi, safi, ribType: 'loc-rib' };
    }

    sendRouteLookupError(messageId, lookup) {
        if (!lookup.error) {
            return false;
        }

        logger.error(lookup.log || lookup.error);
        this.messageHandler.sendErrorResponse(messageId, lookup.error);
        return true;
    }

    toRouteListInfo(route = {}) {
        return {
            routeKey: route.routeKey,
            addrFamilyType: route.addrFamilyType,
            afi: route.afi,
            safi: route.safi,
            ip: route.ip,
            mask: route.mask,
            rd: route.rd,
            rdRaw: route.rdRaw,
            origin: route.origin,
            asPath: route.asPath,
            med: route.med,
            nextHop: route.nextHop,
            pathId: route.pathId,
            labels: route.labels,
            parseStatus: route.parseStatus,
            pathStatus: route.pathStatus,
            pathStatusNames: route.pathStatusNames,
            pathStatusText: route.pathStatusText,
            pathStatusUnknownBits: route.pathStatusUnknownBits,
            pathStatusReason: route.pathStatusReason,
            pathStatusReasonName: route.pathStatusReasonName,
            pathStatusReasonText: route.pathStatusReasonText,
            routeTlvCount: route.routeTlvCount ?? (Array.isArray(route.routeTlvs) ? route.routeTlvs.length : 0),
            routeState: route.routeState
        };
    }

    async queryRouteScope(lookup, options = {}) {
        const snapshot = await this.readPersistence(
            'queryRouteScope',
            {
                routeQuery: {
                    scopeId: lookup.scopeId,
                    page: options.page,
                    pageSize: options.pageSize,
                    routeState: options.routeState || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
                    prefixFilter: options.prefixFilter,
                    orderBy: 'firstSeen'
                },
                summaryQuery: { scopeId: lookup.scopeId }
            },
            { fence: false }
        );
        const routes = snapshot?.routes;
        const summaryResult = snapshot?.summary;
        const summary = {
            active: Number(summaryResult?.active || 0),
            stale: Number(summaryResult?.stale || 0),
            total: Number(summaryResult?.total || 0)
        };
        return {
            list: (routes?.list || []).map(route => this.toRouteListInfo(route)),
            total: Number(routes?.total || 0),
            summary
        };
    }

    async queryRouteDetail(lookup, routeKey) {
        const result = await this.readPersistence(
            'queryRoutes',
            {
                scopeId: lookup.scopeId,
                legacyRouteKey: routeKey,
                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                pageSize: 1
            },
            { fence: false }
        );
        return result?.list?.[0] || null;
    }

    async getBgpInstanceRoutes(messageId, data) {
        try {
            const {
                client,
                instance,
                page,
                pageSize,
                routeState = BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
                prefixFilter
            } = data;
            const lookup = this.getBgpInstanceRouteScope(client, instance);
            if (this.sendRouteLookupError(messageId, lookup)) {
                return;
            }
            const result = await this.queryRouteScope(lookup, { page, pageSize, routeState, prefixFilter });
            lookup.bgpInstance?.setRouteSummary(result.summary);
            this.messageHandler.sendSuccessResponse(messageId, result, 'BGP实例获取路由列表成功');
        } catch (error) {
            logger.error(`Error getting BGP instance routes: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async getBgpInstanceRouteDetail(messageId, data) {
        try {
            const { client, instance, routeKey, route } = data;
            const lookup = this.getBgpInstanceRouteScope(client, instance);
            if (this.sendRouteLookupError(messageId, lookup)) {
                return;
            }
            const detail = await this.queryRouteDetail(lookup, this.getRouteKey(routeKey, route));
            if (!detail) {
                this.messageHandler.sendErrorResponse(messageId, '路由不存在');
                return;
            }
            this.messageHandler.sendSuccessResponse(messageId, detail, 'BGP实例获取路由详情成功');
        } catch (error) {
            logger.error(`Error getting BGP instance route detail: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async getBgpRoutes(messageId, data) {
        try {
            const {
                client,
                session,
                af,
                ribType,
                page,
                pageSize,
                routeState = BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
                prefixFilter
            } = data;
            const lookup = this.getBgpSessionRouteScope(client, session, af, ribType);
            if (this.sendRouteLookupError(messageId, lookup)) {
                return;
            }
            const result = await this.queryRouteScope(lookup, { page, pageSize, routeState, prefixFilter });
            lookup.bgpSession?.setRouteSummary(lookup.afi, lookup.safi, ribType, result.summary);
            this.messageHandler.sendSuccessResponse(messageId, result, '获取路由列表成功');
        } catch (error) {
            logger.error(`Error getting BGP routes: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async getBgpRouteDetail(messageId, data) {
        try {
            const { client, session, af, ribType, routeKey, route } = data;
            const lookup = this.getBgpSessionRouteScope(client, session, af, ribType);
            if (this.sendRouteLookupError(messageId, lookup)) {
                return;
            }
            const detail = await this.queryRouteDetail(lookup, this.getRouteKey(routeKey, route));
            if (!detail) {
                this.messageHandler.sendErrorResponse(messageId, '路由不存在');
                return;
            }
            this.messageHandler.sendSuccessResponse(messageId, detail, '获取路由详情成功');
        } catch (error) {
            logger.error(`Error getting BGP route detail: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async purgeStaleScope(scopeId) {
        let deleted = 0;
        let hasMore = true;
        while (hasMore) {
            const result = await this.persistence.purgeStaleRoutes({
                scopeId,
                routeLimit: 20000,
                reason: 'manual-stale-purge'
            });
            this.handleCommittedPersistenceResult(result);
            deleted += Number(result?.purged || 0);
            hasMore = result?.hasMore === true && Number(result?.purged || 0) > 0;
        }
        return deleted;
    }

    async purgeStaleBgpInstanceRoutes(messageId, data) {
        try {
            const lookup = this.getBgpInstanceRouteScope(data.client, data.instance);
            if (this.sendRouteLookupError(messageId, lookup)) {
                return;
            }
            const deleted = await this.purgeStaleScope(lookup.scopeId);
            const summaryResult = await this.readPersistence('queryScopeSummary', { scopeId: lookup.scopeId });
            lookup.bgpInstance?.setRouteSummary(summaryResult);
            this.messageHandler.sendSuccessResponse(messageId, { deleted }, 'BGP实例过期路由清理成功');
        } catch (error) {
            logger.error(`Error purging BGP instance routes: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    async purgeStaleBgpRoutes(messageId, data) {
        try {
            const lookup = this.getBgpSessionRouteScope(data.client, data.session, data.af, data.ribType);
            if (this.sendRouteLookupError(messageId, lookup)) {
                return;
            }
            const deleted = await this.purgeStaleScope(lookup.scopeId);
            const summaryResult = await this.readPersistence('queryScopeSummary', { scopeId: lookup.scopeId });
            lookup.bgpSession?.setRouteSummary(lookup.afi, lookup.safi, lookup.ribType, summaryResult);
            this.messageHandler.sendSuccessResponse(messageId, { deleted }, '过期路由清理成功');
        } catch (error) {
            logger.error(`Error purging BGP routes: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    normalizePersistedInstance(instance = {}) {
        const routeScopes = Array.isArray(instance.routeScopes) ? instance.routeScopes : [];
        return {
            ...instance,
            enabledAddressFamilies:
                instance.enabledAddressFamilies ||
                (instance.afi === undefined ? [] : [{ afi: Number(instance.afi), safi: Number(instance.safi) }]),
            enabledAddrFamilyTypes:
                instance.enabledAddrFamilyTypes ||
                (instance.addrFamilyType === undefined || instance.addrFamilyType === null
                    ? []
                    : [instance.addrFamilyType]),
            routeScopes,
            isOnline: instance.isOnline === true
        };
    }

    buildLiveInstanceTopology(bmpSession, bgpInstance, persisted = null) {
        const ownerKey = BmpBgpInstance.makeKey(
            bgpInstance.instanceType,
            bgpInstance.instanceRd,
            bgpInstance.afi,
            bgpInstance.safi,
            bgpInstance.instanceRdRaw
        );
        const scopeId =
            persisted?.persistentScopeId ||
            persisted?.scopeId ||
            bmpSession.getPersistenceScopeId(bgpInstance, bgpInstance.afi, bgpInstance.safi, 'loc-rib', 'loc-rib');
        const persistedScope = Array.isArray(persisted?.routeScopes) ? persisted.routeScopes[0] : null;
        const summary = persistedScope?.routeSummary || persisted?.routeSummary || bgpInstance.getRouteSummary();
        bgpInstance.setRouteSummary(summary);
        const sourceId = bmpSession.getPersistentSourceId?.() || this.getPersistentSourceId(persisted || {});
        return this.normalizePersistedInstance({
            ...(persisted || {}),
            ...bgpInstance.getInstanceInfo(),
            persistentSourceId: sourceId,
            sourceId,
            persistentOwnerKey: ownerKey,
            ownerKey,
            persistentScopeId: scopeId,
            scopeId,
            persistentConnectionId: bmpSession.persistenceConnectionId || null,
            connectionId: bmpSession.persistenceConnectionId || null,
            connectionState: 'open',
            isOnline: bgpInstance.instanceState === BmpConst.BMP_SESSION_STATE.PEER_UP,
            routeScopes: persisted?.routeScopes || [
                {
                    persistentScopeId: scopeId,
                    scopeId,
                    persistentSourceId: sourceId,
                    persistentOwnerKey: ownerKey,
                    ownerKey,
                    afi: Number(bgpInstance.afi),
                    safi: Number(bgpInstance.safi),
                    addrFamilyType: getAddrFamilyType(Number(bgpInstance.afi), Number(bgpInstance.safi)),
                    ribType: 'loc-rib',
                    scopeState: bmpSession.getPersistenceScopeState(
                        bgpInstance,
                        bgpInstance.afi,
                        bgpInstance.safi,
                        'loc-rib'
                    ),
                    connectionState: 'open',
                    isOnline: true,
                    routeSummary: summary
                }
            ],
            routeSummary: summary
        });
    }

    async getBgpInstances(messageId, client) {
        try {
            const { client: persistedClient } = await this.queryClientTopology(client);
            const instanceMap = new Map();
            (persistedClient?.instances || []).forEach(instance => {
                const normalized = this.normalizePersistedInstance(instance);
                instanceMap.set(
                    normalized.persistentOwnerKey || normalized.ownerKey || normalized.persistentScopeId,
                    normalized
                );
            });

            const bmpSession = this.findLiveBmpSession(client);
            if (bmpSession) {
                for (const bgpInstance of bmpSession.bgpInstanceMap.values()) {
                    const ownerKey = BmpBgpInstance.makeKey(
                        bgpInstance.instanceType,
                        bgpInstance.instanceRd,
                        bgpInstance.afi,
                        bgpInstance.safi,
                        bgpInstance.instanceRdRaw
                    );
                    instanceMap.set(
                        ownerKey,
                        this.buildLiveInstanceTopology(bmpSession, bgpInstance, instanceMap.get(ownerKey))
                    );
                }
            }
            this.messageHandler.sendSuccessResponse(messageId, Array.from(instanceMap.values()), '获取实例列表成功');
        } catch (error) {
            logger.error(`Error getting BGP instances: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }
}

new BmpWorker(); // 启动监听
