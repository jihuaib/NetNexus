const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const ProtocolProcessWithPromise = require('../worker/core/protocolProcessWithPromise');
const { PROTOCOL_PROCESS_SERVICES, PROTOCOL_PROCESS_TIMEOUTS } = require('../worker/core/protocolProcessServices');
const SnmpConst = require('../const/snmpConst');
const EventDispatcher = require('../utils/eventDispatcher');

const MAX_MIB_SOURCE_PREVIEW_BYTES = 16 * 1024 * 1024;
const SNMP_RUNTIME_CHANGED_EVENT = 'snmp:runtimeChanged';
const MIB_COMPILE_PROGRESS_EVENT = 'snmp:mibCompileProgress';

function generateMessageId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

class SnmpApp {
    constructor(ipcMain, store, options = {}) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.snmpConfigFileKey = 'snmp-config';
        this.snmpMibFilesKey = 'snmp-mib-files';
        this.worker = null;
        this.snmpReady = false;
        this.snmpStarting = false;
        this.snmpStopping = false;
        this.snmpTrapRunning = false;
        this.snmpStartGeneration = 0;
        this.snmpStartPromise = null;
        this.snmpStopPromise = null;
        this.snmpTerminateOnlyWorker = null;
        this.snmpRuntimeStateSignature = '';
        this.snmpTrapEventHandler = null;
        this.snmpRuntimeEventHandler = null;
        this.snmpMibProgressEventHandler = null;
        this.mibProgressTargets = new Map();
        this.eventDispatcher = null;
        this.logLevel = null;
        this.closeMonitorWindowsHandler =
            typeof options.closeMonitorWindows === 'function' ? options.closeMonitorWindows : null;

        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        this.ipcMain.handle('snmp:saveSnmpConfig', this.handleSaveSnmpConfig.bind(this));
        this.ipcMain.handle('snmp:getSnmpConfig', this.handleGetSnmpConfig.bind(this));
        this.ipcMain.handle('snmp:startSnmp', this.handleStartSnmp.bind(this));
        this.ipcMain.handle('snmp:stopSnmp', this.handleStopSnmp.bind(this));
        this.ipcMain.handle('snmp:getSnmpRuntimeState', this.handleGetSnmpRuntimeState.bind(this));
        this.ipcMain.handle('snmp:startSnmpTrap', this.handleStartSnmpTrap.bind(this));
        this.ipcMain.handle('snmp:stopSnmpTrap', this.handleStopSnmpTrap.bind(this));
        this.ipcMain.handle('snmp:getTrapList', this.handleGetTrapList.bind(this));
        this.ipcMain.handle('snmp:clearTrapHistory', this.handleClearTrapHistory.bind(this));
        this.ipcMain.handle('snmp:selectMibFiles', this.handleSelectMibFiles.bind(this));
        this.ipcMain.handle('snmp:selectMibDirectory', this.handleSelectMibDirectory.bind(this));
        this.ipcMain.handle('snmp:compileMibs', this.handleCompileMibs.bind(this));
        this.ipcMain.handle('snmp:getMibStatus', this.handleGetMibStatus.bind(this));
        this.ipcMain.handle('snmp:getMibSource', this.handleGetMibSource.bind(this));
        this.ipcMain.handle('snmp:getMibTreeChildren', this.handleGetMibTreeChildren.bind(this));
        this.ipcMain.handle('snmp:saveMibProject', this.handleSaveMibProject.bind(this));
        this.ipcMain.handle('snmp:listMibProjects', this.handleListMibProjects.bind(this));
        this.ipcMain.handle('snmp:importMibProject', this.handleImportMibProject.bind(this));
        this.ipcMain.handle('snmp:clearMibs', this.handleClearMibs.bind(this));
        this.ipcMain.handle('snmp:translateOid', this.handleTranslateOid.bind(this));
        this.ipcMain.handle('snmp:sendGetRequest', this.handleSendGetRequest.bind(this));
        this.ipcMain.handle('snmp:sendGetNextRequest', this.handleSendGetNextRequest.bind(this));
        this.ipcMain.handle('snmp:sendWalkRequest', this.handleSendWalkRequest.bind(this));
        this.ipcMain.handle('snmp:sendSetRequest', this.handleSendSetRequest.bind(this));
        this.ipcMain.handle('snmp:listOidInstances', this.handleListOidInstances.bind(this));
    }

    normalizeSupportedVersions(versions) {
        const list = Array.isArray(versions) ? versions : [versions].filter(Boolean);
        if (list.includes('v2c')) return ['v2c'];
        if (list.includes('v1')) return ['v1'];
        if (list.includes('v3')) return ['v3'];
        return ['v2c'];
    }

    normalizeSnmpConfig(config = {}) {
        const restConfig = { ...config };
        delete restConfig.targetPort;
        delete restConfig.enableQueryMonitor;
        return {
            ...restConfig,
            supportedVersions: this.normalizeSupportedVersions(restConfig.supportedVersions)
        };
    }

    async handleSaveSnmpConfig(_event, config) {
        try {
            const normalizedConfig = this.normalizeSnmpConfig(config);
            logger.info('SNMP配置已保存');
            this.store.set(this.snmpConfigFileKey, normalizedConfig);
            return successResponse(null, '配置保存成功');
        } catch (error) {
            logger.error('保存SNMP配置失败:', error);
            return errorResponse('配置保存失败: ' + error.message);
        }
    }

    async handleGetSnmpConfig() {
        try {
            const config = this.store.get(this.snmpConfigFileKey);
            if (!config) return successResponse(null, '获取默认配置');
            return successResponse(this.normalizeSnmpConfig(config), '配置获取成功');
        } catch (error) {
            logger.error('获取SNMP配置失败:', error);
            return errorResponse('配置获取失败: ' + error.message);
        }
    }

    getRuntimeStateSnapshot() {
        return {
            running: Boolean(this.worker),
            ready: Boolean(this.worker && this.snmpReady && !this.snmpStopping),
            trapRunning: Boolean(this.worker && this.snmpReady && !this.snmpStopping && this.snmpTrapRunning)
        };
    }

    emitRuntimeChanged(dispatcher = this.eventDispatcher) {
        const state = this.getRuntimeStateSnapshot();
        const signature = JSON.stringify(state);
        if (signature === this.snmpRuntimeStateSignature) return false;
        this.snmpRuntimeStateSignature = signature;
        dispatcher?.emit(SNMP_RUNTIME_CHANGED_EVENT, state);
        return true;
    }

    getRuntimeError() {
        if (!this.worker || !this.snmpReady || this.snmpStopping) {
            return 'SNMP运行时未启动，请先启动SNMP服务';
        }
        return null;
    }

    async requestSnmp(op, data = null, options = undefined) {
        const runtimeError = this.getRuntimeError();
        if (runtimeError) throw new Error(runtimeError);
        return this.worker.sendRequest(op, data, options);
    }

    createSnmpProcess(workerPath, options) {
        return new ProtocolProcessWithPromise(workerPath, options).createLongRunningProcess();
    }

    cleanupSnmpRuntime(worker, options = {}) {
        if (this.worker !== worker) return false;
        const dispatcher = this.eventDispatcher;
        worker?.removeEventListener?.(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, this.snmpTrapEventHandler);
        worker?.removeEventListener?.(SnmpConst.SNMP_EVT_TYPES.RUNTIME_EVT, this.snmpRuntimeEventHandler);
        worker?.removeEventListener?.(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, this.snmpMibProgressEventHandler);
        this.worker = null;
        this.snmpReady = false;
        this.snmpStarting = false;
        this.snmpStopping = false;
        this.snmpTrapRunning = false;
        if (this.snmpTerminateOnlyWorker === worker) this.snmpTerminateOnlyWorker = null;
        this.emitRuntimeChanged(dispatcher);
        dispatcher?.cleanup();
        if (this.eventDispatcher === dispatcher) this.eventDispatcher = null;
        this.snmpTrapEventHandler = null;
        this.snmpRuntimeEventHandler = null;
        this.snmpMibProgressEventHandler = null;
        this.mibProgressTargets.clear();
        if (options.closeMonitorWindows !== false) this.closeMonitorWindows();
        return true;
    }

    async terminateSnmpWorker(worker) {
        try {
            await worker.terminate();
        } catch (error) {
            if (this.worker === worker) {
                this.snmpReady = false;
                this.snmpTrapRunning = false;
                this.emitRuntimeChanged();
            }
            return error;
        }
        this.cleanupSnmpRuntime(worker, { closeMonitorWindows: false });
        return null;
    }

    trackLifecycleOperation(propertyName, operation) {
        let resolveTracked;
        let rejectTracked;
        const tracked = new Promise((resolve, reject) => {
            resolveTracked = resolve;
            rejectTracked = reject;
        });
        this[propertyName] = tracked;
        let result;
        try {
            result = operation();
        } catch (error) {
            result = Promise.reject(error);
        }
        Promise.resolve(result).then(
            value => {
                if (this[propertyName] === tracked) this[propertyName] = null;
                resolveTracked(value);
            },
            error => {
                if (this[propertyName] === tracked) this[propertyName] = null;
                rejectTracked(error);
            }
        );
        return tracked;
    }

    cancelPendingStart() {
        if (!this.snmpStarting && !this.snmpStartPromise) return false;
        this.snmpStartGeneration++;
        this.snmpStopping = true;
        this.snmpReady = false;
        this.snmpTrapRunning = false;
        this.emitRuntimeChanged();
        return true;
    }

    handleStartSnmp(event, config = {}) {
        if (this.snmpStartPromise) return this.snmpStartPromise;
        if (this.snmpStopPromise || this.snmpStopping) {
            return Promise.resolve(errorResponse('SNMP运行时正在停止，请稍后重试'));
        }
        if (this.worker) return Promise.resolve(errorResponse('SNMP运行时已经启动或进程仍在回收'));
        return this.trackLifecycleOperation('snmpStartPromise', () => this.startSnmpOperation(event, config));
    }

    async startSnmpOperation(event, config) {
        const webContents = event?.sender || null;
        const generation = ++this.snmpStartGeneration;
        let worker = null;
        let startSucceeded = false;
        this.snmpStarting = true;
        this.snmpStopping = false;
        this.snmpReady = false;
        this.snmpTrapRunning = false;
        this.snmpRuntimeStateSignature = '';
        try {
            const runtimeConfig = this.normalizeSnmpConfig(config);
            if (this.logLevel) runtimeConfig.logLevel = this.logLevel;
            runtimeConfig.mibFiles = this.getStoredMibFilePaths();
            runtimeConfig.mibCacheFilePath = this.getMibCacheFilePath();
            runtimeConfig.mibProjectRootDir = this.getMibProjectRootDir();
            const workerPath = resolveWorkerPath('snmp/snmpWorker.js');
            worker = this.createSnmpProcess(workerPath, {
                serviceName: PROTOCOL_PROCESS_SERVICES.SNMP,
                onExit: (_code, client, exit = {}) =>
                    this.cleanupSnmpRuntime(client, { closeMonitorWindows: !exit.expected })
            });
            this.worker = worker;
            this.eventDispatcher = new EventDispatcher();
            if (webContents) this.eventDispatcher.setWebContents(webContents);
            this.snmpTrapEventHandler = data => {
                if (this.worker === worker) this.handleSnmpWorkerEvent(data);
            };
            this.snmpRuntimeEventHandler = state => {
                if (this.worker !== worker || !state) return;
                this.snmpTrapRunning = Boolean(state.trapRunning);
                this.emitRuntimeChanged();
            };
            this.snmpMibProgressEventHandler = payload => {
                if (this.worker === worker) this.handleMibCompileProgress(payload);
            };
            worker.addEventListener(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, this.snmpTrapEventHandler);
            worker.addEventListener(SnmpConst.SNMP_EVT_TYPES.RUNTIME_EVT, this.snmpRuntimeEventHandler);
            worker.addEventListener(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, this.snmpMibProgressEventHandler);
            const result = await worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.START_SNMP, runtimeConfig);
            startSucceeded = true;
            if (generation !== this.snmpStartGeneration || this.snmpStopping || this.worker !== worker) {
                throw new Error('SNMP运行时启动已取消');
            }
            this.snmpReady = true;
            this.emitRuntimeChanged();
            return successResponse(this.getRuntimeStateSnapshot(), result.msg || 'SNMP运行时启动成功');
        } catch (error) {
            let finalError = error;
            this.snmpReady = false;
            this.snmpTrapRunning = false;
            this.emitRuntimeChanged();
            if (worker && this.worker === worker) {
                const gracefulStopOwnsWorker = startSucceeded && this.snmpStopping;
                if (!gracefulStopOwnsWorker) {
                    this.snmpTerminateOnlyWorker = worker;
                    if (!this.snmpStopping) {
                        const terminateError = await this.terminateSnmpWorker(worker);
                        if (terminateError) {
                            finalError = new Error(
                                `${error.message}; SNMP进程终止失败，已保留进程句柄以便重试: ${terminateError.message}`
                            );
                        }
                    }
                }
            }
            logger.error('启动SNMP运行时失败:', finalError);
            return errorResponse('启动SNMP运行时失败: ' + finalError.message);
        } finally {
            this.snmpStarting = false;
        }
    }

    handleStopSnmp() {
        if (this.snmpStopPromise) return this.snmpStopPromise;
        if (!this.worker && !this.snmpStarting && !this.snmpStartPromise) {
            return Promise.resolve(errorResponse('SNMP运行时未启动'));
        }
        return this.trackLifecycleOperation('snmpStopPromise', () => this.stopSnmpOperation());
    }

    async stopSnmpOperation() {
        const pendingStart = this.snmpStartPromise;
        const cancelledStart = Boolean(this.snmpStarting || pendingStart);
        this.closeMonitorWindows();
        this.snmpStopping = true;
        this.snmpReady = false;
        this.snmpTrapRunning = false;
        this.snmpStartGeneration++;
        this.emitRuntimeChanged();
        if (pendingStart) await pendingStart.catch(() => {});
        const worker = this.worker;
        if (!worker) {
            this.snmpStopping = false;
            return cancelledStart
                ? successResponse(this.getRuntimeStateSnapshot(), 'SNMP运行时启动已取消')
                : errorResponse('SNMP运行时未启动');
        }

        let stopError = null;
        let stopMessage = cancelledStart ? 'SNMP运行时启动已取消' : 'SNMP运行时停止成功';
        if (this.snmpTerminateOnlyWorker !== worker) {
            try {
                const result = await worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.STOP_SNMP, null, {
                    timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
                });
                stopMessage = result.msg || stopMessage;
            } catch (error) {
                stopError = error;
                logger.error('停止SNMP运行时失败:', error);
            }
        }
        this.snmpTerminateOnlyWorker = worker;
        const terminateError = await this.terminateSnmpWorker(worker);
        if (terminateError) {
            if (this.worker === worker) this.snmpStopping = false;
            const details = [stopError?.message, terminateError.message].filter(Boolean).join('; ');
            return errorResponse(`SNMP进程终止失败，已保留进程句柄以便重试: ${details}`);
        }
        this.snmpStopping = false;
        if (stopError) return errorResponse(stopError.message);
        return successResponse(this.getRuntimeStateSnapshot(), stopMessage);
    }

    handleGetSnmpRuntimeState() {
        return successResponse(this.getRuntimeStateSnapshot(), 'SNMP运行状态获取成功');
    }

    async handleStartSnmpTrap(_event, config = {}) {
        try {
            const result = await this.requestSnmp(SnmpConst.SNMP_REQ_TYPES.START_TRAP, {
                port: config.port,
                maxTrapHistory: config.maxTrapHistory
            });
            this.snmpTrapRunning = Boolean(result.data?.trapRunning);
            this.emitRuntimeChanged();
            return successResponse(this.getRuntimeStateSnapshot(), result.msg || 'SNMP Trap服务启动成功');
        } catch (error) {
            logger.error('启动SNMP Trap服务失败:', error);
            return errorResponse(error.message);
        }
    }

    async handleStopSnmpTrap() {
        this.closeMonitorWindows();
        try {
            const result = await this.requestSnmp(SnmpConst.SNMP_REQ_TYPES.STOP_TRAP);
            this.snmpTrapRunning = false;
            this.emitRuntimeChanged();
            return successResponse(this.getRuntimeStateSnapshot(), result.msg || 'SNMP Trap服务停止成功');
        } catch (error) {
            logger.error('停止SNMP Trap服务失败:', error);
            return errorResponse(error.message);
        }
    }

    closeMonitorWindows() {
        if (!this.closeMonitorWindowsHandler) return;
        try {
            this.closeMonitorWindowsHandler();
        } catch (error) {
            logger.warn(`关闭 SNMP 独立监控窗口失败: ${error.message}`);
        }
    }

    handleSnmpWorkerEvent(data) {
        if (!this.eventDispatcher || !data) return;
        if (data.type === SnmpConst.SNMP_SUB_EVT_TYPES.TRAP_BATCH_RECEIVED) {
            this.eventDispatcher.emitToSubscribers('snmp:event', successResponse(data));
            this.eventDispatcher.emitToPrimary(
                'snmp:event',
                successResponse({
                    type: SnmpConst.SNMP_SUB_EVT_TYPES.STATS_UPDATED,
                    data: data.data || {}
                })
            );
            return;
        }
        if (
            data.type === SnmpConst.SNMP_SUB_EVT_TYPES.TRAP_RECEIVED ||
            data.type === SnmpConst.SNMP_SUB_EVT_TYPES.TRAP_PROCESSED ||
            data.type === SnmpConst.SNMP_SUB_EVT_TYPES.TRAP_ERROR ||
            data.type === SnmpConst.SNMP_SUB_EVT_TYPES.AGENT_CONNECTION ||
            data.type === SnmpConst.SNMP_SUB_EVT_TYPES.AGENT_DISCONNECTION
        ) {
            this.eventDispatcher.emitToSubscribers('snmp:event', successResponse(data));
            return;
        }
        this.eventDispatcher.emit('snmp:event', successResponse(data));
    }

    async handleGetTrapList(_event, query = {}) {
        try {
            const result = await this.requestSnmp(SnmpConst.SNMP_REQ_TYPES.GET_TRAP_LIST, query);
            return successResponse(result.data || [], result.msg || '获取Trap列表成功');
        } catch (error) {
            logger.error('获取Trap列表失败:', error);
            return errorResponse('获取Trap列表失败: ' + error.message);
        }
    }

    async handleClearTrapHistory() {
        try {
            const result = await this.requestSnmp(SnmpConst.SNMP_REQ_TYPES.CLEAR_TRAP_HISTORY);
            return successResponse(null, result.msg || 'Trap历史已清空');
        } catch (error) {
            logger.error('清空Trap历史失败:', error);
            return errorResponse('清空Trap历史失败: ' + error.message);
        }
    }

    showMibOpenDialog(event) {
        const options = {
            title: '导入 MIB 文件',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: '所有支持的 MIB 文件', extensions: ['*'] },
                { name: '常见 MIB 后缀', extensions: ['mib', 'txt', 'my'] }
            ]
        };
        const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
        return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    }

    async handleSelectMibFiles(event) {
        try {
            const result = await this.showMibOpenDialog(event);
            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse([], '已取消选择');
            }
            return successResponse(result.filePaths, 'MIB文件选择成功');
        } catch (error) {
            logger.error('选择MIB文件失败:', error);
            return errorResponse('选择MIB文件失败: ' + error.message);
        }
    }

    async handleSelectMibDirectory(event) {
        try {
            const options = { title: '导入 MIB 目录', properties: ['openDirectory'] };
            const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
            const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse(null, '已取消选择');
            }
            return successResponse(result.filePaths[0], 'MIB目录选择成功');
        } catch (error) {
            logger.error('选择MIB目录失败:', error);
            return errorResponse('选择MIB目录失败: ' + error.message);
        }
    }

    async handleCompileMibs(event, data = []) {
        try {
            const request = Array.isArray(data)
                ? { filePaths: data, force: false }
                : {
                      filePaths: data?.filePaths || data?.requestedFiles || [],
                      force: Boolean(data?.force)
                  };
            const selectedFiles = this.normalizeFilePaths(request.filePaths);
            const requestedFiles = selectedFiles.length > 0 ? selectedFiles : this.getStoredMibFilePaths();
            const result = await this.requestMibWithProgress(event, SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS, {
                filePaths: requestedFiles,
                cacheFilePath: this.getMibCacheFilePath(),
                force: request.force
            });
            this.store.set(this.snmpMibFilesKey, requestedFiles);
            return successResponse(result.data, result.msg || 'MIB编译完成');
        } catch (error) {
            logger.error('MIB编译失败:', error);
            return errorResponse('MIB编译失败: ' + error.message);
        }
    }

    async handleGetMibStatus(event) {
        try {
            const result = await this.requestMibWithProgress(
                event,
                SnmpConst.MIB_REQ_TYPES.GET_MIB_STATUS,
                {
                    requestedFiles: this.getStoredMibFilePaths(),
                    cacheFilePath: this.getMibCacheFilePath()
                },
                { announceImmediately: false }
            );
            return successResponse(result.data, result.msg || '获取MIB状态成功');
        } catch (error) {
            logger.error('获取MIB状态失败:', error);
            return errorResponse('获取MIB状态失败: ' + error.message);
        }
    }

    async handleGetMibSource(_event, request = {}) {
        try {
            const result = await this.requestSnmp(SnmpConst.MIB_REQ_TYPES.GET_MIB_SOURCE, {
                filePath: typeof request === 'string' ? request : request?.filePath,
                requestedFiles: this.getStoredMibFilePaths(),
                maxBytes: MAX_MIB_SOURCE_PREVIEW_BYTES
            });
            return successResponse(result.data, result.msg || '获取MIB源码成功');
        } catch (error) {
            logger.error('获取MIB源码失败:', error);
            return errorResponse('获取MIB源码失败: ' + error.message);
        }
    }

    async handleGetMibTreeChildren(_event, parentOid = '') {
        return this.handleMibRequest(
            SnmpConst.MIB_REQ_TYPES.GET_MIB_TREE_CHILDREN,
            {
                parentOid,
                requestedFiles: this.getStoredMibFilePaths(),
                cacheFilePath: this.getMibCacheFilePath()
            },
            '获取MIB树节点成功',
            '获取MIB树节点失败'
        );
    }

    async handleSaveMibProject(_event, payload = {}) {
        return this.handleMibRequest(
            SnmpConst.MIB_REQ_TYPES.SAVE_MIB_PROJECT,
            {
                name: payload.name,
                requestedFiles: this.getStoredMibFilePaths(),
                cacheFilePath: this.getMibCacheFilePath(),
                projectRootDir: this.getMibProjectRootDir()
            },
            'MIB工程保存成功',
            '保存MIB工程失败'
        );
    }

    async handleListMibProjects() {
        return this.handleMibRequest(
            SnmpConst.MIB_REQ_TYPES.LIST_MIB_PROJECTS,
            { projectRootDir: this.getMibProjectRootDir() },
            'MIB工程列表获取成功',
            '获取MIB工程列表失败'
        );
    }

    async handleImportMibProject(_event, payload = {}) {
        try {
            const result = await this.requestSnmp(SnmpConst.MIB_REQ_TYPES.IMPORT_MIB_PROJECT, {
                name: payload.name || payload.projectName,
                cacheFilePath: this.getMibCacheFilePath(),
                projectRootDir: this.getMibProjectRootDir()
            });
            this.store.set(this.snmpMibFilesKey, this.normalizeFilePaths(result.data?.requestedFiles));
            return successResponse(result.data, result.msg || 'MIB工程导入成功');
        } catch (error) {
            logger.error('导入MIB工程失败:', error);
            return errorResponse('导入MIB工程失败: ' + error.message);
        }
    }

    async handleClearMibs() {
        try {
            const result = await this.requestSnmp(SnmpConst.MIB_REQ_TYPES.CLEAR_MIBS, {
                cacheFilePath: this.getMibCacheFilePath()
            });
            this.store.set(this.snmpMibFilesKey, []);
            return successResponse(result.data, result.msg || 'MIB配置已清空');
        } catch (error) {
            logger.error('清空MIB配置失败:', error);
            return errorResponse('清空MIB配置失败: ' + error.message);
        }
    }

    async handleTranslateOid(_event, oid) {
        return this.handleMibRequest(
            SnmpConst.MIB_REQ_TYPES.TRANSLATE_OID,
            {
                oid,
                requestedFiles: this.getStoredMibFilePaths(),
                cacheFilePath: this.getMibCacheFilePath()
            },
            'OID解析成功',
            'OID解析失败'
        );
    }

    async handleMibRequest(op, data, successMessage, errorMessage) {
        try {
            const result = await this.requestSnmp(op, data);
            return successResponse(result.data, result.msg || successMessage);
        } catch (error) {
            logger.error(`${errorMessage}:`, error);
            return errorResponse(`${errorMessage}: ${error.message}`);
        }
    }

    async handleQueryRequest(op, request, successMessage, errorMessage) {
        try {
            // 查询目标、版本和认证信息已经在 START_SNMP 时固化到 Utility Process；
            // 单次调用只转发 OID、超时、重试等请求参数，主进程不再参与 session 配置。
            const result = await this.requestSnmp(op, request);
            return successResponse(result.data, result.msg || successMessage);
        } catch (error) {
            logger.error(`${errorMessage}:`, error);
            return errorResponse(`${errorMessage}: ${error.message}`);
        }
    }

    handleSendGetRequest(_event, request = {}) {
        return this.handleQueryRequest(
            SnmpConst.SNMP_REQ_TYPES.SEND_GET_REQUEST,
            request,
            'GET查询成功',
            '发送SNMP GET失败'
        );
    }

    handleSendGetNextRequest(_event, request = {}) {
        return this.handleQueryRequest(
            SnmpConst.SNMP_REQ_TYPES.SEND_GET_NEXT_REQUEST,
            request,
            'GET-NEXT查询成功',
            '发送SNMP GET-NEXT失败'
        );
    }

    handleSendWalkRequest(_event, request = {}) {
        return this.handleQueryRequest(
            SnmpConst.SNMP_REQ_TYPES.SEND_WALK_REQUEST,
            request,
            'WALK查询完成',
            '发送SNMP WALK失败'
        );
    }

    handleSendSetRequest(_event, request = {}) {
        return this.handleQueryRequest(
            SnmpConst.SNMP_REQ_TYPES.SEND_SET_REQUEST,
            request,
            'SET发送成功',
            '发送SNMP SET失败'
        );
    }

    handleListOidInstances(_event, request = {}) {
        return this.handleQueryRequest(
            SnmpConst.SNMP_REQ_TYPES.LIST_OID_INSTANCES,
            request,
            '实例枚举完成',
            '枚举SNMP实例失败'
        );
    }

    getMibProjectRootDir() {
        return path.join(app.getPath('userData'), 'snmp-mib-projects');
    }

    getStoredMibFilePaths() {
        return this.normalizeFilePaths(this.store.get(this.snmpMibFilesKey));
    }

    getMibCacheFilePath() {
        return path.join(app.getPath('userData'), 'snmp-mib-cache.json');
    }

    normalizeFilePaths(filePaths) {
        if (!Array.isArray(filePaths)) return [];
        const seen = new Set();
        return filePaths
            .filter(filePath => {
                if (typeof filePath !== 'string') return false;
                const trimmed = filePath.trim();
                if (!trimmed || seen.has(trimmed)) return false;
                seen.add(trimmed);
                return true;
            })
            .map(filePath => filePath.trim());
    }

    emitMibCompileProgress(target, progressId, progress = {}) {
        if (!target || typeof target.send !== 'function') return;
        if (typeof target.isDestroyed === 'function' && target.isDestroyed()) return;
        target.send('unified-event', {
            type: MIB_COMPILE_PROGRESS_EVENT,
            data: successResponse({ progressId, ...progress }, 'MIB编译进度')
        });
    }

    handleMibCompileProgress(payload) {
        if (!payload?.progressId) return;
        const progressState = this.mibProgressTargets.get(payload.progressId);
        if (!progressState) return;
        const { progressId, ...progress } = payload;
        progressState.latest = {
            ...progressState.latest,
            ...progress,
            counts: progress.counts || progressState.latest.counts
        };
        if (progress.phase === 'completed') {
            progressState.completed = true;
            if (!progressState.visible) return;
        } else {
            progressState.visible = true;
        }
        this.emitMibCompileProgress(progressState.target, progressId, progressState.latest);
    }

    async requestMibWithProgress(event, op, data = {}, options = {}) {
        const target = event?.sender;
        if (!target || typeof target.send !== 'function') return this.requestSnmp(op, data);
        const progressId = `${target.id || 'renderer'}-${generateMessageId()}`;
        const progressState = {
            target,
            visible: options.announceImmediately !== false,
            completed: false,
            latest: {
                phase: 'preparing',
                completed: 0,
                total: 0,
                percent: 0,
                counts: { compiled: 0, skipped: 0, failed: 0 },
                message: '正在准备 MIB 编译'
            }
        };
        this.mibProgressTargets.set(progressId, progressState);
        if (progressState.visible) this.emitMibCompileProgress(target, progressId, progressState.latest);
        try {
            const result = await this.requestSnmp(op, { ...data, progressId });
            if (progressState.visible && !progressState.completed) {
                const summary = result.data || {};
                const counts = {
                    compiled: Array.isArray(summary.loadedFiles) ? summary.loadedFiles.length : 0,
                    skipped: Array.isArray(summary.skippedFiles) ? summary.skippedFiles.length : 0,
                    failed: Array.isArray(summary.failedFiles) ? summary.failedFiles.length : 0
                };
                const total = Number(summary.expandedFileCount) || counts.compiled + counts.skipped + counts.failed;
                this.emitMibCompileProgress(target, progressId, {
                    ...progressState.latest,
                    phase: 'completed',
                    completed: total,
                    total,
                    percent: 100,
                    counts,
                    cacheHit: Boolean(summary.cacheHit),
                    message: summary.cacheHit ? '已从缓存加载 MIB' : 'MIB 编译完成'
                });
            }
            return result;
        } catch (error) {
            this.emitMibCompileProgress(target, progressId, {
                ...progressState.latest,
                phase: 'failed',
                message: error.message || 'MIB编译失败'
            });
            throw error;
        } finally {
            this.mibProgressTargets.delete(progressId);
        }
    }

    getSnmpRunning() {
        return this.worker !== null;
    }
}

module.exports = SnmpApp;
