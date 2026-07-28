const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const WorkerWithPromise = require('../worker/core/workerWithPromise');
const RpkiConst = require('../const/rpkiConst');
const RpkiAspa = require('../worker/rpki/rpkiAspa');
const RpkiSqliteStore = require('../worker/rpki/rpkiSqliteStore');
const EventDispatcher = require('../utils/eventDispatcher');
const { normalizeRoaObject, parseRoaJsonFile } = require('../utils/rpkiRoaImport');
const { normalizeAspaObject, parseAspaJsonFile } = require('../utils/rpkiAspaImport');

const STORAGE_BATCH_SIZE = 5000;

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

class RpkiApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.rpkiConfigFileKey = 'rpki-config';
        this.rpkiRouterKeyFileKey = 'rpki-router-key';
        this.worker = null;
        this.eventDispatcher = null;
        this.logLevel = null;
        this.rpkiClientConnectionHandler = null;
        this.rpkiSqliteStore = null;
        this.rpkiStoragePromise = null;
        this.storageMutationQueue = Promise.resolve();
        this.storageClosing = false;
        this.storageClosePromise = null;

        this.registerHandlers();
    }

    registerHandlers() {
        this.ipcMain.handle('rpki:saveRpkiConfig', this.handleSaveRpkiConfig.bind(this));
        this.ipcMain.handle('rpki:loadRpkiConfig', this.handleLoadRpkiConfig.bind(this));
        this.ipcMain.handle('rpki:startRpki', this.handleStartRpki.bind(this));
        this.ipcMain.handle('rpki:stopRpki', this.handleStopRpki.bind(this));
        this.ipcMain.handle('rpki:getClientList', this.handleGetClientList.bind(this));

        this.ipcMain.handle('rpki:addRoa', this.handleAddRoa.bind(this));
        this.ipcMain.handle('rpki:deleteRoa', this.handleDeleteRoa.bind(this));
        this.ipcMain.handle('rpki:deleteAllRoa', this.handleDeleteAllRoa.bind(this));
        this.ipcMain.handle('rpki:getRoaList', this.handleGetRoaList.bind(this));
        this.ipcMain.handle('rpki:selectRoaJsonFile', this.handleSelectRoaJsonFile.bind(this));
        this.ipcMain.handle('rpki:importRoaJson', this.handleImportRoaJson.bind(this));

        this.ipcMain.handle('rpki:addRouterKey', this.handleAddRouterKey.bind(this));
        this.ipcMain.handle('rpki:deleteRouterKey', this.handleDeleteRouterKey.bind(this));
        this.ipcMain.handle('rpki:getRouterKeyList', this.handleGetRouterKeyList.bind(this));

        this.ipcMain.handle('rpki:addAspa', this.handleAddAspa.bind(this));
        this.ipcMain.handle('rpki:deleteAspa', this.handleDeleteAspa.bind(this));
        this.ipcMain.handle('rpki:deleteAllAspa', this.handleDeleteAllAspa.bind(this));
        this.ipcMain.handle('rpki:selectAspaJsonFile', this.handleSelectAspaJsonFile.bind(this));
        this.ipcMain.handle('rpki:importAspaJson', this.handleImportAspaJson.bind(this));
        this.ipcMain.handle('rpki:getAspaList', this.handleGetAspaList.bind(this));
    }

    async handleSaveRpkiConfig(event, config) {
        try {
            this.store.set(this.rpkiConfigFileKey, config);
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
            return successResponse(config, 'RPKI配置文件加载成功');
        } catch (error) {
            logger.error('Error loading RPKI config:', error.message);
            return errorResponse(error.message);
        }
    }

    getRpkiDatabasePath() {
        return path.join(app.getPath('userData'), 'rpki', 'rpki.sqlite3');
    }

    async ensureRpkiStorage() {
        if (this.storageClosing) {
            throw new Error('RPKI SQLite存储正在关闭');
        }
        if (this.rpkiSqliteStore) {
            return this.rpkiSqliteStore;
        }
        if (this.rpkiStoragePromise) {
            return this.rpkiStoragePromise;
        }

        this.rpkiStoragePromise = this.initializeRpkiStorage();
        try {
            return await this.rpkiStoragePromise;
        } catch (error) {
            this.rpkiStoragePromise = null;
            throw error;
        }
    }

    async initializeRpkiStorage() {
        const sqliteStore = new RpkiSqliteStore({ dbPath: this.getRpkiDatabasePath() }).open();
        this.rpkiSqliteStore = sqliteStore;
        return sqliteStore;
    }

    runStorageMutation(task) {
        if (this.storageClosing) {
            return Promise.reject(new Error('RPKI SQLite存储正在关闭'));
        }
        const pending = this.storageMutationQueue.then(task, task);
        this.storageMutationQueue = pending.catch(() => {});
        return pending;
    }

    async notifyDatasetChanged(cacheSerial, operations = [], invalidate = false) {
        const worker = this.worker;
        if (!worker) {
            return;
        }
        try {
            const result = await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.DATASET_CHANGED, {
                cacheSerial,
                operations,
                invalidate
            });
            if (result.status !== 'success') {
                throw new Error(result.msg || 'worker拒绝了数据版本更新');
            }
        } catch (error) {
            await this.handleWorkerSyncFailure(error, worker);
        }
    }

    async handleWorkerSyncFailure(error, worker = this.worker) {
        if (this.worker === worker) {
            this.worker = null;
        }
        if (worker) {
            try {
                worker.removeEventListener?.(
                    RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION,
                    this.rpkiClientConnectionHandler
                );
                await worker.terminate?.();
            } catch (terminateError) {
                logger.warn(`停止失步的RPKI worker失败: ${terminateError.message}`);
            }
        }
        this.eventDispatcher?.cleanup();
        this.eventDispatcher = null;
        const message = `数据已写入SQLite，但运行中的RPKI服务同步失败并已停止: ${error.message}`;
        logger.error(message);
        throw new Error(message);
    }

    async handleStartRpki(event, config) {
        const webContents = event.sender;
        let worker = null;
        try {
            if (this.worker) {
                logger.error('rpki协议已经启动');
                return errorResponse('rpki协议已经启动');
            }

            const sqliteStore = await this.ensureRpkiStorage();
            const rpkiConfigData = {
                ...config,
                rpkiDatabasePath: sqliteStore.dbPath,
                initialRouterKeys: this.store.get(this.rpkiRouterKeyFileKey) || []
            };
            if (this.logLevel) {
                rpkiConfigData.logLevel = this.logLevel;
            }
            logger.info(`${JSON.stringify({ ...rpkiConfigData, initialRouterKeys: undefined })}`);
            const workerPath = resolveWorkerPath('rpki/rpkiWorker.js');
            worker = new WorkerWithPromise(workerPath).createLongRunningWorker();
            this.worker = worker;
            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);
            this.rpkiClientConnectionHandler = data => {
                this.eventDispatcher.emit('rpki:clientConnection', successResponse(data));
            };
            worker.addEventListener(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, this.rpkiClientConnectionHandler);

            const result = await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.START_RPKI, rpkiConfigData);
            logger.info(`rpki启动成功 result: ${JSON.stringify(result)}`);
            return successResponse(null, result.msg);
        } catch (error) {
            if (worker) {
                worker.removeEventListener(
                    RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION,
                    this.rpkiClientConnectionHandler
                );
                await worker.terminate();
                if (this.worker === worker) {
                    this.worker = null;
                }
            }
            this.eventDispatcher?.cleanup();
            this.eventDispatcher = null;
            logger.error('Error starting RPKI:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleStopRpki() {
        const worker = this.worker;
        if (!worker) {
            logger.error('RPKI未启动');
            return errorResponse('RPKI未启动');
        }

        try {
            const result = await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.STOP_RPKI, null);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('Error stopping RPKI:', error.message);
            return errorResponse(error.message);
        } finally {
            worker.removeEventListener(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, this.rpkiClientConnectionHandler);
            await worker.terminate();
            if (this.worker === worker) {
                this.worker = null;
                this.eventDispatcher?.cleanup();
                this.eventDispatcher = null;
            }
        }
    }

    async handleAddRoa(event, roa) {
        try {
            const normalizedRoa = normalizeRoaObject(roa);
            if (!normalizedRoa) {
                return errorResponse('RPKI ROA配置格式无效');
            }

            return await this.runStorageMutation(async () => {
                const sqliteStore = await this.ensureRpkiStorage();
                const result = sqliteStore.addRoa(normalizedRoa);
                if (!(result.inserted || result.added)) {
                    return errorResponse('RPKI ROA配置已经存在');
                }
                await this.notifyDatasetChanged(result.cacheSerial, [
                    { type: 'roa', action: 'announce', data: result.current || result.roa || normalizedRoa }
                ]);
                return successResponse(null, 'RPKI ROA配置保存成功');
            });
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

            return await this.runStorageMutation(async () => {
                const sqliteStore = await this.ensureRpkiStorage();
                const result = sqliteStore.deleteRoa(normalizedRoa);
                if (!result.deleted) {
                    return errorResponse('RPKI ROA配置不存在');
                }
                await this.notifyDatasetChanged(result.cacheSerial, [
                    {
                        type: 'roa',
                        action: 'withdraw',
                        data: result.previous || result.deletedItem || result.roa || normalizedRoa
                    }
                ]);
                return successResponse(null, 'RPKI ROA配置删除成功');
            });
        } catch (error) {
            logger.error('Error deleting ROA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAllRoa() {
        try {
            return await this.runStorageMutation(async () => {
                const sqliteStore = await this.ensureRpkiStorage();
                const result = sqliteStore.clearRoas();
                if (result.deleted > 0) {
                    await this.notifyDatasetChanged(result.cacheSerial, [], true);
                }
                return successResponse({ deleted: result.deleted }, 'RPKI ROA批量删除成功');
            });
        } catch (error) {
            logger.error('Error deleting all ROA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetRoaList(event, options = null) {
        try {
            const sqliteStore = await this.ensureRpkiStorage();
            const queryOptions = options && typeof options === 'object' ? options : { page: 1, pageSize: 1000 };
            const result = sqliteStore.queryRoaPage(queryOptions);
            if (!options || typeof options !== 'object') {
                return successResponse(result.items, 'RPKI ROA配置加载成功');
            }
            return successResponse(result, 'RPKI ROA配置加载成功');
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
        const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
        return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    }

    async handleSelectRoaJsonFile(event) {
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
        try {
            let importFilePath = importOptions?.filePath;
            if (!importFilePath) {
                const result = await this.showRoaJsonOpenDialog(event);
                if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                    return successResponse({ cancelled: true }, '已取消导入');
                }
                importFilePath = result.filePaths[0];
            }
            const stats = await this.importRoaJsonFile(importFilePath, {
                limit: this.normalizeRoaImportLimit(importOptions?.limit)
            });
            return successResponse(stats, 'ROA JSON导入完成');
        } catch (error) {
            logger.error('Error importing ROA JSON:', error.message);
            return errorResponse(error.message);
        }
    }

    importRoaJsonFile(importFilePath, options = {}) {
        return this.runStorageMutation(async () => {
            const sqliteStore = await this.ensureRpkiStorage();
            const importLimit = this.normalizeRoaImportLimit(options.limit);
            const stats = {
                filePath: importFilePath,
                limit: importLimit,
                existing: sqliteStore.getRoaCount(),
                parsed: 0,
                imported: 0,
                duplicate: 0,
                invalid: 0,
                total: 0
            };
            let batch = [];
            let candidates = 0;

            sqliteStore.beginRoaImport();

            const flush = async () => {
                if (batch.length === 0) {
                    return;
                }
                const result = sqliteStore.stageRoaBatch(batch, { countCandidates: Boolean(importLimit) });
                if (result.candidates !== null) {
                    candidates = result.candidates;
                }
                stats.duplicate += result.skipped || 0;
                batch = [];
                await yieldToEventLoop();
            };

            try {
                const parseStats = await parseRoaJsonFile(importFilePath, async roa => {
                    batch.push(roa);
                    if (batch.length >= STORAGE_BATCH_SIZE) {
                        await flush();
                    }
                    if (importLimit && candidates >= importLimit) {
                        return false;
                    }
                    return undefined;
                });
                await flush();
                const result = sqliteStore.commitRoaImport({ maxInserted: importLimit });
                stats.parsed = parseStats.valid;
                stats.invalid = parseStats.invalid;
                stats.imported = result.inserted || result.added || 0;
                stats.duplicate += Math.max(0, result.staged - result.candidates);
                stats.ignoredByLimit = result.ignoredByLimit || 0;
                stats.total = result.total;
                if (stats.imported > 0) {
                    await this.notifyDatasetChanged(result.cacheSerial, [], true);
                }
                logger.info(`ROA JSON导入完成: ${JSON.stringify(stats)}`);
                return stats;
            } catch (error) {
                sqliteStore.abortRoaImport();
                throw error;
            }
        });
    }

    async handleAddRouterKey(event, rk) {
        try {
            return await this.runStorageMutation(async () => {
                const currentList = this.store.get(this.rpkiRouterKeyFileKey) || [];
                if (currentList.some(item => item.ski === rk.ski && item.asn === rk.asn)) {
                    return errorResponse('RouterKey已存在');
                }
                currentList.push(rk);
                this.store.set(this.rpkiRouterKeyFileKey, currentList);
                const worker = this.worker;
                if (worker) {
                    try {
                        const result = await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.ADD_ROUTER_KEY, rk);
                        if (result.status !== 'success') {
                            throw new Error(result.msg || 'worker拒绝RouterKey更新');
                        }
                    } catch (workerError) {
                        await this.handleWorkerSyncFailure(workerError, worker);
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
            return await this.runStorageMutation(async () => {
                const currentList = this.store.get(this.rpkiRouterKeyFileKey) || [];
                const index = currentList.findIndex(item => item.ski === rk.ski && item.asn === rk.asn);
                if (index !== -1) {
                    currentList.splice(index, 1);
                }
                this.store.set(this.rpkiRouterKeyFileKey, currentList);
                const worker = this.worker;
                if (worker && index !== -1) {
                    try {
                        const result = await worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.DELETE_ROUTER_KEY, rk);
                        if (result.status !== 'success') {
                            throw new Error(result.msg || 'worker拒绝RouterKey删除');
                        }
                    } catch (workerError) {
                        await this.handleWorkerSyncFailure(workerError, worker);
                    }
                }
                return successResponse(null, 'RouterKey删除成功');
            });
        } catch (error) {
            logger.error('Error deleting RouterKey:', error.message);
            return errorResponse(error.message);
        }
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
            const storedAspa = this.normalizeStoredAspa(aspa);
            if (!storedAspa) {
                return errorResponse('ASPA配置无效');
            }

            return await this.runStorageMutation(async () => {
                const sqliteStore = await this.ensureRpkiStorage();
                const result = sqliteStore.upsertAspa(storedAspa);
                const previous = result.previous || result.oldAspa || null;
                const current = result.current || result.newAspa || result.aspa || storedAspa;
                if (!result.changed) {
                    return successResponse(null, 'ASPA配置未变化');
                }
                const operation = previous
                    ? { type: 'aspa', action: 'replace', oldData: previous, newData: current }
                    : { type: 'aspa', action: 'announce', data: current };
                await this.notifyDatasetChanged(result.cacheSerial, [operation]);
                return successResponse(null, previous ? 'ASPA覆盖成功' : 'ASPA保存成功');
            });
        } catch (error) {
            logger.error('Error adding ASPA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAspa(event, aspa) {
        try {
            return await this.runStorageMutation(async () => {
                const sqliteStore = await this.ensureRpkiStorage();
                const result = sqliteStore.deleteAspa(aspa?.customerAsn);
                if (!result.deleted) {
                    return errorResponse('ASPA不存在');
                }
                await this.notifyDatasetChanged(result.cacheSerial, [
                    {
                        type: 'aspa',
                        action: 'withdraw',
                        data: result.previous || result.deletedItem || result.oldAspa || result.aspa
                    }
                ]);
                return successResponse({ deleted: result.deleted }, 'ASPA删除成功');
            });
        } catch (error) {
            logger.error('Error deleting ASPA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAllAspa() {
        try {
            return await this.runStorageMutation(async () => {
                const sqliteStore = await this.ensureRpkiStorage();
                const result = sqliteStore.clearAspas();
                if (result.deleted > 0) {
                    await this.notifyDatasetChanged(result.cacheSerial, [], true);
                }
                return successResponse({ deleted: result.deleted }, 'ASPA批量删除成功');
            });
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
        const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
        return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    }

    async handleSelectAspaJsonFile(event) {
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
        try {
            let importFilePath = importOptions?.filePath;
            if (!importFilePath) {
                const result = await this.showAspaJsonOpenDialog(event);
                if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                    return successResponse({ cancelled: true }, '已取消导入');
                }
                importFilePath = result.filePaths[0];
            }
            const stats = await this.importAspaJsonFile(importFilePath, {
                limit: this.normalizeAspaImportLimit(importOptions?.limit)
            });
            return successResponse(stats, 'ASPA JSON导入完成');
        } catch (error) {
            logger.error('Error importing ASPA JSON:', error.message);
            return errorResponse(error.message);
        }
    }

    importAspaJsonFile(importFilePath, options = {}) {
        return this.runStorageMutation(async () => {
            const sqliteStore = await this.ensureRpkiStorage();
            const importLimit = this.normalizeAspaImportLimit(options.limit);
            const stats = {
                filePath: importFilePath,
                limit: importLimit,
                existing: sqliteStore.getAspaCount(),
                parsed: 0,
                imported: 0,
                overwritten: 0,
                invalid: 0,
                total: 0
            };
            let batch = [];
            let parsedCount = 0;

            sqliteStore.beginAspaImport();

            const flush = async () => {
                if (batch.length === 0) {
                    return;
                }
                sqliteStore.stageAspaBatch(batch);
                batch = [];
                await yieldToEventLoop();
            };

            try {
                const parseStats = await parseAspaJsonFile(importFilePath, async aspa => {
                    batch.push(aspa);
                    parsedCount += 1;
                    if (batch.length >= STORAGE_BATCH_SIZE || (importLimit && parsedCount >= importLimit)) {
                        await flush();
                    }
                    if (importLimit && parsedCount >= importLimit) {
                        return false;
                    }
                    return undefined;
                });
                await flush();
                const result = sqliteStore.commitAspaImport();
                stats.parsed = parseStats.valid;
                stats.invalid = parseStats.invalid;
                stats.imported = result.inserted || result.added || 0;
                stats.overwritten = result.overwritten || 0;
                stats.unchanged = result.skipped || 0;
                stats.total = result.total;
                if (result.changed > 0) {
                    await this.notifyDatasetChanged(result.cacheSerial, [], true);
                }
                logger.info(`ASPA JSON导入完成: ${JSON.stringify(stats)}`);
                return stats;
            } catch (error) {
                sqliteStore.abortAspaImport();
                throw error;
            }
        });
    }

    async handleGetAspaList(event, options = null) {
        try {
            const sqliteStore = await this.ensureRpkiStorage();
            const queryOptions = options && typeof options === 'object' ? options : { page: 1, pageSize: 1000 };
            const result = sqliteStore.queryAspaPage(queryOptions);
            if (!options || typeof options !== 'object') {
                return successResponse(result.items, 'ASPA列表加载成功');
            }
            return successResponse(result, 'ASPA列表加载成功');
        } catch (error) {
            logger.error('Error getting ASPA list:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetClientList() {
        if (!this.worker) {
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

    closeStorage() {
        if (this.storageClosePromise) {
            return this.storageClosePromise;
        }
        this.storageClosing = true;
        this.storageClosePromise = (async () => {
            try {
                try {
                    await this.storageMutationQueue;
                } catch (error) {
                    logger.warn(`等待RPKI SQLite写入队列失败: ${error.message}`);
                }

                if (this.rpkiStoragePromise) {
                    try {
                        await this.rpkiStoragePromise;
                    } catch (_) {
                        // Initialization already reports the original error to its caller.
                    }
                }

                const sqliteStore = this.rpkiSqliteStore;
                this.rpkiSqliteStore = null;
                this.rpkiStoragePromise = null;
                sqliteStore?.close();
            } finally {
                this.storageClosing = false;
                this.storageClosePromise = null;
            }
        })();
        return this.storageClosePromise;
    }

    getRpkiRunning() {
        return this.worker !== null;
    }
}

module.exports = RpkiApp;
