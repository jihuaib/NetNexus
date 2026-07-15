const net = require('net');
const util = require('util');
const BgpConst = require('../../const/bgpConst');
const { forEachGeneratedRouteIp } = require('../../utils/ipUtils');
const { getAfiAndSafi, getAddrFamilyType } = require('../../utils/bgpUtils');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const BgpSession = require('./bgpSession');
const BgpInstance = require('./bgpInstance');
const CommonUtils = require('../../utils/commonUtils');
const BgpRoute = require('./bgpRoute');
const BgpRouteSqliteStore = require('./bgpRouteSqliteStore');
const {
    buildLabelGenerationContext,
    getGeneratedLabel,
    buildSrv6SidGenerationContext,
    getGeneratedSrv6Sid,
    forEachQpGeneratedRoute,
    getGeneratedUnicastPathIds,
    buildRandomAsPathGenerationContext,
    getGeneratedRandomAsPath
} = require('../../utils/bgpRouteGenerator');

function makeRouteLookupKey(addressFamily, route) {
    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
        return BgpRoute.makeUnicastKey(route?.pathId, route?.rd, route?.ip, route?.mask);
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_QP) {
        return BgpRoute.makeQpKey(route?.dqpn, route?.ip, route?.mask);
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
        return makeMvpnRouteKey(route);
    }

    return BgpRoute.makeKey(route?.ip, route?.mask);
}

function getMvpnRouteKeySourceAs(routeType, sourceAs) {
    const type = Number(routeType);
    return [
        BgpConst.BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD,
        BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
        BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
    ].includes(type)
        ? sourceAs || ''
        : '';
}

function makeMvpnRouteKey(route) {
    return [
        route?.routeType,
        route?.rd,
        getMvpnRouteKeySourceAs(route?.routeType, route?.sourceAs),
        route?.sourceIp || '',
        route?.groupIp || '',
        route?.originatingRouterIp || ''
    ].join('|');
}

function isUnicastAddressFamily(addressFamily) {
    return addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC;
}

function hasExplicitPathId(route) {
    return route?.pathId !== undefined && route?.pathId !== null && route?.pathId !== '';
}

function shouldEnableAddPathForAddressFamily(config, addressFamily) {
    const normalizedFamily = Number(addressFamily);
    const familyConfig =
        config?.addressFamilyConfig?.[String(normalizedFamily)] ||
        config?.addressFamilyConfig?.[normalizedFamily] ||
        {};
    return isUnicastAddressFamily(normalizedFamily) && familyConfig.sendAddPath === true;
}

function enableLocalAddPathForUnicastFamilies(bgpSession, config, addressFamilies) {
    (addressFamilies || []).forEach(family => {
        const addressFamily = Number(family);
        if (!shouldEnableAddPathForAddressFamily(config, addressFamily)) {
            return;
        }
        const { afi, safi } = getAfiAndSafi(addressFamily);
        bgpSession.setLocalAddPath(afi, safi, BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE);
    });
}

function getImportedRouteAttr(instance, route) {
    const routeAttr = instance.extractRouteAttr(route);
    if (!Object.prototype.hasOwnProperty.call(routeAttr, 'customAttr')) {
        routeAttr.customAttr = '';
    }
    if (!Object.prototype.hasOwnProperty.call(routeAttr, 'rt')) {
        routeAttr.rt = '';
    }
    return routeAttr;
}

function getPeerAddressFamilyOptions(config, addressFamily, allowSrv6PrefixSid = false) {
    const familyConfig =
        config?.addressFamilyConfig?.[String(addressFamily)] || config?.addressFamilyConfig?.[addressFamily] || {};
    const normalizedFamily = Number(addressFamily);
    return {
        sendSrv6PrefixSid:
            allowSrv6PrefixSid &&
            (normalizedFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC ||
                normalizedFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) &&
            familyConfig.sendSrv6PrefixSid === true
    };
}

function getDefaultSrv6EndpointBehavior(addressFamily) {
    return Number(addressFamily) === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC
        ? BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT4
        : BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6;
}

function getAddressFamilyFlag(addressFamily) {
    switch (Number(addressFamily)) {
        case BgpConst.BGP_ADDR_FAMILY.IPV4_UNC:
            return BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_UNC;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_UNC:
            return BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_UNC;
        case BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN:
            return BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_MVPN;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN:
            return BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_MVPN;
        case BgpConst.BGP_ADDR_FAMILY.IPV4_QP:
            return BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_QP;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_QP:
            return BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_QP;
        case BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST:
            return BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_LABEL_UNICAST;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_LABEL_UNICAST:
            return BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_LABEL_UNICAST;
        default:
            return 0;
    }
}

class BgpWorker {
    constructor() {
        this.ipv6Server = null;
        this.server = null;

        this.bgpConfigData = null; // bgp配置数据
        this.ipv4PeerConfigData = null; // ipv4邻居配置数据
        this.ipv6PeerConfigData = null; // ipv6邻居配置数据

        this.bgpSessionMap = new Map();
        this.bgpInstanceMap = new Map();
        this.routeStore = null;

        // 创建消息处理器
        this.messageHandler = new WorkerMessageHandler();
        // 初始化消息处理器
        this.messageHandler.init();
        // 注册消息处理器
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.START_BGP, this.startBgp.bind(this));
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.STOP_BGP, this.stopBgp.bind(this));
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.CONFIG_IPV4_PEER, this.configIpv4Peer.bind(this));
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.CONFIG_IPV6_PEER, this.configIpv6Peer.bind(this));
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.GET_PEER_INFO, this.getPeerInfo.bind(this));
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.DELETE_PEER, this.deletePeer.bind(this));
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_ROUTES,
            this.generateRoutes.bind(this)
        );
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.DELETE_IPV4_ROUTES, this.deleteRoute.bind(this));
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.GENERATE_IPV6_ROUTES,
            this.generateRoutes.bind(this)
        );
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.DELETE_IPV6_ROUTES, this.deleteRoute.bind(this));
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.DELETE_ALL_ROUTES_BY_FAMILY,
            this.deleteAllRoutesByFamily.bind(this)
        );
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.GET_ROUTES, this.getRoutes.bind(this));
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.GET_ROUTE_DETAIL, this.getRouteDetail.bind(this));

        // MVPN
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_MVPN_ROUTES,
            this.generateMvpnRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.DELETE_IPV4_MVPN_ROUTES,
            this.deleteMvpnRoutes.bind(this)
        );
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.IMPORT_ROUTES, this.importRoutes.bind(this));
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.GET_INSTANCE_INFO, this.getInstanceInfo.bind(this));

        // QP
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_QP_ROUTES,
            this.generateQpRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.GENERATE_IPV6_QP_ROUTES,
            this.generateQpRoutes.bind(this)
        );
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.DELETE_IPV4_QP_ROUTES,
            this.deleteQpRoute.bind(this)
        );
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.DELETE_IPV6_QP_ROUTES,
            this.deleteQpRoute.bind(this)
        );
    }

    async startTcpServer(messageId) {
        try {
            const listenPort = this.getListenPort();
            this.server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv4 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv4 localAddress: ${socket.localAddress}:${socket.localPort}`);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const bgpSession = this.bgpSessionMap.get(BgpSession.makeKey(0, socket.remoteAddress));
                    if (!bgpSession) {
                        socket.destroy();
                        return;
                    }
                    bgpSession.recvMsg(data);
                });

                socket.on('end', () => {
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} end`);
                });

                socket.on('close', () => {
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} close`);
                    const bgpSession = this.bgpSessionMap.get(BgpSession.makeKey(0, clientAddress));
                    if (bgpSession) {
                        bgpSession.handleSocketClosed(socket);
                    }
                });

                socket.on('error', err => {
                    logger.error(`ipv4 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                });

                const bgpSession = this.bgpSessionMap.get(BgpSession.makeKey(0, socket.remoteAddress));
                if (!bgpSession) {
                    socket.destroy();
                    return;
                }

                bgpSession.tcpConnectSuccess(socket);
            });

            this.ipv6Server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv6 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv6 localAddress: ${socket.localAddress}:${socket.localPort}`);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const bgpSession = this.bgpSessionMap.get(BgpSession.makeKey(0, socket.remoteAddress));
                    if (!bgpSession) {
                        socket.destroy();
                        return;
                    }
                    bgpSession.recvMsg(data);
                });

                socket.on('end', () => {
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} end`);
                });

                socket.on('close', () => {
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} close`);
                    const bgpSession = this.bgpSessionMap.get(BgpSession.makeKey(0, clientAddress));
                    if (bgpSession) {
                        bgpSession.handleSocketClosed(socket);
                    }
                });

                socket.on('error', err => {
                    logger.error(`ipv6 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                });

                const bgpSession = this.bgpSessionMap.get(BgpSession.makeKey(0, socket.remoteAddress));
                if (!bgpSession) {
                    socket.destroy();
                    return;
                }

                bgpSession.tcpConnectSuccess(socket);
            });

            // 启动ipv4服务器并监听端口
            const listenPormise = util.promisify(this.server.listen).bind(this.server);
            await listenPormise(listenPort, '0.0.0.0');
            logger.info(`TCP Server listening on port ${listenPort} at 0.0.0.0`);
            // 启动ipv6服务器并监听端口
            const listenIpv6Pormise = util.promisify(this.ipv6Server.listen).bind(this.ipv6Server);
            await listenIpv6Pormise(listenPort, '::');
            logger.info(`TCP Server listening on port ${listenPort} at ::`);

            logger.info(`bgp协议启动成功`);
            this.messageHandler.sendSuccessResponse(messageId, null, 'bgp协议启动成功');
        } catch (err) {
            logger.error(`Error starting TCP server: ${err.message}`);
            this.messageHandler.sendErrorResponse(messageId, 'bgp协议启动失败');
        }
    }

    getListenPort() {
        const port = Number(this.bgpConfigData?.port);
        if (Number.isInteger(port) && port >= 1 && port <= 65535) {
            return port;
        }
        return BgpConst.BGP_DEFAULT_PORT;
    }

    startBgp(messageId, bgpConfigData) {
        this.bgpConfigData = bgpConfigData;

        try {
            this.routeStore = new BgpRouteSqliteStore({ dbPath: bgpConfigData.routeDatabasePath || ':memory:' });
            this.routeStore.open();
        } catch (error) {
            logger.error(`BGP SQLite路由库打开失败: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, `BGP路由库打开失败: ${error.message}`);
            return;
        }

        // 设置日志级别
        if (this.bgpConfigData.logLevel) {
            logger.setLevel(this.bgpConfigData.logLevel);
            logger.info(`Worker log level set to: ${this.bgpConfigData.logLevel}`);
        }

        this.bgpConfigData.addressFamily.forEach(addressFamily => {
            const { afi, safi } = getAfiAndSafi(addressFamily);
            // 创建bgp实例
            this.bgpInstanceMap.set(BgpInstance.makeKey(0, afi, safi), new BgpInstance(0, afi, safi, this.routeStore));
        });

        // 启动tcp服务器
        this.startTcpServer(messageId);
    }

    configIpv4Peer(messageId, ipv4PeerConfigData) {
        let isExist = false;
        let errorFamily = '';
        for (let i = 0; i < ipv4PeerConfigData.addressFamily.length; i++) {
            const family = ipv4PeerConfigData.addressFamily[i];
            const { afi, safi } = getAfiAndSafi(family);
            const bgpInstance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
            if (!bgpInstance) {
                // 有地址组实例没创建
                isExist = false;
                errorFamily = family;
                break;
            }
            isExist = true;
        }

        if (!isExist) {
            logger.error(`bgp实例不存在: ${errorFamily}`);
            this.messageHandler.sendErrorResponse(messageId, `bgp实例不存在: ${errorFamily}`);
            return;
        }

        // 创建session结构
        const sessKey = BgpSession.makeKey(0, ipv4PeerConfigData.peerIp);
        let bgpSession = null;
        if (this.bgpSessionMap.has(sessKey)) {
            bgpSession = this.bgpSessionMap.get(sessKey);
            bgpSession.clearSession();
            bgpSession.resetSession();
            // 清空peer
            bgpSession.instanceMap.forEach((instance, _) => {
                instance.peerMap.delete(bgpSession.peerIp);
            });
        } else {
            bgpSession = new BgpSession(0, ipv4PeerConfigData.peerIp, this.bgpInstanceMap, this.messageHandler);
        }
        bgpSession.localAs = this.bgpConfigData.localAs;
        bgpSession.peerAs = ipv4PeerConfigData.peerAs;
        bgpSession.routerId = this.bgpConfigData.routerId;
        bgpSession.holdTime = ipv4PeerConfigData.holdTime;
        this.bgpSessionMap.set(sessKey, bgpSession);
        // 设置本地能力标志
        ipv4PeerConfigData.openCap.forEach(cap => {
            if (cap === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.MULTIPROTOCOL_EXTENSIONS
                );
                // 设置本地地址族标志
                ipv4PeerConfigData.addressFamily.forEach(family => {
                    const familyFlag = getAddressFamilyFlag(family);
                    if (familyFlag) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            familyFlag
                        );
                        return;
                    }
                    if (family === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_UNC
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_UNC
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_MVPN
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_MVPN
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV4_QP) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_QP
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV6_QP) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_QP
                        );
                    }
                });
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.ROUTE_REFRESH
                );
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS
                );
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.BGP_ROLE
                );
                bgpSession.localRole = ipv4PeerConfigData.role;
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING
                );
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.ADD_PATH
                );
                enableLocalAddPathForUnicastFamilies(bgpSession, ipv4PeerConfigData, ipv4PeerConfigData.addressFamily);
            }
        });
        bgpSession.openCapCustom = ipv4PeerConfigData.openCapCustom;

        // 获取bgp实例
        ipv4PeerConfigData.addressFamily.forEach(family => {
            const { afi, safi } = getAfiAndSafi(family);
            const bgpInstance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
            bgpSession.setAddressFamilyOptions(family, getPeerAddressFamilyOptions(ipv4PeerConfigData, family, false));
            bgpInstance.addPeer(bgpSession);
        });

        this.ipv4PeerConfigData = ipv4PeerConfigData;

        logger.info(`ipv4 邻居配置成功`);
        this.messageHandler.sendSuccessResponse(messageId, null, `ipv4 邻居配置成功`);
    }

    configIpv6Peer(messageId, ipv6PeerConfigData) {
        let isExist = false;
        let errorFamily = '';
        for (let i = 0; i < ipv6PeerConfigData.addressFamilyIpv6.length; i++) {
            const family = ipv6PeerConfigData.addressFamilyIpv6[i];
            const { afi, safi } = getAfiAndSafi(family);
            const bgpInstance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
            if (!bgpInstance) {
                // 有地址组实例没创建
                isExist = false;
                errorFamily = family;
                break;
            }
            isExist = true;
        }

        if (!isExist) {
            logger.error(`bgp实例不存在: ${errorFamily}`);
            this.messageHandler.sendErrorResponse(messageId, `bgp实例不存在: ${errorFamily}`);
            return;
        }

        // 创建session结构
        const sessKey = BgpSession.makeKey(0, ipv6PeerConfigData.peerIpv6);
        let bgpSession = null;
        if (this.bgpSessionMap.has(sessKey)) {
            bgpSession = this.bgpSessionMap.get(sessKey);
            bgpSession.clearSession();
            bgpSession.resetSession();
            // 清空peer
            bgpSession.instanceMap.forEach((instance, _) => {
                instance.peerMap.delete(bgpSession.peerIp);
            });
        } else {
            bgpSession = new BgpSession(0, ipv6PeerConfigData.peerIpv6, this.bgpInstanceMap, this.messageHandler);
        }
        bgpSession.localAs = this.bgpConfigData.localAs;
        bgpSession.peerAs = ipv6PeerConfigData.peerIpv6As;
        bgpSession.routerId = this.bgpConfigData.routerId;
        bgpSession.holdTime = ipv6PeerConfigData.holdTimeIpv6;
        this.bgpSessionMap.set(sessKey, bgpSession);
        // 设置本地能力标志
        ipv6PeerConfigData.openCapIpv6.forEach(cap => {
            if (cap === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.MULTIPROTOCOL_EXTENSIONS
                );
                // 设置本地地址族标志
                ipv6PeerConfigData.addressFamilyIpv6.forEach(family => {
                    const familyFlag = getAddressFamilyFlag(family);
                    if (familyFlag) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            familyFlag
                        );
                        return;
                    }
                    if (family === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_UNC
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_UNC
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_MVPN
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_MVPN
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV4_QP) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_QP
                        );
                    } else if (family === BgpConst.BGP_ADDR_FAMILY.IPV6_QP) {
                        bgpSession.localAddrFamilyFlags = CommonUtils.BIT_SET(
                            bgpSession.localAddrFamilyFlags,
                            BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_QP
                        );
                    }
                });
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.ROUTE_REFRESH
                );
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS
                );
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.BGP_ROLE
                );
                bgpSession.localRole = ipv6PeerConfigData.roleIpv6;
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING
                );
            } else if (cap === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                bgpSession.localCapFlags = CommonUtils.BIT_SET(
                    bgpSession.localCapFlags,
                    BgpConst.BGP_CAP_FLAGS.ADD_PATH
                );
                enableLocalAddPathForUnicastFamilies(
                    bgpSession,
                    ipv6PeerConfigData,
                    ipv6PeerConfigData.addressFamilyIpv6
                );
            }
        });
        bgpSession.openCapCustom = ipv6PeerConfigData.openCapCustomIpv6;

        // 获取bgp实例
        ipv6PeerConfigData.addressFamilyIpv6.forEach(family => {
            const { afi, safi } = getAfiAndSafi(family);
            const bgpInstance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
            bgpSession.setAddressFamilyOptions(family, getPeerAddressFamilyOptions(ipv6PeerConfigData, family, true));
            bgpInstance.addPeer(bgpSession);
        });

        this.ipv6PeerConfigData = ipv6PeerConfigData;

        logger.info(`ipv6 邻居配置成功`);
        this.messageHandler.sendSuccessResponse(messageId, null, `ipv6 邻居配置成功`);
    }

    getInstanceInfo(messageId) {
        const instanceInfoList = [];
        this.bgpInstanceMap.forEach((instance, _) => {
            const addressFamily = getAddrFamilyType(instance.afi, instance.safi);
            instanceInfoList.push({
                addressFamily,
                routeCount: instance.routeMap ? instance.routeMap.size : 0,
                peerCount: instance.peerMap ? instance.peerMap.size : 0
            });
        });
        this.messageHandler.sendSuccessResponse(messageId, instanceInfoList, '实例信息查询成功');
    }

    getPeerInfo(messageId) {
        const ipv4PeerInfoList = [];
        const ipv6PeerInfoList = [];
        const ipv4LabelPeerInfoList = [];
        const ipv4MvpnPeerInfoList = [];
        const ipv6MvpnPeerInfoList = [];
        const ipv4QpPeerInfoList = [];
        const ipv6QpPeerInfoList = [];
        this.bgpInstanceMap.forEach((instance, instanceKey) => {
            if (instance.peerMap && instance.peerMap.size > 0) {
                instance.peerMap.forEach((peer, _) => {
                    const peerInfo = peer.getPeerInfo();
                    if (peerInfo.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC) {
                        ipv4PeerInfoList.push(peerInfo);
                    } else if (peerInfo.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
                        ipv6PeerInfoList.push(peerInfo);
                    } else if (peerInfo.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) {
                        ipv4LabelPeerInfoList.push(peerInfo);
                    } else if (peerInfo.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
                        ipv4MvpnPeerInfoList.push(peerInfo);
                    } else if (peerInfo.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN) {
                        ipv6MvpnPeerInfoList.push(peerInfo);
                    } else if (peerInfo.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP) {
                        ipv4QpPeerInfoList.push(peerInfo);
                    } else if (peerInfo.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_QP) {
                        ipv6QpPeerInfoList.push(peerInfo);
                    }
                });
            } else {
                logger.warn(`peerMap is empty or undefined for instance: ${instanceKey}`);
            }
        });

        const peerInfoList = {
            [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]: [...ipv4PeerInfoList],
            [BgpConst.BGP_ADDR_FAMILY.IPV6_UNC]: [...ipv6PeerInfoList],
            [BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST]: [...ipv4LabelPeerInfoList],
            [BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN]: [...ipv4MvpnPeerInfoList],
            [BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN]: [...ipv6MvpnPeerInfoList],
            [BgpConst.BGP_ADDR_FAMILY.IPV4_QP]: [...ipv4QpPeerInfoList],
            [BgpConst.BGP_ADDR_FAMILY.IPV6_QP]: [...ipv6QpPeerInfoList]
        };
        this.messageHandler.sendSuccessResponse(messageId, peerInfoList, '邻居信息查询成功');
    }

    stopBgp(messageId) {
        if (this.server) {
            this.server.close();
            this.server = null;
        }

        if (this.ipv6Server) {
            this.ipv6Server.close();
            this.ipv6Server = null;
        }

        // 清空peerMap
        this.bgpInstanceMap.forEach((instance, _) => {
            instance.peerMap.clear();
        });

        // 关闭session socket
        this.bgpSessionMap.forEach((session, _) => {
            session.clearSession();
            session.resetSession();
        });

        // 清空sessionMap
        this.bgpSessionMap.clear();

        // 清空instanceMap
        this.bgpInstanceMap.clear();

        if (this.routeStore) {
            this.routeStore.sweepOrphanAttributes();
            this.routeStore.close();
            this.routeStore = null;
        }

        // 清空配置数据
        this.bgpConfigData = null;
        this.ipv4PeerConfigData = null;
        this.ipv6PeerConfigData = null;

        logger.info(`BGP stopped successfully`);

        // Send response using messageHandler
        this.messageHandler.sendSuccessResponse(messageId, null, 'bgp协议停止成功');
    }

    generateRoutes(messageId, config) {
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const ipType = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
        const addressFamily = Number(config.addressFamily);
        const isLabelUnicast = addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
        const isSrv6CapableUnicast =
            addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC;
        const labelContext = isLabelUnicast ? buildLabelGenerationContext(config) : null;
        const generatedUnicastPathIds = isSrv6CapableUnicast ? getGeneratedUnicastPathIds(config) : [null];
        const routeCount = Number(config.count);
        const randomAsPathContext = buildRandomAsPathGenerationContext(config);
        const srv6Context = isSrv6CapableUnicast
            ? buildSrv6SidGenerationContext(
                  {
                      ...config,
                      count:
                          Number.isFinite(routeCount) && routeCount > 0
                              ? Math.floor(routeCount) * generatedUnicastPathIds.length
                              : config.count
                  },
                  {
                      defaultEndpointBehavior: getDefaultSrv6EndpointBehavior(addressFamily)
                  }
              )
            : null;
        const nextCustomAttr = config.customAttr || '';
        const nextRt = config.rt || '';
        const hasAttrChanged = instance.customAttr !== nextCustomAttr || instance.rt !== nextRt;
        instance.customAttr = nextCustomAttr;
        instance.rt = nextRt;
        const routeBatchStream = hasAttrChanged ? null : instance.createRouteBatchStream();

        let inserted = 0;
        let updated = 0;
        let unchanged = 0;
        let generatedCount = 0;
        let routeIndex = 0;
        let entries = [];
        const flush = () => {
            if (entries.length === 0) return;
            const batch = entries;
            entries = [];
            const stats = instance.upsertRouteBatch(batch);
            inserted += stats.inserted;
            updated += stats.updated;
            unchanged += stats.unchanged;
            if (stats.changed > 0 && routeBatchStream) {
                routeBatchStream.write(batch.map(entry => entry.route));
            }
        };

        const addRoute = route => {
            const isUnicast = isUnicastAddressFamily(addressFamily);
            const rd = isUnicast ? BgpRoute.normalizeRd(route.rd ?? config.rd) : null;
            const pathId = isUnicast ? BgpRoute.normalizePathId(route.pathId) : null;
            const key = isUnicast
                ? BgpRoute.makeUnicastKey(pathId, rd, route.ip, route.mask)
                : BgpRoute.makeKey(route.ip, route.mask);
            const label = route.label !== undefined && route.label !== null ? route.label : null;
            const attr = instance.makeRouteAttr(null, {
                customAttr: instance.customAttr,
                rt: instance.rt,
                asPath:
                    route.asPath !== undefined
                        ? route.asPath
                        : randomAsPathContext.enabled
                          ? getGeneratedRandomAsPath(randomAsPathContext)
                          : undefined
            });

            if (srv6Context) {
                const generatedSid = srv6Context.enabled ? getGeneratedSrv6Sid(srv6Context, routeIndex) : '';
                attr.srv6Sid = route.srv6Sid !== undefined && route.srv6Sid !== null ? route.srv6Sid : generatedSid;
                attr.srv6EndpointBehavior =
                    route.srv6EndpointBehavior !== undefined && route.srv6EndpointBehavior !== null
                        ? route.srv6EndpointBehavior
                        : srv6Context.enabled
                          ? srv6Context.endpointBehavior
                          : null;
            }

            const bgpRoute = new BgpRoute(instance);
            bgpRoute.ip = route.ip;
            bgpRoute.mask = route.mask;
            if (isUnicast) {
                bgpRoute.rd = rd;
                bgpRoute.pathId = pathId;
            }
            if (isLabelUnicast) bgpRoute.label = label;
            bgpRoute._routeAttr = attr;
            entries.push({ routeKey: key, route: bgpRoute, attr });
            generatedCount += 1;
            routeIndex += 1;
            if (entries.length >= 2000) flush();
        };

        if (Array.isArray(config.routes)) {
            config.routes.forEach(addRoute);
        } else {
            forEachGeneratedRouteIp(ipType, config.prefix, config.mask, config.count, (route, index) => {
                if (isSrv6CapableUnicast) {
                    generatedUnicastPathIds.forEach(pathId =>
                        addRoute({ ...route, rd: config.rd, pathId, addressFamily })
                    );
                } else {
                    addRoute({
                        ...route,
                        rd: config.rd,
                        addressFamily,
                        label: labelContext ? getGeneratedLabel(labelContext, index) : null
                    });
                }
            });
        }
        flush();
        if (routeBatchStream) routeBatchStream.end();
        if (generatedCount === 0) {
            this.messageHandler.sendSuccessResponse(
                messageId,
                { added: 0, updated: 0, unchanged: 0, total: instance.routeMap.size },
                '路由生成成功'
            );
            return;
        }

        if (hasAttrChanged) {
            updated += instance.refreshRouteAttrs(null, { customAttr: instance.customAttr, rt: instance.rt });
            instance.sendRoute();
        }

        this.messageHandler.sendSuccessResponse(
            messageId,
            { added: inserted, updated, unchanged, total: instance.routeMap.size },
            '路由生成成功'
        );
    }

    deleteRoute(messageId, config) {
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const ipType = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
        const addressFamily = Number(config.addressFamily);
        const isUnicast = isUnicastAddressFamily(addressFamily);
        let withdrawnRoutes = [];
        let deleteKeys = new Set();
        let deleted = 0;
        let generatedCount = 0;
        const flush = () => {
            if (deleteKeys.size === 0) return;
            const batch = withdrawnRoutes;
            const stats = instance.deleteRouteBatch(deleteKeys);
            deleted += stats.deleted;
            deleteKeys = new Set();
            withdrawnRoutes = [];
            if (stats.deleted === 0) return;
            instance.withdrawRoute(batch);
            if (isUnicast) {
                const replacements = new Map();
                batch.forEach(route => {
                    const prefixKey = BgpRoute.makeUnicastPrefixKey(route.rd, route.ip, route.mask);
                    if (replacements.has(prefixKey)) return;
                    const replacement = instance.routeMap.queryPrefix(route.ip, {
                        prefixLength: route.mask,
                        rd: BgpRoute.normalizeRd(route.rd),
                        bestPathOnly: true,
                        pageSize: 1,
                        includeTotal: false
                    }).list[0];
                    if (replacement) replacements.set(prefixKey, replacement);
                });
                instance.sendRouteBatch(Array.from(replacements.values()));
            }
        };

        const queueExisting = route => {
            if (!route || deleteKeys.has(route.routeKey)) return;
            deleteKeys.add(route.routeKey);
            withdrawnRoutes.push(route);
            if (deleteKeys.size >= 2000) flush();
        };

        const deleteInput = route => {
            generatedCount += 1;
            if (isUnicast) {
                const rd = BgpRoute.normalizeRd(route.rd ?? config.rd);
                if (hasExplicitPathId(route)) {
                    queueExisting(
                        instance.routeMap.get(BgpRoute.makeUnicastKey(route.pathId, rd, route.ip, route.mask))
                    );
                } else {
                    let cursor = null;
                    do {
                        const page = instance.routeMap.queryPrefix(route.ip, {
                            prefixLength: route.mask,
                            rd,
                            pageSize: 2000,
                            afterRouteId: cursor,
                            includeTotal: false
                        });
                        page.list.forEach(queueExisting);
                        cursor = page.nextCursor;
                    } while (cursor !== null);
                }
            } else {
                queueExisting(instance.routeMap.get(BgpRoute.makeKey(route.ip, route.mask)));
            }
        };

        if (Array.isArray(config.routes)) {
            config.routes.forEach(deleteInput);
        } else {
            forEachGeneratedRouteIp(ipType, config.prefix, config.mask, config.count, route =>
                deleteInput({ ...route, rd: config.rd, pathId: config.pathId })
            );
        }
        flush();
        if (generatedCount === 0) {
            this.messageHandler.sendSuccessResponse(
                messageId,
                { deleted: 0, total: instance.routeMap.size },
                '路由删除成功'
            );
            return;
        }

        this.messageHandler.sendSuccessResponse(messageId, { deleted, total: instance.routeMap.size }, '路由删除成功');
    }

    async deleteAllRoutesByFamily(messageId, queryInfo) {
        try {
            const { addressFamily, routeType } = queryInfo;
            const { afi, safi } = getAfiAndSafi(addressFamily);
            const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
            if (!instance) {
                logger.error('实例不存在');
                this.messageHandler.sendErrorResponse(messageId, '实例不存在');
                return;
            }

            let count = 0;
            let hasMoreRoutes = true;
            while (hasMoreRoutes) {
                const page = instance.routeMap.queryPage({
                    page: 1,
                    pageSize: 2000,
                    routeType,
                    includeTotal: false
                });
                if (page.list.length === 0) {
                    hasMoreRoutes = false;
                    continue;
                }
                const stats = instance.deleteRouteBatch(page.list.map(route => route.routeKey));
                count += stats.deleted;
                if (stats.deleted > 0) {
                    const pending = instance.withdrawRoute(page.list);
                    if (pending) await pending;
                }
            }

            logger.info(`Deleted all ${count} routes for address family ${addressFamily}`);
            this.messageHandler.sendSuccessResponse(
                messageId,
                { deleted: count, total: instance.routeMap.size },
                `成功删除所有 ${count} 条路由`
            );
        } catch (error) {
            logger.error(`删除全部BGP路由失败: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    generateQpRoutes(messageId, config) {
        try {
            const { afi, safi } = getAfiAndSafi(config.addressFamily);
            const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
            if (!instance) {
                logger.error('实例不存在');
                this.messageHandler.sendErrorResponse(messageId, '实例不存在');
                return;
            }

            const nextCustomAttr = config.customAttr || '';
            const randomAsPathContext = buildRandomAsPathGenerationContext(config);
            const hasAttrChanged = instance.customAttr !== nextCustomAttr;
            if (hasAttrChanged) {
                instance.customAttr = nextCustomAttr;
            }
            const routeBatchStream = hasAttrChanged ? null : instance.createRouteBatchStream();

            // 生成路由：IPv4 QP 使用 IPv4 前缀格式，IPv6 QP 使用 IPv6 前缀格式
            const ipType =
                config.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP
                    ? BgpConst.IP_TYPE.IPV4
                    : BgpConst.IP_TYPE.IPV6;
            let inserted = 0;
            let updated = 0;
            let unchanged = 0;
            let entries = [];
            const flush = () => {
                if (entries.length === 0) return;
                const batch = entries;
                entries = [];
                const stats = instance.upsertRouteBatch(batch);
                inserted += stats.inserted;
                updated += stats.updated;
                unchanged += stats.unchanged;
                if (stats.changed > 0 && routeBatchStream) routeBatchStream.write(batch.map(entry => entry.route));
            };
            const generatedCount = forEachQpGeneratedRoute(config, ipType, route => {
                const key = BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask);
                const generatedAsPath = randomAsPathContext.enabled
                    ? getGeneratedRandomAsPath(randomAsPathContext)
                    : undefined;
                const bgpRoute = new BgpRoute(instance);
                bgpRoute.ip = route.ip;
                bgpRoute.mask = route.mask;
                bgpRoute.dqpn = route.dqpn;
                const attr = instance.makeRouteAttr(null, {
                    nextHop: route.bsid,
                    customAttr: instance.customAttr,
                    asPath: generatedAsPath
                });
                bgpRoute._routeAttr = attr;
                entries.push({ routeKey: key, route: bgpRoute, attr });
                if (entries.length >= 2000) flush();
            });
            flush();
            if (routeBatchStream) routeBatchStream.end();
            if (generatedCount === 0) {
                this.messageHandler.sendSuccessResponse(
                    messageId,
                    { added: 0, updated: 0, unchanged: 0, total: instance.routeMap.size },
                    'QP路由生成成功'
                );
                return;
            }

            if (hasAttrChanged) {
                updated += instance.refreshRouteAttrs(null, { customAttr: instance.customAttr });
                instance.sendRoute();
            }

            this.messageHandler.sendSuccessResponse(
                messageId,
                { added: inserted, updated, unchanged, total: instance.routeMap.size },
                'QP路由生成成功'
            );
        } catch (error) {
            logger.error(`QP路由生成失败: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    deleteQpRoute(messageId, config) {
        try {
            const { afi, safi } = getAfiAndSafi(config.addressFamily);
            const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
            if (!instance) {
                logger.error('实例不存在');
                this.messageHandler.sendErrorResponse(messageId, '实例不存在');
                return;
            }

            const ipType =
                config.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP
                    ? BgpConst.IP_TYPE.IPV4
                    : BgpConst.IP_TYPE.IPV6;
            let withdrawnRoutes = [];
            let deleteKeys = [];
            let deleted = 0;
            const flush = () => {
                if (deleteKeys.length === 0) return;
                const stats = instance.deleteRouteBatch(deleteKeys);
                deleted += stats.deleted;
                deleteKeys = [];
                if (stats.deleted > 0) instance.withdrawRoute(withdrawnRoutes);
                withdrawnRoutes = [];
            };
            const generatedCount = forEachQpGeneratedRoute(
                config,
                ipType,
                route => {
                    const key = BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask);
                    const bgpRoute = instance.routeMap.get(key);
                    if (bgpRoute) {
                        withdrawnRoutes.push(bgpRoute);
                        deleteKeys.push(key);
                        if (deleteKeys.length >= 2000) flush();
                    }
                },
                { requireBsid: false }
            );
            flush();
            if (generatedCount === 0) {
                this.messageHandler.sendSuccessResponse(
                    messageId,
                    { deleted: 0, total: instance.routeMap.size },
                    'QP路由删除成功'
                );
                return;
            }

            this.messageHandler.sendSuccessResponse(
                messageId,
                { deleted, total: instance.routeMap.size },
                'QP路由删除成功'
            );
        } catch (error) {
            logger.error(`QP路由删除失败: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    deletePeer(messageId, peerRecord) {
        // 查询实例是否存在
        const { afi, safi } = getAfiAndSafi(peerRecord.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        // 查询session是否存在
        const sessionKey = BgpSession.makeKey(0, peerRecord.peerIp);
        const session = this.bgpSessionMap.get(sessionKey);
        if (!session) {
            logger.error('session不存在');
            this.messageHandler.sendErrorResponse(messageId, 'session不存在');
            return;
        }

        // 查询peer是否存在
        const peer = instance.peerMap.get(peerRecord.peerIp);
        if (!peer) {
            logger.error('peer不存在');
            this.messageHandler.sendErrorResponse(messageId, 'peer不存在');
            return;
        }

        // 删除peer
        instance.peerMap.delete(peerRecord.peerIp);
        const addressFamilyFlag = getAddressFamilyFlag(peerRecord.addressFamily);
        if (addressFamilyFlag) {
            session.localAddrFamilyFlags = CommonUtils.BIT_RESET(session.localAddrFamilyFlags, addressFamilyFlag);
        }
        if (peerRecord.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC) {
            session.localAddrFamilyFlags = CommonUtils.BIT_RESET(
                session.localAddrFamilyFlags,
                BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_UNC
            );
        } else if (peerRecord.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
            session.localAddrFamilyFlags = CommonUtils.BIT_RESET(
                session.localAddrFamilyFlags,
                BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_UNC
            );
        } else if (peerRecord.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
            session.localAddrFamilyFlags = CommonUtils.BIT_RESET(
                session.localAddrFamilyFlags,
                BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV4_MVPN
            );
        } else if (peerRecord.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN) {
            session.localAddrFamilyFlags = CommonUtils.BIT_RESET(
                session.localAddrFamilyFlags,
                BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.IPV6_MVPN
            );
        }

        // 查询是否还有其他实例使用该Session
        let hasOtherInstance = false;
        this.bgpInstanceMap.forEach((tempInstance, _) => {
            if (tempInstance.peerMap.size > 0) {
                tempInstance.peerMap.forEach((tempPeer, _) => {
                    const peerSessionKey = BgpSession.makeKey(0, tempPeer.session.peerIp);
                    if (peerSessionKey === sessionKey) {
                        hasOtherInstance = true;
                    }
                });
            }
        });

        if (!hasOtherInstance) {
            // 删除session
            session.clearSession();
            session.resetSession();
            this.bgpSessionMap.delete(sessionKey);
        } else {
            // 更新session的peerMap
            session.resetSession();
        }

        this.messageHandler.sendSuccessResponse(messageId, null, 'peer删除成功');
    }

    getRoutes(messageId, queryInfo) {
        const { addressFamily, page, pageSize, routeType } = queryInfo;
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const result = instance.queryRoutePage({ page, pageSize, routeType });
        this.messageHandler.sendSuccessResponse(messageId, { list: result.list, total: result.total }, '路由查询成功');
    }

    getRouteDetail(messageId, queryInfo) {
        const { addressFamily, route } = queryInfo;
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const key = makeRouteLookupKey(addressFamily, route);
        const bgpRoute = instance.routeMap.get(key);
        if (!bgpRoute) {
            logger.error(`路由不存在: ${key}`);
            this.messageHandler.sendErrorResponse(messageId, '路由不存在');
            return;
        }

        const routeInfo = bgpRoute.getRouteInfo(instance.getRouteAttr(bgpRoute));
        const attrEntry = instance.getRouteAttrEntry(bgpRoute);
        routeInfo.attrId = bgpRoute.attrId || '';
        routeInfo.attrRefCount = attrEntry?.refCount || 0;

        this.messageHandler.sendSuccessResponse(messageId, routeInfo, '路由详情查询成功');
    }

    getMvpnBaseIp(config) {
        if (config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD) {
            return config.originatingRouterIp;
        }

        if (
            config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD ||
            config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD ||
            config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN ||
            config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
        ) {
            return config.groupIp;
        }

        return '';
    }

    forEachMvpnGeneratedIp(config, callback) {
        const baseIp = this.getMvpnBaseIp(config);
        if (baseIp) {
            return forEachGeneratedRouteIp(BgpConst.IP_TYPE.IPV4, baseIp, BgpConst.IP_HOST_LEN, config.count, callback);
        }

        // Types without IP increment (for example Type 2) keep the existing single-entry behavior.
        callback({ ip: '' }, 0);
        return 1;
    }

    generateMvpnRoutes(messageId, config) {
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const randomAsPathContext = buildRandomAsPathGenerationContext(config);
        const nextRt = config.rt || '';
        const hasAttrChanged = instance.rt !== nextRt;
        instance.rt = nextRt;
        const routeBatchStream = hasAttrChanged ? null : instance.createRouteBatchStream();
        let inserted = 0;
        let updated = 0;
        let unchanged = 0;
        let entries = [];
        const flush = () => {
            if (entries.length === 0) return;
            const batch = entries;
            entries = [];
            const stats = instance.upsertRouteBatch(batch);
            inserted += stats.inserted;
            updated += stats.updated;
            unchanged += stats.unchanged;
            if (stats.changed > 0 && routeBatchStream) routeBatchStream.write(batch.map(entry => entry.route));
        };

        const generatedCount = this.forEachMvpnGeneratedIp(config, ipObj => {
            let currentGroupIp = config.groupIp;
            let currentOrigRouterIp = config.originatingRouterIp;
            if (config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD) {
                currentOrigRouterIp = ipObj.ip;
            } else if ([3, 5, 6, 7].includes(config.routeType)) {
                currentGroupIp = ipObj.ip;
            }
            const routeKey = makeMvpnRouteKey({
                routeType: config.routeType,
                rd: config.rd,
                sourceAs: config.sourceAs,
                sourceIp: config.sourceIp,
                groupIp: currentGroupIp,
                originatingRouterIp: currentOrigRouterIp
            });
            const bgpRoute = new BgpRoute(instance);
            bgpRoute.routeType = config.routeType;
            bgpRoute.rd = config.rd;
            switch (config.routeType) {
                case BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD:
                    bgpRoute.originatingRouterIp = currentOrigRouterIp;
                    break;
                case BgpConst.BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD:
                    bgpRoute.sourceAs = config.sourceAs;
                    break;
                case BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD:
                    bgpRoute.sourceIp = config.sourceIp;
                    bgpRoute.groupIp = currentGroupIp;
                    bgpRoute.originatingRouterIp = config.originatingRouterIp;
                    break;
                case BgpConst.BGP_MVPN_ROUTE_TYPE.LEAF_AD:
                    bgpRoute.originatingRouterIp = config.originatingRouterIp;
                    break;
                case BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD:
                    bgpRoute.sourceIp = config.sourceIp;
                    bgpRoute.groupIp = currentGroupIp;
                    break;
                case BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN:
                    bgpRoute.sourceAs = config.sourceAs;
                    bgpRoute.groupIp = currentGroupIp;
                    break;
                case BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN:
                    bgpRoute.sourceAs = config.sourceAs;
                    bgpRoute.sourceIp = config.sourceIp;
                    bgpRoute.groupIp = currentGroupIp;
                    break;
            }
            const attr = instance.makeRouteAttr(null, {
                rt: instance.rt,
                asPath: randomAsPathContext.enabled ? getGeneratedRandomAsPath(randomAsPathContext) : undefined
            });
            bgpRoute._routeAttr = attr;
            entries.push({ routeKey, route: bgpRoute, attr });
            if (entries.length >= 2000) flush();
        });
        flush();
        if (routeBatchStream) routeBatchStream.end();
        if (hasAttrChanged) {
            updated += instance.refreshRouteAttrs(null, { rt: instance.rt });
            instance.sendRoute();
        }
        this.messageHandler.sendSuccessResponse(
            messageId,
            { added: inserted, updated, unchanged, total: instance.routeMap.size },
            `MVPN路由生成成功，共${generatedCount}条`
        );
    }

    deleteMvpnRoutes(messageId, config) {
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        let withdrawnRoutes = [];
        let deleteKeys = [];
        let deleted = 0;
        const flush = () => {
            if (deleteKeys.length === 0) return;
            const stats = instance.deleteRouteBatch(deleteKeys);
            deleted += stats.deleted;
            deleteKeys = [];
            if (stats.deleted > 0) instance.withdrawRoute(withdrawnRoutes);
            withdrawnRoutes = [];
        };
        const generatedCount = this.forEachMvpnGeneratedIp(config, ipObj => {
            const currentIp = ipObj.ip;

            // Construct dynamic values based on the incrementing IP
            let currentGroupIp = config.groupIp;
            let currentOrigRouterIp = config.originatingRouterIp;

            if (config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD) {
                currentOrigRouterIp = currentIp;
            } else if ([3, 5, 6, 7].includes(config.routeType)) {
                currentGroupIp = currentIp;
            }

            const routeKey = makeMvpnRouteKey({
                routeType: config.routeType,
                rd: config.rd,
                sourceAs: config.sourceAs,
                sourceIp: config.sourceIp,
                groupIp: currentGroupIp,
                originatingRouterIp: currentOrigRouterIp
            });

            const bgpRoute = instance.routeMap.get(routeKey);
            if (bgpRoute) {
                withdrawnRoutes.push(bgpRoute);
                deleteKeys.push(routeKey);
                if (deleteKeys.length >= 2000) flush();
            }
        });
        flush();
        this.messageHandler.sendSuccessResponse(
            messageId,
            { deleted, total: instance.routeMap.size },
            generatedCount === 0 ? '路由删除成功' : 'MVPN路由删除成功'
        );
    }

    importRoutes(messageId, config) {
        const { addressFamily, routes, announce = true, instanceAttrs = {} } = config;
        const routeList = Array.isArray(routes) ? routes : [];
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const hasInstanceAttrChanged =
            (instanceAttrs.customAttr !== undefined && instance.customAttr !== (instanceAttrs.customAttr || '')) ||
            (instanceAttrs.rt !== undefined && instance.rt !== (instanceAttrs.rt || ''));

        if (instanceAttrs.customAttr !== undefined) {
            instance.customAttr = instanceAttrs.customAttr || '';
        }
        if (instanceAttrs.rt !== undefined) {
            instance.rt = instanceAttrs.rt || '';
        }
        if (hasInstanceAttrChanged) {
            const attrOverrides = {};
            if (instanceAttrs.customAttr !== undefined) {
                attrOverrides.customAttr = instance.customAttr;
            }
            if (instanceAttrs.rt !== undefined) {
                attrOverrides.rt = instance.rt;
            }
            instance.refreshRouteAttrs(null, attrOverrides);
        }

        const entries = [];
        routeList.forEach(route => {
            let key;
            if (isUnicastAddressFamily(addressFamily)) {
                route.rd = BgpRoute.normalizeRd(route.rd);
                route.pathId = BgpRoute.normalizePathId(route.pathId);
                key = BgpRoute.makeUnicastKey(route.pathId, route.rd, route.ip, route.mask);
            } else if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
                key = makeMvpnRouteKey(route);
            } else if (
                addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP ||
                addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_QP
            ) {
                key = BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask);
            } else {
                key = BgpRoute.makeKey(route.ip, route.mask);
            }

            const bgpRoute = new BgpRoute(instance);
            instance.copyRouteNlriFields(bgpRoute, route);
            const attr = instance.makeRouteAttr(null, getImportedRouteAttr(instance, route));
            bgpRoute._routeAttr = attr;
            entries.push({ routeKey: key, route: bgpRoute, attr });
        });

        const stats = instance.upsertRouteBatch(entries);
        if (announce && stats.changed > 0) {
            instance.sendRouteBatch(entries.map(entry => entry.route));
        }
        if (announce && hasInstanceAttrChanged) {
            instance.sendRoute();
        }

        this.messageHandler.sendSuccessResponse(
            messageId,
            {
                added: stats.inserted,
                updated: stats.updated,
                unchanged: stats.unchanged,
                total: stats.total
            },
            '路由导入成功'
        );
    }
}

if (require.main === module) {
    new BgpWorker(); // 启动监听
}

module.exports = BgpWorker;
