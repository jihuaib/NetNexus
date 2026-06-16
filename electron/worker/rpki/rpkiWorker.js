const net = require('net');
const util = require('util');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const RpkiSession = require('./rpkiSession');
const RpkiRoa = require('./rpkiRoa');
const RpkiRouterKey = require('./rpkiRouterKey');
const RpkiAspa = require('./rpkiAspa');
const RpkiConst = require('../../const/rpkiConst');
const SshTunnel = require('../shared/sshTunnel');

class RpkiWorker {
    constructor() {
        this.server = null;
        this.ipv6Server = null;
        this.socket = null;

        this.rpkiConfigData = null; // rpki配置数据

        this.rpkiSessionMap = new Map(); // rpki会话map
        this.rpkiRoaMap = new Map(); // rpki roa map
        this.rpkiRouterKeyMap = new Map(); // rpki router key map (v1+)
        this.rpkiAspaMap = new Map(); // rpki aspa map (v2+)
        this.cacheSerial = 1; // RPKI-RTR cache serial number advertised in Notify/End of Data.
        this.serialHistory = [];
        this.serialHistoryOperationCount = 0;
        this.maxSerialHistoryEntries = 1024;
        this.maxSerialHistoryOperations = 200000;

        // 创建消息处理器
        this.messageHandler = new WorkerMessageHandler();
        // 初始化消息处理器
        this.messageHandler.init();
        // 注册消息处理器
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.START_RPKI, this.startRpki.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.STOP_RPKI, this.stopRpki.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.ADD_ROA, this.addRoa.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.ADD_ROA_BATCH, this.addRoaBatch.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.DELETE_ROA, this.deleteRoa.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.DELETE_ROA_BATCH, this.deleteRoaBatch.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.GET_CLIENT_LIST, this.getClientList.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.ADD_ROUTER_KEY, this.addRouterKey.bind(this));
        this.messageHandler.registerHandler(
            RpkiConst.RPKI_REQ_TYPES.DELETE_ROUTER_KEY,
            this.deleteRouterKey.bind(this)
        );
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.ADD_ASPA, this.addAspa.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.ADD_ASPA_BATCH, this.addAspaBatch.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.DELETE_ASPA, this.deleteAspa.bind(this));
        this.messageHandler.registerHandler(
            RpkiConst.RPKI_REQ_TYPES.DELETE_ASPA_BATCH,
            this.deleteAspaBatch.bind(this)
        );
    }

    createRpkiSession(socket, clientAddress, clientPort) {
        const sessionKey = RpkiSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);
        const existingSession = this.rpkiSessionMap.get(sessionKey);
        if (existingSession) {
            existingSession.closeSession();
            this.rpkiSessionMap.delete(sessionKey);
        }

        const rpkiSession = new RpkiSession(this.messageHandler, this);
        this.rpkiSessionMap.set(sessionKey, rpkiSession);

        rpkiSession.socket = socket;
        rpkiSession.localIp = socket.localAddress;
        rpkiSession.localPort = socket.localPort;
        rpkiSession.remoteIp = clientAddress;
        rpkiSession.remotePort = clientPort;
        rpkiSession.aspaFormat = this.rpkiConfigData?.aspaFormat || RpkiConst.RPKI_ASPA_FORMAT.LATEST;

        this.messageHandler.sendEvent(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, {
            opType: 'add',
            data: rpkiSession.getClientInfo()
        });

        return rpkiSession;
    }

    removeRpkiSession(rpkiSession) {
        if (!rpkiSession) {
            return;
        }

        const sessionKey = RpkiSession.makeKey(
            rpkiSession.localIp,
            rpkiSession.localPort,
            rpkiSession.remoteIp,
            rpkiSession.remotePort
        );
        if (this.rpkiSessionMap.get(sessionKey) === rpkiSession) {
            this.rpkiSessionMap.delete(sessionKey);
        }
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
                    const rpkiSession = this.rpkiSessionMap.get(
                        RpkiSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort)
                    );
                    if (!rpkiSession) {
                        logger.error(`ipv4 Client ${clientAddress}:${clientPort} not found in rpkiSessionMap`);
                        socket.destroy();
                        return;
                    }
                    rpkiSession.recvMsg(data);
                });

                socket.on('end', () => {
                    const sessionKey = RpkiSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const rpkiSession = this.rpkiSessionMap.get(sessionKey);
                    if (!rpkiSession) {
                        logger.debug(`ipv4 Client ${clientAddress}:${clientPort} already removed on end`);
                        return;
                    }
                    rpkiSession.closeSession();
                    this.rpkiSessionMap.delete(sessionKey);
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} end`);
                });

                socket.on('close', () => {
                    const sessionKey = RpkiSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const rpkiSession = this.rpkiSessionMap.get(sessionKey);
                    if (!rpkiSession) {
                        logger.debug(`ipv4 Client ${clientAddress}:${clientPort} already removed on close`);
                        return;
                    }
                    rpkiSession.closeSession();
                    this.rpkiSessionMap.delete(sessionKey);
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} close`);
                });

                socket.on('error', err => {
                    const sessionKey = RpkiSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const rpkiSession = this.rpkiSessionMap.get(sessionKey);
                    if (!rpkiSession) {
                        logger.debug(`ipv4 Client ${clientAddress}:${clientPort} already removed on error`);
                        return;
                    }
                    rpkiSession.closeSession();
                    this.rpkiSessionMap.delete(sessionKey);
                    logger.error(`ipv4 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                });

                // 创建RPKI会话
                this.createRpkiSession(socket, clientAddress, clientPort);
            });

            this.ipv6Server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv6 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv6 localAddress: ${socket.localAddress}:${socket.localPort}`);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const rpkiSession = this.rpkiSessionMap.get(
                        RpkiSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort)
                    );
                    if (!rpkiSession) {
                        logger.error(`ipv6 Client ${clientAddress}:${clientPort} not found in rpkiSessionMap`);
                        socket.destroy();
                        return;
                    }
                    rpkiSession.recvMsg(data);
                });

                socket.on('end', () => {
                    const sessionKey = RpkiSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const rpkiSession = this.rpkiSessionMap.get(sessionKey);
                    if (!rpkiSession) {
                        logger.debug(`ipv6 Client ${clientAddress}:${clientPort} already removed on end`);
                        return;
                    }
                    rpkiSession.closeSession();
                    this.rpkiSessionMap.delete(sessionKey);
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} end`);
                });

                socket.on('close', () => {
                    const sessionKey = RpkiSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const rpkiSession = this.rpkiSessionMap.get(sessionKey);
                    if (!rpkiSession) {
                        logger.debug(`ipv6 Client ${clientAddress}:${clientPort} already removed on close`);
                        return;
                    }
                    rpkiSession.closeSession();
                    this.rpkiSessionMap.delete(sessionKey);
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} close`);
                });

                socket.on('error', err => {
                    const sessionKey = RpkiSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const rpkiSession = this.rpkiSessionMap.get(sessionKey);
                    if (!rpkiSession) {
                        logger.debug(`ipv6 Client ${clientAddress}:${clientPort} already removed on error`);
                        return;
                    }
                    rpkiSession.closeSession();
                    this.rpkiSessionMap.delete(sessionKey);
                    logger.error(`ipv6 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                });

                // 创建RPKI会话
                this.createRpkiSession(socket, clientAddress, clientPort);
            });

            // 启动ipv4服务器并监听端口
            const listenPormise = util.promisify(this.server.listen).bind(this.server);
            await listenPormise(this.rpkiConfigData.port, '0.0.0.0');
            logger.info(`TCP Server listening on port ${this.rpkiConfigData.port} at 0.0.0.0`);

            // 启动ipv6服务器并监听端口
            const ipv6ListenPormise = util.promisify(this.ipv6Server.listen).bind(this.ipv6Server);
            await ipv6ListenPormise(this.rpkiConfigData.port, '::');
            logger.info(`TCP Server listening on port ${this.rpkiConfigData.port} at ::`);

            logger.info(`rpki协议启动成功`);
            this.messageHandler.sendSuccessResponse(messageId, null, 'rpki协议启动成功');
        } catch (err) {
            logger.error(`Error starting TCP server: ${err.message}`);
            this.messageHandler.sendErrorResponse(messageId, 'rpki协议启动失败');
        }
    }

    async startRpki(messageId, rpkiConfigData) {
        this.rpkiConfigData = rpkiConfigData;

        // 设置日志级别
        if (this.rpkiConfigData.logLevel) {
            logger.setLevel(this.rpkiConfigData.logLevel);
            logger.info(`Worker log level set to: ${this.rpkiConfigData.logLevel}`);
        }
        // 如果启用了 MD5 认证，使用 SSH 隧道启动远端代理。
        if (rpkiConfigData.enableAuth && rpkiConfigData.md5Password) {
            try {
                logger.info('TCP MD5 authentication enabled, creating SSH tunnel...');

                // 提取SSH服务器地址
                const sshHost = rpkiConfigData.serverAddress;

                // 创建SSH隧道
                this.sshTunnel = new SshTunnel();
                await this.sshTunnel.connect({
                    host: sshHost,
                    username: rpkiConfigData.sshUsername,
                    password: rpkiConfigData.sshPassword
                });

                logger.info('Using TCP MD5 proxy');
                const proxyConfig = rpkiConfigData.md5Password;

                // 启动远程代理
                // 代理监听 rpkiConfigData.port (路由器连接这个端口)
                // 然后转发到 Windows RPKI 服务器
                const localPort = parseInt(rpkiConfigData.localPort);

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
                    'rpki', // 协议类型
                    rpkiConfigData.peerIP, // BMP路由器IP（peer IP）
                    proxyConfig, // MD5密码
                    rpkiConfigData.port, // Linux监听端口（路由器连接）
                    `${windowsIp}:${localPort}` // 转发到 Windows 的 localPort
                );

                logger.info('SSH tunnel and proxy started successfully');
                logger.info(`RPKI router should connect to: ${sshHost}:${rpkiConfigData.port}`);
                logger.info(`Proxy will forward to localhost:${localPort}`);

                // 启动本地TCP服务器 - 直接监听 localPort
                const originalPort = this.rpkiConfigData.port;
                this.rpkiConfigData.port = localPort;

                // 启动本地TCP服务器
                await this.startTcpServer(messageId);

                // 恢复原始端口配置
                this.rpkiConfigData.port = originalPort;

                logger.info('Local RPKI server started, waiting for connections from proxy');
            } catch (error) {
                logger.error(`Failed to setup SSH tunnel: ${error.message}`);
                this.messageHandler.sendErrorResponse(messageId, `SSH隧道连接失败: ${error.message}`);
                return;
            }
        } else {
            // 启动tcp服务器
            this.startTcpServer(messageId);
        }
    }

    async stopRpki(messageId) {
        // 停止SSH隧道和代理
        if (this.sshTunnel) {
            try {
                // 停止远程代理
                if (this.rpkiConfigData) {
                    const localPort = this.rpkiConfigData.localPort;
                    const _sshHost = this.rpkiConfigData.serverAddress;

                    const proxyConfig = this.rpkiConfigData.md5Password;

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
                        'rpki',
                        this.rpkiConfigData.peerIP,
                        proxyConfig,
                        this.rpkiConfigData.port,
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
        this.rpkiConfigData = null;

        // 清空会话
        const closeSessionPromises = [];
        this.rpkiSessionMap.forEach((session, _) => {
            closeSessionPromises.push(session.closeSession({ graceful: true }));
        });
        await Promise.all(closeSessionPromises);
        this.rpkiSessionMap.clear();
        this.rpkiRoaMap.clear();
        this.rpkiRouterKeyMap.clear();
        this.rpkiAspaMap.clear();
        this.clearSerialHistory();
        this.messageHandler.sendSuccessResponse(messageId, null, 'rpki协议停止成功');
    }

    sendSingleRoaData(rpkiRoa) {
        for (const session of this.rpkiSessionMap.values()) {
            session.sendSingleRoaData(rpkiRoa);
        }
    }

    bumpCacheSerial() {
        this.cacheSerial = (this.cacheSerial + 1) >>> 0;
        logger.info(`RPKI cache serial updated: ${this.cacheSerial}`);
        return this.cacheSerial;
    }

    sendSerialNotify() {
        for (const session of this.rpkiSessionMap.values()) {
            session.sendSerialNotify();
        }
    }

    bumpSerialAndNotify(changed) {
        if (!changed) {
            return;
        }
        this.bumpCacheSerial();
        this.sendSerialNotify();
    }

    trimSerialHistory() {
        while (
            this.serialHistory.length > this.maxSerialHistoryEntries ||
            this.serialHistoryOperationCount > this.maxSerialHistoryOperations
        ) {
            const removed = this.serialHistory.shift();
            this.serialHistoryOperationCount -= removed?.operations?.length || 0;
        }
    }

    clearSerialHistory() {
        this.serialHistory = [];
        this.serialHistoryOperationCount = 0;
    }

    recordSerialDeltaAndNotify(operations) {
        const serialOperations = (operations || []).filter(Boolean);
        if (serialOperations.length === 0) {
            return;
        }

        const serial = this.bumpCacheSerial();
        this.serialHistory.push({
            serial,
            operations: serialOperations
        });
        this.serialHistoryOperationCount += serialOperations.length;
        this.trimSerialHistory();
        this.sendSerialNotify();
    }

    getDeltaOperationsSince(serial) {
        const requestedSerial = Number(serial) >>> 0;
        const currentSerial = this.cacheSerial >>> 0;
        if (requestedSerial === currentSerial) {
            return [];
        }

        const expectedFirstSerial = (requestedSerial + 1) >>> 0;
        const firstIndex = this.serialHistory.findIndex(entry => entry.serial === expectedFirstSerial);
        if (firstIndex === -1) {
            return null;
        }

        const entries = this.serialHistory.slice(firstIndex);
        if (entries.length === 0 || entries[entries.length - 1].serial !== currentSerial) {
            return null;
        }

        const operations = [];
        let expectedSerial = expectedFirstSerial;
        for (const entry of entries) {
            if (entry.serial !== expectedSerial) {
                return null;
            }
            operations.push(...entry.operations);
            expectedSerial = (expectedSerial + 1) >>> 0;
        }

        return operations;
    }

    sendRoaBatchData(roas) {
        if (!Array.isArray(roas) || roas.length === 0) {
            return;
        }
        for (const session of this.rpkiSessionMap.values()) {
            session.sendRoaBatchData(roas);
        }
    }

    withdrawSingleRoaData(rpkiRoa) {
        for (const session of this.rpkiSessionMap.values()) {
            session.withdrawSingleRoaData(rpkiRoa);
        }
    }

    withdrawRoaBatchData(roas) {
        if (!Array.isArray(roas) || roas.length === 0) {
            return;
        }
        for (const session of this.rpkiSessionMap.values()) {
            session.withdrawRoaBatchData(roas);
        }
    }

    addRoa(messageId, roa) {
        const key = RpkiRoa.makeKey(roa.ip, roa.mask, roa.asn, roa.maxLength);
        if (this.rpkiRoaMap.has(key)) {
            logger.error(`RPKI ROA配置已存在: ${key}`);
            this.messageHandler.sendErrorResponse(messageId, 'RPKI ROA配置已存在');
            return;
        }
        const rpkiRoa = new RpkiRoa(roa.ip, roa.mask, roa.asn, roa.maxLength, roa.ipType);
        this.rpkiRoaMap.set(key, rpkiRoa);

        this.recordSerialDeltaAndNotify([{ type: 'roa', action: 'announce', data: rpkiRoa }]);

        this.messageHandler.sendSuccessResponse(messageId, null, 'RPKI ROA配置添加成功');
    }

    addRoaBatch(messageId, payload) {
        const roas = Array.isArray(payload) ? payload : payload?.roas || [];
        const announce = Boolean(payload?.announce);
        let added = 0;
        let skipped = 0;
        const addedRoas = [];

        for (const roa of roas) {
            const key = RpkiRoa.makeKey(roa.ip, roa.mask, roa.asn, roa.maxLength);
            if (this.rpkiRoaMap.has(key)) {
                skipped += 1;
                continue;
            }

            const rpkiRoa = new RpkiRoa(roa.ip, roa.mask, roa.asn, roa.maxLength, roa.ipType);
            this.rpkiRoaMap.set(key, rpkiRoa);
            added += 1;
            addedRoas.push(rpkiRoa);
        }

        if (announce) {
            this.recordSerialDeltaAndNotify(
                addedRoas.map(rpkiRoa => ({ type: 'roa', action: 'announce', data: rpkiRoa }))
            );
        }

        this.messageHandler.sendSuccessResponse(
            messageId,
            { added, skipped, total: this.rpkiRoaMap.size },
            'RPKI ROA批量添加成功'
        );
    }

    deleteRoa(messageId, roa) {
        const key = RpkiRoa.makeKey(roa.ip, roa.mask, roa.asn, roa.maxLength);
        if (!this.rpkiRoaMap.has(key)) {
            logger.error(`RPKI ROA配置不存在: ${key}`);
            this.messageHandler.sendErrorResponse(messageId, 'RPKI ROA配置不存在');
            return;
        }

        const rpkiRoa = this.rpkiRoaMap.get(key);

        this.rpkiRoaMap.delete(key);
        this.recordSerialDeltaAndNotify([{ type: 'roa', action: 'withdraw', data: rpkiRoa }]);
        this.messageHandler.sendSuccessResponse(messageId, null, 'RPKI ROA配置删除成功');
    }

    deleteRoaBatch(messageId, payload) {
        const deleteAll = Boolean(payload?.all);
        const inputRoas = Array.isArray(payload?.roas) ? payload.roas : [];
        let deletedRoas = [];
        let notFound = 0;

        if (deleteAll) {
            deletedRoas = Array.from(this.rpkiRoaMap.values());
            this.rpkiRoaMap.clear();
        } else {
            for (const roa of inputRoas) {
                const key = RpkiRoa.makeKey(roa.ip, roa.mask, roa.asn, roa.maxLength);
                const rpkiRoa = this.rpkiRoaMap.get(key);
                if (!rpkiRoa) {
                    notFound += 1;
                    continue;
                }
                deletedRoas.push(rpkiRoa);
                this.rpkiRoaMap.delete(key);
            }
        }

        this.recordSerialDeltaAndNotify(
            deletedRoas.map(rpkiRoa => ({ type: 'roa', action: 'withdraw', data: rpkiRoa }))
        );
        this.messageHandler.sendSuccessResponse(
            messageId,
            {
                deleted: deletedRoas.length,
                notFound,
                total: this.rpkiRoaMap.size
            },
            'RPKI ROA批量删除成功'
        );
    }

    getClientList(messageId) {
        const clientList = [];
        this.rpkiSessionMap.forEach((session, _) => {
            clientList.push(session.getClientInfo());
        });
        this.messageHandler.sendSuccessResponse(messageId, clientList, '获取客户端列表成功');
    }

    // RouterKey (v1+)
    sendSingleRouterKey(rk) {
        for (const session of this.rpkiSessionMap.values()) {
            if (session.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V1) {
                session.sendRouterKey(rk);
            }
        }
    }

    withdrawSingleRouterKey(rk) {
        for (const session of this.rpkiSessionMap.values()) {
            if (session.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V1) {
                session.withdrawRouterKey(rk);
            }
        }
    }

    addRouterKey(messageId, payload) {
        const key = RpkiRouterKey.makeKey(payload.ski, payload.asn);
        if (this.rpkiRouterKeyMap.has(key)) {
            logger.error(`RPKI RouterKey已存在: ${key}`);
            this.messageHandler.sendErrorResponse(messageId, 'RouterKey已存在');
            return;
        }
        const rk = new RpkiRouterKey(payload.ski, payload.asn, payload.spki);
        this.rpkiRouterKeyMap.set(key, rk);
        this.recordSerialDeltaAndNotify([{ type: 'routerKey', action: 'announce', data: rk }]);
        this.messageHandler.sendSuccessResponse(messageId, null, 'RouterKey添加成功');
    }

    deleteRouterKey(messageId, payload) {
        const key = RpkiRouterKey.makeKey(payload.ski, payload.asn);
        if (!this.rpkiRouterKeyMap.has(key)) {
            logger.error(`RPKI RouterKey不存在: ${key}`);
            this.messageHandler.sendErrorResponse(messageId, 'RouterKey不存在');
            return;
        }
        const rk = this.rpkiRouterKeyMap.get(key);
        this.rpkiRouterKeyMap.delete(key);
        this.recordSerialDeltaAndNotify([{ type: 'routerKey', action: 'withdraw', data: rk }]);
        this.messageHandler.sendSuccessResponse(messageId, null, 'RouterKey删除成功');
    }

    // ASPA (v2+)
    sendSingleAspa(aspa) {
        for (const session of this.rpkiSessionMap.values()) {
            if (session.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
                session.sendAspa(aspa);
            }
        }
    }

    sendAspaBatch(aspas) {
        if (!Array.isArray(aspas) || aspas.length === 0) {
            return;
        }
        for (const session of this.rpkiSessionMap.values()) {
            if (session.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
                for (const aspa of aspas) {
                    session.sendAspa(aspa);
                }
            }
        }
    }

    withdrawSingleAspa(aspa) {
        for (const session of this.rpkiSessionMap.values()) {
            if (session.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
                session.withdrawAspa(aspa);
            }
        }
    }

    replaceSingleAspa(oldAspa, newAspa) {
        for (const session of this.rpkiSessionMap.values()) {
            session.replaceAspa(oldAspa, newAspa);
        }
    }

    replaceAspaBatch(replacements) {
        if (!Array.isArray(replacements) || replacements.length === 0) {
            return;
        }
        for (const session of this.rpkiSessionMap.values()) {
            if (session.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
                for (const replacement of replacements) {
                    session.replaceAspa(replacement.oldAspa, replacement.newAspa);
                }
            }
        }
    }

    announceAspaOperations(operations) {
        if (!Array.isArray(operations) || operations.length === 0) {
            return;
        }
        for (const session of this.rpkiSessionMap.values()) {
            if (session.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
                for (const operation of operations) {
                    if (operation.oldAspa) {
                        session.replaceAspa(operation.oldAspa, operation.newAspa);
                    } else {
                        session.sendAspa(operation.newAspa);
                    }
                }
            }
        }
    }

    addAspa(messageId, payload) {
        const key = RpkiAspa.makeKey(payload.customerAsn);
        const oldAspa = this.rpkiAspaMap.get(key);
        const aspa = new RpkiAspa(payload.customerAsn, payload.providerAsns, payload.afiFlags);
        this.rpkiAspaMap.set(key, aspa);
        this.recordSerialDeltaAndNotify([
            oldAspa
                ? { type: 'aspa', action: 'replace', oldData: oldAspa, newData: aspa }
                : { type: 'aspa', action: 'announce', data: aspa }
        ]);
        this.messageHandler.sendSuccessResponse(messageId, null, oldAspa ? 'ASPA覆盖成功' : 'ASPA添加成功');
    }

    addAspaBatch(messageId, payload) {
        const aspas = Array.isArray(payload) ? payload : payload?.aspas || [];
        const announce = Boolean(payload?.announce);
        let added = 0;
        let overwritten = 0;
        const operations = [];

        for (const payloadAspa of aspas) {
            const key = RpkiAspa.makeKey(payloadAspa.customerAsn);
            const oldAspa = this.rpkiAspaMap.get(key);
            const aspa = new RpkiAspa(payloadAspa.customerAsn, payloadAspa.providerAsns, payloadAspa.afiFlags);
            this.rpkiAspaMap.set(key, aspa);

            if (oldAspa) {
                overwritten += 1;
            } else {
                added += 1;
            }
            operations.push({ oldAspa, newAspa: aspa });
        }

        if (announce) {
            this.recordSerialDeltaAndNotify(
                operations.map(operation =>
                    operation.oldAspa
                        ? { type: 'aspa', action: 'replace', oldData: operation.oldAspa, newData: operation.newAspa }
                        : { type: 'aspa', action: 'announce', data: operation.newAspa }
                )
            );
        }

        this.messageHandler.sendSuccessResponse(
            messageId,
            { added, overwritten, total: this.rpkiAspaMap.size },
            'ASPA批量添加成功'
        );
    }

    deleteAspa(messageId, payload) {
        const key = RpkiAspa.makeKey(payload.customerAsn);
        if (!this.rpkiAspaMap.has(key)) {
            logger.error(`RPKI ASPA不存在: ${key}`);
            this.messageHandler.sendErrorResponse(messageId, 'ASPA不存在');
            return;
        }
        const aspa = this.rpkiAspaMap.get(key);
        this.rpkiAspaMap.delete(key);
        this.recordSerialDeltaAndNotify([{ type: 'aspa', action: 'withdraw', data: aspa }]);
        this.messageHandler.sendSuccessResponse(messageId, null, 'ASPA删除成功');
    }

    deleteAspaBatch(messageId, payload) {
        const deleteAll = Boolean(payload?.all);
        if (!deleteAll) {
            this.messageHandler.sendErrorResponse(messageId, '不支持的ASPA批量删除请求');
            return;
        }

        const deletedAspas = Array.from(this.rpkiAspaMap.values());
        this.rpkiAspaMap.clear();

        this.recordSerialDeltaAndNotify(deletedAspas.map(aspa => ({ type: 'aspa', action: 'withdraw', data: aspa })));

        this.messageHandler.sendSuccessResponse(
            messageId,
            { deleted: deletedAspas.length, total: this.rpkiAspaMap.size },
            'ASPA批量删除成功'
        );
    }
}

if (require.main === module) {
    new RpkiWorker(); // 启动监听
}

module.exports = RpkiWorker;
