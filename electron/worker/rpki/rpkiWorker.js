const net = require('net');
const util = require('util');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const RpkiSession = require('./rpkiSession');
const RpkiRoa = require('./rpkiRoa');
const RpkiRouterKey = require('./rpkiRouterKey');
const RpkiAspa = require('./rpkiAspa');
const RpkiConst = require('../../const/rpkiConst');

class RpkiWorker {
    constructor() {
        this.server = null;
        this.ipv6Server = null;
        this.socket = null;

        this.rpkiConfigData = null; // rpki配置数据

        this.rpkiSessionMap = new Map(); // rpki会话map
        this.rpkiRouterKeyMap = new Map(); // rpki router key map (v1+)
        this.rpkiDatabasePath = null;
        this.rpkiStore = null;
        this.cacheSerial = 1; // RPKI-RTR cache serial number advertised in Notify/End of Data.
        this.serialHistory = [];
        this.serialHistoryOperationCount = 0;
        this.serialHistoryBytes = 0;
        this.maxSerialHistoryEntries = 1024;
        this.maxSerialHistoryOperations = 10000;
        this.maxSerialHistoryBytes = 16 * 1024 * 1024;
        this.activeDataSnapshots = 0;
        this.maxConcurrentDataSnapshots = 4;

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
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.DATASET_CHANGED, this.datasetChanged.bind(this));
    }

    getRpkiSqliteStoreClass() {
        // Load the native dependency lazily so protocol-only unit tests can use
        // createDataSnapshot()/iterateRoas()/iterateAspas() without opening a DB.
        return require('./rpkiSqliteStore');
    }

    normalizeCacheSerial(value, fallback = this.cacheSerial) {
        const candidate =
            value && typeof value === 'object' ? (value.cacheSerial ?? value.cache_serial ?? value.serial) : value;
        const number = Number(candidate);
        if (!Number.isInteger(number) || number < 0) {
            return Number(fallback) >>> 0;
        }
        return number >>> 0;
    }

    getStoreCacheSerial(store = this.rpkiStore) {
        if (!store || typeof store.getCacheSerial !== 'function') {
            return this.cacheSerial >>> 0;
        }
        return this.normalizeCacheSerial(store.getCacheSerial(), this.cacheSerial);
    }

    openRpkiStore(databasePath) {
        const normalizedPath = typeof databasePath === 'string' ? databasePath.trim() : '';
        if (!normalizedPath) {
            throw new Error('RPKI SQLite database path is required');
        }

        this.closeRpkiStore();
        const RpkiSqliteStore = this.getRpkiSqliteStoreClass();
        const store = new RpkiSqliteStore({ dbPath: normalizedPath }).open();
        this.rpkiDatabasePath = normalizedPath;
        this.rpkiStore = store;
        this.cacheSerial = this.getStoreCacheSerial(store);
        return store;
    }

    closeRpkiStore() {
        const store = this.rpkiStore;
        this.rpkiStore = null;
        this.rpkiDatabasePath = null;
        if (store && typeof store.close === 'function') {
            store.close();
        }
    }

    restoreInitialRouterKeys(routerKeys) {
        this.rpkiRouterKeyMap.clear();
        for (const payload of Array.isArray(routerKeys) ? routerKeys : []) {
            if (!payload || typeof payload !== 'object') {
                continue;
            }
            const rk = new RpkiRouterKey(payload.ski, payload.asn, payload.spki);
            this.rpkiRouterKeyMap.set(RpkiRouterKey.makeKey(rk.ski, rk.asn), rk);
        }
    }

    createDataSnapshot() {
        if (!this.rpkiDatabasePath) {
            return {
                store: null,
                cacheSerial: this.cacheSerial >>> 0,
                routerKeys: Array.from(this.rpkiRouterKeyMap.values()),
                snapshotStarted: false
            };
        }

        if (this.activeDataSnapshots >= this.maxConcurrentDataSnapshots) {
            throw new Error(`RPKI并发数据快照已达到上限 ${this.maxConcurrentDataSnapshots}`);
        }
        this.activeDataSnapshots += 1;

        let store = null;
        let snapshotStarted = false;
        try {
            const RpkiSqliteStore = this.getRpkiSqliteStoreClass();
            store = new RpkiSqliteStore({
                dbPath: this.rpkiDatabasePath,
                readOnly: true
            }).open();
            let snapshotMetadata = null;
            if (typeof store.beginReadSnapshot === 'function') {
                snapshotMetadata = store.beginReadSnapshot();
                snapshotStarted = true;
            }
            return {
                store,
                cacheSerial: this.normalizeCacheSerial(snapshotMetadata, this.getStoreCacheSerial(store)),
                roaCount: Number(snapshotMetadata?.roaCount) || 0,
                aspaCount: Number(snapshotMetadata?.aspaCount) || 0,
                routerKeys: Array.from(this.rpkiRouterKeyMap.values()),
                snapshotStarted,
                snapshotSlotActive: true,
                closed: false
            };
        } catch (error) {
            if (typeof store?.close === 'function') {
                store.close();
            }
            this.activeDataSnapshots = Math.max(0, this.activeDataSnapshots - 1);
            throw error;
        }
    }

    iterateRoas(snapshot) {
        const store = snapshot?.store || this.rpkiStore;
        return store && typeof store.iterateRoas === 'function' ? store.iterateRoas() : [];
    }

    iterateAspas(snapshot) {
        const store = snapshot?.store || this.rpkiStore;
        return store && typeof store.iterateAspas === 'function' ? store.iterateAspas() : [];
    }

    closeDataSnapshot(snapshot) {
        if (!snapshot || snapshot.closed) {
            return;
        }
        snapshot.closed = true;
        const store = snapshot?.store;
        if (!store) {
            return;
        }
        try {
            if (snapshot.snapshotStarted && typeof store.endReadSnapshot === 'function') {
                store.endReadSnapshot();
            }
        } finally {
            try {
                if (typeof store.close === 'function') {
                    store.close();
                }
            } finally {
                if (snapshot.snapshotSlotActive) {
                    snapshot.snapshotSlotActive = false;
                    this.activeDataSnapshots = Math.max(0, this.activeDataSnapshots - 1);
                    if (this.activeDataSnapshots === 0 && typeof this.rpkiStore?.checkpoint === 'function') {
                        try {
                            this.rpkiStore.checkpoint('PASSIVE');
                        } catch (error) {
                            logger.debug(`RPKI SQLite快照结束后checkpoint未完成: ${error.message}`);
                        }
                    }
                }
            }
        }
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
            this.closeRpkiStore();
            this.messageHandler.sendErrorResponse(messageId, 'rpki协议启动失败');
        }
    }

    async startRpki(messageId, rpkiConfigData) {
        this.rpkiConfigData = rpkiConfigData;
        const configuredSnapshotLimit = Number(rpkiConfigData?.maxConcurrentSnapshots);
        this.maxConcurrentDataSnapshots =
            Number.isInteger(configuredSnapshotLimit) && configuredSnapshotLimit > 0
                ? Math.min(configuredSnapshotLimit, 16)
                : 4;

        try {
            this.openRpkiStore(rpkiConfigData?.rpkiDatabasePath);
            this.restoreInitialRouterKeys(rpkiConfigData?.initialRouterKeys);
            this.clearSerialHistory();
        } catch (error) {
            this.rpkiConfigData = null;
            this.closeRpkiStore();
            logger.error(`RPKI SQLite打开失败: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, `RPKI SQLite打开失败: ${error.message}`);
            return;
        }

        // 设置日志级别
        if (this.rpkiConfigData.logLevel) {
            logger.setLevel(this.rpkiConfigData.logLevel);
            logger.info(`Worker log level set to: ${this.rpkiConfigData.logLevel}`);
        }
        await this.startTcpServer(messageId);
    }

    async stopRpki(messageId) {
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
        this.rpkiRouterKeyMap.clear();
        this.clearSerialHistory();
        this.closeRpkiStore();
        this.rpkiDatabasePath = null;
        this.messageHandler.sendSuccessResponse(messageId, null, 'rpki协议停止成功');
    }

    sendSingleRoaData(rpkiRoa) {
        for (const session of this.rpkiSessionMap.values()) {
            session.sendSingleRoaData(rpkiRoa);
        }
    }

    bumpCacheSerial() {
        if (this.rpkiStore && typeof this.rpkiStore.bumpCacheSerial === 'function') {
            this.cacheSerial = this.normalizeCacheSerial(this.rpkiStore.bumpCacheSerial(), this.cacheSerial);
        } else {
            this.cacheSerial = (this.cacheSerial + 1) >>> 0;
        }
        logger.info(`RPKI cache serial updated: ${this.cacheSerial}`);
        return this.cacheSerial;
    }

    sendSerialNotify() {
        for (const session of this.rpkiSessionMap.values()) {
            session.sendSerialNotify();
        }
    }

    trimSerialHistory() {
        while (
            this.serialHistory.length > this.maxSerialHistoryEntries ||
            this.serialHistoryOperationCount > this.maxSerialHistoryOperations ||
            this.serialHistoryBytes > this.maxSerialHistoryBytes
        ) {
            const removed = this.serialHistory.shift();
            this.serialHistoryOperationCount -= removed?.operations?.length || 0;
            this.serialHistoryBytes -= removed?.bytes || 0;
        }
    }

    clearSerialHistory() {
        this.serialHistory = [];
        this.serialHistoryOperationCount = 0;
        this.serialHistoryBytes = 0;
    }

    estimateSerialOperationsBytes(operations) {
        try {
            return Buffer.byteLength(JSON.stringify(operations));
        } catch (_) {
            return this.maxSerialHistoryBytes + 1;
        }
    }

    isSerialNewer(candidate, reference) {
        const distance = (this.normalizeCacheSerial(candidate) - this.normalizeCacheSerial(reference)) >>> 0;
        return distance !== 0 && distance < 0x80000000;
    }

    resolveMutationSerial(cacheSerial) {
        const previousSerial = this.cacheSerial >>> 0;
        const hasProvidedSerial = cacheSerial !== undefined && cacheSerial !== null && cacheSerial !== '';
        const providedSerial = hasProvidedSerial ? this.normalizeCacheSerial(cacheSerial, previousSerial) : null;
        const storeSerial = this.getStoreCacheSerial();
        let serial = previousSerial;

        if (this.isSerialNewer(storeSerial, serial)) {
            serial = storeSerial;
        }
        if (providedSerial !== null && this.isSerialNewer(providedSerial, serial)) {
            serial = providedSerial;
        }

        // A delayed notification can arrive after a Router Key mutation has
        // already advanced the shared DB serial. Never move backwards; create a
        // fresh reset boundary so clients that queried the intermediate serial
        // are notified again.
        const providedIsNext = providedSerial === null || providedSerial === (previousSerial + 1) >>> 0;
        if (serial === previousSerial) {
            serial = this.bumpCacheSerial();
        }

        return {
            serial,
            forceInvalidate: !providedIsNext || serial !== (previousSerial + 1) >>> 0
        };
    }

    recordSerialDeltaAndNotify(operations, options = {}) {
        const previousSerial = this.cacheSerial >>> 0;
        const resolvedSerial = this.resolveMutationSerial(options.cacheSerial);
        const serial = resolvedSerial.serial;
        const rawOperations = Array.isArray(operations) ? operations : [];
        const serialOperations = rawOperations.filter(Boolean);
        const operationBytes = this.estimateSerialOperationsBytes(serialOperations);
        const invalidated =
            options.invalidate === true ||
            resolvedSerial.forceInvalidate ||
            serialOperations.length > this.maxSerialHistoryOperations ||
            operationBytes > this.maxSerialHistoryBytes ||
            serial !== (previousSerial + 1) >>> 0;

        this.cacheSerial = serial;
        if (invalidated) {
            this.clearSerialHistory();
        } else {
            if (serialOperations.length > 0) {
                this.serialHistory.push({ serial, operations: serialOperations, bytes: operationBytes });
                this.serialHistoryOperationCount += serialOperations.length;
                this.serialHistoryBytes += operationBytes;
                this.trimSerialHistory();
            }
        }

        if (serial !== previousSerial || options.notifyOnSameSerial === true) {
            logger.info(
                `RPKI dataset serial applied: previous=${previousSerial}, current=${serial}, ` +
                    `operations=${invalidated ? 0 : rawOperations.length}, invalidated=${invalidated}`
            );
            this.sendSerialNotify();
        }
        return { cacheSerial: serial, invalidated };
    }

    datasetChanged(messageId, payload = {}) {
        try {
            const result = this.recordSerialDeltaAndNotify(payload.operations, {
                cacheSerial: payload.cacheSerial,
                invalidate: payload.invalidate === true
            });
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    ...result,
                    operationCount: result.invalidated
                        ? 0
                        : Array.isArray(payload.operations)
                          ? payload.operations.length
                          : 0
                },
                'RPKI数据集更新已同步'
            );
        } catch (error) {
            logger.error(`RPKI数据集更新同步失败: ${error.message}`);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
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

    addRoa(messageId, payload) {
        const roa = payload?.roa || payload?.data || payload;
        const rpkiRoa = new RpkiRoa(roa.ip, roa.mask, roa.asn, roa.maxLength, roa.ipType);
        const result = this.recordSerialDeltaAndNotify([{ type: 'roa', action: 'announce', data: rpkiRoa }], {
            cacheSerial: payload?.cacheSerial
        });
        this.messageHandler.sendSuccessResponse(messageId, result, 'RPKI ROA配置添加成功');
    }

    addRoaBatch(messageId, payload) {
        const roas = Array.isArray(payload) ? payload : payload?.roas || [];
        const announce = Boolean(payload?.announce);
        if (announce) {
            this.recordSerialDeltaAndNotify([], {
                cacheSerial: payload?.cacheSerial,
                invalidate: true
            });
        }

        this.messageHandler.sendSuccessResponse(
            messageId,
            {
                added: Number(payload?.added ?? roas.length) || 0,
                skipped: Number(payload?.skipped) || 0,
                total: payload?.total ?? null
            },
            'RPKI ROA批量添加成功'
        );
    }

    deleteRoa(messageId, payload) {
        const roa = payload?.roa || payload?.data || payload;
        const rpkiRoa = new RpkiRoa(roa.ip, roa.mask, roa.asn, roa.maxLength, roa.ipType);
        const result = this.recordSerialDeltaAndNotify([{ type: 'roa', action: 'withdraw', data: rpkiRoa }], {
            cacheSerial: payload?.cacheSerial
        });
        this.messageHandler.sendSuccessResponse(messageId, result, 'RPKI ROA配置删除成功');
    }

    deleteRoaBatch(messageId, payload) {
        const inputRoas = Array.isArray(payload?.roas) ? payload.roas : [];
        this.recordSerialDeltaAndNotify([], {
            cacheSerial: payload?.cacheSerial,
            invalidate: true
        });
        this.messageHandler.sendSuccessResponse(
            messageId,
            {
                deleted: Number(payload?.deleted ?? inputRoas.length) || 0,
                notFound: Number(payload?.notFound) || 0,
                total: payload?.total ?? null
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
        let result;
        try {
            result = this.recordSerialDeltaAndNotify([{ type: 'routerKey', action: 'announce', data: rk }]);
        } catch (error) {
            this.rpkiRouterKeyMap.delete(key);
            throw error;
        }
        this.messageHandler.sendSuccessResponse(messageId, result, 'RouterKey添加成功');
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
        let result;
        try {
            result = this.recordSerialDeltaAndNotify([{ type: 'routerKey', action: 'withdraw', data: rk }]);
        } catch (error) {
            this.rpkiRouterKeyMap.set(key, rk);
            throw error;
        }
        this.messageHandler.sendSuccessResponse(messageId, result, 'RouterKey删除成功');
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
        const aspaPayload = payload?.aspa || payload?.data || payload;
        const previousPayload = payload?.previousAspa || payload?.oldAspa || null;
        const previousAspa = previousPayload
            ? new RpkiAspa(previousPayload.customerAsn, previousPayload.providerAsns, previousPayload.afiFlags)
            : null;
        const aspa = new RpkiAspa(aspaPayload.customerAsn, aspaPayload.providerAsns, aspaPayload.afiFlags);
        const result = this.recordSerialDeltaAndNotify(
            [
                previousAspa
                    ? { type: 'aspa', action: 'replace', oldData: previousAspa, newData: aspa }
                    : { type: 'aspa', action: 'announce', data: aspa }
            ],
            { cacheSerial: payload?.cacheSerial }
        );
        this.messageHandler.sendSuccessResponse(messageId, result, previousAspa ? 'ASPA覆盖成功' : 'ASPA添加成功');
    }

    addAspaBatch(messageId, payload) {
        const aspas = Array.isArray(payload) ? payload : payload?.aspas || [];
        const announce = Boolean(payload?.announce);
        if (announce) {
            this.recordSerialDeltaAndNotify([], {
                cacheSerial: payload?.cacheSerial,
                invalidate: true
            });
        }

        this.messageHandler.sendSuccessResponse(
            messageId,
            {
                added: Number(payload?.added ?? aspas.length) || 0,
                overwritten: Number(payload?.overwritten) || 0,
                total: payload?.total ?? null
            },
            'ASPA批量添加成功'
        );
    }

    deleteAspa(messageId, payload) {
        const aspaPayload = payload?.aspa || payload?.previousAspa || payload?.data || payload;
        const aspa = new RpkiAspa(aspaPayload.customerAsn, aspaPayload.providerAsns, aspaPayload.afiFlags);
        const result = this.recordSerialDeltaAndNotify([{ type: 'aspa', action: 'withdraw', data: aspa }], {
            cacheSerial: payload?.cacheSerial
        });
        this.messageHandler.sendSuccessResponse(messageId, result, 'ASPA删除成功');
    }

    deleteAspaBatch(messageId, payload) {
        const deleteAll = Boolean(payload?.all);
        if (!deleteAll) {
            this.messageHandler.sendErrorResponse(messageId, '不支持的ASPA批量删除请求');
            return;
        }

        this.recordSerialDeltaAndNotify([], {
            cacheSerial: payload?.cacheSerial,
            invalidate: true
        });

        this.messageHandler.sendSuccessResponse(
            messageId,
            { deleted: Number(payload?.deleted) || 0, total: payload?.total ?? 0 },
            'ASPA批量删除成功'
        );
    }
}

if (require.main === module) {
    new RpkiWorker(); // 启动监听
}

module.exports = RpkiWorker;
