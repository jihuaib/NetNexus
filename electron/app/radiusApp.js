const { app } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const WorkerWithPromise = require('../worker/core/workerWithPromise');
const RadiusConst = require('../const/radiusConst');
const EventDispatcher = require('../utils/eventDispatcher');
const { ensureRadiusDefaultConfigFile, loadRadiusRuntimeConfig } = require('../utils/radiusConfigLoader');

class RadiusApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.radiusConfigFileKey = 'radius-config';
        this.worker = null;
        this.logLevel = null;
        this.eventDispatcher = null;
        this.radiusEventHandler = null;

        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        this.ipcMain.handle('radius:saveRadiusConfig', this.handleSaveRadiusConfig.bind(this));
        this.ipcMain.handle('radius:getRadiusConfig', this.handleGetRadiusConfig.bind(this));
        this.ipcMain.handle('radius:startRadius', this.handleStartRadius.bind(this));
        this.ipcMain.handle('radius:stopRadius', this.handleStopRadius.bind(this));
        this.ipcMain.handle('radius:getRequestList', this.handleGetRequestList.bind(this));
        this.ipcMain.handle('radius:clearRequestHistory', this.handleClearRequestHistory.bind(this));
        this.ipcMain.handle('radius:getSessionList', this.handleGetSessionList.bind(this));
    }

    async handleSaveRadiusConfig(_event, config) {
        try {
            const runtimeConfig = { ...(config || {}) };
            delete runtimeConfig.configFilePath;
            delete runtimeConfig.bindAddress;
            delete runtimeConfig.bindAddress6;
            delete runtimeConfig.enableIpv6;
            delete runtimeConfig.clients;
            delete runtimeConfig.users;
            logger.info('handleSaveRadiusConfig', runtimeConfig);
            this.store.set(this.radiusConfigFileKey, runtimeConfig);
            return successResponse(null, '配置保存成功');
        } catch (error) {
            logger.error('保存RADIUS配置失败:', error);
            return errorResponse('配置保存失败: ' + error.message);
        }
    }

    async handleGetRadiusConfig() {
        try {
            const configFilePath = await ensureRadiusDefaultConfigFile(app.getPath('userData'));
            const config = { ...(this.store.get(this.radiusConfigFileKey) || {}) };
            delete config.bindAddress;
            delete config.bindAddress6;
            delete config.enableIpv6;
            delete config.clients;
            delete config.users;
            return successResponse({ ...config, configFilePath }, '配置获取成功');
        } catch (error) {
            logger.error('获取RADIUS配置失败:', error);
            return errorResponse('配置获取失败: ' + error.message);
        }
    }

    async handleStartRadius(event, config) {
        const webContents = event.sender;
        try {
            if (this.worker !== null) {
                logger.error('RADIUS服务器已经启动');
                return errorResponse('RADIUS服务器已经启动');
            }

            const configFilePath = await ensureRadiusDefaultConfigFile(app.getPath('userData'));
            const workerConfig = await loadRadiusRuntimeConfig(config, { configFilePath });
            logger.info(`启动RADIUS服务器: ${JSON.stringify(workerConfig)}`);

            if (this.logLevel) {
                workerConfig.logLevel = this.logLevel;
            }

            const workerPath = resolveWorkerPath('services/radiusWorker.js');
            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            this.radiusEventHandler = data => {
                this.eventDispatcher.emit('radius:event', successResponse(data));
            };
            this.worker.addEventListener(RadiusConst.RADIUS_EVT_TYPES.RADIUS_EVT, this.radiusEventHandler);

            const result = await this.worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.START_RADIUS, workerConfig);
            if (result.status === 'success') {
                logger.info(`RADIUS服务器启动成功: ${result.msg}`);
                return successResponse(result.data, result.msg);
            }

            logger.error(`RADIUS服务器启动失败: ${result.msg}`);
            await this.cleanupWorker();
            return errorResponse(result.msg);
        } catch (error) {
            logger.error('启动RADIUS服务器失败:', error);
            await this.cleanupWorker();
            return errorResponse('启动RADIUS服务器失败: ' + error.message);
        }
    }

    async handleStopRadius() {
        try {
            if (this.worker === null) {
                logger.error('RADIUS服务器未启动');
                return errorResponse('RADIUS服务器未启动');
            }

            const result = await this.worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.STOP_RADIUS, null);
            logger.info(`RADIUS服务器停止成功: ${result.msg}`);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('停止RADIUS服务器失败:', error);
            return errorResponse('停止RADIUS服务器失败: ' + error.message);
        } finally {
            await this.cleanupWorker();
        }
    }

    async handleGetRequestList() {
        try {
            if (this.worker === null) {
                return successResponse([], 'RADIUS服务器未启动');
            }
            const result = await this.worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.GET_REQUEST_LIST, null);
            return successResponse(result.data || [], result.msg || '获取RADIUS请求日志成功');
        } catch (error) {
            logger.error('获取RADIUS请求日志失败:', error);
            return errorResponse('获取RADIUS请求日志失败: ' + error.message);
        }
    }

    async handleClearRequestHistory() {
        try {
            if (this.worker === null) {
                return successResponse(null, 'RADIUS服务器未启动');
            }
            const result = await this.worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.CLEAR_REQUEST_HISTORY, null);
            return successResponse(null, result.msg || 'RADIUS请求日志已清空');
        } catch (error) {
            logger.error('清空RADIUS请求日志失败:', error);
            return errorResponse('清空RADIUS请求日志失败: ' + error.message);
        }
    }

    async handleGetSessionList() {
        try {
            if (this.worker === null) {
                return successResponse([], 'RADIUS服务器未启动');
            }
            const result = await this.worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.GET_SESSION_LIST, null);
            return successResponse(result.data || [], result.msg || '获取RADIUS会话列表成功');
        } catch (error) {
            logger.error('获取RADIUS会话列表失败:', error);
            return errorResponse('获取RADIUS会话列表失败: ' + error.message);
        }
    }

    async cleanupWorker() {
        if (this.worker && this.radiusEventHandler) {
            this.worker.removeEventListener(RadiusConst.RADIUS_EVT_TYPES.RADIUS_EVT, this.radiusEventHandler);
        }

        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }

        if (this.eventDispatcher) {
            this.eventDispatcher.cleanup();
            this.eventDispatcher = null;
        }

        this.radiusEventHandler = null;
    }

    getRadiusRunning() {
        return this.worker !== null;
    }
}

module.exports = RadiusApp;
