const fs = require('fs');
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const WorkerWithPromise = require('../worker/workerWithPromise');
const { getNetworkAddress } = require('../utils/ipUtils');
const RpkiConst = require('../const/rpkiConst');
const RpkiAspa = require('../worker/rpkiAspa');
const EventDispatcher = require('../utils/eventDispatcher');
const {
    getRoaDataFilePath,
    makeRoaStorageKey,
    normalizeRoaObject,
    fileExists,
    ensureParentDir,
    writeLine,
    closeWriteStream,
    renameWithRetry,
    iterateJsonlRoas,
    readJsonlPage,
    countJsonlRows,
    writeRoasToJsonl,
    parseRoaJsonFile
} = require('../utils/rpkiRoaImport');
const {
    getAspaDataFilePath,
    makeAspaStorageKey,
    normalizeAspaObject,
    iterateJsonlAspas,
    readAspaJsonlPage,
    countJsonlAspas,
    writeAspasToJsonl,
    removeAspaFromJsonl,
    parseAspaJsonFile
} = require('../utils/rpkiAspaImport');
const RpkiRoaQueryIndex = require('../utils/rpkiRoaQueryIndex');

class RpkiApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.rpkiConfigFileKey = 'rpki-config';
        this.rpkiRoaFileKey = 'rpki-roa';
        this.rpkiRoaMetaFileKey = 'rpki-roa-meta';
        this.rpkiRouterKeyFileKey = 'rpki-router-key';
        this.rpkiAspaFileKey = 'rpki-aspa';
        this.rpkiAspaMetaFileKey = 'rpki-aspa-meta';
        this.isDev = !app.isPackaged;
        this.worker = null;
        this.eventDispatcher = null; // 添加事件发送器

        this.serverDeploymentConfig = null;

        this.logLevel = null;

        this.rpkiClientConnectionHandler = null;
        this.roaQueryIndex = new RpkiRoaQueryIndex();

        this.registerHandlers();
    }

    registerHandlers() {
        this.ipcMain.handle('rpki:saveRpkiConfig', this.handleSaveRpkiConfig.bind(this));
        this.ipcMain.handle('rpki:loadRpkiConfig', this.handleLoadRpkiConfig.bind(this));
        this.ipcMain.handle('rpki:startRpki', this.handleStartRpki.bind(this));
        this.ipcMain.handle('rpki:stopRpki', this.handleStopRpki.bind(this));
        this.ipcMain.handle('rpki:getClientList', this.handleGetClientList.bind(this));

        // roa
        this.ipcMain.handle('rpki:addRoa', this.handleAddRoa.bind(this));
        this.ipcMain.handle('rpki:deleteRoa', this.handleDeleteRoa.bind(this));
        this.ipcMain.handle('rpki:deleteAllRoa', this.handleDeleteAllRoa.bind(this));
        this.ipcMain.handle('rpki:getRoaList', this.handleGetRoaList.bind(this));
        this.ipcMain.handle('rpki:selectRoaJsonFile', this.handleSelectRoaJsonFile.bind(this));
        this.ipcMain.handle('rpki:importRoaJson', this.handleImportRoaJson.bind(this));

        // router key (v1+)
        this.ipcMain.handle('rpki:addRouterKey', this.handleAddRouterKey.bind(this));
        this.ipcMain.handle('rpki:deleteRouterKey', this.handleDeleteRouterKey.bind(this));
        this.ipcMain.handle('rpki:getRouterKeyList', this.handleGetRouterKeyList.bind(this));

        // aspa (v2+)
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
    setServerDeploymentConfig(config) {
        this.serverDeploymentConfig = config;
    }

    async handleStartRpki(event, rpkiConfigData) {
        const webContents = event.sender;
        try {
            if (null !== this.worker) {
                logger.error(`rpki协议已经启动`);
                return errorResponse('rpki协议已经启动');
            }

            logger.info(`${JSON.stringify(rpkiConfigData)}`);

            // 获取日志级别配置
            if (this.logLevel) {
                rpkiConfigData.logLevel = this.logLevel;
            }

            const workerPath = this.isDev
                ? path.join(__dirname, '../worker/rpkiWorker.js')
                : path.join(process.resourcesPath, 'app', 'electron/worker/rpkiWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            // 设置事件发送器的 webContents
            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            // 注册事件监听
            this.rpkiClientConnectionHandler = data => {
                this.eventDispatcher.emit('rpki:clientConnection', successResponse(data));
            };

            this.worker.addEventListener(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, this.rpkiClientConnectionHandler);

            // 加载 ROA 配置。百万级 ROA 不能逐条 IPC，必须按批次灌入 worker。
            await this.loadRoaStorageToWorker(false);

            // 加载 router key 配置 (v1+)
            const rkList = await this.handleGetRouterKeyList();
            if (rkList.status === 'success') {
                for (const rk of rkList.data) {
                    const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.ADD_ROUTER_KEY, rk);
                    if (result.status !== 'success') {
                        logger.error(`worker RPKI RouterKey恢复失败: ${result.msg}`);
                    }
                }
            }

            // 加载 ASPA 配置。ASPA 也按批次灌入 worker，避免百万级数据逐条 IPC。
            await this.loadAspaStorageToWorker(false);

            if (rpkiConfigData.enableAuth) {
                // 设置 SSH 部署配置
                rpkiConfigData.serverAddress = this.serverDeploymentConfig.serverAddress;
                rpkiConfigData.sshUsername = this.serverDeploymentConfig.sshUsername;
                rpkiConfigData.sshPassword = this.serverDeploymentConfig.sshPassword;
            }

            const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.START_RPKI, rpkiConfigData);

            // 这里肯定是启动成功了，如果失败，会抛出异常
            logger.info(`rpki启动成功 result: ${JSON.stringify(result)}`);
            return successResponse(null, result.msg);
        } catch (error) {
            this.worker.removeEventListener(
                RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION,
                this.rpkiClientConnectionHandler
            );
            await this.worker.terminate();
            this.worker = null;
            this.eventDispatcher.cleanup(); // 清理事件发送器
            this.eventDispatcher = null;
            logger.error('Error starting RPKI:', error.message);
            return errorResponse(error.message);
        }
    }

    getRoaDataFilePath() {
        return getRoaDataFilePath(app.getPath('userData'));
    }

    async ensureRoaFileStorage() {
        const filePath = this.getRoaDataFilePath();
        await ensureParentDir(filePath);

        if (await fileExists(filePath)) {
            const meta = this.store.get(this.rpkiRoaMetaFileKey);
            if (!meta || typeof meta.count !== 'number') {
                await this.updateRoaMeta(await countJsonlRows(filePath));
            }
            return filePath;
        }

        const legacyList = this.store.get(this.rpkiRoaFileKey);
        if (Array.isArray(legacyList) && legacyList.length > 0) {
            const count = await writeRoasToJsonl(filePath, legacyList);
            await this.updateRoaMeta(count);
            logger.info(`旧版 RPKI ROA 配置已迁移到 JSONL: ${count}`);
            return filePath;
        }

        await fs.promises.writeFile(filePath, '', 'utf8');
        await this.updateRoaMeta(0);
        return filePath;
    }

    async updateRoaMeta(count) {
        this.store.set(this.rpkiRoaMetaFileKey, {
            storageVersion: 2,
            count,
            updatedAt: new Date().toISOString()
        });
    }

    async getRoaTotalCount(filePath) {
        const meta = this.store.get(this.rpkiRoaMetaFileKey);
        if (meta && typeof meta.count === 'number') {
            return meta.count;
        }

        const count = await countJsonlRows(filePath);
        await this.updateRoaMeta(count);
        return count;
    }

    async loadRoaFileToWorker(filePath, announce = false) {
        if (!this.worker) {
            return { added: 0, skipped: 0 };
        }

        const batchSize = 5000;
        let batch = [];
        let added = 0;
        let skipped = 0;

        const flush = async () => {
            if (batch.length === 0) {
                return;
            }
            const currentBatch = batch;
            batch = [];
            const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.ADD_ROA_BATCH, {
                roas: currentBatch,
                announce
            });
            added += result.data?.added || 0;
            skipped += result.data?.skipped || 0;
        };

        for await (const roa of iterateJsonlRoas(filePath)) {
            batch.push(roa);
            if (batch.length >= batchSize) {
                await flush();
            }
        }
        await flush();

        logger.info(`worker RPKI ROA批量加载完成: added=${added}, skipped=${skipped}, announce=${announce}`);
        return { added, skipped };
    }

    async loadRoaStorageToWorker(announce = false) {
        const filePath = await this.ensureRoaFileStorage();
        return this.loadRoaFileToWorker(filePath, announce);
    }

    getAspaDataFilePath() {
        return getAspaDataFilePath(app.getPath('userData'));
    }

    async ensureAspaFileStorage() {
        const filePath = this.getAspaDataFilePath();
        await ensureParentDir(filePath);

        if (await fileExists(filePath)) {
            const meta = this.store.get(this.rpkiAspaMetaFileKey);
            if (!meta || typeof meta.count !== 'number') {
                await this.updateAspaMeta(await countJsonlAspas(filePath));
            }
            return filePath;
        }

        const legacyList = this.store.get(this.rpkiAspaFileKey);
        if (Array.isArray(legacyList) && legacyList.length > 0) {
            const count = await writeAspasToJsonl(filePath, legacyList);
            await this.updateAspaMeta(count);
            logger.info(`旧版 RPKI ASPA 配置已迁移到 JSONL: ${count}`);
            return filePath;
        }

        await fs.promises.writeFile(filePath, '', 'utf8');
        await this.updateAspaMeta(0);
        return filePath;
    }

    async updateAspaMeta(count) {
        this.store.set(this.rpkiAspaMetaFileKey, {
            storageVersion: 2,
            count,
            updatedAt: new Date().toISOString()
        });
    }

    async getAspaTotalCount(filePath) {
        const meta = this.store.get(this.rpkiAspaMetaFileKey);
        if (meta && typeof meta.count === 'number') {
            return meta.count;
        }

        const count = await countJsonlAspas(filePath);
        await this.updateAspaMeta(count);
        return count;
    }

    async loadAspaFileToWorker(filePath, announce = false) {
        if (!this.worker) {
            return { added: 0, overwritten: 0 };
        }

        const batchSize = 5000;
        let batch = [];
        let added = 0;
        let overwritten = 0;

        const flush = async () => {
            if (batch.length === 0) {
                return;
            }
            const currentBatch = batch;
            batch = [];
            const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.ADD_ASPA_BATCH, {
                aspas: currentBatch,
                announce
            });
            added += result.data?.added || 0;
            overwritten += result.data?.overwritten || 0;
        };

        for await (const aspa of iterateJsonlAspas(filePath)) {
            batch.push(aspa);
            if (batch.length >= batchSize) {
                await flush();
            }
        }
        await flush();

        logger.info(`worker RPKI ASPA批量加载完成: added=${added}, overwritten=${overwritten}, announce=${announce}`);
        return { added, overwritten };
    }

    async loadAspaStorageToWorker(announce = false) {
        const filePath = await this.ensureAspaFileStorage();
        return this.loadAspaFileToWorker(filePath, announce);
    }

    async handleStopRpki() {
        if (null === this.worker) {
            logger.error('RPKI未启动');
            return errorResponse('RPKI未启动');
        }

        try {
            const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.STOP_RPKI, null);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('Error stopping RPKI:', error.message);
            return errorResponse(error.message);
        } finally {
            this.worker.removeEventListener(
                RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION,
                this.rpkiClientConnectionHandler
            );
            await this.worker.terminate();
            this.worker = null;
            this.eventDispatcher.cleanup(); // 清理事件发送器
            this.eventDispatcher = null;
        }
    }

    isRoaSame(roa1, roa2) {
        if (roa1.asn !== roa2.asn) {
            return false;
        }

        if (roa1.maxLength !== roa2.maxLength) {
            return false;
        }

        if (roa1.ipType !== roa2.ipType) {
            return false;
        }

        const net1 = getNetworkAddress(roa1.ip, roa1.mask);
        const net2 = getNetworkAddress(roa2.ip, roa2.mask);

        return net1 === net2;
    }

    async handleAddRoa(event, roa) {
        try {
            const normalizedRoa = normalizeRoaObject(roa);
            if (!normalizedRoa) {
                return errorResponse('RPKI ROA配置格式无效');
            }

            const filePath = await this.ensureRoaFileStorage();
            logger.info(`handleAddRoa: ${JSON.stringify(normalizedRoa)}`);

            // 检查是否已经存在
            if (await this.roaQueryIndex.hasRoa(filePath, normalizedRoa)) {
                return errorResponse('RPKI ROA配置已经存在');
            }

            if (this.worker) {
                const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.ADD_ROA, normalizedRoa);
                if (result.status === 'success') {
                    logger.info(`worker RPKI ROA配置添加成功`);
                } else {
                    logger.error(`worker RPKI ROA配置添加失败: ${result.msg}`);
                }
            }

            const appendOffset = (await fs.promises.stat(filePath)).size;
            const line = JSON.stringify(normalizedRoa);
            await fs.promises.appendFile(filePath, `${line}\n`, 'utf8');
            const total = await this.getRoaTotalCount(filePath);
            await this.updateRoaMeta(total + 1);
            await this.roaQueryIndex.markAppended(filePath, normalizedRoa, appendOffset, Buffer.byteLength(line));
            return successResponse(null, 'RPKI ROA配置文件保存成功');
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

            const filePath = await this.ensureRoaFileStorage();
            const tempPath = `${filePath}.${process.pid}.${Date.now()}.delete.tmp`;
            const targetKey = makeRoaStorageKey(normalizedRoa);
            const stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
            let removed = false;
            let count = 0;

            logger.info(`handleDeleteRoa: ${JSON.stringify(normalizedRoa)}`);

            try {
                for await (const item of iterateJsonlRoas(filePath)) {
                    if (makeRoaStorageKey(item) === targetKey) {
                        removed = true;
                        continue;
                    }
                    await writeLine(stream, JSON.stringify(item));
                    count += 1;
                }
                await closeWriteStream(stream);
                await renameWithRetry(tempPath, filePath);
            } catch (error) {
                stream.destroy();
                await fs.promises.unlink(tempPath).catch(() => {});
                throw error;
            }

            if (this.worker && removed) {
                const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.DELETE_ROA, normalizedRoa);
                if (result.status === 'success') {
                    logger.info(`worker RPKI ROA删除成功`);
                } else {
                    logger.error(`worker RPKI ROA删除失败: ${result.msg}`);
                }
            }

            await this.updateRoaMeta(count);
            this.roaQueryIndex.invalidate();
            return successResponse(null, 'RPKI ROA配置文件保存成功');
        } catch (error) {
            logger.error('Error deleting ROA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAllRoa() {
        try {
            const filePath = await this.ensureRoaFileStorage();
            const total = await this.getRoaTotalCount(filePath);

            if (this.worker && total > 0) {
                const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.DELETE_ROA_BATCH, {
                    all: true
                });
                logger.info(`worker RPKI ROA批量删除成功: ${JSON.stringify(result.data)}`);
            }

            await fs.promises.writeFile(filePath, '', 'utf8');
            await this.updateRoaMeta(0);
            this.roaQueryIndex.invalidate();
            return successResponse({ deleted: total }, 'RPKI ROA批量删除成功');
        } catch (error) {
            logger.error('Error deleting all ROA:', error.message);
            return errorResponse(error.message);
        }
    }

    hasRoaListFilters(options) {
        return Boolean(
            String(options?.ipType || '').trim() ||
                String(options?.asn || '').trim() ||
                String(options?.prefixFilter || '').trim()
        );
    }

    async handleGetRoaList(event, options = null) {
        try {
            const filePath = await this.ensureRoaFileStorage();
            const total = await this.getRoaTotalCount(filePath);

            if (options && typeof options === 'object') {
                const page = Math.max(1, Number(options.page) || 1);
                const pageSize = Math.min(1000, Math.max(1, Number(options.pageSize) || 10));
                const result = this.hasRoaListFilters(options)
                    ? await this.roaQueryIndex.query(filePath, {
                          ...options,
                          page,
                          pageSize
                      })
                    : {
                          items: await readJsonlPage(filePath, page, pageSize),
                          total,
                          page,
                          pageSize
                      };
                return successResponse(
                    {
                        items: result.items,
                        total: result.total,
                        page: result.page,
                        pageSize: result.pageSize,
                        storageTotal: total
                    },
                    'RPKI ROA配置文件加载成功'
                );
            }

            const currentRoaList = [];
            for await (const roa of iterateJsonlRoas(filePath)) {
                currentRoaList.push(roa);
            }
            return successResponse(currentRoaList, 'RPKI ROA配置文件加载成功');
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
        if (!Number.isFinite(value) || value <= 0) {
            return null;
        }
        return Math.floor(value);
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

    async importRoaJsonFile(importFilePath, options = {}) {
        const filePath = await this.ensureRoaFileStorage();
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.import.tmp`;
        const importedOnlyPath = `${filePath}.${process.pid}.${Date.now()}.imported.tmp`;
        const stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
        const importedOnlyStream = fs.createWriteStream(importedOnlyPath, { encoding: 'utf8' });
        const existingKeys = new Set();
        const importLimit = this.normalizeRoaImportLimit(options.limit);
        const stats = {
            filePath: importFilePath,
            limit: importLimit,
            existing: 0,
            parsed: 0,
            imported: 0,
            duplicate: 0,
            invalid: 0,
            total: 0
        };

        try {
            for await (const roa of iterateJsonlRoas(filePath)) {
                const key = makeRoaStorageKey(roa);
                if (existingKeys.has(key)) {
                    continue;
                }
                existingKeys.add(key);
                await writeLine(stream, JSON.stringify(roa));
                stats.existing += 1;
            }

            const parseStats = await parseRoaJsonFile(importFilePath, async roa => {
                const key = makeRoaStorageKey(roa);
                if (existingKeys.has(key)) {
                    stats.duplicate += 1;
                    return;
                }

                existingKeys.add(key);
                const line = JSON.stringify(roa);
                await writeLine(stream, line);
                await writeLine(importedOnlyStream, line);
                stats.imported += 1;

                if (importLimit && stats.imported >= importLimit) {
                    return false;
                }
            });

            stats.parsed = parseStats.valid;
            stats.invalid = parseStats.invalid;
            stats.total = stats.existing + stats.imported;

            await closeWriteStream(stream);
            await closeWriteStream(importedOnlyStream);
            await renameWithRetry(tempPath, filePath);
            await this.updateRoaMeta(stats.total);
            this.roaQueryIndex.invalidate();

            if (this.worker && stats.imported > 0) {
                await this.loadRoaFileToWorker(importedOnlyPath, true);
            }

            await fs.promises.unlink(importedOnlyPath).catch(() => {});
            logger.info(`ROA JSON导入完成: ${JSON.stringify(stats)}`);
            return stats;
        } catch (error) {
            stream.destroy();
            importedOnlyStream.destroy();
            await fs.promises.unlink(tempPath).catch(() => {});
            await fs.promises.unlink(importedOnlyPath).catch(() => {});
            throw error;
        }
    }

    // ============ Router Key (v1+) ============
    async handleAddRouterKey(event, rk) {
        try {
            let currentList = this.store.get(this.rpkiRouterKeyFileKey) || [];
            const index = currentList.findIndex(item => item.ski === rk.ski && item.asn === rk.asn);
            if (index !== -1) {
                return errorResponse('RouterKey已存在');
            }

            if (this.worker) {
                const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.ADD_ROUTER_KEY, rk);
                if (result.status !== 'success') {
                    logger.error(`worker RouterKey添加失败: ${result.msg}`);
                    return errorResponse(result.msg);
                }
            }

            currentList.push(rk);
            this.store.set(this.rpkiRouterKeyFileKey, currentList);
            return successResponse(null, 'RouterKey保存成功');
        } catch (error) {
            logger.error('Error adding RouterKey:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteRouterKey(event, rk) {
        try {
            let currentList = this.store.get(this.rpkiRouterKeyFileKey) || [];
            const index = currentList.findIndex(item => item.ski === rk.ski && item.asn === rk.asn);
            if (index !== -1) {
                currentList.splice(index, 1);
            }

            if (this.worker) {
                const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.DELETE_ROUTER_KEY, rk);
                if (result.status !== 'success') {
                    logger.error(`worker RouterKey删除失败: ${result.msg}`);
                }
            }

            this.store.set(this.rpkiRouterKeyFileKey, currentList);
            return successResponse(null, 'RouterKey删除成功');
        } catch (error) {
            logger.error('Error deleting RouterKey:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetRouterKeyList() {
        try {
            const list = this.store.get(this.rpkiRouterKeyFileKey) || [];
            return successResponse(list, 'RouterKey列表加载成功');
        } catch (error) {
            logger.error('Error getting RouterKey list:', error.message);
            return errorResponse(error.message);
        }
    }

    // ============ ASPA (v2+) ============
    async handleAddAspa(event, aspa) {
        let tempPath = null;
        let stream = null;
        try {
            const filePath = await this.ensureAspaFileStorage();
            tempPath = `${filePath}.${process.pid}.${Date.now()}.add.tmp`;
            stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
            const storedAspa = normalizeAspaObject({
                ...aspa,
                providerAsns: RpkiAspa.parseProviderAsns(aspa.providerAsns)
            });
            if (!storedAspa) {
                throw new Error('ASPA配置无效');
            }

            const key = makeAspaStorageKey(storedAspa);
            let replaced = false;
            let total = 0;

            for await (const item of iterateJsonlAspas(filePath)) {
                const itemKey = makeAspaStorageKey(item);
                if (itemKey === key) {
                    if (!replaced) {
                        await writeLine(stream, JSON.stringify(storedAspa));
                        replaced = true;
                        total += 1;
                    }
                    continue;
                }

                await writeLine(stream, JSON.stringify(item));
                total += 1;
            }

            if (!replaced) {
                await writeLine(stream, JSON.stringify(storedAspa));
                total += 1;
            }

            await closeWriteStream(stream);
            stream = null;

            if (this.worker) {
                const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.ADD_ASPA, storedAspa);
                if (result.status !== 'success') {
                    logger.error(`worker ASPA添加失败: ${result.msg}`);
                    return errorResponse(result.msg);
                }
            }

            await renameWithRetry(tempPath, filePath);
            tempPath = null;
            await this.updateAspaMeta(total);
            return successResponse(null, replaced ? 'ASPA覆盖成功' : 'ASPA保存成功');
        } catch (error) {
            if (stream) {
                stream.destroy();
            }
            if (tempPath) {
                await fs.promises.unlink(tempPath).catch(() => {});
            }
            logger.error('Error adding ASPA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAspa(event, aspa) {
        try {
            const filePath = await this.ensureAspaFileStorage();
            const { deleted, deletedAspa, total } = await removeAspaFromJsonl(filePath, aspa.customerAsn);
            await this.updateAspaMeta(total);

            if (deleted === 0) {
                return errorResponse('ASPA不存在');
            }

            if (this.worker && deletedAspa) {
                try {
                    await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.DELETE_ASPA, deletedAspa);
                } catch (workerError) {
                    logger.warn(`worker ASPA删除同步失败: ${workerError.message}`);
                }
            }

            return successResponse({ deleted }, 'ASPA删除成功');
        } catch (error) {
            logger.error('Error deleting ASPA:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAllAspa() {
        try {
            const filePath = await this.ensureAspaFileStorage();
            const total = await this.getAspaTotalCount(filePath);

            if (this.worker && total > 0) {
                const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.DELETE_ASPA_BATCH, {
                    all: true
                });
                if (result.status !== 'success') {
                    logger.error(`worker ASPA批量删除失败: ${result.msg}`);
                }
            }

            await fs.promises.writeFile(filePath, '', 'utf8');
            await this.updateAspaMeta(0);
            return successResponse({ deleted: total }, 'ASPA批量删除成功');
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
        if (!Number.isFinite(value) || value <= 0) {
            return null;
        }
        return Math.floor(value);
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

    async importAspaJsonFile(importFilePath, options = {}) {
        const filePath = await this.ensureAspaFileStorage();
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.import.tmp`;
        const importedOpsPath = `${filePath}.${process.pid}.${Date.now()}.imported.tmp`;
        const importLimit = this.normalizeAspaImportLimit(options.limit);
        const importedOpsStream = fs.createWriteStream(importedOpsPath, { encoding: 'utf8' });
        let stream = null;
        const existingKeys = new Set();
        const touchedKeys = new Set();
        const latestImportedByKey = new Map();
        const importedOrder = [];
        let importSequence = 0;
        const stats = {
            filePath: importFilePath,
            limit: importLimit,
            existing: 0,
            parsed: 0,
            imported: 0,
            overwritten: 0,
            invalid: 0,
            total: 0
        };

        try {
            for await (const aspa of iterateJsonlAspas(filePath)) {
                const key = makeAspaStorageKey(aspa);
                if (existingKeys.has(key)) {
                    continue;
                }
                existingKeys.add(key);
                stats.existing += 1;
            }

            const parseStats = await parseAspaJsonFile(importFilePath, async aspa => {
                const key = makeAspaStorageKey(aspa);
                if (existingKeys.has(key) || touchedKeys.has(key)) {
                    stats.overwritten += 1;
                } else {
                    stats.imported += 1;
                }

                touchedKeys.add(key);
                importSequence += 1;
                latestImportedByKey.set(key, { aspa, sequence: importSequence });
                importedOrder.push({ key, sequence: importSequence });
                await writeLine(importedOpsStream, JSON.stringify(aspa));

                if (importLimit && importSequence >= importLimit) {
                    return false;
                }
            });

            stats.parsed = parseStats.valid;
            stats.invalid = parseStats.invalid;

            await closeWriteStream(importedOpsStream);

            stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
            let finalTotal = 0;
            for await (const aspa of iterateJsonlAspas(filePath)) {
                const key = makeAspaStorageKey(aspa);
                if (touchedKeys.has(key)) {
                    continue;
                }
                await writeLine(stream, JSON.stringify(aspa));
                finalTotal += 1;
            }

            for (const item of importedOrder) {
                const latest = latestImportedByKey.get(item.key);
                if (!latest || latest.sequence !== item.sequence) {
                    continue;
                }
                await writeLine(stream, JSON.stringify(latest.aspa));
                finalTotal += 1;
            }

            stats.total = finalTotal;
            await closeWriteStream(stream);
            stream = null;
            await renameWithRetry(tempPath, filePath);
            await this.updateAspaMeta(stats.total);

            if (this.worker && importSequence > 0) {
                await this.loadAspaFileToWorker(importedOpsPath, true);
            }

            await fs.promises.unlink(importedOpsPath).catch(() => {});
            logger.info(`ASPA JSON导入完成: ${JSON.stringify(stats)}`);
            return stats;
        } catch (error) {
            importedOpsStream.destroy();
            if (stream) {
                stream.destroy();
            }
            await fs.promises.unlink(tempPath).catch(() => {});
            await fs.promises.unlink(importedOpsPath).catch(() => {});
            throw error;
        }
    }

    async handleGetAspaList(event, options = null) {
        try {
            const filePath = await this.ensureAspaFileStorage();
            const total = await this.getAspaTotalCount(filePath);

            if (options && typeof options === 'object') {
                const page = Math.max(1, Number(options.page) || 1);
                const pageSize = Math.min(1000, Math.max(1, Number(options.pageSize) || 20));
                const items = await readAspaJsonlPage(filePath, page, pageSize);
                return successResponse(
                    {
                        items,
                        total,
                        page,
                        pageSize,
                        storageTotal: total
                    },
                    'ASPA列表加载成功'
                );
            }

            const items = await readAspaJsonlPage(filePath, 1, Math.min(total || 20, 1000));
            return successResponse(items, 'ASPA列表加载成功');
        } catch (error) {
            logger.error('Error getting ASPA list:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetClientList() {
        if (null === this.worker) {
            return successResponse([], 'RPKI未启动');
        }

        try {
            const result = await this.worker.sendRequest(RpkiConst.RPKI_REQ_TYPES.GET_CLIENT_LIST, null);
            logger.info(`获取客户端列表成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取客户端列表成功');
        } catch (error) {
            logger.error('Error getting client list:', error.message);
            return errorResponse(error.message);
        }
    }

    getRpkiRunning() {
        return null !== this.worker;
    }
}

module.exports = RpkiApp;
