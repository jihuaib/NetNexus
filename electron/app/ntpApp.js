const path = require('path');
const { app } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const WorkerWithPromise = require('../worker/workerWithPromise');
const NtpConst = require('../const/ntpConst');
const EventDispatcher = require('../utils/eventDispatcher');

class NtpApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.ntpConfigFileKey = 'ntp-config';
        this.worker = null;
        this.isDev = !app.isPackaged;
        this.logLevel = null;
        this.eventDispatcher = null;
        this.ntpEventHandler = null;

        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        this.ipcMain.handle('ntp:saveNtpConfig', this.handleSaveNtpConfig.bind(this));
        this.ipcMain.handle('ntp:getNtpConfig', this.handleGetNtpConfig.bind(this));
        this.ipcMain.handle('ntp:startNtp', this.handleStartNtp.bind(this));
        this.ipcMain.handle('ntp:stopNtp', this.handleStopNtp.bind(this));
        this.ipcMain.handle('ntp:getRequestList', this.handleGetRequestList.bind(this));
        this.ipcMain.handle('ntp:clearRequestHistory', this.handleClearRequestHistory.bind(this));
    }

    async handleSaveNtpConfig(_event, config) {
        try {
            logger.info('handleSaveNtpConfig', config);
            this.store.set(this.ntpConfigFileKey, config);
            return successResponse(null, '配置保存成功');
        } catch (error) {
            logger.error('保存NTP配置失败:', error);
            return errorResponse('配置保存失败: ' + error.message);
        }
    }

    async handleGetNtpConfig() {
        try {
            const config = this.store.get(this.ntpConfigFileKey);
            if (!config) {
                return successResponse(null, '获取默认配置');
            }
            return successResponse(config, '配置获取成功');
        } catch (error) {
            logger.error('获取NTP配置失败:', error);
            return errorResponse('配置获取失败: ' + error.message);
        }
    }

    async handleStartNtp(event, config) {
        const webContents = event.sender;
        try {
            if (this.worker !== null) {
                logger.error('NTP服务器已经启动');
                return errorResponse('NTP服务器已经启动');
            }

            logger.info(`启动NTP服务器: ${JSON.stringify(config)}`);

            if (this.logLevel) {
                config.logLevel = this.logLevel;
            }

            const workerPath = this.isDev
                ? path.join(__dirname, '../worker/ntpWorker.js')
                : path.join(process.resourcesPath, 'app', 'electron/worker/ntpWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            this.ntpEventHandler = data => {
                this.eventDispatcher.emit('ntp:event', successResponse(data));
            };
            this.worker.addEventListener(NtpConst.NTP_EVT_TYPES.NTP_EVT, this.ntpEventHandler);

            const result = await this.worker.sendRequest(NtpConst.NTP_REQ_TYPES.START_NTP, config);
            if (result.status === 'success') {
                logger.info(`NTP服务器启动成功: ${result.msg}`);
                return successResponse(result.data, result.msg);
            }

            logger.error(`NTP服务器启动失败: ${result.msg}`);
            await this.cleanupWorker();
            return errorResponse(result.msg);
        } catch (error) {
            logger.error('启动NTP服务器失败:', error);
            await this.cleanupWorker();
            return errorResponse('启动NTP服务器失败: ' + error.message);
        }
    }

    async handleStopNtp() {
        try {
            if (this.worker === null) {
                logger.error('NTP服务器未启动');
                return errorResponse('NTP服务器未启动');
            }

            const result = await this.worker.sendRequest(NtpConst.NTP_REQ_TYPES.STOP_NTP, null);
            logger.info(`NTP服务器停止成功: ${result.msg}`);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('停止NTP服务器失败:', error);
            return errorResponse('停止NTP服务器失败: ' + error.message);
        } finally {
            await this.cleanupWorker();
        }
    }

    async handleGetRequestList() {
        try {
            if (this.worker === null) {
                return successResponse([], 'NTP服务器未启动');
            }

            const result = await this.worker.sendRequest(NtpConst.NTP_REQ_TYPES.GET_REQUEST_LIST, null);
            return successResponse(result.data || [], result.msg || '获取请求日志成功');
        } catch (error) {
            logger.error('获取NTP请求日志失败:', error);
            return errorResponse('获取NTP请求日志失败: ' + error.message);
        }
    }

    async handleClearRequestHistory() {
        try {
            if (this.worker === null) {
                return successResponse(null, 'NTP服务器未启动');
            }

            const result = await this.worker.sendRequest(NtpConst.NTP_REQ_TYPES.CLEAR_REQUEST_HISTORY, null);
            return successResponse(null, result.msg || '请求日志已清空');
        } catch (error) {
            logger.error('清空NTP请求日志失败:', error);
            return errorResponse('清空NTP请求日志失败: ' + error.message);
        }
    }

    async cleanupWorker() {
        if (this.worker && this.ntpEventHandler) {
            this.worker.removeEventListener(NtpConst.NTP_EVT_TYPES.NTP_EVT, this.ntpEventHandler);
        }

        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }

        if (this.eventDispatcher) {
            this.eventDispatcher.cleanup();
            this.eventDispatcher = null;
        }

        this.ntpEventHandler = null;
    }

    getNtpRunning() {
        return this.worker !== null;
    }
}

module.exports = NtpApp;
