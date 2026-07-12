const { successResponse, errorResponse } = require('../utils/responseUtils');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const WorkerWithPromise = require('../worker/core/workerWithPromise');
const logger = require('../log/logger');
const BmpConst = require('../const/bmpConst');
const EventDispatcher = require('../utils/eventDispatcher');

class BmpApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.bmpConfigFileKey = 'bmp-config';
        this.worker = null;
        this.eventDispatcher = null;

        this.bmpInitiationHandler = null;
        this.bmpSessionUpdateHandler = null;
        this.bmpRouteUpdateHandler = null;
        this.bmpTerminationHandler = null;
        this.bmpStatisticsReportHandler = null;

        this.serverDeploymentConfig = null;

        this.logLevel = null;

        this.registerHandlers();
    }

    registerHandlers() {
        this.ipcMain.handle('bmp:saveBmpConfig', this.handleSaveBmpConfig.bind(this));
        this.ipcMain.handle('bmp:loadBmpConfig', this.handleLoadBmpConfig.bind(this));
        this.ipcMain.handle('bmp:startBmp', this.handleStartBmp.bind(this));
        this.ipcMain.handle('bmp:stopBmp', this.handleStopBmp.bind(this));
        this.ipcMain.handle('bmp:getClientList', this.handleGetClientList.bind(this));
        this.ipcMain.handle('bmp:getRouteLens', this.handleGetRouteLens.bind(this));
        this.ipcMain.handle('bmp:getBgpSessions', this.handleGetBgpSessions.bind(this));
        this.ipcMain.handle('bmp:getBgpRoutes', this.handleGetBgpRoutes.bind(this));
        this.ipcMain.handle('bmp:getBgpRouteDetail', this.handleGetBgpRouteDetail.bind(this));
        this.ipcMain.handle('bmp:getBgpInstances', this.handleGetBgpInstances.bind(this));
        this.ipcMain.handle('bmp:getBgpInstanceRoutes', this.handleGetBgpInstanceRoutes.bind(this));
        this.ipcMain.handle('bmp:getBgpInstanceRouteDetail', this.handleGetBgpInstanceRouteDetail.bind(this));
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

    async sendWorkerQuery(reqType, data, notRunningData = null) {
        if (null === this.worker) {
            return successResponse(notRunningData, 'BMP未启动');
        }

        const result = await this.worker.sendRequest(reqType, data);
        return successResponse(result.data, result.msg);
    }

    async queryClientList() {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST, null, []);
    }

    async queryRouteLens(query, routeState) {
        if (this.worker === null) {
            return errorResponse('BMP未启动');
        }
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_ROUTE_LENS, { query, routeState });
    }

    async queryBgpSessions(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, client, []);
    }

    async queryBgpStatisticsReports(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_BGP_STATISTICS_REPORTS, client, []);
    }

    async queryBgpInstanceStatisticsReports(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_STATISTICS_REPORTS, client, []);
    }

    async queryBgpRoutes({ client, session, af, ribType, page, pageSize, routeState, prefixFilter }) {
        return this.sendWorkerQuery(
            BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES,
            {
                client,
                session,
                af,
                ribType,
                page,
                pageSize,
                routeState,
                prefixFilter
            },
            []
        );
    }

    async queryBgpRouteDetail({ client, session, af, ribType, routeKey }) {
        return this.sendWorkerQuery(
            BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTE_DETAIL,
            {
                client,
                session,
                af,
                ribType,
                routeKey
            },
            null
        );
    }

    async queryBgpInstances(client) {
        return this.sendWorkerQuery(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, client, []);
    }

    async queryBgpInstanceRoutes({ client, instance, page, pageSize, routeState, prefixFilter }) {
        return this.sendWorkerQuery(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES,
            {
                client,
                instance,
                page,
                pageSize,
                routeState,
                prefixFilter
            },
            []
        );
    }

    async queryBgpInstanceRouteDetail({ client, instance, routeKey }) {
        return this.sendWorkerQuery(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTE_DETAIL,
            {
                client,
                instance,
                routeKey
            },
            null
        );
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

            const workerPath = resolveWorkerPath('bmp/bmpWorker.js');

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
        try {
            const result = await this.queryClientList();
            logger.info(`获取客户端列表成功 result: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            logger.error('Error getting client list:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetRouteLens(event, query, routeState = BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE) {
        try {
            return await this.queryRouteLens(query, routeState);
        } catch (error) {
            logger.error('Error getting Route Lens:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpSessions(event, client) {
        logger.info(`获取BGP会话列表 client: ${JSON.stringify(client)}`);

        try {
            const result = await this.queryBgpSessions(client);
            logger.info(`获取BGP会话列表成功 result: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            logger.error('Error getting bgp sessions:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpStatisticsReports(event, client) {
        try {
            return await this.queryBgpStatisticsReports(client);
        } catch (error) {
            logger.error('Error getting BGP statistics reports:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstanceStatisticsReports(event, client) {
        try {
            return await this.queryBgpInstanceStatisticsReports(client);
        } catch (error) {
            logger.error('Error getting BGP instance statistics reports:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpRoutes(event, client, session, af, ribType, page, pageSize, routeState, prefixFilter) {
        logger.info(
            `获取路由列表 client: ${JSON.stringify(client)} session: ${JSON.stringify(session)} af: ${JSON.stringify(af)} ribType: ${JSON.stringify(ribType)} page: ${JSON.stringify(page)} pageSize: ${JSON.stringify(pageSize)} prefixFilter: ${JSON.stringify(prefixFilter)}`
        );

        try {
            const result = await this.queryBgpRoutes({
                client,
                session,
                af,
                ribType,
                page,
                pageSize,
                routeState,
                prefixFilter
            });
            logger.info(`获取路由列表成功 result: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            logger.error('Error getting routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpRouteDetail(event, client, session, af, ribType, routeKey) {
        try {
            return await this.queryBgpRouteDetail({
                client,
                session,
                af,
                ribType,
                routeKey
            });
        } catch (error) {
            logger.error('Error getting route detail:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstanceRoutes(event, client, instance, page, pageSize, routeState, prefixFilter) {
        logger.info(
            `获取BGP实例路由列表 client: ${JSON.stringify(client)} instance: ${JSON.stringify(instance)} page: ${JSON.stringify(page)} pageSize: ${JSON.stringify(pageSize)} prefixFilter: ${JSON.stringify(prefixFilter)}`
        );

        try {
            const result = await this.queryBgpInstanceRoutes({
                client,
                instance,
                page,
                pageSize,
                routeState,
                prefixFilter
            });
            logger.info(`获取BGP实例路由列表成功 result: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            logger.error('Error getting routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetBgpInstanceRouteDetail(event, client, instance, routeKey) {
        try {
            return await this.queryBgpInstanceRouteDetail({
                client,
                instance,
                routeKey
            });
        } catch (error) {
            logger.error('Error getting instance route detail:', error.message);
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
        logger.info(`获取BGP实例列表 client: ${JSON.stringify(client)}`);

        try {
            const result = await this.queryBgpInstances(client);
            logger.info(`获取BGP实例列表成功 result: ${JSON.stringify(result)}`);
            return result;
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
