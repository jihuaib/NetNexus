const net = require('net');
const util = require('util');
const ipaddr = require('ipaddr.js');
const BgpConst = require('../../const/bgpConst');
const { forEachGeneratedRouteIp } = require('../../utils/ipUtils');
const { getAfiAndSafi, getAddrFamilyType } = require('../../utils/bgpUtils');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const BgpSession = require('./bgpSession');
const BgpInstance = require('./bgpInstance');
const CommonUtils = require('../../utils/commonUtils');
const BgpRoute = require('./bgpRoute');

const MAX_QP_DQPN = 0xffffff;
const MAX_IPV6_INT = (1n << 128n) - 1n;
const MAX_IPV4_INT = (1n << 32n) - 1n;

function normalizePositiveInteger(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.floor(number);
}

function normalizeOptionalPositiveInteger(value, fallback = 1) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    return Number(value);
}

function normalizeQpRouteGrowthMode(mode) {
    return Object.values(BgpConst.BGP_QP_ROUTE_GROWTH_MODE).includes(mode)
        ? mode
        : BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;
}

function normalizeQpBsidMode(mode) {
    return Object.values(BgpConst.BGP_QP_BSID_MODE).includes(mode)
        ? mode
        : BgpConst.BGP_QP_BSID_MODE.FIXED;
}

function routeGrowthIncludesIp(mode) {
    return (
        mode === BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP ||
        mode === BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN
    );
}

function routeGrowthIncludesDqpn(mode) {
    return (
        mode === BgpConst.BGP_QP_ROUTE_GROWTH_MODE.DQPN ||
        mode === BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN
    );
}

function ipToBigInt(ip, ipType) {
    const address = ipaddr.parse(ip);
    const expectedKind = ipType === BgpConst.IP_TYPE.IPV4 ? 'ipv4' : 'ipv6';
    if (address.kind() !== expectedKind) {
        throw new Error(ipType === BgpConst.IP_TYPE.IPV4 ? '请输入有效的IPv4地址' : '请输入有效的IPv6地址');
    }

    return address.toByteArray().reduce((result, byte) => (result << 8n) + BigInt(byte), 0n);
}

function getIpRouteStep(ipType, mask, ipStep) {
    const maxMask = ipType === BgpConst.IP_TYPE.IPV4 ? 32 : 128;
    const routeStep = mask === maxMask ? 1n : 1n << BigInt(maxMask - mask);
    return routeStep * BigInt(ipStep);
}

function ipv6ToBigInt(ip) {
    const address = ipaddr.parse(ip);
    if (address.kind() !== 'ipv6') {
        throw new Error('BSID必须是IPv6地址');
    }

    return address.toByteArray().reduce((result, byte) => (result << 8n) + BigInt(byte), 0n);
}

function bigIntToIpv6(value) {
    const bytes = [];
    for (let i = 15; i >= 0; i--) {
        bytes[i] = Number(value & 0xffn);
        value >>= 8n;
    }

    return ipaddr.fromByteArray(bytes).toString();
}

function makeRouteLookupKey(addressFamily, route) {
    if (
        addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP ||
        addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_QP
    ) {
        return BgpRoute.makeQpKey(route?.dqpn, route?.ip, route?.mask);
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
        return [
            route?.routeType,
            route?.rd,
            route?.sourceAs || '',
            route?.sourceIp || '',
            route?.groupIp || '',
            route?.originatingRouterIp || ''
        ].join('|');
    }

    return BgpRoute.makeKey(route?.ip, route?.mask);
}

function getQpBaseRoute(ipType, prefix, mask) {
    let baseRoute = null;
    forEachGeneratedRouteIp(ipType, prefix, mask, 1, route => {
        baseRoute = route;
    });
    if (!baseRoute) {
        throw new Error('QP路由前缀配置无效');
    }
    return baseRoute;
}

function buildQpGenerationContext(config, ipType, options = {}) {
    const requireBsid = options.requireBsid !== false;
    const routeGrowthMode = normalizeQpRouteGrowthMode(config.routeGrowthMode);
    const bsidMode = normalizeQpBsidMode(config.bsidMode);
    const growIp = routeGrowthIncludesIp(routeGrowthMode);
    const growDqpn = routeGrowthIncludesDqpn(routeGrowthMode);

    const count = normalizePositiveInteger(config.count, 0);
    if (count <= 0) {
        return { count: 0 };
    }

    const ipStep = normalizeOptionalPositiveInteger(config.ipStep, 1);
    if (growIp) {
        if (!Number.isInteger(ipStep) || ipStep <= 0) {
            throw new Error('IP步长必须为正整数');
        }
        const startIp = ipToBigInt(config.prefix, ipType);
        const mask = normalizePositiveInteger(config.mask, NaN);
        const maxMask = ipType === BgpConst.IP_TYPE.IPV4 ? 32 : 128;
        if (!Number.isInteger(mask) || mask < 1 || mask > maxMask) {
            throw new Error(ipType === BgpConst.IP_TYPE.IPV4 ? '请输入有效的IPv4掩码' : '请输入有效的IPv6掩码');
        }
        const lastIp = startIp + BigInt(count - 1) * getIpRouteStep(ipType, mask, ipStep);
        const maxIp = ipType === BgpConst.IP_TYPE.IPV4 ? MAX_IPV4_INT : MAX_IPV6_INT;
        if (lastIp > maxIp) {
            throw new Error('IP连续生成超出地址范围');
        }
    }

    const startDqpn = normalizePositiveInteger(config.startDqpn, 0);
    const dqpnStep = normalizePositiveInteger(config.dqpnStep, 1);
    if (!Number.isInteger(startDqpn) || startDqpn < 0 || startDqpn > MAX_QP_DQPN) {
        throw new Error('DQPN范围为 0 ~ 16777215（24bit）');
    }
    if (growDqpn) {
        if (!Number.isInteger(dqpnStep) || dqpnStep <= 0) {
            throw new Error('DQPN步长必须为正整数');
        }
        const lastDqpn = startDqpn + (count - 1) * dqpnStep;
        if (lastDqpn > MAX_QP_DQPN) {
            throw new Error('DQPN连续生成超出 24bit 范围');
        }
    }

    const baseRoute = growIp ? null : getQpBaseRoute(ipType, config.prefix, config.mask);
    const bsidBase = `${config.bsid || ''}`.trim();
    if (requireBsid && !bsidBase) {
        throw new Error('请输入BSID');
    }
    const resolveBsid = requireBsid || Boolean(bsidBase);
    let bsidBaseInt = null;
    let bsidStep = 0n;
    if (resolveBsid && bsidMode === BgpConst.BGP_QP_BSID_MODE.CONTINUOUS) {
        bsidBaseInt = ipv6ToBigInt(bsidBase);
        bsidStep = BigInt(normalizePositiveInteger(config.bsidStep, 1));
        if (bsidStep <= 0n) {
            throw new Error('BSID步长必须为正整数');
        }
        if (bsidBaseInt + BigInt(count - 1) * bsidStep > MAX_IPV6_INT) {
            throw new Error('BSID连续生成超出IPv6地址范围');
        }
    } else if (resolveBsid) {
        ipv6ToBigInt(bsidBase);
    }

    return {
        count,
        routeGrowthMode,
        bsidMode,
        growIp,
        growDqpn,
        ipStep,
        startDqpn,
        dqpnStep,
        baseRoute,
        bsidBase,
        bsidBaseInt,
        bsidStep,
        resolveBsid
    };
}

function forEachQpGeneratedRoute(config, ipType, callback, options = {}) {
    const context = buildQpGenerationContext(config, ipType, options);
    if (context.count === 0 || typeof callback !== 'function') {
        return 0;
    }

    const emit = (route, index) => {
        const dqpn = context.growDqpn ? context.startDqpn + index * context.dqpnStep : context.startDqpn;
        const bsid =
            context.resolveBsid && context.bsidMode === BgpConst.BGP_QP_BSID_MODE.CONTINUOUS
                ? bigIntToIpv6(context.bsidBaseInt + BigInt(index) * context.bsidStep)
                : context.bsidBase;

        callback({ ip: route.ip, mask: route.mask, dqpn, bsid }, index);
    };

    if (context.growIp) {
        return forEachGeneratedRouteIp(ipType, config.prefix, config.mask, context.count, emit, context.ipStep);
    }

    for (let index = 0; index < context.count; index++) {
        emit(context.baseRoute, index);
    }

    return context.count;
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
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.GET_ROUTE_DETAIL,
            this.getRouteDetail.bind(this)
        );

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
            await listenPormise(BgpConst.BGP_DEFAULT_PORT, '0.0.0.0');
            logger.info(`TCP Server listening on port ${BgpConst.BGP_DEFAULT_PORT} at 0.0.0.0`);
            // 启动ipv6服务器并监听端口
            const listenIpv6Pormise = util.promisify(this.ipv6Server.listen).bind(this.ipv6Server);
            await listenIpv6Pormise(BgpConst.BGP_DEFAULT_PORT, '::');
            logger.info(`TCP Server listening on port ${BgpConst.BGP_DEFAULT_PORT} at ::`);

            logger.info(`bgp协议启动成功`);
            this.messageHandler.sendSuccessResponse(messageId, null, 'bgp协议启动成功');
        } catch (err) {
            logger.error(`Error starting TCP server: ${err.message}`);
            this.messageHandler.sendErrorResponse(messageId, 'bgp协议启动失败');
        }
    }

    startBgp(messageId, bgpConfigData) {
        this.bgpConfigData = bgpConfigData;

        // 设置日志级别
        if (this.bgpConfigData.logLevel) {
            logger.setLevel(this.bgpConfigData.logLevel);
            logger.info(`Worker log level set to: ${this.bgpConfigData.logLevel}`);
        }

        this.bgpConfigData.addressFamily.forEach(addressFamily => {
            const { afi, safi } = getAfiAndSafi(addressFamily);
            // 创建bgp实例
            this.bgpInstanceMap.set(BgpInstance.makeKey(0, afi, safi), new BgpInstance(0, afi, safi));
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
            }
        });
        bgpSession.openCapCustom = ipv4PeerConfigData.openCapCustom;

        // 获取bgp实例
        ipv4PeerConfigData.addressFamily.forEach(family => {
            const { afi, safi } = getAfiAndSafi(family);
            const bgpInstance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
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
            }
        });
        bgpSession.openCapCustom = ipv6PeerConfigData.openCapCustomIpv6;

        // 获取bgp实例
        ipv6PeerConfigData.addressFamilyIpv6.forEach(family => {
            const { afi, safi } = getAfiAndSafi(family);
            const bgpInstance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
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
                peerCount: instance.peerMap ? instance.peerMap.size : 0,
                singleRouteSend: !!instance.singleRouteSend
            });
        });
        this.messageHandler.sendSuccessResponse(messageId, instanceInfoList, '实例信息查询成功');
    }

    getPeerInfo(messageId) {
        const ipv4PeerInfoList = [];
        const ipv6PeerInfoList = [];
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

        // 清空routeMap
        this.bgpInstanceMap.forEach((instance, _) => {
            instance.routeMap.clear();
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

        // 清空配置数据
        this.bgpConfigData = null;
        this.ipv4PeerConfigData = null;
        this.ipv6PeerConfigData = null;

        logger.info(`BGP stopped successfully`);

        // Send response using messageHandler
        this.messageHandler.sendSuccessResponse(messageId, null, 'bgp协议停止成功');
    }

    generateRoutes(messageId, config) {
        // 查询实例是否存在
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        // 生成路由IP
        const ipType = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
        let hasRouteChanged = false;
        const generatedCount = forEachGeneratedRouteIp(ipType, config.prefix, config.mask, config.count, route => {
            const key = BgpRoute.makeKey(route.ip, route.mask);
            if (!instance.routeMap.has(key)) {
                const bgpRoute = new BgpRoute(instance);
                bgpRoute.ip = route.ip;
                bgpRoute.mask = route.mask;
                instance.routeMap.set(key, bgpRoute);
                hasRouteChanged = true;
            }
        });
        if (generatedCount === 0) {
            this.messageHandler.sendSuccessResponse(messageId, null, '路由生成成功');
            return;
        }

        if (instance.customAttr !== config.customAttr) {
            instance.customAttr = config.customAttr;
            hasRouteChanged = true;
        }

        if (instance.rt !== config.rt) {
            instance.rt = config.rt;
            hasRouteChanged = true;
        }

        if (hasRouteChanged) {
            instance.sendRoute();
        }

        this.messageHandler.sendSuccessResponse(messageId, null, '路由生成成功');
    }

    deleteRoute(messageId, config) {
        // 查询实例是否存在
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        // 生成路由IP
        const ipType = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
        const withdrawnRoutes = [];
        const generatedCount = forEachGeneratedRouteIp(ipType, config.prefix, config.mask, config.count, route => {
            const key = BgpRoute.makeKey(route.ip, route.mask);
            if (instance.routeMap.has(key)) {
                const bgpRoute = instance.routeMap.get(key);
                instance.routeMap.delete(key);
                withdrawnRoutes.push(bgpRoute);
            }
        });
        if (generatedCount === 0) {
            this.messageHandler.sendSuccessResponse(messageId, null, '路由删除成功');
            return;
        }

        if (withdrawnRoutes.length > 0) {
            instance.withdrawRoute(withdrawnRoutes);
        }

        if (instance.routeMap.size === 0) {
            instance.singleRouteSend = false;
        }

        this.messageHandler.sendSuccessResponse(messageId, null, '路由删除成功');
    }

    deleteAllRoutesByFamily(messageId, queryInfo) {
        const { addressFamily } = queryInfo;
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const withdrawnRoutes = [];
        instance.routeMap.forEach((route, _) => {
            withdrawnRoutes.push(route);
        });

        const count = withdrawnRoutes.length;

        // Clear all routes
        instance.routeMap.clear();

        // Send withdraw message if there were routes
        if (withdrawnRoutes.length > 0) {
            instance.withdrawRoute(withdrawnRoutes);
        }

        instance.singleRouteSend = false;

        logger.info(`Deleted all ${count} routes for address family ${addressFamily}`);
        this.messageHandler.sendSuccessResponse(messageId, { deleted: count }, `成功删除所有 ${count} 条路由`);
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

            // 更新实例的 BSID。连续模式下每条路由仍会写入自己的 nextHop，这里仅作为 fallback。
            if (config.bsid !== undefined) {
                instance.bsid = config.bsid;
            }

            // 生成路由：IPv4 QP 使用 IPv4 前缀格式，IPv6 QP 使用 IPv6 前缀格式
            const ipType =
                config.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP
                    ? BgpConst.IP_TYPE.IPV4
                    : BgpConst.IP_TYPE.IPV6;
            let hasRouteChanged = false;
            const generatedCount = forEachQpGeneratedRoute(config, ipType, route => {
                const key = BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask);
                if (!instance.routeMap.has(key)) {
                    const bgpRoute = new BgpRoute(instance);
                    bgpRoute.ip = route.ip;
                    bgpRoute.mask = route.mask;
                    bgpRoute.dqpn = route.dqpn;
                    bgpRoute.nextHop = route.bsid;
                    instance.routeMap.set(key, bgpRoute);
                    hasRouteChanged = true;
                } else {
                    const bgpRoute = instance.routeMap.get(key);
                    if (bgpRoute.nextHop !== route.bsid) {
                        bgpRoute.nextHop = route.bsid;
                        hasRouteChanged = true;
                    }
                }
            });
            if (generatedCount === 0) {
                this.messageHandler.sendSuccessResponse(messageId, null, 'QP路由生成成功');
                return;
            }

            if (instance.customAttr !== config.customAttr) {
                instance.customAttr = config.customAttr;
                hasRouteChanged = true;
            }

            if (hasRouteChanged) {
                instance.sendRoute();
            }

            this.messageHandler.sendSuccessResponse(messageId, null, 'QP路由生成成功');
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
            const withdrawnRoutes = [];
            const generatedCount = forEachQpGeneratedRoute(
                config,
                ipType,
                route => {
                    const key = BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask);
                    if (instance.routeMap.has(key)) {
                        const bgpRoute = instance.routeMap.get(key);
                        instance.routeMap.delete(key);
                        withdrawnRoutes.push(bgpRoute);
                    }
                },
                { requireBsid: false }
            );
            if (generatedCount === 0) {
                this.messageHandler.sendSuccessResponse(messageId, null, 'QP路由删除成功');
                return;
            }

            if (withdrawnRoutes.length > 0) {
                instance.withdrawRoute(withdrawnRoutes);
            }

            if (instance.routeMap.size === 0) {
                instance.singleRouteSend = false;
            }

            this.messageHandler.sendSuccessResponse(messageId, null, 'QP路由删除成功');
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
        const { addressFamily, page, pageSize } = queryInfo;
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const currentPage = Math.max(1, parseInt(page, 10) || 1);
        const currentPageSize = Math.max(1, parseInt(pageSize, 10) || 10);
        const total = instance.routeMap.size;
        const startIndex = (currentPage - 1) * currentPageSize;
        const list = [];

        let index = 0;
        for (const route of instance.routeMap.values()) {
            if (index >= startIndex) {
                list.push(route.getRouteInfo());
                if (list.length >= currentPageSize) {
                    break;
                }
            }
            index += 1;
        }

        this.messageHandler.sendSuccessResponse(messageId, { list, total }, '路由查询成功');
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

        const routeInfo = bgpRoute.getRouteInfo();
        routeInfo.rt = routeInfo.rt || instance.rt || '';
        routeInfo.customAttr = routeInfo.customAttr || instance.customAttr || '';
        routeInfo.bsid = instance.bsid || '';

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
            return forEachGeneratedRouteIp(
                BgpConst.IP_TYPE.IPV4,
                baseIp,
                BgpConst.IP_HOST_LEN,
                config.count,
                callback
            );
        }

        // Types without IP increment (for example Type 2) keep the existing single-entry behavior.
        callback({ ip: '' }, 0);
        return 1;
    }

    generateMvpnRoutes(messageId, config) {
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        let hasRouteChanged = false;

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

            // Create a comprehensive key
            // Key format: type|rd|sourceAs|sourceIp|groupIp|origRouterIp
            const routeKey = `${config.routeType}|${config.rd}|${config.sourceAs || ''}|${config.sourceIp || ''}|${currentGroupIp || ''}|${currentOrigRouterIp || ''}`;

            if (!instance.routeMap.has(routeKey)) {
                const bgpRoute = new BgpRoute(instance);
                bgpRoute.routeType = config.routeType;
                bgpRoute.rd = config.rd;

                // Set specific fields based on type
                switch (config.routeType) {
                    case BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD: // Type 1
                        bgpRoute.originatingRouterIp = currentOrigRouterIp;
                        break;
                    case BgpConst.BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD: // Type 2
                        bgpRoute.sourceAs = config.sourceAs;
                        break;
                    case BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD: // Type 3
                        bgpRoute.sourceIp = config.sourceIp;
                        bgpRoute.groupIp = currentGroupIp;
                        bgpRoute.originatingRouterIp = config.originatingRouterIp;
                        break;
                    case BgpConst.BGP_MVPN_ROUTE_TYPE.LEAF_AD: // Type 4
                        bgpRoute.originatingRouterIp = config.originatingRouterIp;
                        // Add Route Key fields if supported later
                        break;
                    case BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD: // Type 5
                        bgpRoute.sourceIp = config.sourceIp;
                        bgpRoute.groupIp = currentGroupIp;
                        break;
                    case BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN: // Type 6
                        bgpRoute.sourceAs = config.sourceAs;
                        bgpRoute.groupIp = currentGroupIp;
                        break;
                    case BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN: // Type 7
                        bgpRoute.sourceAs = config.sourceAs;
                        bgpRoute.sourceIp = config.sourceIp;
                        bgpRoute.groupIp = currentGroupIp;
                        break;
                }

                instance.routeMap.set(routeKey, bgpRoute);
                hasRouteChanged = true;
            }
        });
        if (generatedCount === 0) {
            this.messageHandler.sendSuccessResponse(messageId, null, '路由生成成功');
            return;
        }

        if (instance.rt !== config.rt) {
            instance.rt = config.rt;
            hasRouteChanged = true;
        }
        if (hasRouteChanged) {
            instance.sendRoute();
        }

        this.messageHandler.sendSuccessResponse(messageId, null, `MVPN路由生成成功，共${generatedCount}条`);
    }

    deleteMvpnRoutes(messageId, config) {
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const withdrawnRoutes = [];
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

            // Use same key logic as generation
            const routeKey = `${config.routeType}|${config.rd}|${config.sourceAs || ''}|${config.sourceIp || ''}|${currentGroupIp || ''}|${currentOrigRouterIp || ''}`;

            if (instance.routeMap.has(routeKey)) {
                const bgpRoute = instance.routeMap.get(routeKey);
                instance.routeMap.delete(routeKey);
                withdrawnRoutes.push(bgpRoute);
            }
        });
        if (generatedCount === 0) {
            this.messageHandler.sendSuccessResponse(messageId, null, '路由删除成功');
            return;
        }

        if (withdrawnRoutes.length > 0) {
            instance.withdrawRoute(withdrawnRoutes);
        }

        this.messageHandler.sendSuccessResponse(messageId, null, 'MVPN路由删除成功');
    }

    importRoutes(messageId, config) {
        const { addressFamily, routes, announce = true, instanceAttrs = {}, singleRouteSend = false } = config;
        const routeList = Array.isArray(routes) ? routes : [];
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        if (instanceAttrs.customAttr !== undefined) {
            instance.customAttr = instanceAttrs.customAttr || '';
        }
        if (instanceAttrs.rt !== undefined) {
            instance.rt = instanceAttrs.rt || '';
        }
        if (instanceAttrs.bsid !== undefined) {
            instance.bsid = instanceAttrs.bsid || '';
        }

        if (routeList.length !== 0 && (singleRouteSend || routeList.some(route => route.asPath))) {
            instance.singleRouteSend = true;
        }

        let hasRouteChanged = false;
        routeList.forEach(route => {
            let key;
            if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
                key = `${route.routeType}|${route.rd}|${route.sourceAs || ''}|${route.sourceIp || ''}|${route.groupIp || ''}|${route.originatingRouterIp || ''}`;
            } else if (
                addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP ||
                addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_QP
            ) {
                key = BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask);
            } else {
                key = BgpRoute.makeKey(route.ip, route.mask);
            }

            if (!instance.routeMap.has(key)) {
                const bgpRoute = new BgpRoute(instance);
                Object.assign(bgpRoute, route);
                if (route.formatted !== undefined) {
                    bgpRoute.customAttr = route.formatted; // Map formatted to customAttr for MRT imports.
                }

                instance.routeMap.set(key, bgpRoute);
                hasRouteChanged = true;
            } else {
                const bgpRoute = instance.routeMap.get(key);
                Object.assign(bgpRoute, route);
                if (route.formatted !== undefined) {
                    bgpRoute.customAttr = route.formatted;
                }
                hasRouteChanged = true;
            }
        });

        if (hasRouteChanged && announce) {
            instance.sendRoute();
        }

        this.messageHandler.sendSuccessResponse(messageId, null, '路由导入成功');
    }
}

if (require.main === module) {
    new BgpWorker(); // 启动监听
}

module.exports = BgpWorker;
