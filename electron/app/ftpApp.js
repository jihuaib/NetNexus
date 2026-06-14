const { DEFAULT_TOOLS_SETTINGS } = require('../const/toolsConst');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const WorkerWithPromise = require('../worker/core/workerWithPromise');
const FtpConst = require('../const/ftpConst');
const EventDispatcher = require('../utils/eventDispatcher');
class FtpApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.ftpConfigFileKey = 'ftp-config';
        this.ftpUserListFileKey = 'ftp-user-list';
        this.worker = null;
        this.maxFtpUser = DEFAULT_TOOLS_SETTINGS.ftpServer.maxFtpUser;
        // 注册IPC处理程序
        this.registerIpcHandlers();

        this.logLevel = null;

        this.eventDispatcher = null;
        this.ftpEvtHandler = null;
    }

    /**
     * 注册IPC处理程序
     */
    registerIpcHandlers() {
        this.ipcMain.handle('ftp:addFtpUser', this.handleAddFtpUser.bind(this));
        this.ipcMain.handle('ftp:getFtpUserList', this.handleGetFtpUserList.bind(this));
        this.ipcMain.handle('ftp:deleteFtpUser', this.handleDeleteFtpUser.bind(this));
        this.ipcMain.handle('ftp:saveFtpConfig', this.handleSaveFtpConfig.bind(this));
        this.ipcMain.handle('ftp:getFtpConfig', this.handleGetFtpConfig.bind(this));
        this.ipcMain.handle('ftp:startFtp', this.handleStartFtp.bind(this));
        this.ipcMain.handle('ftp:stopFtp', this.handleStopFtp.bind(this));
        this.ipcMain.handle('ftp:getClientList', this.handleGetClientList.bind(this));
    }

    async handleAddFtpUser(event, user) {
        logger.info('handleAddFtpUser', user);
        let config = this.store.get(this.ftpUserListFileKey);
        if (!config) {
            config = [];
        }

        let isExist = false;
        let index = -1;
        config.forEach(element => {
            if (element.username === user.username) {
                isExist = true;
                index = config.indexOf(element);
            }
        });

        if (isExist) {
            // 更新用户
            config[index] = user;
            this.store.set(this.ftpUserListFileKey, config);
            return successResponse(null, '用户更新成功');
        }

        if (config.length >= this.maxFtpUser) {
            config.splice(0, 1);
        }

        config.push(user);
        this.store.set(this.ftpUserListFileKey, config);
        return successResponse(null, '用户添加成功');
    }

    async handleGetFtpUserList() {
        const config = this.store.get(this.ftpUserListFileKey);
        if (!config) {
            return successResponse([], '用户列表获取成功');
        }
        return successResponse(config, '用户列表获取成功');
    }

    async handleDeleteFtpUser(event, user) {
        logger.info('handleDeleteFtpUser', user);
        const config = this.store.get(this.ftpUserListFileKey);
        if (!config) {
            return successResponse([], '用户列表获取成功');
        }
        const index = config.findIndex(element => element.username === user.username);
        if (index !== -1) {
            config.splice(index, 1);
        }
        this.store.set(this.ftpUserListFileKey, config);
        return successResponse(null, '用户删除成功');
    }

    async handleSaveFtpConfig(event, config) {
        logger.info('handleSaveFtpConfig', config);
        this.store.set(this.ftpConfigFileKey, config);
        return successResponse(null, '配置保存成功');
    }

    async handleGetFtpConfig() {
        const config = this.store.get(this.ftpConfigFileKey);
        if (!config) {
            return successResponse(null, '配置不存在');
        }
        return successResponse(config, '配置获取成功');
    }

    /**
     * 处理启动FTP服务器
     * @param {object} event IPC事件
     * @param {object} config FTP配置
     * @returns {Promise<object>} 操作结果
     */
    async handleStartFtp(event, config, user) {
        const webContents = event.sender;
        try {
            if (null !== this.worker) {
                logger.error(`ftp协议已经启动`);
                return errorResponse('ftp协议已经启动');
            }

            logger.info(`${JSON.stringify(config)}`);
            logger.info(`${JSON.stringify(user)}`);

            // 获取日志级别配置
            if (this.logLevel) {
                config.logLevel = this.logLevel;
            }

            const workerPath = resolveWorkerPath('transfer/ftpWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            // 设置事件发送器的 webContents
            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            // 定义事件处理函数
            this.ftpEvtHandler = data => {
                this.eventDispatcher.emit('ftp:event', successResponse(data));
            };

            // 注册事件监听器，处理来自worker的事件通知
            this.worker.addEventListener(FtpConst.FTP_EVT_TYPES.FTP_EVT, this.ftpEvtHandler);

            const result = await this.worker.sendRequest(FtpConst.FTP_REQ_TYPES.START_FTP, {
                ftpConfig: config,
                userConfig: user
            });
            if (result.status === 'success') {
                logger.info(`worker FTP启动成功: ${JSON.stringify(result)}`);
            } else {
                logger.error(`worker FTP启动失败: ${JSON.stringify(result)} ${result.msg}`);
            }

            // 这里肯定是启动成功了，如果失败，会抛出异常
            logger.info(`ftp启动成功 result: ${JSON.stringify(result)}`);
            return successResponse(null, result.msg);
        } catch (error) {
            this.worker.removeEventListener(FtpConst.FTP_EVT_TYPES.FTP_EVT, this.ftpEvtHandler);
            await this.worker.terminate();
            this.worker = null;
            this.eventDispatcher.cleanup(); // 清理事件发送器
            this.eventDispatcher = null;
            logger.error('Error starting FTP:', error.message);
            return errorResponse(error.message);
        }
    }

    /**
     * 处理停止FTP服务器
     * @returns {Promise<object>} 操作结果
     */
    async handleStopFtp() {
        try {
            if (null === this.worker) {
                logger.error('FTP未启动');
                return errorResponse('FTP未启动');
            }

            const result = await this.worker.sendRequest(FtpConst.FTP_REQ_TYPES.STOP_FTP, null);
            logger.info(`ftp停止成功 result: ${JSON.stringify(result)}`);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('Error stopping FTP:', error.message);
            return errorResponse(error.message);
        } finally {
            // 移除事件监听器
            this.worker.removeEventListener(FtpConst.FTP_EVT_TYPES.FTP_EVT, this.ftpEvtHandler);
            await this.worker.terminate();
            this.worker = null;
            this.eventDispatcher.cleanup(); // 清理事件发送器
            this.eventDispatcher = null;
        }
    }

    async handleGetClientList() {
        if (null === this.worker) {
            return successResponse([], 'FTP未启动');
        }

        try {
            const result = await this.worker.sendRequest(FtpConst.FTP_REQ_TYPES.GET_CLIENT_LIST, null);
            logger.info(`获取客户端列表成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取客户端列表成功');
        } catch (error) {
            logger.error('Error getting client list:', error.message);
            return errorResponse(error.message);
        }
    }

    setMaxFtpUser(maxFtpUser) {
        this.maxFtpUser = maxFtpUser;
    }

    getFtpRunning() {
        return null !== this.worker;
    }
}

module.exports = FtpApp;
