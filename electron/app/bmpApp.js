const { app } = require('electron');
const path = require('path');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const WorkerWithPromise = require('../worker/workerWithPromise');
const logger = require('../log/logger');
const BmpConst = require('../const/bmpConst');
const EventDispatcher = require('../utils/eventDispatcher');

class BmpApp {
    constructor(ipcMain, store, keychainManager) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.bmpConfigFileKey = 'bmp-config';
        this.isDev = !app.isPackaged;
        this.worker = null;
        this.eventDispatcher = null;

        this.bmpInitiationHandler = null;
        this.bmpSessionUpdateHandler = null;
        this.bmpRouteUpdateHandler = null;
        this.bmpTerminationHandler = null;
        this.bmpStatisticsReportHandler = null;

        this.serverDeploymentConfig = null;
        this.keychainManager = keychainManager;

        this.logLevel = null;

        this.registerHandlers();
    }

    registerHandlers() {
        this.ipcMain.handle('bmp:saveBmpConfig', this.handleSaveBmpConfig.bind(this));
        this.ipcMain.handle('bmp:loadBmpConfig', this.handleLoadBmpConfig.bind(this));
        this.ipcMain.handle('bmp:startBmp', this.handleStartBmp.bind(this));
        this.ipcMain.handle('bmp:stopBmp', this.handleStopBmp.bind(this));
        this.ipcMain.handle('bmp:getClientList', this.handleGetClientList.bind(this));
        this.ipcMain.handle('bmp:getBgpSessions', this.handleGetBgpSessions.bind(this));
        this.ipcMain.handle('bmp:getBgpRoutes', this.handleGetBgpRoutes.bind(this));
        this.ipcMain.handle('bmp:getBgpInstances', this.handleGetBgpInstances.bind(this));
        this.ipcMain.handle('bmp:getBgpInstanceRoutes', this.handleGetBgpInstanceRoutes.bind(this));
        this.ipcMain.handle('bmp:purgeStaleBgpRoutes', this.handlePurgeStaleBgpRoutes.bind(this));
        this.ipcMain.handle('bmp:purgeStaleBgpInstanceRoutes', this.handlePurgeStaleBgpInstanceRoutes.bind(this));
        this.ipcMain.handle('bmp:getBgpStatisticsReports', this.handleGetBgpStatisticsReports.bind(this));
        this.ipcMain.handle(
            'bmp:getBgpInstanceStatisticsReports',
            this.handleGetBgpInstanceStatisticsReports.bind(this)
        );
    }

    async handleSaveBmpConfig(event, config) {
        try {
            this.store.set(this.bmpConfigFileKey, config);
            return successResponse(null, 'BMP配置文件保存成功');
        } catch (error) {
            logger.error('Error saving BMP config:', error.message);
            return errorResponse(error.message);
        }
    }

    setServerDeploymentConfig(config) {
        this.serverDeploymentConfig = config;
    }

    async handleLoadBmpConfig() {
        try {
            const config = this.store.get(this.bmpConfigFileKey);
            if (!config) {
                return successResponse(null, 'BMP配置文件不存在');
            }
            return successResponse(config, 'BMP配置文件加载成功');
        } catch (error) {
            logger.error('Error loading BMP config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleStartBmp(event, bmpConfigData) {
        const webContents = event.sender;
        try {
            if (null !== this.worker) {
                logger.error(`bmp协议已经启动`);
                return errorResponse('bmp协议已经启动');
            }

            logger.info(`${JSON.stringify(bmpConfigData)}`);

            // 获取日志级别配置
            if (this.logLevel) {
                bmpConfigData.logLevel = this.logLevel;
            }

            const workerPath = this.isDev
                ? path.join(__dirname, '../worker/bmpWorker.js')
                : path.join(process.resourcesPath, 'app', 'electron/worker/bmpWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            // 设置事件发送器的 webContents
            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            // 定义事件处理函数
            this.bmpInitiationHandler = data => {
                this.eventDispatcher.emit('bmp:initiation', successResponse(data.data));
            };

            this.bmpSessionUpdateHandler = data => {
                this.eventDispatcher.emit('bmp:sessionUpdate', successResponse(data.data));
            };

            this.bmpInstanceUpdateHandler = data => {
                this.eventDispatcher.emit('bmp:instanceUpdate', successResponse(data.data));
            };

            this.bmpRouteUpdateHandler = data => {
                this.eventDispatcher.emit('bmp:routeUpdate', successResponse(data.data));
            };

            this.bmpInstanceRouteUpdateHandler = data => {
                this.eventDispatcher.emit('bmp:instanceRouteUpdate', successResponse(data.data));
            };

            this.bmpTerminationHandler = data => {
                this.eventDispatcher.emit('bmp:termination', successResponse(data.data));
            };

            this.bmpStatisticsReportHandler = data => {
                this.eventDispatcher.emit('bmp:statisticsReport', successResponse(data.data));
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

            if (bmpConfigData.enableAuth) {
                // 设置 SSH 部署配置
                bmpConfigData.serverAddress = this.serverDeploymentConfig.serverAddress;
                bmpConfigData.sshUsername = this.serverDeploymentConfig.sshUsername;
                bmpConfigData.sshPassword = this.serverDeploymentConfig.sshPassword;
            }

            // 如果启用认证且使用 keychain 模式，解析当前有效密钥
            if (bmpConfigData.authMode === 'keychain' && bmpConfigData.keychainId) {
                if (!this.keychainManager) {
                    throw new Error('KeychainManager not initialized');
                }

                logger.info(`Using TCP-AO for keychain: ${bmpConfigData.keychainId}`);

                const tcpAoKeysJson = this.keychainManager.generateTcpAoKeysJson(bmpConfigData.keychainId);

                if (!tcpAoKeysJson) {
                    throw new Error('当前时间段没有有效的密钥');
                }

                // 设置 TCP-AO 配置
                bmpConfigData.useTcpAo = true;
                bmpConfigData.tcpAoKeysJson = tcpAoKeysJson;

                logger.info(`TCP-AO enabled with ${JSON.parse(tcpAoKeysJson).length} keys`);
            }

            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.START_BMP, bmpConfigData);

            // 这里肯定是启动成功了，如果失败，会抛出异常
            logger.info(`bmp启动成功 result: ${JSON.stringify(result)}`);
            return successResponse(null, result.msg);
        } catch (error) {
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.INITIATION, this.bmpInitiationHandler);
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.SESSION_UPDATE, this.bmpSessionUpdateHandler);
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, this.bmpInstanceUpdateHandler);
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, this.bmpRouteUpdateHandler);
            this.worker.removeEventListener(
                BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE,
                this.bmpInstanceRouteUpdateHandler
            );
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.TERMINATION, this.bmpTerminationHandler);
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, this.bmpStatisticsReportHandler);
            await this.worker.terminate();
            this.worker = null;
            this.eventDispatcher.cleanup(); // 清理事件发送器
            this.eventDispatcher = null;
            logger.error('Error starting BMP:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleStopBmp() {
        if (null === this.worker) {
            logger.error('BMP未启动');
            return errorResponse('BMP未启动');
        }

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.STOP_BMP, null);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('Error stopping BMP:', error.message);
            return errorResponse(error.message);
        } finally {
            // 移除事件监听器
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.INITIATION, this.bmpInitiationHandler);
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.SESSION_UPDATE, this.bmpSessionUpdateHandler);
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, this.bmpInstanceUpdateHandler);
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, this.bmpRouteUpdateHandler);
            this.worker.removeEventListener(
                BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE,
                this.bmpInstanceRouteUpdateHandler
            );
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.TERMINATION, this.bmpTerminationHandler);
            this.worker.removeEventListener(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, this.bmpStatisticsReportHandler);
            await this.worker.terminate();
            this.worker = null;
            this.eventDispatcher.cleanup(); // 清理事件发送器
            this.eventDispatcher = null;
        }
    }

    async handleGetClientList() {
        if (null === this.worker) {
            return successResponse([], 'BMP未启动');
        }

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST, null);
            logger.info(`获取客户端列表成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取客户端列表成功');
        } catch (error) {
            logger.error('Error getting client list:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpSessions(event, client) {
        if (null === this.worker) {
            return successResponse([], 'BMP未启动');
        }

        logger.info(`获取BGP会话列表 client: ${JSON.stringify(client)}`);

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, client);
            logger.info(`获取BGP会话列表成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取BGP会话列表成功');
        } catch (error) {
            logger.error('Error getting bgp sessions:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpStatisticsReports(event, client) {
        if (null === this.worker) {
            return successResponse([], 'BMP未启动');
        }

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.GET_BGP_STATISTICS_REPORTS, client);
            return successResponse(result.data, '获取BGP统计报表成功');
        } catch (error) {
            logger.error('Error getting BGP statistics reports:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstanceStatisticsReports(event, client) {
        if (null === this.worker) {
            return successResponse([], 'BMP未启动');
        }

        try {
            const result = await this.worker.sendRequest(
                BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_STATISTICS_REPORTS,
                client
            );
            return successResponse(result.data, '获取BGP实例统计报表成功');
        } catch (error) {
            logger.error('Error getting BGP instance statistics reports:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpRoutes(event, client, session, af, ribType, page, pageSize, routeState) {
        if (null === this.worker) {
            return successResponse([], 'BMP未启动');
        }

        logger.info(
            `获取路由列表 client: ${JSON.stringify(client)} session: ${JSON.stringify(session)} af: ${JSON.stringify(af)} ribType: ${JSON.stringify(ribType)} page: ${JSON.stringify(page)} pageSize: ${JSON.stringify(pageSize)}`
        );

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES, {
                client,
                session,
                af,
                ribType,
                page,
                pageSize,
                routeState
            });
            logger.info(`获取路由列表成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取路由列表成功');
        } catch (error) {
            logger.error('Error getting routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstanceRoutes(event, client, instance, page, pageSize, routeState) {
        if (null === this.worker) {
            return successResponse([], 'BMP未启动');
        }

        logger.info(
            `获取BGP实例路由列表 client: ${JSON.stringify(client)} instance: ${JSON.stringify(instance)} page: ${JSON.stringify(page)} pageSize: ${JSON.stringify(pageSize)}`
        );

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES, {
                client,
                instance,
                page,
                pageSize,
                routeState
            });
            logger.info(`获取BGP实例路由列表成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取BGP实例路由列表成功');
        } catch (error) {
            logger.error('Error getting routes:', error.message);
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
        if (null === this.worker) {
            return successResponse([], 'BMP未启动');
        }

        logger.info(`获取BGP实例列表 client: ${JSON.stringify(client)}`);

        try {
            const result = await this.worker.sendRequest(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, client);
            logger.info(`获取BGP实例列表成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取BGP实例列表成功');
        } catch (error) {
            logger.error('Error getting BGP instances:', error.message);
            return errorResponse(error.message);
        }
    }

    getBmpRunning() {
        return null !== this.worker;
    }
}

module.exports = BmpApp;
