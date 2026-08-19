const net = require('net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const ipaddr = require('ipaddr.js');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const RequestWorkerClient = require('../core/requestWorkerClient');
const RpkiSession = require('./rpkiSession');
const RpkiRouterKey = require('./rpkiRouterKey');
const RPKI_IMPORT_OP = require('./rpkiImportConst');
const RpkiConst = require('../../const/rpkiConst');
const TcpAoProxy = require('./tcpAoProxy');
const {
    TCP_AO_FORWARD_CAPABILITY_BYTES,
    TCP_AO_FORWARD_HEADER_BYTES,
    TCP_AO_FORWARD_HEADER_TIMEOUT_MS,
    TCP_AO_UNIX_PATH_MAX_BYTES,
    decodeTcpAoForwardHeader
} = require('./tcpAoForwardProtocol');
const { RPKI_AUTH_TYPES, redactTcpAoConfig } = require('../../utils/tcpAoConfig');

const DEFAULT_SNAPSHOT_SHUTDOWN_TIMEOUT_MS = 2000;
const MAX_PENDING_TCP_AO_HEADERS = 256;

class RpkiWorker {
    constructor() {
        this.server = null;
        this.ipv6Server = null;
        this.tcpAoProxy = null;
        this.tcpAoSocketDirectory = null;
        this.tcpAoDirectoryIdentity = null;
        this.tcpAoSocketPath = null;
        this.tcpAoSocketIdentity = null;
        this.tcpAoForwardCapability = null;
        this.tcpAoForwardHeaderTimeoutMs = TCP_AO_FORWARD_HEADER_TIMEOUT_MS;
        this.tcpAoExitCleanup = null;
        this.pendingTcpAoSockets = new Set();
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
        this.storageMutationQueue = Promise.resolve();
        this.storageStopping = false;
        this.activeImportClients = new Set();
        this.closingRpkiSessions = new Set();

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
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.GET_ROA_LIST, this.getRoaList.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.GET_ASPA_LIST, this.getAspaList.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.IMPORT_ROA_JSON, this.importRoaJson.bind(this));
        this.messageHandler.registerHandler(RpkiConst.RPKI_REQ_TYPES.IMPORT_ASPA_JSON, this.importAspaJson.bind(this));
    }

    assertStorageAvailable() {
        if (this.storageStopping) {
            throw new Error('RPKI存储正在停止');
        }
        if (!this.rpkiConfigData || !this.rpkiStore || !this.rpkiDatabasePath) {
            throw new Error('RPKI协议未启动');
        }
    }

    enqueueStorageTask(task) {
        this.assertStorageAvailable();
        const pending = this.storageMutationQueue.then(task);
        this.storageMutationQueue = pending.catch(() => {});
        return pending;
    }

    handleStorageRequest(messageId, label, task, successMessage) {
        return Promise.resolve()
            .then(() => this.enqueueStorageTask(task))
            .then(result => {
                const message =
                    typeof successMessage === 'function' ? successMessage(result) : successMessage || `${label}成功`;
                this.messageHandler.sendSuccessResponse(messageId, result, message);
                return result;
            })
            .catch(error => {
                logger.error(`${label}失败: ${error.message}`);
                this.messageHandler.sendErrorResponse(messageId, error.message);
                return null;
            });
    }

    async terminateActiveImportClients() {
        const clients = Array.from(this.activeImportClients);
        const results = await Promise.allSettled(clients.map(client => client.terminate()));
        for (const result of results) {
            if (result.status === 'rejected') {
                logger.warn(`停止RPKI导入worker失败: ${result.reason?.message || result.reason}`);
            }
        }
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

    createRpkiSession(
        socket,
        clientAddress,
        clientPort,
        localAddress = socket.localAddress,
        localPort = socket.localPort
    ) {
        if (this.storageStopping) {
            socket?.destroy?.();
            return null;
        }

        const sessionKey = RpkiSession.makeKey(localAddress, localPort, clientAddress, clientPort);
        const existingSession = this.rpkiSessionMap.get(sessionKey);
        if (existingSession) {
            existingSession.closeSession();
            this.rpkiSessionMap.delete(sessionKey);
        }

        const rpkiSession = new RpkiSession(this.messageHandler, this);
        this.rpkiSessionMap.set(sessionKey, rpkiSession);

        rpkiSession.socket = socket;
        rpkiSession.localIp = localAddress;
        rpkiSession.localPort = localPort;
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

    trackClosingRpkiSession(rpkiSession, closePromise) {
        if (!rpkiSession) {
            return;
        }
        if (!this.closingRpkiSessions) {
            this.closingRpkiSessions = new Set();
        }
        this.closingRpkiSessions.add(rpkiSession);
        Promise.resolve(closePromise).then(
            () => this.closingRpkiSessions.delete(rpkiSession),
            () => this.closingRpkiSessions.delete(rpkiSession)
        );
    }

    closeTcpServer(server, label) {
        if (!server || typeof server.close !== 'function') {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = error => {
                if (settled) {
                    return;
                }
                settled = true;
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
                    reject(error);
                    return;
                }
                resolve();
            };

            try {
                server.close(finish);
            } catch (error) {
                finish(error);
            }
        }).catch(error => {
            error.message = `${label}关闭失败: ${error.message}`;
            throw error;
        });
    }

    ensurePendingTcpAoSockets() {
        if (!this.pendingTcpAoSockets) this.pendingTcpAoSockets = new Set();
        return this.pendingTcpAoSockets;
    }

    destroyPendingTcpAoSockets() {
        const pending = this.ensurePendingTcpAoSockets();
        for (const socket of pending) socket.destroy?.();
        pending.clear();
    }

    isOwnedTcpAoDirectory(directoryPath, expectedIdentity = null) {
        try {
            const stats = fs.lstatSync(directoryPath);
            const uid = typeof process.getuid === 'function' ? process.getuid() : null;
            return (
                stats.isDirectory() &&
                !stats.isSymbolicLink() &&
                (stats.mode & 0o777) === 0o700 &&
                (uid === null || stats.uid === uid) &&
                (!expectedIdentity || (stats.dev === expectedIdentity.dev && stats.ino === expectedIdentity.ino))
            );
        } catch (_error) {
            return false;
        }
    }

    createTcpAoForwardEndpoint() {
        this.cleanupTcpAoForwardEndpoint();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-rpki-ao-'));
        this.tcpAoSocketDirectory = directory;
        const exitCleanup = () => this.cleanupTcpAoForwardEndpoint();
        this.tcpAoExitCleanup = exitCleanup;
        process.once('exit', exitCleanup);
        try {
            fs.chmodSync(directory, 0o700);
            const directoryStats = fs.lstatSync(directory);
            const uid = typeof process.getuid === 'function' ? process.getuid() : null;
            if (
                !directoryStats.isDirectory() ||
                directoryStats.isSymbolicLink() ||
                (directoryStats.mode & 0o777) !== 0o700 ||
                (uid !== null && directoryStats.uid !== uid)
            ) {
                throw new Error('TCP-AO内部Unix socket目录权限无效');
            }
            this.tcpAoDirectoryIdentity = { dev: directoryStats.dev, ino: directoryStats.ino };
            const socketPath = path.join(directory, 'r.sock');
            if (Buffer.byteLength(socketPath, 'utf8') > TCP_AO_UNIX_PATH_MAX_BYTES) {
                throw new Error(`TCP-AO内部Unix socket路径超过${TCP_AO_UNIX_PATH_MAX_BYTES}字节`);
            }
            this.tcpAoSocketPath = socketPath;
            this.tcpAoForwardCapability = crypto.randomBytes(TCP_AO_FORWARD_CAPABILITY_BYTES);
            return { socketPath, capability: this.tcpAoForwardCapability };
        } catch (error) {
            this.cleanupTcpAoForwardEndpoint();
            throw error;
        }
    }

    secureTcpAoSocketFile() {
        const socketPath = this.tcpAoSocketPath;
        if (!socketPath || !this.isOwnedTcpAoDirectory(this.tcpAoSocketDirectory, this.tcpAoDirectoryIdentity)) {
            throw new Error('TCP-AO内部Unix socket目录无效');
        }
        const initialStats = fs.lstatSync(socketPath);
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (!initialStats.isSocket() || initialStats.isSymbolicLink() || (uid !== null && initialStats.uid !== uid)) {
            throw new Error('TCP-AO内部Unix socket文件无效');
        }
        this.tcpAoSocketIdentity = { dev: initialStats.dev, ino: initialStats.ino };
        fs.chmodSync(socketPath, 0o600);
        const stats = fs.lstatSync(socketPath);
        if (
            !stats.isSocket() ||
            stats.isSymbolicLink() ||
            (stats.mode & 0o777) !== 0o600 ||
            (uid !== null && stats.uid !== uid) ||
            stats.dev !== this.tcpAoSocketIdentity.dev ||
            stats.ino !== this.tcpAoSocketIdentity.ino
        ) {
            throw new Error('TCP-AO内部Unix socket文件权限无效');
        }
    }

    cleanupTcpAoForwardEndpoint() {
        this.destroyPendingTcpAoSockets();
        const exitCleanup = this.tcpAoExitCleanup;
        this.tcpAoExitCleanup = null;
        if (typeof exitCleanup === 'function') process.removeListener('exit', exitCleanup);
        if (Buffer.isBuffer(this.tcpAoForwardCapability)) this.tcpAoForwardCapability.fill(0);
        this.tcpAoForwardCapability = null;

        const directory = this.tcpAoSocketDirectory;
        const directoryIdentity = this.tcpAoDirectoryIdentity;
        const socketPath = this.tcpAoSocketPath;
        const identity = this.tcpAoSocketIdentity;
        this.tcpAoSocketDirectory = null;
        this.tcpAoDirectoryIdentity = null;
        this.tcpAoSocketPath = null;
        this.tcpAoSocketIdentity = null;
        if (!directory || !this.isOwnedTcpAoDirectory(directory, directoryIdentity)) return;

        if (socketPath) {
            try {
                const stats = fs.lstatSync(socketPath);
                const sameSocket =
                    stats.isSocket() &&
                    !stats.isSymbolicLink() &&
                    (!identity || (stats.dev === identity.dev && stats.ino === identity.ino));
                if (sameSocket) fs.unlinkSync(socketPath);
            } catch (error) {
                if (error.code !== 'ENOENT') logger.debug(`清理TCP-AO Unix socket失败: ${error.message}`);
            }
        }
        try {
            fs.rmdirSync(directory);
        } catch (error) {
            if (error.code !== 'ENOENT') logger.debug(`清理TCP-AO Unix socket目录失败: ${error.message}`);
        }
    }

    validateTcpAoPeerMetadata(metadata) {
        if (metadata.localPort !== Number(this.rpkiConfigData?.port)) {
            throw new Error('TCP-AO转发头本地端口与服务配置不匹配');
        }
        const peer = this.rpkiConfigData?.tcpAo?.peer;
        let network;
        let prefixLength;
        let remote;
        try {
            [network, prefixLength] = ipaddr.parseCIDR(peer);
            remote = ipaddr.parse(metadata.remoteAddress);
        } catch (_error) {
            throw new Error('TCP-AO转发头远端地址无效');
        }
        if (network.kind() !== remote.kind() || !remote.match(network, prefixLength)) {
            throw new Error('TCP-AO转发头远端地址不属于已认证profile');
        }
        return metadata;
    }

    acceptTcpAoInternalSocket(socket) {
        const pending = this.ensurePendingTcpAoSockets();
        const capability = this.tcpAoForwardCapability;
        if (
            this.storageStopping ||
            !Buffer.isBuffer(capability) ||
            capability.length !== TCP_AO_FORWARD_CAPABILITY_BYTES ||
            pending.size >= MAX_PENDING_TCP_AO_HEADERS
        ) {
            socket.destroy();
            return;
        }

        const header = Buffer.alloc(TCP_AO_FORWARD_HEADER_BYTES);
        let received = 0;
        let finished = false;
        pending.add(socket);
        const configuredTimeout = Number(this.tcpAoForwardHeaderTimeoutMs);
        const headerTimeoutMs =
            Number.isFinite(configuredTimeout) && configuredTimeout > 0
                ? Math.min(configuredTimeout, TCP_AO_FORWARD_HEADER_TIMEOUT_MS)
                : TCP_AO_FORWARD_HEADER_TIMEOUT_MS;
        const timer = setTimeout(() => rejectHeader(), headerTimeoutMs);
        timer.unref?.();

        const cleanup = () => {
            clearTimeout(timer);
            pending.delete(socket);
            socket.removeListener('data', onData);
            socket.removeListener('end', onEnd);
            socket.removeListener('close', onClose);
            socket.removeListener('error', onError);
            header.fill(0);
        };
        const rejectHeader = () => {
            if (finished) return;
            finished = true;
            cleanup();
            socket.destroy();
        };
        const onEnd = () => rejectHeader();
        const onClose = () => rejectHeader();
        const onError = () => rejectHeader();
        const onData = chunk => {
            if (finished || !Buffer.isBuffer(chunk)) return;
            const copyLength = Math.min(TCP_AO_FORWARD_HEADER_BYTES - received, chunk.length);
            chunk.copy(header, received, 0, copyLength);
            received += copyLength;
            if (received < TCP_AO_FORWARD_HEADER_BYTES) return;

            socket.pause();
            let metadata;
            try {
                metadata = this.validateTcpAoPeerMetadata(
                    decodeTcpAoForwardHeader(header, this.tcpAoForwardCapability)
                );
                if (this.storageStopping) throw new Error('RPKI正在停止');
            } catch (_error) {
                rejectHeader();
                return;
            }
            const initialData = chunk.subarray(copyLength);
            finished = true;
            cleanup();
            try {
                const session = this.attachClientSocket(socket, 'tcp-ao', metadata, initialData);
                if (!session) {
                    socket.destroy();
                    return;
                }
                socket.resume();
            } catch (error) {
                logger.warn(`TCP-AO内部连接初始化失败: ${error.message}`);
                socket.destroy();
            }
        };
        socket.on('data', onData);
        socket.once('end', onEnd);
        socket.once('close', onClose);
        socket.once('error', onError);
        socket.resume();
    }

    async waitForActiveDataSnapshots(timeoutMs = DEFAULT_SNAPSHOT_SHUTDOWN_TIMEOUT_MS) {
        const deadline = Date.now() + Math.max(1, Number(timeoutMs) || DEFAULT_SNAPSHOT_SHUTDOWN_TIMEOUT_MS);
        while ((Number(this.activeDataSnapshots) || 0) > 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const activeSnapshots = Number(this.activeDataSnapshots) || 0;
        if (activeSnapshots > 0) {
            const error = new Error(`RPKI停止时仍有${activeSnapshots}个SQLite快照未释放`);
            error.code = 'RPKI_SNAPSHOT_SHUTDOWN_TIMEOUT';
            throw error;
        }
    }

    attachClientSocket(socket, transportLabel, endpoint = {}, initialData = null) {
        const clientAddress = endpoint.remoteAddress ?? socket.remoteAddress;
        const clientPort = endpoint.remotePort ?? socket.remotePort;
        const localAddress = endpoint.localAddress ?? socket.localAddress;
        const localPort = endpoint.localPort ?? socket.localPort;
        const sessionKey = RpkiSession.makeKey(localAddress, localPort, clientAddress, clientPort);
        logger.info(`${transportLabel} Client connected from ${clientAddress}:${clientPort}`);
        logger.info(`${transportLabel} localAddress: ${localAddress}:${localPort}`);

        const rpkiSession = this.createRpkiSession(socket, clientAddress, clientPort, localAddress, localPort);
        if (!rpkiSession) return null;

        socket.on('data', data => {
            if (this.rpkiSessionMap.get(sessionKey) !== rpkiSession) {
                logger.error(`${transportLabel} Client ${clientAddress}:${clientPort} not found in rpkiSessionMap`);
                socket.destroy();
                return;
            }
            rpkiSession.recvMsg(data);
        });

        const closeSession = (eventName, error = null) => {
            if (rpkiSession.closed) {
                logger.debug(`${transportLabel} Client ${clientAddress}:${clientPort} already removed on ${eventName}`);
                return;
            }
            rpkiSession.closeSession();
            if (error) {
                logger.error(`${transportLabel} TCP Error from ${clientAddress}:${clientPort}: ${error.message}`);
            } else {
                logger.info(`${transportLabel} Client ${clientAddress}:${clientPort} ${eventName}`);
            }
        };
        socket.on('end', () => closeSession('end'));
        socket.on('close', () => closeSession('close'));
        socket.on('error', error => closeSession('error', error));
        if (Buffer.isBuffer(initialData) && initialData.length > 0) rpkiSession.recvMsg(initialData);
        return rpkiSession;
    }

    createTcpServer(transportLabel) {
        return net.createServer(socket => this.attachClientSocket(socket, transportLabel));
    }

    listenTcpServer(server, port, host, options = {}) {
        return new Promise((resolve, reject) => {
            const onError = error => {
                server.removeListener('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve(server.address());
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen({ port, host, ...options });
        });
    }

    listenUnixServer(server, socketPath) {
        return new Promise((resolve, reject) => {
            const onError = error => {
                server.removeListener('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve(server.address());
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(socketPath);
        });
    }

    createTcpAoProxy() {
        return new TcpAoProxy();
    }

    scheduleFatalExit() {
        setImmediate(() => process.exit(1));
    }

    handleTcpAoUnexpectedExit(error) {
        if (this.storageStopping) return;
        logger.error(`TCP-AO helper异常退出，RPKI协议进程将停止: ${error.message}`);
        const failure = error?.runtimeFailure || {
            code: 'TCP_AO_HELPER_EXIT',
            reason: 'TCP-AO认证进程异常退出，RPKI服务已安全停止'
        };
        try {
            this.messageHandler.sendEvent(RpkiConst.RPKI_EVT_TYPES.RUNTIME_FAILURE, failure);
        } catch (eventError) {
            logger.warn(`TCP-AO运行时故障事件发送失败: ${eventError.message}`);
        } finally {
            this.scheduleFatalExit();
        }
    }

    async startPlainTcpServers() {
        this.server = this.createTcpServer('ipv4');
        await this.listenTcpServer(this.server, this.rpkiConfigData.port, '0.0.0.0');
        logger.info(`TCP Server listening on port ${this.rpkiConfigData.port} at 0.0.0.0`);

        this.ipv6Server = this.createTcpServer('ipv6');
        await this.listenTcpServer(this.ipv6Server, this.rpkiConfigData.port, '::', { ipv6Only: true });
        logger.info(`TCP Server listening on port ${this.rpkiConfigData.port} at ::`);
    }

    async startTcpAoServer() {
        if (!this.rpkiConfigData?.tcpAo) throw new Error('缺少TCP-AO运行配置');
        const { socketPath, capability } = this.createTcpAoForwardEndpoint();
        this.server = net.createServer({ pauseOnConnect: true }, socket => this.acceptTcpAoInternalSocket(socket));
        this.server.maxConnections = MAX_PENDING_TCP_AO_HEADERS;
        await this.listenUnixServer(this.server, socketPath);
        this.secureTcpAoSocketFile();

        const proxy = this.createTcpAoProxy();
        this.tcpAoProxy = proxy;
        proxy.once('unexpectedExit', error => this.handleTcpAoUnexpectedExit(error));
        const runtimeProfile = this.rpkiConfigData.tcpAo;
        let startup;
        try {
            // TcpAoProxy serializes the helper configuration synchronously. Remove
            // every worker-owned plaintext key reference immediately afterwards;
            // the helper owns the rotation schedule from this point onward.
            startup = proxy.start({
                listenPort: this.rpkiConfigData.port,
                forwardSocket: socketPath,
                forwardCapability: capability,
                profiles: [runtimeProfile]
            });
        } finally {
            this.rpkiConfigData.tcpAo = redactTcpAoConfig(runtimeProfile);
            for (const key of Array.isArray(runtimeProfile?.keys) ? runtimeProfile.keys : []) {
                if (Object.prototype.hasOwnProperty.call(key, 'key')) key.key = '<redacted>';
            }
        }
        const status = await startup;
        logger.info(`TCP-AO helper ready on port ${status.listenPort}; families=${(status.families || []).join(',')}`);
    }

    async startTcpServer(messageId) {
        try {
            const tcpAoEnabled = this.rpkiConfigData?.authType === RPKI_AUTH_TYPES.TCP_AO;
            if (tcpAoEnabled) await this.startTcpAoServer();
            else await this.startPlainTcpServers();

            const suffix = tcpAoEnabled ? '（TCP-AO认证）' : '';
            logger.info(`rpki协议启动成功${suffix}`);
            this.messageHandler.sendSuccessResponse(messageId, null, `rpki协议启动成功${suffix}`);
        } catch (err) {
            logger.error(`Error starting TCP server: ${err.message}`);
            const proxy = this.tcpAoProxy;
            this.tcpAoProxy = null;
            const ipv4Server = this.server;
            const ipv6Server = this.ipv6Server;
            this.server = null;
            this.ipv6Server = null;
            this.destroyPendingTcpAoSockets();
            await Promise.allSettled([
                proxy?.stop?.(),
                this.closeTcpServer(ipv4Server, 'RPKI TCP server'),
                this.closeTcpServer(ipv6Server, 'RPKI IPv6 TCP server')
            ]);
            this.cleanupTcpAoForwardEndpoint();
            this.closeRpkiStore();
            this.rpkiConfigData = null;
            this.rpkiRouterKeyMap.clear();
            this.messageHandler.sendErrorResponse(messageId, `rpki协议启动失败: ${err.message}`);
        }
    }

    async startRpki(messageId, rpkiConfigData) {
        if (this.storageStopping || this.rpkiStore || this.rpkiConfigData) {
            this.messageHandler.sendErrorResponse(messageId, 'rpki协议已经启动或正在停止');
            return;
        }

        this.storageMutationQueue = Promise.resolve();
        this.storageStopping = false;
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
        if (this.storageStopping) {
            this.messageHandler.sendErrorResponse(messageId, 'rpki协议正在停止');
            return;
        }

        this.storageStopping = true;
        let stopError = null;
        const ipv4Server = this.server;
        const ipv6Server = this.ipv6Server;
        const tcpAoProxy = this.tcpAoProxy;
        this.server = null;
        this.ipv6Server = null;
        this.tcpAoProxy = null;
        this.destroyPendingTcpAoSockets();

        const serverClosePromises = [
            tcpAoProxy?.stop?.() || Promise.resolve(),
            this.closeTcpServer(ipv4Server, 'RPKI IPv4 TCP server'),
            this.closeTcpServer(ipv6Server, 'RPKI IPv6 TCP server')
        ];
        const sessions = new Set([
            ...this.rpkiSessionMap.values(),
            ...(this.closingRpkiSessions ? this.closingRpkiSessions.values() : [])
        ]);
        const sessionClosePromises = Array.from(sessions, session => {
            try {
                return Promise.resolve(session.closeSession({ graceful: true }));
            } catch (error) {
                return Promise.reject(error);
            }
        });
        const storageDrainPromise = (async () => {
            await this.terminateActiveImportClients();
            await this.storageMutationQueue;
        })();

        try {
            const shutdownResults = await Promise.allSettled([
                storageDrainPromise,
                ...sessionClosePromises,
                ...serverClosePromises
            ]);
            const rejectedShutdown = shutdownResults.find(result => result.status === 'rejected');
            await this.waitForActiveDataSnapshots();
            if (rejectedShutdown) {
                throw rejectedShutdown.reason;
            }
        } catch (error) {
            stopError = error;
            logger.error(`停止RPKI协议失败: ${error.message}`);
        } finally {
            this.cleanupTcpAoForwardEndpoint();
            this.rpkiConfigData = null;
            this.rpkiSessionMap.clear();
            this.closingRpkiSessions?.clear();
            this.rpkiRouterKeyMap.clear();
            this.clearSerialHistory();
            if ((Number(this.activeDataSnapshots) || 0) === 0) {
                try {
                    this.closeRpkiStore();
                } catch (error) {
                    stopError ||= error;
                    logger.error(`关闭RPKI SQLite失败: ${error.message}`);
                }
            } else {
                const error = new Error(`RPKI SQLite仍有${this.activeDataSnapshots}个活动快照，拒绝提前关闭存储`);
                error.code = 'RPKI_ACTIVE_SNAPSHOTS';
                stopError ||= error;
                logger.error(error.message);
            }
            this.storageMutationQueue = Promise.resolve();
            this.storageStopping = false;
        }

        if (stopError) {
            this.messageHandler.sendErrorResponse(messageId, stopError.message);
        } else {
            this.messageHandler.sendSuccessResponse(messageId, null, 'rpki协议停止成功');
        }
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
        return this.handleStorageRequest(
            messageId,
            'RPKI数据集更新同步',
            () => {
                const result = this.recordSerialDeltaAndNotify(payload.operations, {
                    cacheSerial: payload.cacheSerial,
                    invalidate: payload.invalidate === true
                });
                return {
                    ...result,
                    operationCount: result.invalidated
                        ? 0
                        : Array.isArray(payload.operations)
                          ? payload.operations.length
                          : 0
                };
            },
            'RPKI数据集更新已同步'
        );
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
        return this.handleStorageRequest(
            messageId,
            'RPKI ROA配置添加',
            () => {
                const roa = payload?.roa || payload?.data || payload;
                const result = this.rpkiStore.addRoa(roa);
                if (!(result.inserted || result.added)) {
                    throw new Error('RPKI ROA配置已经存在');
                }
                const serialResult = this.recordSerialDeltaAndNotify(
                    [{ type: 'roa', action: 'announce', data: result.current || result.roa }],
                    { cacheSerial: result.cacheSerial }
                );
                return { ...result, ...serialResult };
            },
            'RPKI ROA配置添加成功'
        );
    }

    addRoaBatch(messageId, payload) {
        return this.handleStorageRequest(
            messageId,
            'RPKI ROA批量添加',
            () => {
                const roas = Array.isArray(payload) ? payload : payload?.roas || [];
                const result = this.rpkiStore.addRoaBatch(roas, { maxInserted: payload?.limit });
                if (result.inserted || result.added) {
                    const serialResult = this.recordSerialDeltaAndNotify([], {
                        cacheSerial: result.cacheSerial,
                        invalidate: true
                    });
                    return { ...result, ...serialResult };
                }
                return result;
            },
            'RPKI ROA批量添加成功'
        );
    }

    deleteRoa(messageId, payload) {
        return this.handleStorageRequest(
            messageId,
            'RPKI ROA配置删除',
            () => {
                const roa = payload?.roa || payload?.data || payload;
                const result = this.rpkiStore.deleteRoa(roa);
                if (!result.deleted) {
                    throw new Error('RPKI ROA配置不存在');
                }
                const serialResult = this.recordSerialDeltaAndNotify(
                    [{ type: 'roa', action: 'withdraw', data: result.previous || result.deletedItem }],
                    { cacheSerial: result.cacheSerial }
                );
                return { ...result, ...serialResult };
            },
            'RPKI ROA配置删除成功'
        );
    }

    deleteRoaBatch(messageId) {
        return this.handleStorageRequest(
            messageId,
            'RPKI ROA批量删除',
            () => {
                const result = this.rpkiStore.clearRoas();
                if (result.deleted > 0) {
                    const serialResult = this.recordSerialDeltaAndNotify([], {
                        cacheSerial: result.cacheSerial,
                        invalidate: true
                    });
                    return { ...result, ...serialResult };
                }
                return result;
            },
            'RPKI ROA批量删除成功'
        );
    }

    getRoaList(messageId, options = {}) {
        return this.handleStorageRequest(
            messageId,
            'RPKI ROA配置加载',
            () => this.rpkiStore.queryRoaPage(options || {}),
            'RPKI ROA配置加载成功'
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
        return this.handleStorageRequest(
            messageId,
            'RouterKey添加',
            () => {
                const key = RpkiRouterKey.makeKey(payload.ski, payload.asn);
                if (this.rpkiRouterKeyMap.has(key)) {
                    throw new Error('RouterKey已存在');
                }
                const rk = new RpkiRouterKey(payload.ski, payload.asn, payload.spki);
                this.rpkiRouterKeyMap.set(key, rk);
                try {
                    return this.recordSerialDeltaAndNotify([{ type: 'routerKey', action: 'announce', data: rk }]);
                } catch (error) {
                    this.rpkiRouterKeyMap.delete(key);
                    throw error;
                }
            },
            'RouterKey添加成功'
        );
    }

    deleteRouterKey(messageId, payload) {
        return this.handleStorageRequest(
            messageId,
            'RouterKey删除',
            () => {
                const key = RpkiRouterKey.makeKey(payload.ski, payload.asn);
                if (!this.rpkiRouterKeyMap.has(key)) {
                    throw new Error('RouterKey不存在');
                }
                const rk = this.rpkiRouterKeyMap.get(key);
                this.rpkiRouterKeyMap.delete(key);
                try {
                    return this.recordSerialDeltaAndNotify([{ type: 'routerKey', action: 'withdraw', data: rk }]);
                } catch (error) {
                    this.rpkiRouterKeyMap.set(key, rk);
                    throw error;
                }
            },
            'RouterKey删除成功'
        );
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
        return this.handleStorageRequest(
            messageId,
            'ASPA配置添加',
            () => {
                const aspa = payload?.aspa || payload?.data || payload;
                const result = this.rpkiStore.upsertAspa(aspa);
                if (!result.changed) {
                    return result;
                }
                const previous = result.previous || result.oldAspa;
                const current = result.current || result.newAspa;
                const operation = previous
                    ? { type: 'aspa', action: 'replace', oldData: previous, newData: current }
                    : { type: 'aspa', action: 'announce', data: current };
                const serialResult = this.recordSerialDeltaAndNotify([operation], {
                    cacheSerial: result.cacheSerial
                });
                return { ...result, ...serialResult };
            },
            result =>
                result.previous || result.oldAspa ? 'ASPA覆盖成功' : result.changed ? 'ASPA添加成功' : 'ASPA配置未变化'
        );
    }

    addAspaBatch(messageId, payload) {
        return this.handleStorageRequest(
            messageId,
            'ASPA批量添加',
            () => {
                const aspas = Array.isArray(payload) ? payload : payload?.aspas || [];
                const result = this.rpkiStore.upsertAspaBatch(aspas);
                if (result.changed > 0) {
                    const serialResult = this.recordSerialDeltaAndNotify([], {
                        cacheSerial: result.cacheSerial,
                        invalidate: true
                    });
                    return { ...result, ...serialResult };
                }
                return result;
            },
            'ASPA批量添加成功'
        );
    }

    deleteAspa(messageId, payload) {
        return this.handleStorageRequest(
            messageId,
            'ASPA删除',
            () => {
                const aspa = payload?.aspa || payload?.previousAspa || payload?.data || payload;
                const result = this.rpkiStore.deleteAspa(aspa?.customerAsn ?? aspa);
                if (!result.deleted) {
                    throw new Error('ASPA不存在');
                }
                const serialResult = this.recordSerialDeltaAndNotify(
                    [{ type: 'aspa', action: 'withdraw', data: result.previous || result.deletedItem }],
                    { cacheSerial: result.cacheSerial }
                );
                return { ...result, ...serialResult };
            },
            'ASPA删除成功'
        );
    }

    deleteAspaBatch(messageId) {
        return this.handleStorageRequest(
            messageId,
            'ASPA批量删除',
            () => {
                const result = this.rpkiStore.clearAspas();
                if (result.deleted > 0) {
                    const serialResult = this.recordSerialDeltaAndNotify([], {
                        cacheSerial: result.cacheSerial,
                        invalidate: true
                    });
                    return { ...result, ...serialResult };
                }
                return result;
            },
            'ASPA批量删除成功'
        );
    }

    getAspaList(messageId, options = {}) {
        return this.handleStorageRequest(
            messageId,
            'ASPA列表加载',
            () => this.rpkiStore.queryAspaPage(options || {}),
            'ASPA列表加载成功'
        );
    }

    async runImportWorker(operation, payload = {}) {
        if (this.storageStopping) {
            throw new Error('RPKI存储正在停止');
        }

        const workerPath = path.join(__dirname, 'rpkiImportWorker.js');
        const client = new RequestWorkerClient(workerPath, { defaultTimeoutMs: 0 }).start();
        const importWorkerThreadId = client.worker?.threadId;
        this.activeImportClients.add(client);
        try {
            const response = await client.sendRequest(
                operation,
                {
                    filePath: payload?.filePath,
                    limit: payload?.limit,
                    dbPath: this.rpkiDatabasePath
                },
                { timeoutMs: 0 }
            );
            return { ...response.data, importWorkerThreadId };
        } finally {
            this.activeImportClients.delete(client);
            try {
                await client.terminate();
            } catch (error) {
                logger.warn(`停止RPKI导入worker失败: ${error.message}`);
            }
        }
    }

    importRoaJson(messageId, payload = {}) {
        return this.handleStorageRequest(
            messageId,
            'ROA JSON导入',
            async () => {
                const result = await this.runImportWorker(RPKI_IMPORT_OP.IMPORT_ROA_JSON, payload);
                if (result.changed > 0) {
                    const serialResult = this.recordSerialDeltaAndNotify([], {
                        cacheSerial: result.cacheSerial,
                        invalidate: true
                    });
                    return { ...result, ...serialResult };
                }
                return result;
            },
            'ROA JSON导入完成'
        );
    }

    importAspaJson(messageId, payload = {}) {
        return this.handleStorageRequest(
            messageId,
            'ASPA JSON导入',
            async () => {
                const result = await this.runImportWorker(RPKI_IMPORT_OP.IMPORT_ASPA_JSON, payload);
                if (result.changed > 0) {
                    const serialResult = this.recordSerialDeltaAndNotify([], {
                        cacheSerial: result.cacheSerial,
                        invalidate: true
                    });
                    return { ...result, ...serialResult };
                }
                return result;
            },
            'ASPA JSON导入完成'
        );
    }
}

if (require.main === module) {
    new RpkiWorker(); // 启动监听
}

module.exports = RpkiWorker;
