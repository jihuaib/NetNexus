const net = require('net');
const util = require('util');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const BmpSession = require('./bmpSession');
const SshTunnel = require('../shared/sshTunnel');
const { getAfiAndSafi } = require('../../utils/bgpUtils');
const BmpBgpSession = require('./bmpBgpSession');
const BmpBgpRoute = require('./bmpBgpRoute');
const BmpConst = require('../../const/bmpConst');
const { buildRoutePrefixQuery, routeMatchesPrefixQuery } = require('../../utils/routePrefixUtils');
const RouteUpdateAggregator = require('../../utils/routeUpdateAggregator');
const { buildBmpRouteLens } = require('../../utils/bmpRouteLens');

class BmpWorker {
    constructor() {
        this.server = null;
        this.ipv6Server = null;
        this.socket = null;

        this.bmpConfigData = null; // bmp配置数据
        this.sshTunnel = null; // SSH隧道（用于MD5认证）

        this.bmpSessionMap = new Map(); // bmp会话map
        this.routeUpdateAggregator = new RouteUpdateAggregator();
        this.routeUpdateFlushTimer = null;
        this.routeUpdateFlushIntervalMs = 1000;

        // 创建消息处理器
        this.messageHandler = new WorkerMessageHandler();
        // 初始化消息处理器
        this.messageHandler.init();
        // 注册消息处理器
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.START_BMP, this.startBmp.bind(this));
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.STOP_BMP, this.stopBmp.bind(this));
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST, this.getClientList.bind(this));
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, this.getBgpSessions.bind(this));
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES, this.getBgpRoutes.bind(this));
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTE_DETAIL,
            this.getBgpRouteDetail.bind(this)
        );
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, this.getBgpInstances.bind(this));
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES,
            this.getBgpInstanceRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTE_DETAIL,
            this.getBgpInstanceRouteDetail.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.PURGE_STALE_BGP_ROUTES,
            this.purgeStaleBgpRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.PURGE_STALE_BGP_INSTANCE_ROUTES,
            this.purgeStaleBgpInstanceRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_STATISTICS_REPORTS,
            this.getBgpStatisticsReports.bind(this)
        );
        this.messageHandler.registerHandler(
            BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_STATISTICS_REPORTS,
            this.getBgpInstanceStatisticsReports.bind(this)
        );
        this.messageHandler.registerHandler(BmpConst.BMP_REQ_TYPES.GET_ROUTE_LENS, this.getRouteLens.bind(this));
    }

    createBmpSession(socket, clientAddress, clientPort) {
        const sessionKey = BmpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);
        this.removeBmpSessionByKey(sessionKey);

        const bmpSession = new BmpSession(this.messageHandler, this);
        this.bmpSessionMap.set(sessionKey, bmpSession);

        bmpSession.socket = socket;
        bmpSession.localIp = socket.localAddress;
        bmpSession.localPort = socket.localPort;
        bmpSession.remoteIp = clientAddress;
        bmpSession.remotePort = clientPort;

        return bmpSession;
    }

    removeBmpSessionByKey(sessionKey) {
        const bmpSession = this.bmpSessionMap.get(sessionKey);
        if (!bmpSession) {
            return null;
        }

        this.bmpSessionMap.delete(sessionKey);
        const clientInfo = bmpSession.getClientInfo();
        bmpSession.closeSession();
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.TERMINATION, { data: clientInfo });
        return bmpSession;
    }

    enqueueRouteUpdateEvent(update) {
        this.routeUpdateAggregator.enqueueRouteUpdate(update);
        this.scheduleRouteUpdateFlush();
    }

    enqueueInstanceRouteUpdateEvent(update) {
        this.routeUpdateAggregator.enqueueInstanceRouteUpdate(update);
        this.scheduleRouteUpdateFlush();
    }

    scheduleRouteUpdateFlush() {
        if (this.routeUpdateFlushTimer) {
            return;
        }

        this.routeUpdateFlushTimer = setTimeout(() => {
            this.flushRouteUpdateEvents();
        }, this.routeUpdateFlushIntervalMs);
    }

    flushRouteUpdateEvents() {
        if (this.routeUpdateFlushTimer) {
            clearTimeout(this.routeUpdateFlushTimer);
            this.routeUpdateFlushTimer = null;
        }

        const routeUpdates = this.routeUpdateAggregator.flushRouteUpdates();
        const instanceRouteUpdates = this.routeUpdateAggregator.flushInstanceRouteUpdates();

        routeUpdates.forEach(update => {
            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, { data: update });
        });
        instanceRouteUpdates.forEach(update => {
            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE, { data: update });
        });
    }

    clearRouteUpdateAggregation() {
        if (this.routeUpdateFlushTimer) {
            clearTimeout(this.routeUpdateFlushTimer);
            this.routeUpdateFlushTimer = null;
        }
        this.routeUpdateAggregator.clear();
    }

    async startTcpServer(messageId) {
        try {
            this.server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv4 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv4 localAddress: ${socket.localAddress}:${socket.localPort}`);
                const sessionKey = BmpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const bmpSession = this.bmpSessionMap.get(sessionKey);
                    if (!bmpSession) {
                        logger.error(`ipv4 Client ${clientAddress}:${clientPort} not found in bmpSessionMap`);
                        socket.destroy();
                        return;
                    }
                    bmpSession.recvMsg(data);
                });

                socket.on('end', () => {
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} end`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                socket.on('close', () => {
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} close`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                socket.on('error', err => {
                    logger.error(`ipv4 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                // 创建BMP会话
                this.createBmpSession(socket, clientAddress, clientPort);
            });

            this.ipv6Server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv6 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv6 localAddress: ${socket.localAddress}:${socket.localPort}`);
                const sessionKey = BmpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const bmpSession = this.bmpSessionMap.get(sessionKey);
                    if (!bmpSession) {
                        logger.error(`ipv6 Client ${clientAddress}:${clientPort} not found in bmpSessionMap`);
                        socket.destroy();
                        return;
                    }
                    bmpSession.recvMsg(data);
                });

                socket.on('end', () => {
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} end`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                socket.on('close', () => {
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} close`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                socket.on('error', err => {
                    logger.error(`ipv6 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                    this.removeBmpSessionByKey(sessionKey);
                });

                // 创建BMP会话
                this.createBmpSession(socket, clientAddress, clientPort);
            });

            // 启动ipv4服务器并监听端口
            const listenPormise = util.promisify(this.server.listen).bind(this.server);
            await listenPormise(this.bmpConfigData.port, '0.0.0.0');
            logger.info(`TCP Server listening on port ${this.bmpConfigData.port} at 0.0.0.0`);

            // 启动ipv6服务器并监听端口
            const ipv6ListenPormise = util.promisify(this.ipv6Server.listen).bind(this.ipv6Server);
            await ipv6ListenPormise(this.bmpConfigData.port, '::');
            logger.info(`TCP Server listening on port ${this.bmpConfigData.port} at ::`);

            logger.info(`bmp协议启动成功`);
            this.messageHandler.sendSuccessResponse(messageId, null, 'bmp协议启动成功');
        } catch (err) {
            logger.error(`Error starting TCP server: ${err.message}`);
            this.messageHandler.sendErrorResponse(messageId, 'bmp协议启动失败');
        }
    }

    async startBmp(messageId, bmpConfigData) {
        this.bmpConfigData = bmpConfigData;
        this.bmpConfigData.bmpV4TlvDraft =
            Number(this.bmpConfigData.bmpV4TlvDraft) === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                ? BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                : BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20;
        const defaultPathMarkingTlvType =
            this.bmpConfigData.bmpV4TlvDraft === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                ? BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.PATH_MARKING
                : BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING;
        const pathMarkingTlvType = Number(this.bmpConfigData.pathMarkingTlvType);
        this.bmpConfigData.pathMarkingTlvType =
            Number.isInteger(pathMarkingTlvType) && pathMarkingTlvType >= 1 && pathMarkingTlvType <= 0x3fff
                ? pathMarkingTlvType
                : defaultPathMarkingTlvType;

        // 设置日志级别
        if (this.bmpConfigData.logLevel) {
            logger.setLevel(this.bmpConfigData.logLevel);
            logger.info(`Worker log level set to: ${this.bmpConfigData.logLevel}`);
        }
        logger.info(`BMPv4 TLV draft set to draft-${this.bmpConfigData.bmpV4TlvDraft}`);
        logger.info(`BMP Path Marking TLV type set to ${this.bmpConfigData.pathMarkingTlvType}`);

        // 如果启用了 MD5 认证，使用 SSH 隧道启动远端代理。
        if (bmpConfigData.enableAuth && bmpConfigData.md5Password) {
            try {
                logger.info('TCP MD5 authentication enabled, creating SSH tunnel...');

                // 提取SSH服务器地址
                const sshHost = bmpConfigData.serverAddress;

                // 创建SSH隧道
                this.sshTunnel = new SshTunnel();
                await this.sshTunnel.connect({
                    host: sshHost,
                    username: bmpConfigData.sshUsername,
                    password: bmpConfigData.sshPassword
                });

                logger.info('Using TCP MD5 proxy');
                const proxyConfig = bmpConfigData.md5Password;

                // 启动远程代理
                // 代理监听 bmpConfigData.port (路由器连接这个端口)
                // 然后转发到 Windows BMP 服务器
                const localPort = parseInt(bmpConfigData.localPort);

                // 获取 Windows 客户端 IP（从 SSH 连接）
                let windowsIp = 'localhost';
                try {
                    const whoamiOutput = await this.sshTunnel.execCommand('echo $SSH_CLIENT');
                    const sshClientInfo = whoamiOutput.trim().split(' ');
                    if (sshClientInfo.length > 0) {
                        windowsIp = sshClientInfo[0]; // SSH 客户端 IP
                        logger.info(`Detected Windows client IP: ${windowsIp}`);
                    }
                } catch (error) {
                    logger.warn(`Could not detect Windows IP, using localhost: ${error.message}`);
                }

                await this.sshTunnel.startProxy(
                    'bmp', // 协议类型
                    bmpConfigData.peerIP, // BMP路由器IP（peer IP）
                    proxyConfig, // MD5密码
                    bmpConfigData.port, // Linux监听端口（路由器连接）
                    `${windowsIp}:${localPort}` // 转发到 Windows 的 localPort
                );

                logger.info('SSH tunnel and proxy started successfully');
                logger.info(`BMP router should connect to: ${sshHost}:${bmpConfigData.port}`);
                logger.info(`Proxy will forward to localhost:${localPort}`);

                // 启动本地TCP服务器 - 直接监听 localPort
                const originalPort = this.bmpConfigData.port;
                this.bmpConfigData.port = localPort;

                // 启动本地TCP服务器
                await this.startTcpServer(messageId);

                // 恢复原始端口配置
                this.bmpConfigData.port = originalPort;

                logger.info('Local BMP server started, waiting for connections from proxy');
            } catch (error) {
                logger.error(`Failed to setup SSH tunnel: ${error.message}`);
                this.messageHandler.sendErrorResponse(messageId, `SSH隧道连接失败: ${error.message}`);
                return;
            }
        } else {
            // 直接TCP模式
            await this.startTcpServer(messageId);
        }
    }

    async stopBmp(messageId) {
        logger.info('Stopping BMP server...');
        this.clearRouteUpdateAggregation();

        // 停止SSH隧道和代理
        if (this.sshTunnel) {
            try {
                // 停止远程代理
                if (this.bmpConfigData) {
                    const localPort = this.bmpConfigData.localPort;
                    const _sshHost = this.bmpConfigData.serverAddress;

                    const proxyConfig = this.bmpConfigData.md5Password;

                    // 获取 Windows 客户端 IP（与 startProxy 保持一致）
                    let windowsIp = 'localhost';
                    try {
                        const whoamiOutput = await this.sshTunnel.execCommand('echo $SSH_CLIENT');
                        const sshClientInfo = whoamiOutput.trim().split(' ');
                        if (sshClientInfo.length > 0) {
                            windowsIp = sshClientInfo[0];
                        }
                    } catch (error) {
                        // Ignore error, use localhost as fallback
                    }

                    await this.sshTunnel.stopProxy(
                        'bmp',
                        this.bmpConfigData.peerIP,
                        proxyConfig,
                        this.bmpConfigData.port,
                        `${windowsIp}:${localPort}`
                    );
                }
                // 断开SSH连接
                await this.sshTunnel.disconnect();
            } catch (error) {
                logger.error(`Error stopping SSH tunnel: ${error.message}`);
            }
            this.sshTunnel = null;
        }

        if (this.server) {
            this.server.close();
            this.server = null;
        }

        if (this.ipv6Server) {
            this.ipv6Server.close();
            this.ipv6Server = null;
        }

        // 清空配置数据
        this.bmpConfigData = null;

        // 发送全局终止事件通知前端
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.TERMINATION, { data: null });

        // 清空会话
        this.bmpSessionMap.forEach((session, _) => {
            session.closeSession();
        });
        this.bmpSessionMap.clear();
        this.messageHandler.sendSuccessResponse(messageId, null, 'bmp协议停止成功');
    }

    getClientList(messageId) {
        const clientList = [];
        this.bmpSessionMap.forEach((session, _) => {
            const clientInfo = session.getClientInfo();
            clientList.push(clientInfo);
        });
        this.messageHandler.sendSuccessResponse(messageId, clientList, '获取客户端列表成功');
    }

    getRouteLens(messageId, data = {}) {
        try {
            const result = buildBmpRouteLens(this.bmpSessionMap, data);
            this.messageHandler.sendSuccessResponse(messageId, result, '路由追踪查询成功');
        } catch (error) {
            logger.error(`Error getting Route Lens: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    getBgpSessions(messageId, client) {
        const bmpSessionKey = BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort);
        const bmpSession = this.bmpSessionMap.get(bmpSessionKey);
        const peerList = [];
        if (!bmpSession) {
            logger.error(`BMP会话 ${bmpSessionKey} 不存在`);
            this.messageHandler.sendErrorResponse(messageId, 'BMP会话不存在');
            return;
        }
        bmpSession.bgpSessionMap.forEach((session, _) => {
            peerList.push(session.getSessionInfo());
        });
        this.messageHandler.sendSuccessResponse(messageId, peerList, '获取对等体列表成功');
    }

    getBgpStatisticsReports(messageId, client) {
        const bmpSessionKey = BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort);
        const bmpSession = this.bmpSessionMap.get(bmpSessionKey);
        if (!bmpSession) {
            logger.error(`BMP会话 ${bmpSessionKey} 不存在`);
            this.messageHandler.sendErrorResponse(messageId, 'BMP会话不存在');
            return;
        }

        this.messageHandler.sendSuccessResponse(
            messageId,
            Array.from(bmpSession.bgpStatisticsReportMap.values()),
            '获取BGP统计报表成功'
        );
    }

    getBgpInstanceStatisticsReports(messageId, client) {
        const bmpSessionKey = BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort);
        const bmpSession = this.bmpSessionMap.get(bmpSessionKey);
        if (!bmpSession) {
            logger.error(`BMP会话 ${bmpSessionKey} 不存在`);
            this.messageHandler.sendErrorResponse(messageId, 'BMP会话不存在');
            return;
        }

        this.messageHandler.sendSuccessResponse(
            messageId,
            Array.from(bmpSession.bgpInstanceStatisticsReportMap.values()),
            '获取BGP实例统计报表成功'
        );
    }

    getBmpSessionByClient(client) {
        const bmpSessionKey = BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort);
        return {
            bmpSessionKey,
            bmpSession: this.bmpSessionMap.get(bmpSessionKey)
        };
    }

    getRouteKey(routeKey, routeInfo) {
        if (routeKey) {
            return routeKey;
        }

        if (!routeInfo) {
            return '';
        }

        return BmpBgpRoute.makeKey(routeInfo.pathId, routeInfo.rd, routeInfo.ip, routeInfo.mask);
    }

    getBgpSessionRouteMap(client, session, af, ribType) {
        const { bmpSessionKey, bmpSession } = this.getBmpSessionByClient(client);
        if (!bmpSession) {
            return { error: 'BMP会话不存在', log: `BMP会话 ${bmpSessionKey} 不存在` };
        }

        const bgpSessionKey = BmpBgpSession.makeKey(
            session.sessionType,
            session.sessionRd,
            session.sessionIp,
            session.sessionAs
        );
        const bgpSession = bmpSession.bgpSessionMap.get(bgpSessionKey);
        if (!bgpSession) {
            return { error: 'BGP会话不存在', log: `BMP会话 ${bmpSessionKey} 不存在BGP会话 ${bgpSessionKey}` };
        }

        const { afi, safi } = getAfiAndSafi(af);
        const afKey = `${afi}|${safi}`;
        const ribTypeRouteMap = bgpSession.bgpRoutes.get(afKey);
        if (!ribTypeRouteMap) {
            return { error: '地址族不存在', log: `BGP会话 ${bgpSessionKey} 不存在地址族 ${afKey}` };
        }

        const routeMap = ribTypeRouteMap.get(ribType);
        if (!routeMap) {
            return { error: 'ribType不存在', log: `BGP会话 ${bgpSessionKey} 不存在 ribType ${ribType}` };
        }

        return { bmpSession, bgpSession, routeMap, afi, safi };
    }

    getBgpInstanceRouteMap(client, instance) {
        const { bmpSessionKey, bmpSession } = this.getBmpSessionByClient(client);
        if (!bmpSession) {
            return { error: 'BMP会话不存在', log: `BMP会话 ${bmpSessionKey} 不存在` };
        }

        const { afi, safi } = getAfiAndSafi(instance.addrFamilyType);
        const bgpInstKey = BmpBgpSession.makeKey(instance.instanceType, instance.instanceRd, afi, safi);
        const bgpInstance = bmpSession.bgpInstanceMap.get(bgpInstKey);
        if (!bgpInstance) {
            return { error: 'BGP实例不存在', log: `BMP会话 ${bmpSessionKey} 不存在BGP实例 ${bgpInstKey}` };
        }

        return { bmpSession, bgpInstance, routeMap: bgpInstance.bgpRoutes, afi, safi };
    }

    sendRouteLookupError(messageId, lookup) {
        if (!lookup.error) {
            return false;
        }

        logger.error(lookup.log || lookup.error);
        this.messageHandler.sendErrorResponse(messageId, lookup.error);
        return true;
    }

    isRouteStateMatched(route, routeState) {
        if (routeState === BmpConst.BMP_ROUTE_STATE_FILTER.ALL) {
            return true;
        }

        const state = route.routeState || BmpConst.BMP_ROUTE_STATE.ACTIVE;
        return state === routeState;
    }

    getPagedRouteResult(routeMap, options) {
        const page = Math.max(1, Number(options.page) || 1);
        const pageSize = Math.max(1, Number(options.pageSize) || 10);
        const routeState = options.routeState || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
        const prefixQuery = buildRoutePrefixQuery(options.prefixFilter);
        const start = (page - 1) * pageSize;
        const list = [];
        let total = 0;

        const appendRoute = route => {
            if (!route || !this.isRouteStateMatched(route, routeState)) {
                return;
            }

            if (
                (prefixQuery.mode === 'scan' || prefixQuery.mode === 'index-or-scan') &&
                !routeMatchesPrefixQuery(route, prefixQuery)
            ) {
                return;
            }

            if (total >= start && list.length < pageSize) {
                list.push(route.getRouteListInfo());
            }
            total += 1;
        };

        const canUsePrefixIndex =
            (prefixQuery.mode === 'index' || prefixQuery.mode === 'index-or-scan') &&
            typeof options.getIndexedRouteKeys === 'function';
        const indexedRouteKeys = canUsePrefixIndex ? options.getIndexedRouteKeys(prefixQuery.key) : [];

        if (canUsePrefixIndex && (prefixQuery.mode === 'index' || indexedRouteKeys.length > 0)) {
            indexedRouteKeys.forEach(routeKey => {
                appendRoute(routeMap.get(routeKey));
            });
        } else {
            routeMap.forEach(route => {
                appendRoute(route);
            });
        }

        return { list, total };
    }

    getBgpInstanceRoutes(messageId, data) {
        const {
            client,
            instance,
            page,
            pageSize,
            routeState = BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
            prefixFilter
        } = data;
        const lookup = this.getBgpInstanceRouteMap(client, instance);
        if (this.sendRouteLookupError(messageId, lookup)) {
            return;
        }

        const { list, total } = this.getPagedRouteResult(lookup.routeMap, {
            page,
            pageSize,
            routeState,
            prefixFilter,
            getIndexedRouteKeys: prefixKey => lookup.bgpInstance.getRouteKeysByPrefix(prefixKey)
        });
        const summary = lookup.bgpInstance.getRouteSummary();

        this.messageHandler.sendSuccessResponse(messageId, { list, total, summary }, 'BGP实例获取路由列表成功');
    }

    getBgpInstanceRouteDetail(messageId, data) {
        const { client, instance, routeKey, route } = data;
        const lookup = this.getBgpInstanceRouteMap(client, instance);
        if (this.sendRouteLookupError(messageId, lookup)) {
            return;
        }

        const key = this.getRouteKey(routeKey, route);
        const bgpRoute = lookup.routeMap.get(key);
        if (!bgpRoute) {
            this.messageHandler.sendErrorResponse(messageId, '路由不存在');
            return;
        }

        this.messageHandler.sendSuccessResponse(messageId, bgpRoute.getRouteInfo(), 'BGP实例获取路由详情成功');
    }

    getBgpRoutes(messageId, data) {
        const {
            client,
            session,
            af,
            ribType,
            page,
            pageSize,
            routeState = BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
            prefixFilter
        } = data;
        const lookup = this.getBgpSessionRouteMap(client, session, af, ribType);
        if (this.sendRouteLookupError(messageId, lookup)) {
            return;
        }

        const { list, total } = this.getPagedRouteResult(lookup.routeMap, {
            page,
            pageSize,
            routeState,
            prefixFilter,
            getIndexedRouteKeys: prefixKey =>
                lookup.bgpSession.getRouteKeysByPrefix(lookup.afi, lookup.safi, ribType, prefixKey)
        });
        const summary = lookup.bgpSession.getRouteSummary(lookup.afi, lookup.safi, ribType);

        this.messageHandler.sendSuccessResponse(messageId, { list, total, summary }, '获取路由列表成功');
    }

    getBgpRouteDetail(messageId, data) {
        const { client, session, af, ribType, routeKey, route } = data;
        const lookup = this.getBgpSessionRouteMap(client, session, af, ribType);
        if (this.sendRouteLookupError(messageId, lookup)) {
            return;
        }

        const key = this.getRouteKey(routeKey, route);
        const bgpRoute = lookup.routeMap.get(key);
        if (!bgpRoute) {
            this.messageHandler.sendErrorResponse(messageId, '路由不存在');
            return;
        }

        this.messageHandler.sendSuccessResponse(messageId, bgpRoute.getRouteInfo(), '获取路由详情成功');
    }

    purgeStaleRouteMap(routeMap, onDelete) {
        let deleted = 0;
        routeMap.forEach((route, key) => {
            if (route.routeState === BmpConst.BMP_ROUTE_STATE.STALE) {
                if (typeof onDelete === 'function') {
                    onDelete(route, key);
                }
                routeMap.delete(key);
                deleted += 1;
            }
        });
        return deleted;
    }

    purgeStaleBgpInstanceRoutes(messageId, data) {
        const { client, instance } = data;
        const bmpSessionKey = BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort);
        const bmpSession = this.bmpSessionMap.get(bmpSessionKey);
        if (!bmpSession) {
            logger.error(`BMP会话 ${bmpSessionKey} 不存在`);
            this.messageHandler.sendErrorResponse(messageId, 'BMP会话不存在');
            return;
        }

        const { afi, safi } = getAfiAndSafi(instance.addrFamilyType);
        const bgpInstKey = BmpBgpSession.makeKey(instance.instanceType, instance.instanceRd, afi, safi);
        const bgpInstance = bmpSession.bgpInstanceMap.get(bgpInstKey);
        if (!bgpInstance) {
            logger.error(`BMP会话 ${bmpSessionKey} 不存在BGP实例 ${bgpInstKey}`);
            this.messageHandler.sendErrorResponse(messageId, 'BGP实例不存在');
            return;
        }

        const deleted = this.purgeStaleRouteMap(bgpInstance.bgpRoutes, (route, key) => {
            bgpInstance.removeRouteFromPrefixIndex(key, route);
            bgpInstance.recordRouteDelete(route);
            bgpInstance.releaseRouteAttr(route);
        });
        this.messageHandler.sendSuccessResponse(messageId, { deleted }, 'BGP实例过期路由清理成功');
    }

    purgeStaleBgpRoutes(messageId, data) {
        const { client, session, af, ribType } = data;
        const bmpSessionKey = BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort);
        const bmpSession = this.bmpSessionMap.get(bmpSessionKey);
        if (!bmpSession) {
            logger.error(`BMP会话 ${bmpSessionKey} 不存在`);
            this.messageHandler.sendErrorResponse(messageId, 'BMP会话不存在');
            return;
        }

        const bgpSessionKey = BmpBgpSession.makeKey(
            session.sessionType,
            session.sessionRd,
            session.sessionIp,
            session.sessionAs
        );
        const bgpSession = bmpSession.bgpSessionMap.get(bgpSessionKey);
        if (!bgpSession) {
            logger.error(`BMP会话 ${bmpSessionKey} 不存在BGP会话 ${bgpSessionKey}`);
            this.messageHandler.sendErrorResponse(messageId, 'BGP会话不存在');
            return;
        }

        const { afi, safi } = getAfiAndSafi(af);
        const ribTypeRouteMap = bgpSession.bgpRoutes.get(`${afi}|${safi}`);
        const routeMap = ribTypeRouteMap ? ribTypeRouteMap.get(ribType) : null;
        if (!routeMap) {
            this.messageHandler.sendErrorResponse(messageId, '路由表不存在');
            return;
        }

        const deleted = this.purgeStaleRouteMap(routeMap, (route, key) => {
            bgpSession.removeRouteFromPrefixIndex(afi, safi, ribType, key, route);
            bgpSession.recordRouteDelete(afi, safi, ribType, route);
            bgpSession.releaseRouteAttr(route);
        });
        this.messageHandler.sendSuccessResponse(messageId, { deleted }, '过期路由清理成功');
    }

    getBgpInstances(messageId, client) {
        const bmpSessionKey = BmpSession.makeKey(client.localIp, client.localPort, client.remoteIp, client.remotePort);
        const bmpSession = this.bmpSessionMap.get(bmpSessionKey);
        if (!bmpSession) {
            logger.error(`BMP会话 ${bmpSessionKey} 不存在`);
            this.messageHandler.sendErrorResponse(messageId, 'BMP会话不存在');
            return;
        }

        const instanceList = [];
        bmpSession.bgpInstanceMap.forEach((instance, _) => {
            instanceList.push(instance.getInstanceInfo());
        });

        this.messageHandler.sendSuccessResponse(messageId, instanceList, '获取实例列表成功');
    }
}

new BmpWorker(); // 启动监听
