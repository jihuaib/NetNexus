const net = require('net');
const ipaddr = require('ipaddr.js');
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
const { buildAttributeRuleContext, getGeneratedAttributeValues } = require('../../utils/bgpAttributeRules');

function validateTreePrefixRange(config, ipType, prefixStep = 1) {
    const count = Math.floor(Number(config.count));
    if (!Number.isFinite(count) || count <= 0) return;
    const bits = ipType === BgpConst.IP_TYPE.IPV6 ? 128 : 32;
    const mask = Number(config.mask);
    if (!Number.isInteger(mask) || mask < 0 || mask > bits) throw new Error('路由前缀长度无效');
    const address = ipaddr.parse(config.prefix);
    if ((address.kind() === 'ipv6' ? 128 : 32) !== bits) throw new Error('路由前缀地址族无效');
    const number = address.toByteArray().reduce((value, byte) => value * 256n + BigInt(byte), 0n);
    const step = (1n << BigInt(bits - mask)) * BigInt(prefixStep);
    const networkStep = 1n << BigInt(bits - mask);
    const network = (number / networkStep) * networkStep;
    const prefixes = count;
    if (network + BigInt(prefixes - 1) * step > (1n << BigInt(bits)) - 1n) throw new Error('路由前缀递增超出地址范围');
}

function* iterateTreeRouteInputs(config, ipType, pathCount, prefixStep = 1) {
    if (Array.isArray(config.routes)) {
        yield* config.routes;
        return;
    }
    const bits = ipType === BgpConst.IP_TYPE.IPV6 ? 128 : 32;
    const address = ipaddr.parse(config.prefix);
    const raw = address.toByteArray().reduce((value, byte) => value * 256n + BigInt(byte), 0n);
    const networkStep = 1n << BigInt(bits - Number(config.mask));
    const step = networkStep * BigInt(prefixStep);
    const start = (raw / networkStep) * networkStep;
    for (let index = 0; index < Number(config.count); index += 1) {
        let number = start + BigInt(index) * step;
        const bytes = Array(bits / 8).fill(0);
        for (let byte = bytes.length - 1; byte >= 0; byte -= 1) {
            bytes[byte] = Number(number & 255n);
            number >>= 8n;
        }
        const ip = ipaddr.fromByteArray(bytes).toString();
        for (let pathId = 0; pathId < pathCount; pathId += 1) {
            yield { ip, mask: Number(config.mask), rd: config.rd, pathId };
        }
    }
}

function formatBgpListenError(error, port, platform = process.platform) {
    if (error?.code === 'EADDRINUSE') return `BGP监听端口${port}已被其他进程占用`;
    if (platform === 'linux' && (error?.code === 'EACCES' || error?.code === 'EPERM')) {
        return `BGP监听端口${port}权限不足；请安装正式Linux .deb，或为当前Electron可执行文件配置CAP_NET_BIND_SERVICE`;
    }
    return `BGP协议启动失败: ${error?.message || '未知监听错误'}`;
}

function makeRouteLookupKey(addressFamily, route) {
    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) {
        return BgpRoute.makeLabelUnicastKey(route?.pathId, route?.ip, route?.mask);
    }
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

function makeMvpnRouteKey(route) {
    return BgpRoute.makeMvpnKey(route);
}

function* iterateQpTreeRouteInputs(config, ipType) {
    if (Array.isArray(config.routes)) {
        yield* config.routes;
        return;
    }
    const mode = config.routeGrowthMode ?? BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;
    if (!Object.values(BgpConst.BGP_QP_ROUTE_GROWTH_MODE).includes(mode)) throw new Error('QP增长模式无效');
    const growIp = mode !== BgpConst.BGP_QP_ROUTE_GROWTH_MODE.DQPN;
    const ipStep = Number(config.ipStep ?? 1);
    if (!Number.isSafeInteger(ipStep) || ipStep < 0) throw new Error('QP IP步长必须为非负整数');
    validateTreePrefixRange({ ...config, count: growIp ? config.count : 1 }, ipType, ipStep);
    if (growIp) yield* iterateTreeRouteInputs(config, ipType, 1, ipStep);
    else {
        const [base] = iterateTreeRouteInputs({ ...config, count: 1 }, ipType, 1);
        for (let index = 0; index < Number(config.count); index += 1) yield { ...base };
    }
}

function normalizeMvpnTreeInput(input) {
    const routeType = Number(input.routeType);
    if (!Number.isInteger(routeType) || routeType < 1 || routeType > 7) throw new Error('MVPN路由类型范围为1~7');
    const route = { routeType, rd: input.rd };
    const ipFields =
        {
            1: ['originatingRouterIp'],
            3: ['sourceIp', 'groupIp', 'originatingRouterIp'],
            4: ['originatingRouterIp'],
            5: ['sourceIp', 'groupIp'],
            6: ['sourceIp', 'groupIp'],
            7: ['sourceIp', 'groupIp']
        }[routeType] || [];
    for (const field of ipFields) {
        let address;
        try {
            address = ipaddr.parse(String(input[field] ?? ''));
        } catch (_error) {
            throw new Error(`MVPN ${field}必须是IPv4地址`);
        }
        if (address.kind() !== 'ipv4') throw new Error(`MVPN ${field}必须是IPv4地址`);
        route[field] = address.toString();
    }
    if ([2, 6, 7].includes(routeType)) {
        const sourceAs = Number(input.sourceAs);
        if (input.sourceAs === undefined || !Number.isInteger(sourceAs) || sourceAs < 0 || sourceAs > 0xffffffff)
            throw new Error('MVPN Source AS范围为0~4294967295');
        route.sourceAs = sourceAs;
    }
    if (routeType === 4) {
        const leafRouteKey = String(input.leafRouteKey ?? '')
            .replace(/\s/g, '')
            .toLowerCase();
        if (!/^(?:[0-9a-f]{2})+$/.test(leafRouteKey) || leafRouteKey.length / 2 + 4 > 255)
            throw new Error('Leaf Route Key必须为非空十六进制，含Origin地址后不能超过255字节');
        route.leafRouteKey = leafRouteKey;
        delete route.rd;
    }
    return route;
}

function* iterateMvpnTreeRouteInputs(config) {
    if (Array.isArray(config.routes)) {
        for (const route of config.routes) yield normalizeMvpnTreeInput(route);
        return;
    }
    const base = normalizeMvpnTreeInput(config);
    const count = Number(config.count);
    if (base.routeType === 2) {
        if (base.sourceAs + count - 1 > 0xffffffff) throw new Error('MVPN Source AS递增超出uint32范围');
        for (let index = 0; index < count; index += 1) yield { ...base, sourceAs: base.sourceAs + index };
        return;
    }
    const field = [1, 4].includes(base.routeType) ? 'originatingRouterIp' : 'groupIp';
    const prefix = base[field];
    validateTreePrefixRange({ prefix, mask: 32, count }, BgpConst.IP_TYPE.IPV4);
    for (const route of iterateTreeRouteInputs({ prefix, mask: 32, count }, BgpConst.IP_TYPE.IPV4, 1))
        yield { ...base, [field]: route.ip };
}

function isUnicastAddressFamily(addressFamily) {
    return addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC;
}

function supportsAddPathAddressFamily(addressFamily) {
    return isUnicastAddressFamily(addressFamily) || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
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
    return supportsAddPathAddressFamily(normalizedFamily) && familyConfig.sendAddPath === true;
}

function enableLocalAddPathForFamilies(bgpSession, config, addressFamilies) {
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
        this.routeGroupMutation = Promise.resolve();
        this.pendingRouteGroupMutations = 0;
        this.bulkRouteMutation = null;

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
        this.messageHandler.registerHandler(BgpConst.BGP_REQ_TYPES.SEND_RAW_PACKET, this.sendRawPacket.bind(this));
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.GET_ROUTE_GROUP_STATES,
            this.getRouteGroupStates.bind(this)
        );
        this.messageHandler.registerHandler(
            BgpConst.BGP_REQ_TYPES.WITHDRAW_ROUTE_GROUP,
            this.withdrawRouteGroup.bind(this)
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
        const listenPort = this.getListenPort();
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
            await listenPormise(listenPort, '0.0.0.0');
            logger.info(`TCP Server listening on port ${listenPort} at 0.0.0.0`);
            // 启动ipv6服务器并监听端口
            const listenIpv6Pormise = util.promisify(this.ipv6Server.listen).bind(this.ipv6Server);
            await listenIpv6Pormise({ port: listenPort, host: '::', ipv6Only: true });
            logger.info(`TCP Server listening on port ${listenPort} at ::`);

            logger.info(`bgp协议启动成功`);
            this.messageHandler.sendSuccessResponse(messageId, null, 'bgp协议启动成功');
        } catch (err) {
            logger.error(`Error starting TCP server: ${err.message}`);
            if (this.server?.listening) this.server.close();
            if (this.ipv6Server?.listening) this.ipv6Server.close();
            this.messageHandler.sendErrorResponse(messageId, formatBgpListenError(err, listenPort));
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
            const recoveryHint = error.message.startsWith('BGP route SQLite schema')
                ? '；请在“设置 → 数据”中删除旧 BGP 路由数据库后重试'
                : '';
            this.messageHandler.sendErrorResponse(messageId, `BGP路由库打开失败: ${error.message}${recoveryHint}`);
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
                enableLocalAddPathForFamilies(bgpSession, ipv4PeerConfigData, ipv4PeerConfigData.addressFamily);
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
                enableLocalAddPathForFamilies(bgpSession, ipv6PeerConfigData, ipv6PeerConfigData.addressFamilyIpv6);
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

    async sendRawPacket(messageId, config = {}) {
        try {
            const { vrfIndex = 0, peerIp, packetHex } = config || {};
            if (!Number.isInteger(vrfIndex) || vrfIndex < 0) {
                throw new Error('VRF 索引必须为非负整数');
            }
            if (typeof peerIp !== 'string' || !net.isIP(peerIp)) {
                throw new Error('请选择有效的 IPv4 或 IPv6 邻居地址');
            }
            const session = this.bgpSessionMap.get(BgpSession.makeKey(vrfIndex, peerIp));
            if (!session) {
                throw new Error('BGP 邻居会话不存在，请先配置并建立邻居连接');
            }

            const result = await session.sendRawPacket(packetHex);
            this.messageHandler.sendSuccessResponse(messageId, result, 'BGP 原始报文发送成功');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
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
        if (this.pendingRouteGroupMutations || this.bulkRouteMutation) {
            return Promise.all([this.routeGroupMutation, this.bulkRouteMutation]).then(() => this.stopBgp(messageId));
        }
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

    getRouteStores() {
        return [
            ...new Set(
                [this.routeStore, ...Array.from(this.bgpInstanceMap.values(), instance => instance.routeStore)].filter(
                    Boolean
                )
            )
        ];
    }

    assertUnmanagedRouteOwnership(instance, routes) {
        if (
            !instance.routeStore.listRouteGroups().some(group => {
                const { afi, safi } = getAfiAndSafi(group.addressFamily);
                return instance.afi === afi && instance.safi === safi;
            })
        )
            return;
        const definition = instance.routeStore.getInstance(instance.instanceKey);
        const candidates = (function* () {
            for (const route of routes)
                yield {
                    ...route,
                    routeKey: makeRouteLookupKey(getAddrFamilyType(instance.afi, instance.safi), route),
                    prefix: route.ip,
                    prefixLength: route.mask,
                    rd: instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST ? undefined : route.rd
                };
        })();
        instance.routeStore.assertRouteOwnership(definition, candidates);
    }

    assertLegacyAttributeRefreshAllowed(instance, changed) {
        if (!changed) return;
        if (
            instance.routeStore.listRouteGroups().some(group => {
                const { afi, safi } = getAfiAndSafi(group.addressFamily);
                return instance.afi === afi && instance.safi === safi;
            })
        )
            throw new Error('该地址族存在路由组快照，请通过路由组编辑属性');
    }

    getRouteGroupStates(messageId) {
        const groups = this.getRouteStores().flatMap(store => store.listRouteGroups());
        this.messageHandler.sendSuccessResponse(messageId, { groups }, '路由组状态查询成功');
    }

    assertRouteMutationsAvailable() {
        if (this.pendingRouteGroupMutations || this.bulkRouteMutation) {
            throw new Error('路由组生成或撤销正在进行，请完成后重试');
        }
    }

    serializeRouteGroupMutation(operation) {
        if (this.bulkRouteMutation) throw new Error('路由批量删除正在进行，请完成后重试');
        this.pendingRouteGroupMutations += 1;
        const pending = this.routeGroupMutation.then(operation, operation).finally(() => {
            this.pendingRouteGroupMutations -= 1;
        });
        this.routeGroupMutation = pending.catch(() => {});
        return pending;
    }

    async withdrawStoredGroupRoutes(rows) {
        const batches = new Map();
        for (const row of rows || []) {
            const instance = this.bgpInstanceMap.get(row.instanceKey);
            if (!instance) continue;
            if (!batches.has(instance)) batches.set(instance, []);
            const batch = batches.get(instance);
            const route = instance.hydrateRoute(row);
            if (row.forceWithdraw) route._forceWithdraw = true;
            if (row.label === null) route._labelAbsent = true;
            if (row.dqpn === null && instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) route._dqpnAbsent = true;
            batch.push(route);
            if (batch.length === 2000) {
                await instance.withdrawRoute(batch);
                batches.set(instance, []);
            }
        }
        for (const [instance, routes] of batches) {
            if (routes.length) await instance.withdrawRoute(routes);
        }
    }

    async announceStoredGroup(instance, groupId) {
        const streams = Array.from(instance.peerMap.values(), peer =>
            peer.createRouteBatchStream({ abandonOnBackpressure: false })
        );
        let batch = [];
        const write = async () => {
            if (!batch.length) return;
            const routes = batch;
            batch = [];
            await Promise.all(streams.map(stream => stream.write(routes)));
        };
        for (const row of instance.routeStore.iterateRouteGroupRoutes(groupId, { batchSize: 2000 })) {
            batch.push(instance.hydrateRoute(row));
            if (batch.length === 2000) await write();
        }
        await write();
        await Promise.all(streams.map(stream => stream.end()));
    }

    assertTreeRouteEncodable(instance, route) {
        for (const peer of instance.peerMap.values()) {
            if (peer.peerState !== BgpConst.BGP_PEER_STATE.ESTABLISHED) continue;
            const builder = peer.getRouteGroupBuilder(route);
            if (!builder) continue;
            const result = builder([route], 0);
            if (result.buffer?.length > BgpConst.BGP_MAX_PKT_SIZE)
                throw new Error(`路由 ${route.routeKey} 的BGP报文超过${BgpConst.BGP_MAX_PKT_SIZE}字节上限`);
            if (!result.status || result.index !== 1 || !Buffer.isBuffer(result.buffer))
                throw new Error(`路由 ${route.routeKey} 无法编码到BGP报文`);
        }
    }

    commitGeneratedRouteGroup(messageId, config, instance, routes) {
        return this.serializeRouteGroupMutation(async () => {
            const stats = instance.routeStore.replaceRouteGroup(config.groupId, {
                groupName: config.groupName || config.groupId,
                addressFamily: Number(config.addressFamily),
                instanceKey: instance.instanceKey,
                routes,
                includeOldRoutes: false
            });
            await this.withdrawStoredGroupRoutes(stats.withdrawnRoutes || stats.oldRoutes);
            await this.announceStoredGroup(instance, config.groupId);
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    added: stats.inserted,
                    updated: stats.updated,
                    unchanged: stats.unchanged,
                    deleted: stats.deleted,
                    total: instance.routeMap.size
                },
                '路由组生成成功'
            );
        });
    }

    withdrawRouteGroup(messageId, config = {}) {
        if (typeof config.groupId !== 'string' || !config.groupId.trim()) throw new Error('路由组ID不能为空');
        return this.serializeRouteGroupMutation(async () => {
            const store = this.getRouteStores().find(candidate =>
                candidate.listRouteGroups().some(group => group.groupId === config.groupId)
            );
            const result = store ? store.withdrawRouteGroup(config.groupId) : { deleted: 0, routes: [] };
            await this.withdrawStoredGroupRoutes(result.routes);
            this.messageHandler.sendSuccessResponse(messageId, { deleted: result.deleted }, '路由组撤销成功');
        });
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
        const managedGroup = config.groupId !== undefined;
        if (!managedGroup) this.assertRouteMutationsAvailable();
        if (managedGroup && (typeof config.groupId !== 'string' || !config.groupId.trim()))
            throw new Error('路由组ID不能为空');
        if (
            managedGroup &&
            (Array.isArray(config.routes)
                ? !config.routes.length
                : !Number.isSafeInteger(Number(config.count)) || Number(config.count) < 1)
        )
            throw new Error('路由组数量必须为正整数');
        const routeCount = Number(config.count);
        const attributeRuleContext = buildAttributeRuleContext(
            config,
            Math.random,
            Array.isArray(config.routes) ? config.routes.length : routeCount
        );
        if (managedGroup && !attributeRuleContext.enabled) throw new Error('路由组必须使用树属性配置');
        const nlriEncoding =
            attributeRuleContext.enabled || config.nlriEncoding !== undefined
                ? BgpRoute.normalizeNlriEncoding(config.nlriEncoding)
                : null;
        if (Array.isArray(config.routes)) {
            config.routes.forEach(route => {
                if (route.nlriEncoding !== undefined) BgpRoute.normalizeNlriEncoding(route.nlriEncoding);
                if (route.mpNextHop !== undefined) BgpRoute.normalizeMpNextHop(route.mpNextHop);
            });
        }
        const generatedUnicastPathIds = isSrv6CapableUnicast
            ? attributeRuleContext.enabled
                ? [0]
                : getGeneratedUnicastPathIds(config)
            : [null];
        const prefixStep =
            attributeRuleContext.enabled && !Array.isArray(config.routes) ? Number(config.ipStep ?? 1) : 1;
        if (attributeRuleContext.enabled && !Array.isArray(config.routes)) {
            if (!Number.isSafeInteger(prefixStep) || prefixStep < 1) throw new Error('路由前缀IP步长必须为正整数');
            validateTreePrefixRange(config, ipType, prefixStep);
        }
        const hasLabelRule = attributeRuleContext.rules.some(rule => rule.type === 'label');
        if (hasLabelRule && !isLabelUnicast) throw new Error('MPLS Label属性仅适用于IPv4 Label地址族');
        if (
            !supportsAddPathAddressFamily(addressFamily) &&
            attributeRuleContext.rules.some(rule => rule.type === 'addPath')
        ) {
            throw new Error('ADD-PATH节点仅适用于Unicast和IPv4 Label地址族');
        }
        if (!isSrv6CapableUnicast && attributeRuleContext.rules.some(rule => rule.type === 'srv6')) {
            throw new Error('SRv6节点仅适用于Unicast地址族');
        }
        const labelContext =
            isLabelUnicast && !attributeRuleContext.enabled ? buildLabelGenerationContext(config) : null;
        const randomAsPathContext = attributeRuleContext.enabled
            ? { enabled: false }
            : buildRandomAsPathGenerationContext(config);
        const srv6Context =
            isSrv6CapableUnicast && !attributeRuleContext.enabled
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
        if (!managedGroup)
            this.assertUnmanagedRouteOwnership(instance, iterateTreeRouteInputs(config, ipType, 1, prefixStep));
        const nextCustomAttr = config.customAttr || '';
        const nextRt = config.rt || '';
        const hasAttrChanged =
            !managedGroup &&
            !attributeRuleContext.enabled &&
            (instance.customAttr !== nextCustomAttr || instance.rt !== nextRt);
        this.assertLegacyAttributeRefreshAllowed(instance, hasAttrChanged);
        if (!managedGroup && !attributeRuleContext.enabled) {
            instance.customAttr = nextCustomAttr;
            instance.rt = nextRt;
        }
        const routeBatchStream = managedGroup || hasAttrChanged ? null : instance.createRouteBatchStream();

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
            const generatedAttributes = attributeRuleContext.enabled
                ? getGeneratedAttributeValues(attributeRuleContext, routeIndex)
                : null;
            const pathId = supportsAddPathAddressFamily(addressFamily)
                ? BgpRoute.normalizePathId(generatedAttributes?.pathId ?? route.pathId)
                : null;
            const key = isLabelUnicast
                ? BgpRoute.makeLabelUnicastKey(pathId, route.ip, route.mask)
                : isUnicast
                  ? BgpRoute.makeUnicastKey(pathId, rd, route.ip, route.mask)
                  : BgpRoute.makeKey(route.ip, route.mask);
            const label = generatedAttributes ? (generatedAttributes.label ?? null) : (route.label ?? null);
            const attr = instance.makeRouteAttr(
                null,
                generatedAttributes
                    ? {
                          customAttr: '',
                          rt: '',
                          ...generatedAttributes.attr,
                          attributePolicy: 'configured',
                          configuredAttributes: attributeRuleContext.attributeRules.map(rule => rule.type)
                      }
                    : {
                          customAttr: instance.customAttr,
                          rt: instance.rt,
                          asPath:
                              route.asPath !== undefined
                                  ? route.asPath
                                  : randomAsPathContext.enabled
                                    ? getGeneratedRandomAsPath(randomAsPathContext)
                                    : undefined
                      }
            );

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
            if (route.nlriEncoding !== undefined || nlriEncoding !== null) {
                bgpRoute.nlriEncoding = BgpRoute.normalizeNlriEncoding(route.nlriEncoding ?? nlriEncoding);
            }
            if (generatedAttributes || route.mpNextHop !== undefined) {
                bgpRoute.mpNextHop = BgpRoute.normalizeMpNextHop(
                    generatedAttributes ? generatedAttributes.mpNextHop : route.mpNextHop
                );
            }
            if (isUnicast) {
                bgpRoute.rd = rd;
            }
            if (supportsAddPathAddressFamily(addressFamily)) bgpRoute.pathId = pathId;
            if (isLabelUnicast) bgpRoute.label = label;
            bgpRoute._routeAttr = attr;
            bgpRoute.routeKey = key;
            const entry = { routeKey: key, route: bgpRoute, attr };
            generatedCount += 1;
            routeIndex += 1;
            if (generatedAttributes) this.assertTreeRouteEncodable(instance, bgpRoute);
            if (managedGroup) {
                return { routeKey: key, ...instance.serializeRoute(bgpRoute), attr };
            }
            entries.push(entry);
            if (entries.length >= 2000) flush();
        };

        if (managedGroup) {
            const inputs = iterateTreeRouteInputs(
                config,
                ipType,
                supportsAddPathAddressFamily(addressFamily) ? attributeRuleContext.pathCount : 1,
                prefixStep
            );
            const candidates = (function* () {
                for (const route of inputs) yield addRoute(route);
            })();
            return this.commitGeneratedRouteGroup(messageId, config, instance, candidates);
        }
        if (Array.isArray(config.routes)) {
            config.routes.forEach(addRoute);
        } else if (attributeRuleContext.enabled) {
            for (const route of iterateTreeRouteInputs(
                config,
                ipType,
                supportsAddPathAddressFamily(addressFamily) ? attributeRuleContext.pathCount : 1,
                prefixStep
            ))
                addRoute(route);
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
        this.assertRouteMutationsAvailable();
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            logger.error('实例不存在');
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const ipType = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
        const addressFamily = Number(config.addressFamily);
        const isUnicast = supportsAddPathAddressFamily(addressFamily);
        const isLabel = addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
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
                        rd: isLabel ? undefined : BgpRoute.normalizeRd(route.rd),
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
                        instance.routeMap.get(
                            isLabel
                                ? BgpRoute.makeLabelUnicastKey(route.pathId, route.ip, route.mask)
                                : BgpRoute.makeUnicastKey(route.pathId, rd, route.ip, route.mask)
                        )
                    );
                } else {
                    let cursor = null;
                    do {
                        const page = instance.routeMap.queryPrefix(route.ip, {
                            prefixLength: route.mask,
                            rd: isLabel ? undefined : rd,
                            pageSize: 2000,
                            afterRouteId: cursor,
                            includeTotal: false
                        });
                        page.list.forEach(queueExisting);
                        cursor = page.nextCursor;
                    } while (cursor !== null);
                }
            } else {
                queueExisting(instance.routeMap.get(makeRouteLookupKey(addressFamily, route)));
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

    deleteAllRoutesByFamily(messageId, queryInfo) {
        this.assertRouteMutationsAvailable();
        const pending = this.deleteAllRoutesByFamilyNow(messageId, queryInfo);
        this.bulkRouteMutation = pending;
        return pending.finally(() => {
            if (this.bulkRouteMutation === pending) this.bulkRouteMutation = null;
        });
    }

    async deleteAllRoutesByFamilyNow(messageId, queryInfo) {
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

    generateSpecialTreeRoutes(messageId, config) {
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) throw new Error('实例不存在');
        const managed = config.groupId !== undefined;
        if (managed && (typeof config.groupId !== 'string' || !config.groupId.trim()))
            throw new Error('路由组ID不能为空');
        if (!managed) this.assertRouteMutationsAvailable();
        const count = Array.isArray(config.routes) ? config.routes.length : Number(config.count);
        if (!Number.isSafeInteger(count) || count < 1) throw new Error('路由组数量必须为正整数');
        const isQp = safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP;
        if (!isQp && Number(config.addressFamily) !== BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN)
            throw new Error('当前地址族不支持专用树生成');
        const context = buildAttributeRuleContext(config, Math.random, count);
        if (!context.enabled) throw new Error('路由组必须使用树属性配置');
        if (context.rules.some(rule => ['addPath', 'label', 'srv6'].includes(rule.type)))
            throw new Error('当前地址族不支持ADD-PATH、Label或Unicast SRv6节点');
        if (isQp && context.rules.some(rule => rule.type === 'mpNextHop'))
            throw new Error('QP的MP下一跳请通过BSID节点配置');
        const ipType = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 ? BgpConst.IP_TYPE.IPV6 : BgpConst.IP_TYPE.IPV4;
        const inputs = isQp ? iterateQpTreeRouteInputs(config, ipType) : iterateMvpnTreeRouteInputs(config);
        const assertEncodable = route => this.assertTreeRouteEncodable(instance, route);
        const candidates = (function* () {
            let index = 0;
            for (const input of inputs) {
                const generated = getGeneratedAttributeValues(context, index);
                const route = new BgpRoute(instance);
                instance.copyRouteNlriFields(route, input);
                route.nlriEncoding = BgpRoute.normalizeNlriEncoding(config.nlriEncoding);
                route.mpNextHop = BgpRoute.normalizeMpNextHop(generated.mpNextHop);
                if (isQp) route.dqpn = generated.dqpn ?? null;
                const attr = instance.makeRouteAttr(null, {
                    customAttr: '',
                    rt: '',
                    ...generated.attr,
                    attributePolicy: 'configured',
                    configuredAttributes: context.attributeRules.map(rule => rule.type)
                });
                route._routeAttr = attr;
                route.routeKey = makeRouteLookupKey(Number(config.addressFamily), route);
                assertEncodable(route);
                index += 1;
                yield { routeKey: route.routeKey, ...instance.serializeRoute(route), attr };
            }
        })();
        if (managed) return this.commitGeneratedRouteGroup(messageId, config, instance, candidates);
        const entries = Array.from(candidates, entry => ({
            routeKey: entry.routeKey,
            route: instance.hydrateRoute({ ...entry.route, routeKey: entry.routeKey, routeAttr: entry.attr }),
            attr: entry.attr
        }));
        this.assertUnmanagedRouteOwnership(
            instance,
            entries.map(entry => entry.route)
        );
        let inserted = 0;
        let updated = 0;
        let unchanged = 0;
        const stream = instance.createRouteBatchStream();
        for (let index = 0; index < entries.length; index += 2000) {
            const batch = entries.slice(index, index + 2000);
            const stats = instance.upsertRouteBatch(batch);
            inserted += stats.inserted;
            updated += stats.updated;
            unchanged += stats.unchanged;
            if (stats.changed) stream.write(batch.map(entry => entry.route));
        }
        stream.end();
        this.messageHandler.sendSuccessResponse(
            messageId,
            { added: inserted, updated, unchanged, total: instance.routeMap.size },
            '路由生成成功'
        );
    }

    generateQpRoutes(messageId, config) {
        if (config.attributeRules !== undefined || config.nlriRules !== undefined || config.groupId !== undefined)
            return this.generateSpecialTreeRoutes(messageId, config);
        this.assertRouteMutationsAvailable();
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
            this.assertLegacyAttributeRefreshAllowed(instance, hasAttrChanged);
            if (
                instance.routeStore
                    .listRouteGroups()
                    .some(group => group.addressFamily === Number(config.addressFamily))
            ) {
                const ipType = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
                forEachQpGeneratedRoute(config, ipType, route => this.assertUnmanagedRouteOwnership(instance, [route]));
            }
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
        if (Array.isArray(config.routes)) return this.deleteRoute(messageId, config);
        if (Object.hasOwn(config, 'dqpn') || config.startDqpn === null)
            return this.deleteRoute(messageId, {
                ...config,
                routes: [
                    {
                        ip: config.ip ?? config.prefix,
                        mask: config.mask,
                        dqpn: Object.hasOwn(config, 'dqpn') ? config.dqpn : config.startDqpn
                    }
                ]
            });
        this.assertRouteMutationsAvailable();
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
        if (config.attributeRules !== undefined || config.nlriRules !== undefined || config.groupId !== undefined)
            return this.generateSpecialTreeRoutes(messageId, config);
        this.assertRouteMutationsAvailable();
        const { afi, safi } = getAfiAndSafi(config.addressFamily);
        const instance = this.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
        if (!instance) {
            this.messageHandler.sendErrorResponse(messageId, '实例不存在');
            return;
        }

        const randomAsPathContext = buildRandomAsPathGenerationContext(config);
        const nextRt = config.rt || '';
        const hasAttrChanged = instance.rt !== nextRt;
        this.assertLegacyAttributeRefreshAllowed(instance, hasAttrChanged);
        if (instance.routeStore.listRouteGroups().some(group => group.addressFamily === Number(config.addressFamily))) {
            this.forEachMvpnGeneratedIp(config, ipObj => {
                const routeType = Number(config.routeType);
                const row = {
                    ...config,
                    originatingRouterIp: routeType === 1 ? ipObj.ip : config.originatingRouterIp,
                    groupIp: [3, 5, 6, 7].includes(routeType) ? ipObj.ip : config.groupIp
                };
                this.assertUnmanagedRouteOwnership(instance, [row]);
            });
        }
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
                    bgpRoute.sourceIp = config.sourceIp;
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
        if (Array.isArray(config.routes)) return this.deleteRoute(messageId, config);
        if (config.leafRouteKey) return this.deleteRoute(messageId, { ...config, routes: [config] });
        this.assertRouteMutationsAvailable();
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
                originatingRouterIp: currentOrigRouterIp,
                leafRouteKey: config.leafRouteKey
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
        this.assertRouteMutationsAvailable();
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

        this.assertUnmanagedRouteOwnership(instance, routeList);
        this.assertLegacyAttributeRefreshAllowed(instance, hasInstanceAttrChanged);
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
            if (Number(addressFamily) === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) {
                route.pathId = BgpRoute.normalizePathId(route.pathId);
                key = BgpRoute.makeLabelUnicastKey(route.pathId, route.ip, route.mask);
            } else if (isUnicastAddressFamily(addressFamily)) {
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
module.exports.formatBgpListenError = formatBgpListenError;
