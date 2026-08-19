const path = require('path');
const { fileURLToPath } = require('node:url');
const { app, BrowserWindow, dialog } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const ProtocolProcessWithPromise = require('../worker/core/protocolProcessWithPromise');
const { PROTOCOL_PROCESS_SERVICES, PROTOCOL_PROCESS_TIMEOUTS } = require('../worker/core/protocolProcessServices');
const RpkiConst = require('../const/rpkiConst');
const RpkiAspa = require('../worker/rpki/rpkiAspa');
const EventDispatcher = require('../utils/eventDispatcher');
const { normalizeRoaObject } = require('../utils/rpkiRoaImport');
const { normalizeAspaObject } = require('../utils/rpkiAspaImport');
const SecureCredentialStore = require('../utils/secureCredentialStore');
const TcpAoSettingsStore = require('../utils/tcpAoSettingsStore');
const { RPKI_AUTH_TYPES, normalizeRpkiAuthSelection, redactTcpAoConfig } = require('../utils/tcpAoConfig');

const RPKI_RUNTIME_CHANGED_EVENT = 'rpki:runtimeChanged';
const PACKAGED_RENDERER_PATH = path.resolve(__dirname, '../../dist/index.html');
const MAX_RUNTIME_FAILURE_CODE_LENGTH = 64;
const MAX_RUNTIME_FAILURE_REASON_LENGTH = 512;

function normalizeRuntimeFailure(failure, fallback = null) {
    const source = failure && typeof failure === 'object' ? failure : fallback;
    if (!source || typeof source !== 'object') return null;
    const code = String(source.code || 'RPKI_PROCESS_EXIT')
        .trim()
        .slice(0, MAX_RUNTIME_FAILURE_CODE_LENGTH);
    const reason = String(source.reason || 'RPKI协议进程异常退出，服务已停止')
        .trim()
        .slice(0, MAX_RUNTIME_FAILURE_REASON_LENGTH);
    return { code: code || 'RPKI_PROCESS_EXIT', reason: reason || 'RPKI协议进程异常退出，服务已停止' };
}

function isTrustedRpkiRendererUrl(senderUrl, options = {}) {
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

function normalizeRpkiConfig(config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('RPKI配置格式无效');
    }
    const port = Number(config.port ?? RpkiConst.RPKI_DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('RPKI服务端口必须是1-65535之间的整数');
    }
    const maxProtocolVersion = Number(config.maxProtocolVersion ?? RpkiConst.RPKI_MAX_SUPPORTED_VERSION);
    if (!Object.values(RpkiConst.RPKI_PROTOCOL_VERSION).includes(maxProtocolVersion)) {
        throw new Error('RPKI最高协议版本无效');
    }
    const aspaFormat = String(config.aspaFormat || RpkiConst.RPKI_ASPA_FORMAT.LATEST);
    if (!Object.values(RpkiConst.RPKI_ASPA_FORMAT).includes(aspaFormat)) {
        throw new Error('RPKI ASPA编码格式无效');
    }
    return {
        port: String(port),
        maxProtocolVersion,
        aspaFormat,
        ...normalizeRpkiAuthSelection(config)
    };
}

class RpkiApp {
    constructor(ipcMain, store, options = {}) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.primaryWebContents = options.primaryWebContents || null;
        this.browserWindow = options.browserWindow || BrowserWindow;
        this.appIsPackaged = options.appIsPackaged;
        this.platform = options.platform || process.platform;
        this.packagedRendererPath = options.packagedRendererPath || PACKAGED_RENDERER_PATH;
        this.rpkiConfigFileKey = 'rpki-config';
        this.rpkiRouterKeyFileKey = 'rpki-router-key';
        this.credentialStore = options.credentialStore || new SecureCredentialStore();
        this.tcpAoSettingsStore =
            options.tcpAoSettingsStore || new TcpAoSettingsStore(this.store, this.credentialStore);
        this.worker = null;
        this.rpkiReady = false;
        this.rpkiStopping = false;
        this.eventDispatcher = null;
        this.logLevel = null;
        this.rpkiClientConnectionHandler = null;
        this.rpkiStarting = false;
        this.rpkiStartGeneration = 0;
        this.rpkiStartPromise = null;
        this.rpkiStopPromise = null;
        this.rpkiTerminateOnlyWorker = null;
        this.rpkiRuntimeState = null;
        this.rpkiRuntimeFailure = null;
        this.rpkiRuntimeFailureHandler = null;
        this.routerKeyMutationQueue = Promise.resolve();

        this.registerHandlers();
    }

    registerHandlers() {
        this.registerTrustedHandler('rpki:saveRpkiConfig', this.handleSaveRpkiConfig);
        this.registerTrustedHandler('rpki:loadRpkiConfig', this.handleLoadRpkiConfig);
        this.registerTrustedHandler('rpki:saveTcpAoSettings', this.handleSaveTcpAoSettings);
        this.registerTrustedHandler('rpki:loadTcpAoSettings', this.handleLoadTcpAoSettings);
        this.registerTrustedHandler('rpki:startRpki', this.handleStartRpki);
        this.registerTrustedHandler('rpki:stopRpki', this.handleStopRpki);
        this.registerTrustedHandler('rpki:getClientList', this.handleGetClientList);

        this.registerTrustedHandler('rpki:addRoa', this.handleAddRoa);
        this.registerTrustedHandler('rpki:deleteRoa', this.handleDeleteRoa);
        this.registerTrustedHandler('rpki:deleteAllRoa', this.handleDeleteAllRoa);
        this.registerTrustedHandler('rpki:getRoaList', this.handleGetRoaList);
        this.registerTrustedHandler('rpki:selectRoaJsonFile', this.handleSelectRoaJsonFile);
        this.registerTrustedHandler('rpki:importRoaJson', this.handleImportRoaJson);

        this.registerTrustedHandler('rpki:addRouterKey', this.handleAddRouterKey);
        this.registerTrustedHandler('rpki:deleteRouterKey', this.handleDeleteRouterKey);
        this.registerTrustedHandler('rpki:getRouterKeyList', this.handleGetRouterKeyList);

        this.registerTrustedHandler('rpki:addAspa', this.handleAddAspa);
        this.registerTrustedHandler('rpki:deleteAspa', this.handleDeleteAspa);
        this.registerTrustedHandler('rpki:deleteAllAspa', this.handleDeleteAllAspa);
        this.registerTrustedHandler('rpki:selectAspaJsonFile', this.handleSelectAspaJsonFile);
        this.registerTrustedHandler('rpki:importAspaJson', this.handleImportAspaJson);
        this.registerTrustedHandler('rpki:getAspaList', this.handleGetAspaList);
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
            throw new Error('拒绝来自未知窗口的RPKI请求');
        }

        if (
            isTrustedRpkiRendererUrl(senderUrl, {
                isPackaged: this.appIsPackaged ?? app.isPackaged,
                packagedRendererPath: this.packagedRendererPath
            })
        ) {
            return;
        }
        throw new Error('拒绝来自非应用页面的RPKI请求');
    }

    async handleSaveRpkiConfig(event, config) {
        try {
            const storedConfig = normalizeRpkiConfig(config);
            this.store.set(this.rpkiConfigFileKey, storedConfig);
            return successResponse(null, 'RPKI配置文件保存成功');
        } catch (error) {
            logger.error('Error saving RPKI config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadRpkiConfig() {
        try {
            const config = this.store.get(this.rpkiConfigFileKey);
            if (!config) {
                return successResponse(null, 'RPKI配置文件不存在');
            }
            const safeConfig = normalizeRpkiConfig(config);
            return successResponse(safeConfig, 'RPKI配置文件加载成功');
        } catch (error) {
            logger.error('Error loading RPKI config:', error.message);
            return errorResponse(error.message);
        }
    }

    getTcpAoSettingsStore() {
        // SystemApp replaces protocol stores after a major-version cleanup.
        this.tcpAoSettingsStore.store = this.store;
        return this.tcpAoSettingsStore;
    }

    async initializeCredentialStore() {
        if (typeof this.credentialStore.initialize === 'function') {
            await this.credentialStore.initialize();
        }
    }

    async handleSaveTcpAoSettings(event, settings) {
        try {
            await this.initializeCredentialStore();
            const saved = this.getTcpAoSettingsStore().saveSettings(settings);
            return successResponse(saved, 'TCP-AO配置保存成功');
        } catch (error) {
            logger.error('Error saving TCP-AO settings:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadTcpAoSettings() {
        try {
            await this.initializeCredentialStore();
            return successResponse(this.getTcpAoSettingsStore().listProfiles(), 'TCP-AO配置加载成功');
        } catch (error) {
            logger.error('Error loading TCP-AO settings:', error.message);
            return errorResponse(error.message);
        }
    }

    getRpkiDatabasePath() {
        return path.join(app.getPath('userData'), 'rpki', 'rpki.sqlite3');
    }

    getRuntimeError() {
        if (!this.worker || !this.rpkiReady || this.rpkiStopping) {
            return 'RPKI未运行，请先启动RPKI服务';
        }
        return null;
    }

    emitRuntimeChanged(running, dispatcher = this.eventDispatcher, failure = null) {
        const normalizedRunning = Boolean(running);
        if (this.rpkiRuntimeState === normalizedRunning) return false;
        this.rpkiRuntimeState = normalizedRunning;
        const normalizedFailure = normalizedRunning ? null : normalizeRuntimeFailure(failure);
        dispatcher?.emit(RPKI_RUNTIME_CHANGED_EVENT, {
            running: normalizedRunning,
            ...(normalizedFailure
                ? { unexpected: true, code: normalizedFailure.code, reason: normalizedFailure.reason }
                : {})
        });
        return true;
    }

    cleanupRpkiRuntime(worker, failure = null) {
        if (this.worker !== worker) return false;

        const dispatcher = this.eventDispatcher;
        worker?.removeEventListener?.(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, this.rpkiClientConnectionHandler);
        worker?.removeEventListener?.(RpkiConst.RPKI_EVT_TYPES.RUNTIME_FAILURE, this.rpkiRuntimeFailureHandler);
        const runtimeFailure = normalizeRuntimeFailure(failure || this.rpkiRuntimeFailure);
        this.worker = null;
        this.rpkiReady = false;
        this.rpkiStopping = false;
        if (this.rpkiTerminateOnlyWorker === worker) this.rpkiTerminateOnlyWorker = null;
        this.emitRuntimeChanged(false, dispatcher, runtimeFailure);
        dispatcher?.cleanup();
        if (this.eventDispatcher === dispatcher) this.eventDispatcher = null;
        this.rpkiClientConnectionHandler = null;
        this.rpkiRuntimeFailure = null;
        this.rpkiRuntimeFailureHandler = null;
        return true;
    }

    createRpkiProcess(workerPath, options) {
        return new ProtocolProcessWithPromise(workerPath, options).createLongRunningProcess();
    }

    async terminateRpkiWorker(worker) {
        try {
            await worker.terminate();
        } catch (error) {
            if (this.worker === worker) {
                this.rpkiReady = false;
                this.emitRuntimeChanged(false);
            }
            return error;
        }

        this.cleanupRpkiRuntime(worker);
        if (this.rpkiTerminateOnlyWorker === worker) this.rpkiTerminateOnlyWorker = null;
        return null;
    }

    async requestRpki(reqType, payload = null, options = undefined) {
        const runtimeError = this.getRuntimeError();
        if (runtimeError) {
            const error = new Error(runtimeError);
            error.code = 'RPKI_NOT_RUNNING';
            throw error;
        }

        const worker = this.worker;
        return worker.sendRequest(reqType, payload, options);
    }

    runRouterKeyMutation(task) {
        const pending = this.routerKeyMutationQueue.then(task, task);
        this.routerKeyMutationQueue = pending.catch(() => {});
        return pending;
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

    handleStartRpki(event, config) {
        if (this.rpkiStartPromise) return this.rpkiStartPromise;
        if (this.rpkiStopPromise || this.rpkiStopping) {
            return Promise.resolve(errorResponse('RPKI正在停止，请稍后重试'));
        }
        if (this.worker) {
            logger.error('rpki协议已经启动或进程仍在回收');
            return Promise.resolve(errorResponse('rpki协议已经启动或进程仍在回收'));
        }

        return this.trackLifecycleOperation('rpkiStartPromise', () => this.startRpkiOperation(event, config));
    }

    async startRpkiOperation(event, config) {
        const webContents = event?.sender || null;
        let worker = null;
        this.rpkiStarting = true;
        this.rpkiReady = false;
        this.rpkiStopping = false;
        this.rpkiRuntimeState = null;
        this.rpkiRuntimeFailure = null;
        const startGeneration = ++this.rpkiStartGeneration;
        let startRequestSucceeded = false;
        try {
            const normalizedConfig = normalizeRpkiConfig(config);
            const auth = normalizeRpkiAuthSelection(normalizedConfig);
            let tcpAo = null;
            if (auth.authType === RPKI_AUTH_TYPES.TCP_AO) {
                if (this.platform !== 'linux') {
                    throw new Error('TCP-AO认证仅支持Linux 6.7及以上系统');
                }
                await this.initializeCredentialStore();
                tcpAo = this.getTcpAoSettingsStore().getRuntimeProfile(auth.tcpAoProfileId);
            }
            const rpkiConfigData = {
                ...normalizedConfig,
                tcpAo,
                rpkiDatabasePath: this.getRpkiDatabasePath(),
                initialRouterKeys: this.store.get(this.rpkiRouterKeyFileKey) || []
            };
            if (this.logLevel) {
                rpkiConfigData.logLevel = this.logLevel;
            }
            logger.info(
                `${JSON.stringify({
                    ...rpkiConfigData,
                    tcpAo: tcpAo ? redactTcpAoConfig(tcpAo) : null,
                    initialRouterKeys: undefined
                })}`
            );

            const workerPath = resolveWorkerPath('rpki/rpkiWorker.js');
            worker = this.createRpkiProcess(workerPath, {
                serviceName: PROTOCOL_PROCESS_SERVICES.RPKI,
                onExit: (code, client, details = {}) => {
                    const failure = details.expected
                        ? null
                        : this.rpkiRuntimeFailure || {
                              code: 'RPKI_PROCESS_EXIT',
                              reason: `RPKI协议进程异常退出（退出码 ${Number.isInteger(code) ? code : '-'}），服务已停止`
                          };
                    this.cleanupRpkiRuntime(client, failure);
                }
            });
            this.worker = worker;
            this.eventDispatcher = new EventDispatcher();
            if (webContents) this.eventDispatcher.setWebContents(webContents);
            this.rpkiClientConnectionHandler = data => {
                this.eventDispatcher?.emit('rpki:clientConnection', successResponse(data));
            };
            this.rpkiRuntimeFailureHandler = failure => {
                if (this.worker !== worker) return;
                this.rpkiRuntimeFailure = normalizeRuntimeFailure(failure);
                this.rpkiReady = false;
                this.emitRuntimeChanged(false, this.eventDispatcher, this.rpkiRuntimeFailure);
            };
            worker.addEventListener(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, this.rpkiClientConnectionHandler);
            worker.addEventListener(RpkiConst.RPKI_EVT_TYPES.RUNTIME_FAILURE, this.rpkiRuntimeFailureHandler);

            const result = await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.START_RPKI, rpkiConfigData);
            startRequestSucceeded = true;
            if (this.rpkiRuntimeFailure) {
                throw new Error(this.rpkiRuntimeFailure.reason);
            }
            if (startGeneration !== this.rpkiStartGeneration || this.rpkiStopping || this.worker !== worker) {
                throw new Error('RPKI启动已取消');
            }
            this.rpkiReady = true;
            this.emitRuntimeChanged(true);
            logger.info(`rpki启动成功 result: ${JSON.stringify(result)}`);
            return successResponse(null, result.msg);
        } catch (error) {
            let finalError = error;
            this.rpkiReady = false;
            this.emitRuntimeChanged(false);
            if (worker && this.worker === worker) {
                const gracefulStopOwnsWorker = startRequestSucceeded && this.rpkiStopping;
                if (!gracefulStopOwnsWorker) {
                    this.rpkiTerminateOnlyWorker = worker;
                    if (!this.rpkiStopping) {
                        const terminateError = await this.terminateRpkiWorker(worker);
                        if (terminateError) {
                            finalError = new Error(
                                `${error.message}; RPKI进程终止失败，已保留进程句柄以便重试: ${terminateError.message}`
                            );
                        }
                    }
                }
            }
            logger.error('Error starting RPKI:', finalError.message);
            return errorResponse(finalError.message);
        } finally {
            this.rpkiStarting = false;
            if (this.rpkiStopping && !this.worker && !this.rpkiStopPromise) this.rpkiStopping = false;
        }
    }

    handleStopRpki() {
        if (this.rpkiStopPromise) return this.rpkiStopPromise;
        if (!this.worker && !this.rpkiStarting && !this.rpkiStartPromise) {
            logger.error('RPKI未启动');
            return Promise.resolve(errorResponse('RPKI未启动'));
        }

        return this.trackLifecycleOperation('rpkiStopPromise', () => this.stopRpkiOperation());
    }

    async stopRpkiOperation() {
        const pendingStart = this.rpkiStartPromise;
        const cancelledPendingStart = Boolean(this.rpkiStarting || pendingStart);
        this.rpkiStopping = true;
        this.rpkiReady = false;
        this.emitRuntimeChanged(false);
        this.cancelPendingStart();
        if (pendingStart) await pendingStart.catch(() => {});

        const worker = this.worker;
        if (!worker) {
            this.rpkiStopping = false;
            return cancelledPendingStart ? successResponse(null, 'RPKI启动已取消') : errorResponse('RPKI未启动');
        }

        let stopError = null;
        let stopMessage = cancelledPendingStart ? 'RPKI启动已取消' : 'rpki协议停止成功';
        const terminateOnly = this.rpkiTerminateOnlyWorker === worker;
        if (!terminateOnly) {
            try {
                const result = await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.STOP_RPKI, null, {
                    timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
                });
                stopMessage = result.msg || stopMessage;
            } catch (error) {
                stopError = error;
                logger.error('Error stopping RPKI:', error.message);
            }
        }

        this.rpkiTerminateOnlyWorker = worker;
        const terminateError = await this.terminateRpkiWorker(worker);
        if (terminateError) {
            if (this.worker === worker) {
                this.rpkiStopping = false;
                this.rpkiReady = false;
            }
            const details = [stopError?.message, terminateError.message].filter(Boolean).join('; ');
            const message = `RPKI进程终止失败，已保留进程句柄以便重试: ${details}`;
            logger.error(message);
            return errorResponse(message);
        }

        this.rpkiStopping = false;
        if (stopError) return errorResponse(stopError.message);
        return successResponse(null, stopMessage);
    }

    async handleAddRoa(event, roa) {
        try {
            const normalizedRoa = normalizeRoaObject(roa);
            if (!normalizedRoa) {
                return errorResponse('RPKI ROA配置格式无效');
            }
            const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.ADD_ROA, normalizedRoa);
            return successResponse(result.data, result.msg || 'RPKI ROA配置保存成功');
        } catch (error) {
            logger.error('Error adding ROA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteRoa(event, roa) {
        try {
            const normalizedRoa = normalizeRoaObject(roa);
            if (!normalizedRoa) {
                return errorResponse('RPKI ROA配置格式无效');
            }
            const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.DELETE_ROA, normalizedRoa);
            return successResponse(result.data, result.msg || 'RPKI ROA配置删除成功');
        } catch (error) {
            logger.error('Error deleting ROA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAllRoa() {
        try {
            const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.DELETE_ALL_ROA);
            return successResponse(result.data, result.msg || 'RPKI ROA批量删除成功');
        } catch (error) {
            logger.error('Error deleting all ROA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetRoaList(event, options = null) {
        try {
            const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.GET_ROA_LIST, options);
            const data =
                (!options || typeof options !== 'object') &&
                !Array.isArray(result.data) &&
                Array.isArray(result.data?.items)
                    ? result.data.items
                    : result.data;
            return successResponse(data, result.msg || 'RPKI ROA配置加载成功');
        } catch (error) {
            logger.error('Error getting ROA list:', error.message);
            return errorResponse(error.message);
        }
    }

    async showRoaJsonOpenDialog(event) {
        const options = {
            title: '导入 ROA JSON 文件',
            properties: ['openFile'],
            filters: [
                { name: 'JSON', extensions: ['json'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        };
        const win = BrowserWindow.fromWebContents(event?.sender) || BrowserWindow.getFocusedWindow();
        return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    }

    async handleSelectRoaJsonFile(event) {
        const runtimeError = this.getRuntimeError();
        if (runtimeError) return errorResponse(runtimeError);
        try {
            const result = await this.showRoaJsonOpenDialog(event);
            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse(null, '已取消选择');
            }
            return successResponse(result.filePaths[0], 'ROA JSON文件选择成功');
        } catch (error) {
            logger.error('Error selecting ROA JSON:', error.message);
            return errorResponse(error.message);
        }
    }

    normalizeRoaImportLimit(limit) {
        const value = Number(limit);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    }

    async handleImportRoaJson(event, importOptions = {}) {
        const runtimeError = this.getRuntimeError();
        if (runtimeError) return errorResponse(runtimeError);
        try {
            let importFilePath = importOptions?.filePath;
            if (!importFilePath) {
                const result = await this.showRoaJsonOpenDialog(event);
                if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                    return successResponse({ cancelled: true }, '已取消导入');
                }
                importFilePath = result.filePaths[0];
            }
            const workerStats = await this.importRoaJsonFile(importFilePath, {
                limit: this.normalizeRoaImportLimit(importOptions?.limit)
            });
            const { importWorkerThreadId: _importWorkerThreadId, ...stats } = workerStats || {};
            return successResponse(stats, 'ROA JSON导入完成');
        } catch (error) {
            logger.error('Error importing ROA JSON:', error.message);
            return errorResponse(error.message);
        }
    }

    async importRoaJsonFile(importFilePath, options = {}) {
        const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.IMPORT_ROA_JSON, {
            filePath: importFilePath,
            limit: this.normalizeRoaImportLimit(options.limit)
        });
        logger.info(`ROA JSON导入完成: ${JSON.stringify(result.data)}`);
        return result.data || {};
    }

    async handleAddRouterKey(event, rk) {
        try {
            return await this.runRouterKeyMutation(async () => {
                if (this.worker && !this.rpkiReady) {
                    return errorResponse('RPKI正在启动或停止，请稍后重试');
                }

                const currentList = this.store.get(this.rpkiRouterKeyFileKey) || [];
                if (currentList.some(item => item.ski === rk.ski && item.asn === rk.asn)) {
                    return errorResponse('RouterKey已存在');
                }
                currentList.push(rk);
                this.store.set(this.rpkiRouterKeyFileKey, currentList);

                const worker = this.worker;
                if (worker && this.rpkiReady) {
                    try {
                        await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.ADD_ROUTER_KEY, rk);
                    } catch (workerError) {
                        await this.handleRouterKeySyncFailure(workerError, worker);
                    }
                }
                return successResponse(null, 'RouterKey保存成功');
            });
        } catch (error) {
            logger.error('Error adding RouterKey:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteRouterKey(event, rk) {
        try {
            return await this.runRouterKeyMutation(async () => {
                if (this.worker && !this.rpkiReady) {
                    return errorResponse('RPKI正在启动或停止，请稍后重试');
                }

                const currentList = this.store.get(this.rpkiRouterKeyFileKey) || [];
                const index = currentList.findIndex(item => item.ski === rk.ski && item.asn === rk.asn);
                if (index !== -1) currentList.splice(index, 1);
                this.store.set(this.rpkiRouterKeyFileKey, currentList);

                const worker = this.worker;
                if (worker && this.rpkiReady && index !== -1) {
                    try {
                        await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.DELETE_ROUTER_KEY, rk);
                    } catch (workerError) {
                        await this.handleRouterKeySyncFailure(workerError, worker);
                    }
                }
                return successResponse(null, 'RouterKey删除成功');
            });
        } catch (error) {
            logger.error('Error deleting RouterKey:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleRouterKeySyncFailure(error, worker) {
        if (this.worker === worker) {
            this.rpkiReady = false;
        }
        this.rpkiTerminateOnlyWorker = worker;
        const terminateError = await this.terminateRpkiWorker(worker);
        if (terminateError && this.worker === worker) this.rpkiStopping = false;
        const terminationDetails = terminateError
            ? `；RPKI进程终止失败，已保留进程句柄以便重试: ${terminateError.message}`
            : '';
        const message = `RouterKey已保存，但运行中的RPKI服务同步失败并已停止: ${error.message}${terminationDetails}`;
        logger.error(message);
        throw new Error(message);
    }

    async handleGetRouterKeyList() {
        try {
            return successResponse(this.store.get(this.rpkiRouterKeyFileKey) || [], 'RouterKey列表加载成功');
        } catch (error) {
            logger.error('Error getting RouterKey list:', error.message);
            return errorResponse(error.message);
        }
    }

    normalizeStoredAspa(aspa) {
        return normalizeAspaObject({
            ...aspa,
            providerAsns: RpkiAspa.parseProviderAsns(aspa?.providerAsns)
        });
    }

    async handleAddAspa(event, aspa) {
        try {
            const normalizedAspa = this.normalizeStoredAspa(aspa);
            if (!normalizedAspa) {
                return errorResponse('ASPA配置无效');
            }
            const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.ADD_ASPA, normalizedAspa);
            return successResponse(result.data, result.msg || 'ASPA保存成功');
        } catch (error) {
            logger.error('Error adding ASPA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAspa(event, aspa) {
        try {
            const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.DELETE_ASPA, aspa);
            return successResponse(result.data, result.msg || 'ASPA删除成功');
        } catch (error) {
            logger.error('Error deleting ASPA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAllAspa() {
        try {
            const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.DELETE_ALL_ASPA);
            return successResponse(result.data, result.msg || 'ASPA批量删除成功');
        } catch (error) {
            logger.error('Error deleting all ASPA:', error.message);
            return errorResponse(error.message);
        }
    }

    async showAspaJsonOpenDialog(event) {
        const options = {
            title: '导入 ASPA JSON 文件',
            properties: ['openFile'],
            filters: [
                { name: 'JSON', extensions: ['json'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        };
        const win = BrowserWindow.fromWebContents(event?.sender) || BrowserWindow.getFocusedWindow();
        return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    }

    async handleSelectAspaJsonFile(event) {
        const runtimeError = this.getRuntimeError();
        if (runtimeError) return errorResponse(runtimeError);
        try {
            const result = await this.showAspaJsonOpenDialog(event);
            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse(null, '已取消选择');
            }
            return successResponse(result.filePaths[0], 'ASPA JSON文件选择成功');
        } catch (error) {
            logger.error('Error selecting ASPA JSON:', error.message);
            return errorResponse(error.message);
        }
    }

    normalizeAspaImportLimit(limit) {
        const value = Number(limit);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    }

    async handleImportAspaJson(event, importOptions = {}) {
        const runtimeError = this.getRuntimeError();
        if (runtimeError) return errorResponse(runtimeError);
        try {
            let importFilePath = importOptions?.filePath;
            if (!importFilePath) {
                const result = await this.showAspaJsonOpenDialog(event);
                if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                    return successResponse({ cancelled: true }, '已取消导入');
                }
                importFilePath = result.filePaths[0];
            }
            const workerStats = await this.importAspaJsonFile(importFilePath, {
                limit: this.normalizeAspaImportLimit(importOptions?.limit)
            });
            const { importWorkerThreadId: _importWorkerThreadId, ...stats } = workerStats || {};
            return successResponse(stats, 'ASPA JSON导入完成');
        } catch (error) {
            logger.error('Error importing ASPA JSON:', error.message);
            return errorResponse(error.message);
        }
    }

    async importAspaJsonFile(importFilePath, options = {}) {
        const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.IMPORT_ASPA_JSON, {
            filePath: importFilePath,
            limit: this.normalizeAspaImportLimit(options.limit)
        });
        logger.info(`ASPA JSON导入完成: ${JSON.stringify(result.data)}`);
        return result.data || {};
    }

    async handleGetAspaList(event, options = null) {
        try {
            const result = await this.requestRpki(RpkiConst.RPKI_REQ_TYPES.GET_ASPA_LIST, options);
            const data =
                (!options || typeof options !== 'object') &&
                !Array.isArray(result.data) &&
                Array.isArray(result.data?.items)
                    ? result.data.items
                    : result.data;
            return successResponse(data, result.msg || 'ASPA列表加载成功');
        } catch (error) {
            logger.error('Error getting ASPA list:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetClientList() {
        if (!this.worker || !this.rpkiReady || this.rpkiStopping) {
            return successResponse([], 'RPKI未启动');
        }
        try {
            const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.GET_CLIENT_LIST, null);
            return successResponse(result.data, '获取客户端列表成功');
        } catch (error) {
            logger.error('Error getting client list:', error.message);
            return errorResponse(error.message);
        }
    }

    getRpkiRunning() {
        return this.worker !== null || this.rpkiStarting;
    }

    cancelPendingStart() {
        if (!this.rpkiStarting && !this.rpkiStartPromise) return false;
        this.rpkiStopping = true;
        this.rpkiReady = false;
        this.rpkiStartGeneration += 1;
        return true;
    }
}

module.exports = RpkiApp;
module.exports.PACKAGED_RENDERER_PATH = PACKAGED_RENDERER_PATH;
module.exports.isTrustedRpkiRendererUrl = isTrustedRpkiRendererUrl;
