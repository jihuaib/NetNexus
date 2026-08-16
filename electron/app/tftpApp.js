const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const ProtocolProcessWithPromise = require('../worker/core/protocolProcessWithPromise');
const { PROTOCOL_PROCESS_SERVICES, PROTOCOL_PROCESS_TIMEOUTS } = require('../worker/core/protocolProcessServices');
const TftpConst = require('../const/tftpConst');
const EventDispatcher = require('../utils/eventDispatcher');

class TftpApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.tftpConfigFileKey = 'tftp-config';
        this.worker = null;
        this.logLevel = null;
        this.eventDispatcher = null;
        this.tftpEventHandler = null;

        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        this.ipcMain.handle('tftp:saveTftpConfig', this.handleSaveTftpConfig.bind(this));
        this.ipcMain.handle('tftp:getTftpConfig', this.handleGetTftpConfig.bind(this));
        this.ipcMain.handle('tftp:startTftp', this.handleStartTftp.bind(this));
        this.ipcMain.handle('tftp:stopTftp', this.handleStopTftp.bind(this));
        this.ipcMain.handle('tftp:getTransferList', this.handleGetTransferList.bind(this));
        this.ipcMain.handle('tftp:clearTransferHistory', this.handleClearTransferHistory.bind(this));
    }

    async handleSaveTftpConfig(_event, config) {
        try {
            logger.info('handleSaveTftpConfig', config);
            this.store.set(this.tftpConfigFileKey, config);
            return successResponse(null, '配置保存成功');
        } catch (error) {
            logger.error('保存TFTP配置失败:', error);
            return errorResponse('配置保存失败: ' + error.message);
        }
    }

    async handleGetTftpConfig() {
        try {
            const config = this.store.get(this.tftpConfigFileKey);
            if (!config) {
                return successResponse(null, '获取默认配置');
            }
            return successResponse(config, '配置获取成功');
        } catch (error) {
            logger.error('获取TFTP配置失败:', error);
            return errorResponse('配置获取失败: ' + error.message);
        }
    }

    async handleStartTftp(event, config) {
        const webContents = event.sender;
        try {
            if (this.worker !== null) {
                logger.error('TFTP服务器已经启动');
                return errorResponse('TFTP服务器已经启动');
            }

            logger.info(`启动TFTP服务器: ${JSON.stringify(config)}`);

            if (this.logLevel) {
                config.logLevel = this.logLevel;
            }

            const workerPath = resolveWorkerPath('transfer/tftpWorker.js');

            const processFactory = new ProtocolProcessWithPromise(workerPath, {
                serviceName: PROTOCOL_PROCESS_SERVICES.TFTP,
                onExit: (_code, client, exit = {}) => {
                    if (this.worker !== client) return;
                    if (exit.expected) return;
                    this.worker = null;
                    this.eventDispatcher?.cleanup();
                    this.eventDispatcher = null;
                    this.tftpEventHandler = null;
                }
            });
            this.worker = processFactory.createLongRunningProcess();

            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            this.tftpEventHandler = data => {
                this.eventDispatcher.emit('tftp:event', successResponse(data));
            };
            this.worker.addEventListener(TftpConst.TFTP_EVT_TYPES.TFTP_EVT, this.tftpEventHandler);

            const result = await this.worker.sendRequest(TftpConst.TFTP_REQ_TYPES.START_TFTP, config);
            if (result.status === 'success') {
                logger.info(`TFTP服务器启动成功: ${result.msg}`);
                return successResponse(result.data, result.msg);
            }

            logger.error(`TFTP服务器启动失败: ${result.msg}`);
            await this.cleanupWorker();
            return errorResponse(result.msg);
        } catch (error) {
            logger.error('启动TFTP服务器失败:', error);
            await this.cleanupWorker();
            return errorResponse('启动TFTP服务器失败: ' + error.message);
        }
    }

    async handleStopTftp() {
        try {
            if (this.worker === null) {
                logger.error('TFTP服务器未启动');
                return errorResponse('TFTP服务器未启动');
            }

            const result = await this.worker.sendRequest(TftpConst.TFTP_REQ_TYPES.STOP_TFTP, null, {
                timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
            });
            logger.info(`TFTP服务器停止成功: ${result.msg}`);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('停止TFTP服务器失败:', error);
            return errorResponse('停止TFTP服务器失败: ' + error.message);
        } finally {
            await this.cleanupWorker();
        }
    }

    async handleGetTransferList() {
        try {
            if (this.worker === null) {
                return successResponse([], 'TFTP服务器未启动');
            }

            const result = await this.worker.sendRequest(TftpConst.TFTP_REQ_TYPES.GET_TRANSFER_LIST, null);
            return successResponse(result.data || [], result.msg || '获取TFTP传输日志成功');
        } catch (error) {
            logger.error('获取TFTP传输日志失败:', error);
            return errorResponse('获取TFTP传输日志失败: ' + error.message);
        }
    }

    async handleClearTransferHistory() {
        try {
            if (this.worker === null) {
                return successResponse(null, 'TFTP服务器未启动');
            }

            const result = await this.worker.sendRequest(TftpConst.TFTP_REQ_TYPES.CLEAR_TRANSFER_HISTORY, null);
            return successResponse(null, result.msg || '传输日志已清空');
        } catch (error) {
            logger.error('清空TFTP传输日志失败:', error);
            return errorResponse('清空TFTP传输日志失败: ' + error.message);
        }
    }

    async cleanupWorker() {
        if (this.worker && this.tftpEventHandler) {
            this.worker.removeEventListener(TftpConst.TFTP_EVT_TYPES.TFTP_EVT, this.tftpEventHandler);
        }

        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }

        if (this.eventDispatcher) {
            this.eventDispatcher.cleanup();
            this.eventDispatcher = null;
        }

        this.tftpEventHandler = null;
    }

    getTftpRunning() {
        return this.worker !== null;
    }
}

module.exports = TftpApp;
