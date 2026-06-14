const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const WorkerWithPromise = require('../worker/core/workerWithPromise');
const SyslogConst = require('../const/syslogConst');
const EventDispatcher = require('../utils/eventDispatcher');

class SyslogApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.syslogConfigFileKey = 'syslog-config';
        this.worker = null;
        this.logLevel = null;
        this.eventDispatcher = null;
        this.syslogEventHandler = null;

        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        this.ipcMain.handle('syslog:saveSyslogConfig', this.handleSaveSyslogConfig.bind(this));
        this.ipcMain.handle('syslog:getSyslogConfig', this.handleGetSyslogConfig.bind(this));
        this.ipcMain.handle('syslog:startSyslog', this.handleStartSyslog.bind(this));
        this.ipcMain.handle('syslog:stopSyslog', this.handleStopSyslog.bind(this));
        this.ipcMain.handle('syslog:getMessageList', this.handleGetMessageList.bind(this));
        this.ipcMain.handle('syslog:getMessageDetail', this.handleGetMessageDetail.bind(this));
        this.ipcMain.handle('syslog:clearMessageHistory', this.handleClearMessageHistory.bind(this));
    }

    async handleSaveSyslogConfig(_event, config) {
        try {
            logger.info('handleSaveSyslogConfig', config);
            this.store.set(this.syslogConfigFileKey, config);
            return successResponse(null, '配置保存成功');
        } catch (error) {
            logger.error('保存Syslog配置失败:', error);
            return errorResponse('配置保存失败: ' + error.message);
        }
    }

    async handleGetSyslogConfig() {
        try {
            const config = this.store.get(this.syslogConfigFileKey);
            if (!config) {
                return successResponse(null, '获取默认配置');
            }
            return successResponse(config, '配置获取成功');
        } catch (error) {
            logger.error('获取Syslog配置失败:', error);
            return errorResponse('配置获取失败: ' + error.message);
        }
    }

    async handleStartSyslog(event, config) {
        const webContents = event.sender;
        try {
            if (this.worker !== null) {
                logger.error('Syslog服务器已经启动');
                return errorResponse('Syslog服务器已经启动');
            }

            const workerConfig = { ...(config || {}) };
            logger.info(`启动Syslog服务器: ${JSON.stringify(workerConfig)}`);

            if (this.logLevel) {
                workerConfig.logLevel = this.logLevel;
            }

            const workerPath = resolveWorkerPath('services/syslogWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            this.syslogEventHandler = data => {
                this.eventDispatcher.emit('syslog:event', successResponse(data));
            };
            this.worker.addEventListener(SyslogConst.SYSLOG_EVT_TYPES.SYSLOG_EVT, this.syslogEventHandler);

            const result = await this.worker.sendRequest(SyslogConst.SYSLOG_REQ_TYPES.START_SYSLOG, workerConfig);
            if (result.status === 'success') {
                logger.info(`Syslog服务器启动成功: ${result.msg}`);
                return successResponse(result.data, result.msg);
            }

            logger.error(`Syslog服务器启动失败: ${result.msg}`);
            await this.cleanupWorker();
            return errorResponse(result.msg);
        } catch (error) {
            logger.error('启动Syslog服务器失败:', error);
            await this.cleanupWorker();
            return errorResponse('启动Syslog服务器失败: ' + error.message);
        }
    }

    async handleStopSyslog() {
        try {
            if (this.worker === null) {
                logger.error('Syslog服务器未启动');
                return errorResponse('Syslog服务器未启动');
            }

            const result = await this.worker.sendRequest(SyslogConst.SYSLOG_REQ_TYPES.STOP_SYSLOG, null);
            logger.info(`Syslog服务器停止成功: ${result.msg}`);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('停止Syslog服务器失败:', error);
            return errorResponse('停止Syslog服务器失败: ' + error.message);
        } finally {
            await this.cleanupWorker();
        }
    }

    async handleGetMessageList(_event, query = {}) {
        try {
            if (this.worker === null) {
                return successResponse(
                    {
                        list: [],
                        total: 0,
                        page: Number(query.page || 1),
                        pageSize: Number(query.pageSize || 20)
                    },
                    'Syslog服务器未启动'
                );
            }

            const result = await this.worker.sendRequest(SyslogConst.SYSLOG_REQ_TYPES.GET_MESSAGE_LIST, query);
            return successResponse(
                result.data || { list: [], total: 0, page: 1, pageSize: 20 },
                result.msg || '获取Syslog消息日志成功'
            );
        } catch (error) {
            logger.error('获取Syslog消息日志失败:', error);
            return errorResponse('获取Syslog消息日志失败: ' + error.message);
        }
    }

    async handleGetMessageDetail(_event, id) {
        try {
            if (this.worker === null) {
                return errorResponse('Syslog服务器未启动');
            }

            const result = await this.worker.sendRequest(SyslogConst.SYSLOG_REQ_TYPES.GET_MESSAGE_DETAIL, id);
            if (result.status === 'success') {
                return successResponse(result.data, result.msg || '获取Syslog消息详情成功');
            }
            return errorResponse(result.msg || '获取Syslog消息详情失败');
        } catch (error) {
            logger.error('获取Syslog消息详情失败:', error);
            return errorResponse('获取Syslog消息详情失败: ' + error.message);
        }
    }

    async handleClearMessageHistory() {
        try {
            if (this.worker === null) {
                return successResponse(null, 'Syslog服务器未启动');
            }

            const result = await this.worker.sendRequest(SyslogConst.SYSLOG_REQ_TYPES.CLEAR_MESSAGE_HISTORY, null);
            return successResponse(null, result.msg || 'Syslog消息日志已清空');
        } catch (error) {
            logger.error('清空Syslog消息日志失败:', error);
            return errorResponse('清空Syslog消息日志失败: ' + error.message);
        }
    }

    async cleanupWorker() {
        if (this.worker && this.syslogEventHandler) {
            this.worker.removeEventListener(SyslogConst.SYSLOG_EVT_TYPES.SYSLOG_EVT, this.syslogEventHandler);
        }

        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }

        if (this.eventDispatcher) {
            this.eventDispatcher.cleanup();
            this.eventDispatcher = null;
        }

        this.syslogEventHandler = null;
    }

    getSyslogRunning() {
        return this.worker !== null;
    }
}

module.exports = SyslogApp;
