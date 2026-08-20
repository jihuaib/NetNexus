const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('node:url');
const { app, BrowserWindow } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const ProtocolProcessWithPromise = require('../worker/core/protocolProcessWithPromise');
const { PROTOCOL_PROCESS_SERVICES, PROTOCOL_PROCESS_TIMEOUTS } = require('../worker/core/protocolProcessServices');
const logger = require('../log/logger');
const BmpConst = require('../const/bmpConst');
const EventDispatcher = require('../utils/eventDispatcher');
const BmpPersistenceClient = require('../worker/bmp/bmpPersistenceClient');
const { normalizeBmpClientKey } = require('../window/monitorWindowManager');
const SecureCredentialStore = require('../utils/secureCredentialStore');
const TcpAoSettingsStore = require('../utils/tcpAoSettingsStore');
const TcpMd5SettingsStore = require('../utils/tcpMd5SettingsStore');
const {
    BMP_AUTH_TYPES,
    normalizeBmpAuthenticationSelection,
    redactAuthenticationConfig
} = require('../utils/tcpAuthConfig');
const { assertNonOverlappingTcpAoProfiles } = require('../utils/tcpAoConfig');
const { assertNonOverlappingTcpMd5Profiles } = require('../utils/tcpMd5Config');
const TcpAoSettingsLifecycleGate = require('./tcpAoSettingsLifecycleGate');

const BMP_ANALYSIS_INVALIDATION_EVENTS = Object.freeze(['bmp:routeAssuranceInvalidated', 'bmp:routeLensInvalidated']);
const BMP_RUNTIME_CHANGED_EVENT = 'bmp:runtimeChanged';
const PACKAGED_RENDERER_PATH = path.resolve(__dirname, '../../dist/index.html');
const MAX_RUNTIME_FAILURE_CODE_LENGTH = 64;
const MAX_RUNTIME_FAILURE_REASON_LENGTH = 512;
const TCP_AO_RUNTIME_RELOAD_TIMEOUT_MS = 15_000;

function clearRuntimeTcpAoProfiles(profiles) {
    for (const profile of Array.isArray(profiles) ? profiles : []) {
        for (const key of Array.isArray(profile?.keys) ? profile.keys : []) {
            if (Object.prototype.hasOwnProperty.call(key, 'key')) key.key = '<redacted>';
        }
        if (profile && typeof profile === 'object') profile.keys = [];
    }
}

const BMP_PERSISTENCE_ARTIFACTS = Object.freeze([
    { kind: 'database', suffix: '' },
    { kind: 'wal', suffix: '-wal' },
    { kind: 'shm', suffix: '-shm' },
    { kind: 'journal', suffix: '-journal' }
]);

function normalizeRuntimeFailure(failure, fallback = null) {
    const source = failure && typeof failure === 'object' ? failure : fallback;
    if (!source || typeof source !== 'object') return null;
    const code = String(source.code || 'BMP_PROCESS_EXIT')
        .trim()
        .slice(0, MAX_RUNTIME_FAILURE_CODE_LENGTH);
    const reason = String(source.reason || 'BMP协议进程异常退出，服务已停止')
        .trim()
        .slice(0, MAX_RUNTIME_FAILURE_REASON_LENGTH);
    return { code: code || 'BMP_PROCESS_EXIT', reason: reason || 'BMP协议进程异常退出，服务已停止' };
}

function isTrustedBmpRendererUrl(senderUrl, options = {}) {
    let parsed;
    try {
        parsed = new URL(String(senderUrl || ''));
    } catch (_error) {
        return false;
    }
    const isPackaged = options.isPackaged ?? app.isPackaged;
    if (!isPackaged) return parsed.origin === 'http://127.0.0.1:3000';
    if (parsed.protocol !== 'file:') return false;
    try {
        return (
            path.resolve(fileURLToPath(parsed)) === path.resolve(options.packagedRendererPath || PACKAGED_RENDERER_PATH)
        );
    } catch (_error) {
        return false;
    }
}

function normalizeBmpConfig(config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('BMP配置格式无效');
    }
    const port = Number(config.port ?? 1790);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('BMP服务端口必须是1-65535之间的整数');
    }
    const bmpV4TlvDraft =
        Number(config.bmpV4TlvDraft) === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
            ? BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
            : BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20;
    const defaultPathMarkingTlvType =
        bmpV4TlvDraft === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
            ? BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.PATH_MARKING
            : BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING;
    const pathMarkingTlvType = Number(config.pathMarkingTlvType ?? defaultPathMarkingTlvType);
    if (!Number.isInteger(pathMarkingTlvType) || pathMarkingTlvType < 1 || pathMarkingTlvType > 0x3fff) {
        throw new Error('BMP Path TLV类型必须是1-16383之间的整数');
    }
    return {
        port: String(port),
        bmpV4TlvDraft,
        pathMarkingTlvType,
        persistenceEnabled: true,
        ...normalizeBmpAuthenticationSelection(config)
    };
}

class BmpApp {
    constructor(ipcMain, store, options = {}) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.primaryWebContents = options.primaryWebContents || null;
        this.browserWindow = options.browserWindow || BrowserWindow;
        this.appIsPackaged = options.appIsPackaged;
        this.platform = options.platform || process.platform;
        this.packagedRendererPath = options.packagedRendererPath || PACKAGED_RENDERER_PATH;
        this.credentialStore = options.credentialStore || new SecureCredentialStore();
        this.tcpAoSettingsStore =
            options.tcpAoSettingsStore || new TcpAoSettingsStore(this.store, this.credentialStore);
        this.tcpMd5SettingsStore =
            options.tcpMd5SettingsStore || new TcpMd5SettingsStore(this.store, this.credentialStore);
        this.tcpAoSettingsLifecycleGate = options.tcpAoSettingsLifecycleGate || new TcpAoSettingsLifecycleGate();
        this.bmpConfigFileKey = 'bmp-config';
        this.persistenceDbPath = path.join(
            this.store?.path ? path.dirname(this.store.path) : process.cwd(),
            'bmp',
            'bmp.sqlite3'
        );
        this.worker = null;
        this.bmpStarting = false;
        this.bmpStopping = false;
        this.bmpStartPromise = null;
        this.bmpStopPromise = null;
        this.bmpStartGeneration = 0;
        this.bmpQueuedTcpAoStartGeneration = null;
        this.bmpRuntimeState = null;
        this.bmpRuntimeFailure = null;
        this.runningAuthType = BMP_AUTH_TYPES.NONE;
        this.runningTcpAoProfileIds = [];
        this.persistenceDatabaseDeleting = false;
        this.eventDispatcher = null;
        this.runningPersistenceEnabled = false;
        this.offlinePersistenceReader = null;
        this.offlinePersistenceOpenPromise = null;
        this.offlinePersistenceLock = Promise.resolve();
        this.offlinePersistenceClosePromises = new Set();
        this.closeMonitorWindowsHandler =
            typeof options.closeMonitorWindows === 'function' ? options.closeMonitorWindows : null;

        this.bmpInitiationHandler = null;
        this.bmpSessionUpdateHandler = null;
        this.bmpRouteUpdateHandler = null;
        this.bmpTerminationHandler = null;
        this.bmpStatisticsReportHandler = null;
        this.bmpRuntimeFailureHandler = null;

        this.logLevel = null;

        this.registerHandlers();
    }

    registerHandlers() {
        this.registerTrustedHandler('bmp:saveBmpConfig', this.handleSaveBmpConfig);
        this.registerTrustedHandler('bmp:loadBmpConfig', this.handleLoadBmpConfig);
        this.registerTrustedHandler('bmp:loadTcpAoSettings', this.handleLoadTcpAoSettings);
        this.registerTrustedHandler('bmp:loadTcpMd5Settings', this.handleLoadTcpMd5Settings);
        this.registerTrustedHandler('bmp:startBmp', this.handleStartBmp);
        this.registerTrustedHandler('bmp:stopBmp', this.handleStopBmp);
        this.ipcMain.handle('bmp:getClientList', this.handleGetClientList.bind(this));
        this.ipcMain.handle('bmp:getClient', this.handleGetClient.bind(this));
        this.ipcMain.handle('bmp:deleteClientData', this.handleDeleteClientData.bind(this));
        this.ipcMain.handle('bmp:getRouteLens', this.handleGetRouteLens.bind(this));
        this.ipcMain.handle('bmp:getRouteAssurance', this.handleGetRouteAssurance.bind(this));
        this.ipcMain.handle('bmp:setRouteAssuranceEnabled', this.handleSetRouteAssuranceEnabled.bind(this));
        this.ipcMain.handle('bmp:getBgpSessions', this.handleGetBgpSessions.bind(this));
        this.ipcMain.handle('bmp:getBgpRoutes', this.handleGetBgpRoutes.bind(this));
        this.ipcMain.handle('bmp:getBgpRouteDetail', this.handleGetBgpRouteDetail.bind(this));
        this.ipcMain.handle('bmp:getBgpInstances', this.handleGetBgpInstances.bind(this));
        this.ipcMain.handle('bmp:getBgpInstanceRoutes', this.handleGetBgpInstanceRoutes.bind(this));
        this.ipcMain.handle('bmp:getBgpInstanceRouteDetail', this.handleGetBgpInstanceRouteDetail.bind(this));
        this.ipcMain.handle('bmp:purgeStaleBgpRoutes', this.handlePurgeStaleBgpRoutes.bind(this));
        this.ipcMain.handle('bmp:purgeStaleBgpInstanceRoutes', this.handlePurgeStaleBgpInstanceRoutes.bind(this));
        this.ipcMain.handle('bmp:getBgpStatisticsReports', this.handleGetBgpStatisticsReports.bind(this));
        this.ipcMain.handle(
            'bmp:getBgpInstanceStatisticsReports',
            this.handleGetBgpInstanceStatisticsReports.bind(this)
        );
        this.ipcMain.handle('bmp:getPersistenceStatus', this.handleGetPersistenceStatus.bind(this));
        this.ipcMain.handle('bmp:getPersistenceDatabaseInfo', this.handleGetPersistenceDatabaseInfo.bind(this));
        this.ipcMain.handle('bmp:deletePersistenceDatabase', this.handleDeletePersistenceDatabase.bind(this));
        this.ipcMain.handle('bmp:getPersistedRoutes', this.handleGetPersistedRoutes.bind(this));
        this.ipcMain.handle('bmp:getPersistedRouteEvents', this.handleGetPersistedRouteEvents.bind(this));
    }

    registerTrustedHandler(channel, handler) {
        this.ipcMain.handle(channel, (event, ...args) => {
            this.assertTrustedSender(event);
            return handler.call(this, event, ...args);
        });
    }

    assertTrustedSender(event) {
        const sender = event?.sender;
        const senderFrame = event?.senderFrame;
        const ownerWindow = sender ? this.browserWindow?.fromWebContents?.(sender) : null;
        const senderUrl = String(senderFrame?.url || sender?.getURL?.() || '');
        if (
            !sender ||
            sender !== this.primaryWebContents ||
            !senderFrame ||
            senderFrame !== sender.mainFrame ||
            !ownerWindow ||
            ownerWindow.isDestroyed?.() ||
            !senderUrl
        ) {
            throw new Error('拒绝来自未知窗口的BMP请求');
        }
        if (
            isTrustedBmpRendererUrl(senderUrl, {
                isPackaged: this.appIsPackaged ?? app.isPackaged,
                packagedRendererPath: this.packagedRendererPath
            })
        ) {
            return;
        }
        throw new Error('拒绝来自非应用页面的BMP请求');
    }

    emitDetailedMonitorUpdate(eventType, data) {
        if (!this.eventDispatcher) {
            return;
        }

        // Session/路由明细只发往显式订阅的独立监控窗口；没有对应窗口时
        // emitToSubscribers 会直接返回，不产生 renderer IPC。
        this.eventDispatcher.emitToSubscribers(eventType, successResponse(data));

        // 路由矩阵和路由追踪仅需失效信号来触发重查，并且只在各自页面
        // 激活订阅期间投递，避免把完整 BMP 更新复制到主窗口。
        const invalidation = successResponse({ sourceEvent: eventType });
        BMP_ANALYSIS_INVALIDATION_EVENTS.forEach(invalidationEvent => {
            this.eventDispatcher.emitToSubscribers(invalidationEvent, invalidation);
        });
    }

    async handleSaveBmpConfig(event, config) {
        try {
            const storedConfig = normalizeBmpConfig(config);
            if (storedConfig.authType === BMP_AUTH_TYPES.TCP_AO) {
                this.getTcpAoSettingsStore().assertProfilesExist(storedConfig.tcpAoProfileIds);
            } else if (storedConfig.authType === BMP_AUTH_TYPES.TCP_MD5) {
                this.getTcpMd5SettingsStore().assertProfilesExist(storedConfig.tcpMd5ProfileIds);
            }
            this.store.set(this.bmpConfigFileKey, storedConfig);
            return successResponse(null, 'BMP配置文件保存成功');
        } catch (error) {
            logger.error('Error saving BMP config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLogLevelChange(logLevel) {
        this.logLevel = logLevel;
        const reader = this.offlinePersistenceReader;
        if (!reader || typeof reader.setLogLevel !== 'function') {
            return;
        }
        try {
            await reader.setLogLevel(logLevel);
        } catch (error) {
            logger.warn(`同步离线 BMP SQLite 日志级别失败: ${error.message}`);
        }
    }

    async handleLoadBmpConfig() {
        try {
            const config = this.store.get(this.bmpConfigFileKey);
            if (!config) {
                return successResponse(null, 'BMP配置文件不存在');
            }
            return successResponse(normalizeBmpConfig(config), 'BMP配置文件加载成功');
        } catch (error) {
            logger.error('Error loading BMP config:', error.message);
            return errorResponse(error.message);
        }
    }

    getTcpAoSettingsStore() {
        // SystemApp replaces protocol stores after a major-version cleanup.
        this.tcpAoSettingsStore.store = this.store;
        return this.tcpAoSettingsStore;
    }

    getTcpMd5SettingsStore() {
        this.tcpMd5SettingsStore.store = this.store;
        return this.tcpMd5SettingsStore;
    }

    async initializeCredentialStore() {
        if (typeof this.credentialStore.initialize === 'function') {
            await this.credentialStore.initialize();
        }
    }

    async handleLoadTcpAoSettings() {
        try {
            await this.initializeCredentialStore();
            return successResponse(this.getTcpAoSettingsStore().listProfiles(), 'TCP-AO配置加载成功');
        } catch (error) {
            logger.error('Error loading BMP TCP-AO settings:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadTcpMd5Settings() {
        try {
            await this.initializeCredentialStore();
            return successResponse(this.getTcpMd5SettingsStore().listProfiles(), 'TCP MD5配置加载成功');
        } catch (error) {
            logger.error('Error loading BMP TCP MD5 settings:', error.message);
            return errorResponse(error.message);
        }
    }

    getTcpAoRuntimeReloadState(options = {}) {
        const ignoreQueuedStart = options.ignoreQueuedStart === true && !this.bmpStarting;
        if (
            this.bmpStarting ||
            this.bmpStopping ||
            this.bmpStopPromise ||
            (this.bmpStartPromise && !ignoreQueuedStart)
        ) {
            return { service: 'BMP', state: 'transitioning', profileIds: [] };
        }
        if (!this.worker || this.runningAuthType !== BMP_AUTH_TYPES.TCP_AO) {
            return { service: 'BMP', state: 'inactive', profileIds: [] };
        }
        return {
            service: 'BMP',
            state: 'running',
            profileIds: [...this.runningTcpAoProfileIds]
        };
    }

    async reloadTcpAoRuntimeProfiles(profiles) {
        const state = this.getTcpAoRuntimeReloadState();
        if (state.state !== 'running') throw new Error('BMP未以TCP-AO认证方式稳定运行');
        const profileIds = (Array.isArray(profiles) ? profiles : []).map(profile => profile?.id);
        if (JSON.stringify(profileIds) !== JSON.stringify(state.profileIds)) {
            throw new Error('BMP TCP-AO运行Profile选择已变化，需要停止并重新启动BMP服务');
        }
        const worker = this.worker;
        let request;
        try {
            request = worker.sendRequest(
                BmpConst.BMP_REQ_TYPES.RELOAD_TCP_AO_PROFILES,
                { profiles },
                { timeoutMs: TCP_AO_RUNTIME_RELOAD_TIMEOUT_MS }
            );
        } finally {
            clearRuntimeTcpAoProfiles(profiles);
        }
        const result = await request;
        if (this.worker !== worker || this.getTcpAoRuntimeReloadState().state !== 'running') {
            throw new Error('BMP在TCP-AO密钥热更新期间已停止');
        }
        return result.data || {};
    }

    async stopTcpAoRuntimeAfterReloadFailure() {
        if (!this.worker && !this.bmpStarting && !this.bmpStartPromise) return { stopped: true };
        const result = await this.handleStopBmp();
        return { stopped: result?.status === 'success', message: result?.msg || '' };
    }

    emitRuntimeChanged(running, dispatcher = this.eventDispatcher, failure = null) {
        const normalizedRunning = Boolean(running);
        const normalizedFailure = normalizedRunning ? null : normalizeRuntimeFailure(failure);
        const nextStateKey = normalizedFailure
            ? `${normalizedRunning}|${normalizedFailure.code}|${normalizedFailure.reason}`
            : String(normalizedRunning);
        if (this.bmpRuntimeState === nextStateKey) return false;
        this.bmpRuntimeState = nextStateKey;
        dispatcher?.emit(BMP_RUNTIME_CHANGED_EVENT, {
            running: normalizedRunning,
            ...(normalizedFailure
                ? { unexpected: true, code: normalizedFailure.code, reason: normalizedFailure.reason }
                : {})
        });
        return true;
    }

    createBmpProcess(workerPath, options) {
        return new ProtocolProcessWithPromise(workerPath, options).createLongRunningProcess();
    }

    trackLifecycleOperation(propertyName, operation) {
        let resolveTracked;
        let rejectTracked;
        const trackedPromise = new Promise((resolve, reject) => {
            resolveTracked = resolve;
            rejectTracked = reject;
        });
        this[propertyName] = trackedPromise;

        let operationResult;
        try {
            operationResult = operation();
        } catch (error) {
            operationResult = Promise.reject(error);
        }
        Promise.resolve(operationResult).then(
            value => {
                if (this[propertyName] === trackedPromise) this[propertyName] = null;
                resolveTracked(value);
            },
            error => {
                if (this[propertyName] === trackedPromise) this[propertyName] = null;
                rejectTracked(error);
            }
        );
        return trackedPromise;
    }

    async sendWorkerQuery(reqType, data, notRunningData = null) {
        if (null === this.worker) {
            return successResponse(notRunningData, 'BMP未启动');
        }

        const result = await this.worker.sendRequest(reqType, data);
        return successResponse(result.data, result.msg);
    }

    async queryClientList() {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST, null, []);
    }

    async queryClient(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_CLIENT, client, null);
    }

    async queryRouteLens(query, routeState) {
        if (this.worker === null) {
            return errorResponse('BMP未启动');
        }
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_ROUTE_LENS, { query, routeState });
    }

    async queryRouteAssurance(filters = {}) {
        if (this.worker === null) {
            return errorResponse('BMP未启动');
        }
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_ROUTE_ASSURANCE, filters);
    }

    async setRouteAssuranceEnabled(settings = {}) {
        if (this.worker === null) {
            return errorResponse('BMP未启动');
        }
        const data =
            settings && typeof settings === 'object'
                ? { enabled: Boolean(settings.enabled), filters: settings.filters || {} }
                : { enabled: Boolean(settings), filters: {} };
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.SET_ROUTE_ASSURANCE_ENABLED, data);
    }

    async queryBgpSessions(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, client, []);
    }

    async queryBgpStatisticsReports(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_BGP_STATISTICS_REPORTS, client, []);
    }

    async queryBgpInstanceStatisticsReports(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_STATISTICS_REPORTS, client, []);
    }

    async serializeOfflinePersistence(operation) {
        const previous = this.offlinePersistenceLock;
        let release;
        this.offlinePersistenceLock = new Promise(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    handleOfflinePersistenceFailure(client, error) {
        logger.error(`Offline BMP persistence reader failed: ${error.message}`);
        if (this.offlinePersistenceReader === client) {
            this.offlinePersistenceReader = null;
            this.offlinePersistenceOpenPromise = null;
        }
        this.trackOfflinePersistenceClose(client);
    }

    createPersistenceClient(options) {
        return new BmpPersistenceClient(options);
    }

    createOfflinePersistenceReader() {
        let client;
        client = this.createPersistenceClient({
            dbPath: this.persistenceDbPath,
            readOnly: true,
            logLevel: this.logLevel,
            onError: error => this.handleOfflinePersistenceFailure(client, error)
        });
        return client;
    }

    async openOfflinePersistenceReader() {
        let client = this.createOfflinePersistenceReader();
        this.offlinePersistenceReader = client;
        this.offlinePersistenceOpenPromise = client.open();
        try {
            await this.offlinePersistenceOpenPromise;
            return client;
        } catch (error) {
            if (this.offlinePersistenceReader === client) {
                this.offlinePersistenceReader = null;
                this.offlinePersistenceOpenPromise = null;
            }
            await client.close({ suppressErrors: true }).catch(() => {});
            if (error.code !== 'BMP_PERSISTENCE_SCHEMA_MIGRATION_REQUIRED') {
                throw error;
            }

            const migrator = this.createPersistenceClient({
                dbPath: this.persistenceDbPath,
                logLevel: this.logLevel
            });
            try {
                await migrator.open();
            } finally {
                await migrator.close({ suppressErrors: true }).catch(() => {});
            }

            client = this.createOfflinePersistenceReader();
            this.offlinePersistenceReader = client;
            this.offlinePersistenceOpenPromise = client.open();
            await this.offlinePersistenceOpenPromise;
            return client;
        }
    }

    async withOfflinePersistence(query) {
        return this.serializeOfflinePersistence(async () => {
            if (!fs.existsSync(this.persistenceDbPath)) {
                throw new Error('BMP持久化数据库不存在');
            }
            const client = this.offlinePersistenceReader || (await this.openOfflinePersistenceReader());
            await this.offlinePersistenceOpenPromise;
            return query(client);
        });
    }

    async closeOfflinePersistenceReader() {
        return this.serializeOfflinePersistence(() => this.closeOfflinePersistenceReaderUnlocked());
    }

    async closeOfflinePersistenceReaderUnlocked() {
        const client = this.offlinePersistenceReader;
        this.offlinePersistenceReader = null;
        this.offlinePersistenceOpenPromise = null;
        if (client) {
            await this.trackOfflinePersistenceClose(client);
        }
        await this.waitForOfflinePersistenceCloses();
    }

    trackOfflinePersistenceClose(client) {
        if (!(this.offlinePersistenceClosePromises instanceof Set)) {
            this.offlinePersistenceClosePromises = new Set();
        }

        let trackedPromise;
        trackedPromise = Promise.resolve()
            .then(() => client.close({ suppressErrors: true }))
            .catch(() => {})
            .finally(() => this.offlinePersistenceClosePromises.delete(trackedPromise));
        this.offlinePersistenceClosePromises.add(trackedPromise);
        return trackedPromise;
    }

    async waitForOfflinePersistenceCloses() {
        if (!(this.offlinePersistenceClosePromises instanceof Set)) {
            return;
        }
        while (this.offlinePersistenceClosePromises.size > 0) {
            await Promise.all(this.offlinePersistenceClosePromises);
        }
    }

    getPersistenceArtifactDescriptors() {
        return BMP_PERSISTENCE_ARTIFACTS.map(artifact => ({
            ...artifact,
            path: `${this.persistenceDbPath}${artifact.suffix}`
        }));
    }

    getPersistenceDatabaseInfo() {
        const artifacts = [];
        let totalSize = 0;

        for (const artifact of this.getPersistenceArtifactDescriptors()) {
            try {
                const stats = fs.statSync(artifact.path);
                if (!stats.isFile()) {
                    continue;
                }
                artifacts.push({
                    kind: artifact.kind,
                    size: stats.size
                });
                totalSize += stats.size;
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }
        }

        const running = Boolean(this.worker);
        const starting = Boolean(this.bmpStarting);
        const deleting = Boolean(this.persistenceDatabaseDeleting);
        return {
            dbPath: this.persistenceDbPath,
            exists: artifacts.length > 0,
            running,
            starting,
            deleting,
            busy: running || starting || deleting,
            canDelete: artifacts.length > 0 && !running && !starting && !deleting,
            totalSize,
            fileCount: artifacts.length,
            artifacts
        };
    }

    async deletePersistenceDatabase() {
        if (this.worker) {
            throw new Error('请先停止 BMP 服务后再删除数据库');
        }
        if (this.bmpStarting) {
            throw new Error('BMP 服务正在启动，请稍后重试');
        }
        if (this.persistenceDatabaseDeleting) {
            throw new Error('BMP 数据库正在删除，请勿重复操作');
        }

        this.persistenceDatabaseDeleting = true;
        try {
            const result = await this.serializeOfflinePersistence(async () => {
                if (this.worker || this.bmpStarting) {
                    throw new Error('请先停止 BMP 服务后再删除数据库');
                }

                await this.closeOfflinePersistenceReaderUnlocked();
                const beforeDelete = this.getPersistenceDatabaseInfo();
                const deletedArtifacts = [];

                const artifacts = this.getPersistenceArtifactDescriptors();
                const databaseArtifact = artifacts.find(artifact => artifact.kind === 'database');
                const sidecarArtifacts = artifacts.filter(artifact => artifact.kind !== 'database');
                const deletionErrors = [];

                for (const artifact of sidecarArtifacts) {
                    try {
                        await fs.promises.unlink(artifact.path);
                        deletedArtifacts.push(artifact.kind);
                    } catch (error) {
                        if (error.code !== 'ENOENT') {
                            deletionErrors.push({ artifact, error });
                        }
                    }
                }

                if (deletionErrors.length === 0 && databaseArtifact) {
                    try {
                        await fs.promises.unlink(databaseArtifact.path);
                        deletedArtifacts.unshift(databaseArtifact.kind);
                    } catch (error) {
                        if (error.code !== 'ENOENT') {
                            deletionErrors.push({ artifact: databaseArtifact, error });
                        }
                    }
                }

                if (deletionErrors.length > 0) {
                    const failedKinds = deletionErrors.map(item => item.artifact.kind).join(', ');
                    throw new Error(`BMP 数据库文件删除失败（${failedKinds}）：${deletionErrors[0].error.message}`);
                }

                const afterDelete = this.getPersistenceDatabaseInfo();
                if (afterDelete.exists) {
                    throw new Error('BMP 数据库文件未能全部删除');
                }

                return {
                    ...afterDelete,
                    deleted: deletedArtifacts.length > 0,
                    deletedArtifacts,
                    deletedFileCount: deletedArtifacts.length,
                    reclaimedBytes: beforeDelete.totalSize
                };
            });
            return {
                ...result,
                deleting: false,
                busy: false,
                canDelete: false
            };
        } finally {
            this.persistenceDatabaseDeleting = false;
        }
    }

    async queryPersistenceStatus() {
        if (this.worker && this.runningPersistenceEnabled) {
            return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_PERSISTENCE_STATUS, null, null);
        }
        if (!fs.existsSync(this.persistenceDbPath)) {
            return successResponse(
                {
                    enabled: this.worker ? this.runningPersistenceEnabled : true,
                    ready: false,
                    dbPath: this.persistenceDbPath,
                    running: Boolean(this.worker)
                },
                'BMP持久化数据库尚未创建'
            );
        }
        const status = await this.withOfflinePersistence(client => client.getStatus());
        return successResponse(
            {
                ...status,
                enabled: this.worker ? this.runningPersistenceEnabled : true,
                running: Boolean(this.worker)
            },
            '获取BMP持久化状态成功'
        );
    }

    async queryPersistedRoutes(query = {}) {
        if (this.worker && this.runningPersistenceEnabled) {
            return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, query, null);
        }
        const result = await this.withOfflinePersistence(client => client.queryRoutes(query));
        return successResponse(result, '查询离线BMP路由成功');
    }

    async queryPersistedRouteEvents(query = {}) {
        if (this.worker && this.runningPersistenceEnabled) {
            return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTE_EVENTS, query, null);
        }
        const result = await this.withOfflinePersistence(client => client.queryEvents(query));
        return successResponse(result, '查询离线BMP路由事件成功');
    }

    async queryBgpRoutes({ client, session, af, ribType, page, pageSize, routeState, prefixFilter }) {
        return this.sendWorkerQuery(
            BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES,
            {
                client,
                session,
                af,
                ribType,
                page,
                pageSize,
                routeState,
                prefixFilter
            },
            []
        );
    }

    async queryBgpRouteDetail({ client, session, af, ribType, routeKey }) {
        return this.sendWorkerQuery(
            BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTE_DETAIL,
            {
                client,
                session,
                af,
                ribType,
                routeKey
            },
            null
        );
    }

    async queryBgpInstances(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, client, []);
    }

    async queryBgpInstanceRoutes({ client, instance, page, pageSize, routeState, prefixFilter }) {
        return this.sendWorkerQuery(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES,
            {
                client,
                instance,
                page,
                pageSize,
                routeState,
                prefixFilter
            },
            []
        );
    }

    async queryBgpInstanceRouteDetail({ client, instance, routeKey }) {
        return this.sendWorkerQuery(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTE_DETAIL,
            {
                client,
                instance,
                routeKey
            },
            null
        );
    }

    handleStartBmp(event, bmpConfigData) {
        if (this.bmpStartPromise) return this.bmpStartPromise;
        if (this.bmpStopPromise || this.bmpStopping) {
            return Promise.resolve(errorResponse('BMP正在停止，请稍后重试'));
        }
        if (this.worker) {
            logger.error('bmp协议已经启动或进程仍在回收');
            return Promise.resolve(errorResponse('bmp协议已经启动或进程仍在回收'));
        }
        if (this.persistenceDatabaseDeleting) {
            return Promise.resolve(errorResponse('BMP数据库正在删除，请稍后重试'));
        }

        let tcpAoStart = false;
        try {
            tcpAoStart = normalizeBmpConfig(bmpConfigData).authType === BMP_AUTH_TYPES.TCP_AO;
        } catch (_error) {
            // Invalid input is rejected by startBmpOperation without reading a
            // persisted TCP-AO profile, so it does not need the settings gate.
        }
        const queuedStartGeneration = tcpAoStart ? ++this.bmpStartGeneration : null;
        if (queuedStartGeneration !== null) this.bmpQueuedTcpAoStartGeneration = queuedStartGeneration;
        return this.trackLifecycleOperation('bmpStartPromise', () => {
            if (!tcpAoStart) return this.startBmpOperation(event, bmpConfigData);
            return this.tcpAoSettingsLifecycleGate.runExclusive(() => {
                const cancelled =
                    this.bmpStopping ||
                    this.bmpQueuedTcpAoStartGeneration !== queuedStartGeneration ||
                    this.bmpStartGeneration !== queuedStartGeneration;
                if (this.bmpQueuedTcpAoStartGeneration === queuedStartGeneration) {
                    this.bmpQueuedTcpAoStartGeneration = null;
                }
                if (cancelled) return errorResponse('BMP启动已取消');
                return this.startBmpOperation(event, bmpConfigData, queuedStartGeneration);
            });
        });
    }

    async startBmpOperation(event, bmpConfigData, reservedStartGeneration = null) {
        const webContents = event?.sender || null;
        this.bmpStarting = true;
        this.bmpStopping = false;
        this.bmpRuntimeState = null;
        this.bmpRuntimeFailure = null;
        this.runningAuthType = BMP_AUTH_TYPES.NONE;
        this.runningTcpAoProfileIds = [];
        const startGeneration = reservedStartGeneration ?? ++this.bmpStartGeneration;
        try {
            const inputConfig = bmpConfigData;
            const normalizedConfig = normalizeBmpConfig(inputConfig);
            const auth = normalizeBmpAuthenticationSelection(normalizedConfig);
            let tcpAoProfiles = [];
            let tcpMd5Profiles = [];
            if (auth.authType === BMP_AUTH_TYPES.TCP_AO) {
                if (this.platform !== 'linux') {
                    throw new Error('TCP-AO认证仅支持Linux 6.7及以上系统');
                }
                await this.initializeCredentialStore();
                tcpAoProfiles = auth.tcpAoProfileIds.map(profileId =>
                    this.getTcpAoSettingsStore().getRuntimeProfile(profileId)
                );
                assertNonOverlappingTcpAoProfiles(tcpAoProfiles);
            } else if (auth.authType === BMP_AUTH_TYPES.TCP_MD5) {
                if (this.platform !== 'linux') {
                    throw new Error('TCP MD5认证仅支持Linux系统');
                }
                await this.initializeCredentialStore();
                tcpMd5Profiles = auth.tcpMd5ProfileIds.map(profileId =>
                    this.getTcpMd5SettingsStore().getRuntimeProfile(profileId)
                );
                assertNonOverlappingTcpMd5Profiles(tcpMd5Profiles);
            }
            bmpConfigData = {
                ...normalizedConfig,
                tcpAoProfiles,
                tcpMd5Profiles,
                // SQLite now is the BMP RIB rather than an optional history sink.
                persistenceEnabled: true,
                persistenceDbPath: this.persistenceDbPath,
                persistenceBatchSize: Number(inputConfig.persistenceBatchSize) || 2000,
                persistenceBatchBytes: Number(inputConfig.persistenceBatchBytes) || 2 * 1024 * 1024,
                persistenceFlushMs: Number(inputConfig.persistenceFlushMs) || 20,
                persistenceHighWatermarkBytes: Number(inputConfig.persistenceHighWatermarkBytes) || 64 * 1024 * 1024,
                persistenceLowWatermarkBytes: Number(inputConfig.persistenceLowWatermarkBytes) || 32 * 1024 * 1024,
                // Offline current RIB data is persistent state. It may only be
                // reconciled by that source's lifecycle or removed explicitly.
                persistencePurgeExpiredStaleRoutes: false,
                persistenceRefreshTimeoutMs: Number(inputConfig.persistenceRefreshTimeoutMs) || 30 * 60 * 1000,
                persistenceEventRetentionMs: Number(inputConfig.persistenceEventRetentionMs) || 7 * 24 * 60 * 60 * 1000,
                persistenceMaxDbBytes: Number(inputConfig.persistenceMaxDbBytes) || 20 * 1024 * 1024 * 1024
            };
            await this.closeOfflinePersistenceReader();
            if (startGeneration !== this.bmpStartGeneration || this.bmpStopping) {
                throw new Error('BMP启动已取消');
            }
            this.runningPersistenceEnabled = true;
            logger.info('BMP config:', {
                ...bmpConfigData,
                tcpAoProfiles: tcpAoProfiles.map(profile => redactAuthenticationConfig(profile)),
                tcpMd5Profiles: tcpMd5Profiles.map(profile => redactAuthenticationConfig(profile)),
                persistenceDbPath: '[user-data]/bmp/bmp.sqlite3'
            });

            // 获取日志级别配置
            if (this.logLevel) {
                bmpConfigData.logLevel = this.logLevel;
            }

            const workerPath = resolveWorkerPath('bmp/bmpWorker.js');

            this.worker = this.createBmpProcess(workerPath, {
                serviceName: PROTOCOL_PROCESS_SERVICES.BMP,
                onExit: (code, client, exit = {}) => {
                    if (this.worker !== client) return;
                    if (exit.expected) return;
                    const failure =
                        this.bmpRuntimeFailure ||
                        normalizeRuntimeFailure({
                            code: 'BMP_PROCESS_EXIT',
                            reason: `BMP协议进程异常退出（退出码 ${Number.isInteger(code) ? code : '-'}），服务已停止`
                        });
                    this.emitRuntimeChanged(false, this.eventDispatcher, failure);
                    this.worker = null;
                    this.runningPersistenceEnabled = false;
                    this.runningAuthType = BMP_AUTH_TYPES.NONE;
                    this.runningTcpAoProfileIds = [];
                    this.closeMonitorWindows();
                    this.eventDispatcher?.cleanup();
                    this.eventDispatcher = null;
                    this.bmpRuntimeFailureHandler = null;
                }
            });
            const activeWorker = this.worker;

            // 设置事件发送器的 webContents
            this.eventDispatcher = new EventDispatcher();
            if (webContents) this.eventDispatcher.setWebContents(webContents);

            // 定义事件处理函数
            this.bmpInitiationHandler = data => {
                this.eventDispatcher.emit('bmp:initiation', successResponse(data.data));
            };

            this.bmpSessionUpdateHandler = data => {
                this.emitDetailedMonitorUpdate('bmp:sessionUpdate', data.data);
            };

            this.bmpInstanceUpdateHandler = data => {
                this.emitDetailedMonitorUpdate('bmp:instanceUpdate', data.data);
            };

            this.bmpRouteUpdateHandler = data => {
                this.emitDetailedMonitorUpdate('bmp:routeUpdate', data.data);
            };

            this.bmpInstanceRouteUpdateHandler = data => {
                this.emitDetailedMonitorUpdate('bmp:instanceRouteUpdate', data.data);
            };

            this.bmpTerminationHandler = data => {
                this.eventDispatcher.emit('bmp:termination', successResponse(data.data));
            };

            this.bmpStatisticsReportHandler = data => {
                // 统计明细只供按 Client 打开的统一监控窗口使用；没有窗口时不产生 renderer IPC。
                this.eventDispatcher.emitToSubscribers('bmp:statisticsReport', successResponse(data.data));
            };

            this.bmpRuntimeFailureHandler = failure => {
                if (this.worker !== activeWorker) return;
                this.bmpRuntimeFailure = normalizeRuntimeFailure(failure);
                this.runningAuthType = BMP_AUTH_TYPES.NONE;
                this.runningTcpAoProfileIds = [];
                this.emitRuntimeChanged(false, this.eventDispatcher, this.bmpRuntimeFailure);
            };

            // 注册事件监听器，处理来自worker的事件通知
            this.worker.addEventListener(BmpConst.BMP_EVT_TYPES.INITIATION, this.bmpInitiationHandler);
            this.worker.addEventListener(BmpConst.BMP_EVT_TYPES.SESSION_UPDATE, this.bmpSessionUpdateHandler);
            this.worker.addEventListener(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, this.bmpInstanceUpdateHandler);
            this.worker.addEventListener(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, this.bmpRouteUpdateHandler);
            this.worker.addEventListener(
                BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE,
                this.bmpInstanceRouteUpdateHandler
            );
            this.worker.addEventListener(BmpConst.BMP_EVT_TYPES.TERMINATION, this.bmpTerminationHandler);
            this.worker.addEventListener(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, this.bmpStatisticsReportHandler);
            this.worker.addEventListener(BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE, this.bmpRuntimeFailureHandler);

            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.START_BMP, bmpConfigData);
            if (this.bmpRuntimeFailure) {
                throw new Error(this.bmpRuntimeFailure.reason);
            }
            if (startGeneration !== this.bmpStartGeneration || this.bmpStopping || this.worker !== activeWorker) {
                throw new Error('BMP启动已取消');
            }

            // 这里肯定是启动成功了，如果失败，会抛出异常
            this.runningAuthType = auth.authType;
            this.runningTcpAoProfileIds = auth.authType === BMP_AUTH_TYPES.TCP_AO ? [...auth.tcpAoProfileIds] : [];
            this.emitRuntimeChanged(true);
            logger.info('bmp启动成功 result:', result);
            return successResponse(null, result.msg);
        } catch (error) {
            const worker = this.worker;
            if (worker) {
                worker.removeEventListener(BmpConst.BMP_EVT_TYPES.INITIATION, this.bmpInitiationHandler);
                worker.removeEventListener(BmpConst.BMP_EVT_TYPES.SESSION_UPDATE, this.bmpSessionUpdateHandler);
                worker.removeEventListener(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, this.bmpInstanceUpdateHandler);
                worker.removeEventListener(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, this.bmpRouteUpdateHandler);
                worker.removeEventListener(
                    BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE,
                    this.bmpInstanceRouteUpdateHandler
                );
                worker.removeEventListener(BmpConst.BMP_EVT_TYPES.TERMINATION, this.bmpTerminationHandler);
                worker.removeEventListener(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, this.bmpStatisticsReportHandler);
                worker.removeEventListener(BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE, this.bmpRuntimeFailureHandler);
                await worker.terminate().catch(() => {});
                if (this.worker === worker) {
                    this.worker = null;
                }
            }
            this.runningPersistenceEnabled = false;
            this.runningAuthType = BMP_AUTH_TYPES.NONE;
            this.runningTcpAoProfileIds = [];
            this.emitRuntimeChanged(false);
            if (this.eventDispatcher) {
                this.eventDispatcher.cleanup(); // 清理事件发送器
                this.eventDispatcher = null;
            }
            logger.error('Error starting BMP:', error.message);
            return errorResponse(error.message);
        } finally {
            this.bmpStarting = false;
            if (this.bmpStopping && !this.worker && !this.bmpStopPromise) this.bmpStopping = false;
        }
    }

    handleStopBmp() {
        if (this.bmpStopPromise) return this.bmpStopPromise;
        if (!this.worker && !this.bmpStarting && !this.bmpStartPromise) {
            logger.error('BMP未启动');
            return Promise.resolve(errorResponse('BMP未启动'));
        }

        return this.trackLifecycleOperation('bmpStopPromise', () => this.stopBmpOperation());
    }

    async stopBmpOperation() {
        this.closeMonitorWindows();
        const pendingStart = this.bmpStartPromise;
        const queuedTcpAoStart = Boolean(
            pendingStart && !this.bmpStarting && this.bmpQueuedTcpAoStartGeneration !== null
        );
        const cancelledPendingStart = Boolean(this.bmpStarting || pendingStart);
        this.bmpStopping = true;
        this.runningAuthType = BMP_AUTH_TYPES.NONE;
        this.runningTcpAoProfileIds = [];
        this.emitRuntimeChanged(false);
        this.cancelPendingStart();
        if (pendingStart && !queuedTcpAoStart) await pendingStart.catch(() => {});

        if (!this.worker) {
            this.bmpStopping = false;
            return cancelledPendingStart ? successResponse(null, 'BMP启动已取消') : errorResponse('BMP未启动');
        }

        const worker = this.worker;
        try {
            const result = await worker.sendRequest(BmpConst.BMP_REQ_TYPES.STOP_BMP, null, {
                timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.BMP_STOP
            });
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('Error stopping BMP:', error.message);
            return errorResponse(error.message);
        } finally {
            // A failed persistence drain is reported to the caller, but the outer worker must
            // still be released so the BMP service can be started again instead of becoming a zombie.
            worker.removeEventListener(BmpConst.BMP_EVT_TYPES.INITIATION, this.bmpInitiationHandler);
            worker.removeEventListener(BmpConst.BMP_EVT_TYPES.SESSION_UPDATE, this.bmpSessionUpdateHandler);
            worker.removeEventListener(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, this.bmpInstanceUpdateHandler);
            worker.removeEventListener(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, this.bmpRouteUpdateHandler);
            worker.removeEventListener(
                BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE,
                this.bmpInstanceRouteUpdateHandler
            );
            worker.removeEventListener(BmpConst.BMP_EVT_TYPES.TERMINATION, this.bmpTerminationHandler);
            worker.removeEventListener(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, this.bmpStatisticsReportHandler);
            worker.removeEventListener(BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE, this.bmpRuntimeFailureHandler);
            await worker.terminate().catch(() => {});
            if (this.worker === worker) {
                this.worker = null;
            }
            this.runningPersistenceEnabled = false;
            this.runningAuthType = BMP_AUTH_TYPES.NONE;
            this.runningTcpAoProfileIds = [];
            if (this.eventDispatcher) {
                this.eventDispatcher.cleanup(); // 清理事件发送器
                this.eventDispatcher = null;
            }
            this.bmpRuntimeFailure = null;
            this.bmpRuntimeFailureHandler = null;
            this.bmpStopping = false;
        }
    }

    closeMonitorWindows() {
        if (!this.closeMonitorWindowsHandler) {
            return;
        }
        try {
            this.closeMonitorWindowsHandler();
        } catch (error) {
            logger.warn(`关闭 BMP 独立监控窗口失败: ${error.message}`);
        }
    }

    async handleGetPersistenceStatus() {
        try {
            return await this.queryPersistenceStatus();
        } catch (error) {
            logger.error('Error getting BMP persistence status:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetPersistenceDatabaseInfo() {
        try {
            return successResponse(this.getPersistenceDatabaseInfo(), '获取BMP数据库状态成功');
        } catch (error) {
            logger.error('Error getting BMP database info:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeletePersistenceDatabase() {
        try {
            const result = await this.deletePersistenceDatabase();
            return successResponse(result, result.deleted ? 'BMP数据库删除成功' : 'BMP数据库不存在，无需删除');
        } catch (error) {
            logger.error('Error deleting BMP persistence database:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetPersistedRoutes(event, query = {}) {
        try {
            return await this.queryPersistedRoutes(query);
        } catch (error) {
            logger.error('Error getting persisted BMP routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetPersistedRouteEvents(event, query = {}) {
        try {
            return await this.queryPersistedRouteEvents(query);
        } catch (error) {
            logger.error('Error getting persisted BMP route events:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetClientList() {
        try {
            const result = await this.queryClientList();
            logger.info('获取客户端列表成功 count:', result?.data?.length || 0);
            return result;
        } catch (error) {
            logger.error('Error getting client list:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetClient(event, clientKey) {
        const normalizedClientKey = normalizeBmpClientKey(clientKey);
        if (!normalizedClientKey) {
            return errorResponse('BMP Client 标识无效');
        }

        const client = normalizedClientKey.startsWith('source:')
            ? { persistentSourceId: normalizedClientKey.slice('source:'.length) }
            : (() => {
                  const [localIp, localPort, remoteIp, remotePort] = normalizedClientKey
                      .slice('connection:'.length)
                      .split('|');
                  return {
                      localIp,
                      localPort: Number(localPort),
                      remoteIp,
                      remotePort: Number(remotePort)
                  };
              })();

        try {
            return await this.queryClient(client);
        } catch (error) {
            logger.error('Error getting BMP client:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteClientData(event, request = {}) {
        if (null === this.worker) {
            return errorResponse('请先启动 BMP 服务后删除离线客户端');
        }

        try {
            const deleteRequest = {
                sourceId: typeof request?.sourceId === 'string' ? request.sourceId.trim() : '',
                remoteIp: typeof request?.remoteIp === 'string' ? request.remoteIp.trim() : ''
            };
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.DELETE_CLIENT_DATA, deleteRequest);
            return successResponse(result.data, result.msg || 'BMP客户端关联数据删除成功');
        } catch (error) {
            logger.error('Error deleting BMP client data:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetRouteLens(event, query, routeState = BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE) {
        try {
            return await this.queryRouteLens(query, routeState);
        } catch (error) {
            logger.error('Error getting Route Lens:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetRouteAssurance(event, filters = {}) {
        try {
            return await this.queryRouteAssurance(filters);
        } catch (error) {
            logger.error('Error getting Route Assurance:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSetRouteAssuranceEnabled(event, settings) {
        try {
            return await this.setRouteAssuranceEnabled(settings);
        } catch (error) {
            logger.error('Error setting Route Assurance state:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpSessions(event, client) {
        logger.info('获取BGP会话列表 client:', client);

        try {
            const result = await this.queryBgpSessions(client);
            logger.info('获取BGP会话列表成功 count:', result?.data?.length || 0);
            return result;
        } catch (error) {
            logger.error('Error getting bgp sessions:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpStatisticsReports(event, client) {
        try {
            return await this.queryBgpStatisticsReports(client);
        } catch (error) {
            logger.error('Error getting BGP statistics reports:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstanceStatisticsReports(event, client) {
        try {
            return await this.queryBgpInstanceStatisticsReports(client);
        } catch (error) {
            logger.error('Error getting BGP instance statistics reports:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpRoutes(event, client, session, af, ribType, page, pageSize, routeState, prefixFilter) {
        logger.info('获取路由列表:', {
            sourceId: client?.persistentSourceId || client?.sourceId,
            scopeId: session?.persistentScopeId || session?.scopeId,
            af,
            ribType,
            page,
            pageSize,
            prefixFilter
        });

        try {
            const result = await this.queryBgpRoutes({
                client,
                session,
                af,
                ribType,
                page,
                pageSize,
                routeState,
                prefixFilter
            });
            logger.info('获取路由列表成功:', {
                total: Number(result?.data?.total) || 0,
                displayed: result?.data?.list?.length || 0
            });
            return result;
        } catch (error) {
            logger.error('Error getting routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpRouteDetail(event, client, session, af, ribType, routeKey) {
        try {
            return await this.queryBgpRouteDetail({
                client,
                session,
                af,
                ribType,
                routeKey
            });
        } catch (error) {
            logger.error('Error getting route detail:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstanceRoutes(event, client, instance, page, pageSize, routeState, prefixFilter) {
        logger.info('获取BGP实例路由列表:', {
            sourceId: client?.persistentSourceId || client?.sourceId,
            scopeId: instance?.persistentScopeId || instance?.scopeId,
            page,
            pageSize,
            prefixFilter
        });

        try {
            const result = await this.queryBgpInstanceRoutes({
                client,
                instance,
                page,
                pageSize,
                routeState,
                prefixFilter
            });
            logger.info('获取BGP实例路由列表成功:', {
                total: Number(result?.data?.total) || 0,
                displayed: result?.data?.list?.length || 0
            });
            return result;
        } catch (error) {
            logger.error('Error getting routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstanceRouteDetail(event, client, instance, routeKey) {
        try {
            return await this.queryBgpInstanceRouteDetail({
                client,
                instance,
                routeKey
            });
        } catch (error) {
            logger.error('Error getting instance route detail:', error.message);
            return errorResponse(error.message);
        }
    }

    async handlePurgeStaleBgpRoutes(event, client, session, af, ribType) {
        if (null === this.worker) {
            return successResponse({ deleted: 0 }, 'BMP未启动');
        }

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.PURGE_STALE_BGP_ROUTES, {
                client,
                session,
                af,
                ribType
            });
            return successResponse(result.data, '过期路由清理成功');
        } catch (error) {
            logger.error('Error purging stale routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handlePurgeStaleBgpInstanceRoutes(event, client, instance) {
        if (null === this.worker) {
            return successResponse({ deleted: 0 }, 'BMP未启动');
        }

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.PURGE_STALE_BGP_INSTANCE_ROUTES, {
                client,
                instance
            });
            return successResponse(result.data, 'BGP实例过期路由清理成功');
        } catch (error) {
            logger.error('Error purging stale instance routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstances(event, client) {
        logger.info('获取BGP实例列表 client:', client);

        try {
            const result = await this.queryBgpInstances(client);
            logger.info('获取BGP实例列表成功 count:', result?.data?.length || 0);
            return result;
        } catch (error) {
            logger.error('Error getting BGP instances:', error.message);
            return errorResponse(error.message);
        }
    }

    getBmpRunning() {
        return null !== this.worker || this.bmpStarting || Boolean(this.bmpStartPromise);
    }

    cancelPendingStart() {
        if (!this.bmpStarting && !this.bmpStartPromise) return false;
        this.bmpStopping = true;
        this.bmpQueuedTcpAoStartGeneration = null;
        this.bmpStartGeneration += 1;
        return true;
    }
}

module.exports = BmpApp;
module.exports.PACKAGED_RENDERER_PATH = PACKAGED_RENDERER_PATH;
module.exports.isTrustedBmpRendererUrl = isTrustedBmpRendererUrl;
module.exports.normalizeBmpConfig = normalizeBmpConfig;
