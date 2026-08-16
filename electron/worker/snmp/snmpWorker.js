const path = require('node:path');
const snmp = require('net-snmp');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const WorkerWithPromise = require('../core/workerWithPromise');
const SnmpConst = require('../../const/snmpConst');
const MibRegistry = require('../../utils/mibRegistry');
const { formatSnmpValue } = require('../../utils/snmpValueFormatter');
const { LOG_REQ_TYPES } = require('../../const/toolsConst');

const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';
const GENERIC_TRAP_OIDS = {
    0: '1.3.6.1.6.3.1.1.5.1',
    1: '1.3.6.1.6.3.1.1.5.2',
    2: '1.3.6.1.6.3.1.1.5.3',
    3: '1.3.6.1.6.3.1.1.5.4',
    4: '1.3.6.1.6.3.1.1.5.5',
    5: '1.3.6.1.6.3.1.1.5.6'
};

class SnmpWorker {
    constructor() {
        this.receiver = null;
        this.receiverClosePromises = new WeakMap();
        this.snmpConfig = null;
        this.trapConfig = null;
        this.runtimeReady = false;
        this.runtimeStopping = false;
        this.runtimeGeneration = 0;
        this.trapRunning = false;
        this.trapStopping = false;
        this.trapGeneration = 0;
        this.trapStopPromise = null;
        this.activeSessions = new Set();
        this.agentMap = new Map(); // 代理映射
        this.trapCounter = 0;
        this.trapHistory = [];
        this.maxTrapHistory = SnmpConst.DEFAULT_SNMP_SETTINGS.maxTrapHistory;
        this.pendingTrapUpdateCount = 0;
        this.pendingTrapLatestTrap = null;
        this.pendingTrapSourceIps = new Set();
        this.trapUpdateFlushTimer = null;
        this.trapUpdateFlushIntervalMs = 1000;
        this.mibRegistry = new MibRegistry();
        this.mibWorker = null;
        this.mibProgressHandler = null;

        // 创建消息处理器
        this.messageHandler = new WorkerMessageHandler({
            onLogLevelChange: logLevel => this.handleLogLevelChange(logLevel)
        });
        // 初始化消息处理器
        this.messageHandler.init();
        // 注册消息处理器
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.START_SNMP, this.startSnmp.bind(this));
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.STOP_SNMP, this.stopSnmp.bind(this));
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.START_TRAP, this.startTrap.bind(this));
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.STOP_TRAP, this.stopTrap.bind(this));
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.GET_RUNTIME_STATE,
            this.getRuntimeStateRequest.bind(this)
        );
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.GET_TRAP_LIST, this.getTrapList.bind(this));
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.CLEAR_TRAP_HISTORY,
            this.clearTrapHistory.bind(this)
        );
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.COMPILE_MIBS, this.compileMibs.bind(this));
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.SEND_GET_REQUEST,
            this.sendGetRequest.bind(this)
        );
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.SEND_GET_NEXT_REQUEST,
            this.sendGetNextRequest.bind(this)
        );
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.SEND_WALK_REQUEST,
            this.sendWalkRequest.bind(this)
        );
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.SEND_SET_REQUEST,
            this.sendSetRequest.bind(this)
        );
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.LIST_OID_INSTANCES,
            this.listOidInstances.bind(this)
        );
        Object.values(SnmpConst.MIB_REQ_TYPES).forEach(op => {
            this.messageHandler.registerHandler(op, (messageId, data) => this.forwardMibRequest(messageId, op, data));
        });
    }

    async handleLogLevelChange(logLevel) {
        if (this.snmpConfig) this.snmpConfig.logLevel = logLevel;
        if (this.mibWorker) {
            await this.mibWorker.sendRequest(LOG_REQ_TYPES.SET_LOG_LEVEL, logLevel);
        }
    }

    enqueueTrapUpdateEvent(trapData) {
        this.pendingTrapUpdateCount++;
        this.pendingTrapLatestTrap = trapData;
        if (trapData.sourceIp) {
            this.pendingTrapSourceIps.add(trapData.sourceIp);
        }
        this.scheduleTrapUpdateFlush();
    }

    scheduleTrapUpdateFlush() {
        if (this.trapUpdateFlushTimer) {
            return;
        }

        this.trapUpdateFlushTimer = setTimeout(() => {
            this.flushTrapUpdateEvents();
        }, this.trapUpdateFlushIntervalMs);
    }

    flushTrapUpdateEvents() {
        if (this.trapUpdateFlushTimer) {
            clearTimeout(this.trapUpdateFlushTimer);
            this.trapUpdateFlushTimer = null;
        }

        if (this.pendingTrapUpdateCount === 0) {
            return;
        }

        const latestTrap = this.pendingTrapLatestTrap;
        const update = {
            changedCount: this.pendingTrapUpdateCount,
            totalTraps: this.trapCounter,
            historyCount: this.trapHistory.length,
            sourceIpCount: this.pendingTrapSourceIps.size,
            latestTrapAt: latestTrap?.timestamp || null,
            latestSourceIp: latestTrap?.sourceIp || null
        };

        this.pendingTrapUpdateCount = 0;
        this.pendingTrapLatestTrap = null;
        this.pendingTrapSourceIps.clear();

        this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
            type: SnmpConst.SNMP_SUB_EVT_TYPES.TRAP_BATCH_RECEIVED,
            data: update
        });
    }

    clearTrapUpdateAggregation() {
        if (this.trapUpdateFlushTimer) {
            clearTimeout(this.trapUpdateFlushTimer);
            this.trapUpdateFlushTimer = null;
        }

        this.pendingTrapUpdateCount = 0;
        this.pendingTrapLatestTrap = null;
        this.pendingTrapSourceIps.clear();
    }

    getRuntimeState() {
        const ready = this.runtimeReady && !this.runtimeStopping;
        return {
            running: ready,
            ready,
            trapRunning: ready && this.trapRunning && !this.trapStopping
        };
    }

    requireRuntime(messageId) {
        if (this.runtimeReady && !this.runtimeStopping) return true;
        this.messageHandler.sendErrorResponse(messageId, 'SNMP运行时未启动，请先启动SNMP服务');
        return false;
    }

    emitRuntimeState() {
        this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.RUNTIME_EVT, this.getRuntimeState());
    }

    getRuntimeStateRequest(messageId) {
        this.messageHandler.sendSuccessResponse(messageId, this.getRuntimeState(), 'SNMP运行状态获取成功');
    }

    async startSnmp(messageId, config = {}) {
        try {
            if (this.runtimeReady || this.runtimeStopping) {
                this.messageHandler.sendErrorResponse(messageId, 'SNMP运行时已经启动');
                return;
            }
            this.runtimeGeneration++;
            this.runtimeStopping = false;
            this.snmpConfig = {
                ...config,
                supportedVersions: Array.isArray(config.supportedVersions)
                    ? [...config.supportedVersions]
                    : [],
                mibFiles: Array.isArray(config.mibFiles) ? [...config.mibFiles] : []
            };
            this.trapConfig = null;
            if (this.snmpConfig.logLevel) {
                logger.setLevel(this.snmpConfig.logLevel);
                logger.info(`Worker log level set to: ${this.snmpConfig.logLevel}`);
            }
            this.runtimeReady = true;
            this.trapRunning = false;
            this.emitRuntimeState();
            this.messageHandler.sendSuccessResponse(messageId, this.getRuntimeState(), 'SNMP运行时启动成功');
        } catch (error) {
            this.runtimeReady = false;
            this.runtimeStopping = false;
            this.trapRunning = false;
            this.trapStopping = false;
            this.snmpConfig = null;
            this.trapConfig = null;
            logger.error('启动SNMP运行时失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'SNMP运行时启动失败: ' + error.message);
        }
    }

    async startTrap(messageId, config = {}) {
        if (!this.requireRuntime(messageId)) return;
        if (this.receiver || this.trapRunning || this.trapStopping) {
            this.messageHandler.sendErrorResponse(messageId, 'SNMP Trap服务已经启动');
            return;
        }
        const runtimeGeneration = this.runtimeGeneration;
        const trapGeneration = ++this.trapGeneration;
        let receiver = null;
        try {
            // Trap 控制只能改变 Trap 自身参数。查询目标、版本与认证始终以
            // START_SNMP 时的运行快照为准，避免 Trap 启动污染 manager session 配置。
            const requestedPort = Number(config.port ?? this.snmpConfig?.port ?? SnmpConst.DEFAULT_SNMP_SETTINGS.port);
            if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
                throw new Error('SNMP Trap端口必须是1到65535之间的整数');
            }
            const requestedHistory = Number(
                config.maxTrapHistory ??
                    this.snmpConfig?.maxTrapHistory ??
                    SnmpConst.DEFAULT_SNMP_SETTINGS.maxTrapHistory
            );
            const maxTrapHistory =
                Number.isFinite(requestedHistory) && requestedHistory > 0
                    ? Math.min(100000, Math.floor(requestedHistory))
                    : SnmpConst.DEFAULT_SNMP_SETTINGS.maxTrapHistory;
            const trapConfig = {
                ...(this.snmpConfig || {}),
                port: requestedPort,
                maxTrapHistory
            };
            this.trapConfig = {
                port: trapConfig.port,
                maxTrapHistory: trapConfig.maxTrapHistory
            };
            this.maxTrapHistory = maxTrapHistory;
            this.trapHistory = [];
            this.trapCounter = 0;
            this.agentMap.clear();
            this.clearTrapUpdateAggregation();
            receiver = snmp.createReceiver(this.buildReceiverOptions(trapConfig), (error, notification) => {
                this.handleReceiverCallback(error, notification, {
                    receiver,
                    runtimeGeneration,
                    trapGeneration
                });
            });
            this.receiver = receiver;
            this.configureAuthorizer(receiver.getAuthorizer(), trapConfig);
            await this.waitForReceiverSockets(receiver);
            if (
                !this.runtimeReady ||
                this.runtimeStopping ||
                runtimeGeneration !== this.runtimeGeneration ||
                trapGeneration !== this.trapGeneration ||
                this.receiver !== receiver
            ) {
                await this.closeReceiver(receiver);
                throw new Error('SNMP Trap服务启动已取消');
            }
            this.trapRunning = true;
            logger.info(`SNMP Trap服务器启动成功，监听端口: ${trapConfig.port}`);
            this.messageHandler.sendSuccessResponse(
                messageId,
                this.getRuntimeState(),
                'SNMP Trap服务启动成功'
            );
            this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                type: SnmpConst.SNMP_SUB_EVT_TYPES.SERVER_STATUS,
                data: {
                    status: 'running',
                    port: trapConfig.port,
                    supportedVersions: trapConfig.supportedVersions
                }
            });
            this.emitRuntimeState();
        } catch (error) {
            logger.error('启动SNMP Trap服务器失败:', error);
            if (receiver) await this.closeReceiver(receiver);
            if (trapGeneration === this.trapGeneration) {
                this.trapRunning = false;
                this.trapConfig = null;
                this.emitRuntimeState();
            }
            this.messageHandler.sendErrorResponse(messageId, 'SNMP Trap服务启动失败: ' + error.message);
        }
    }

    buildReceiverOptions(config) {
        return {
            includeAuthentication: true,
            disableAuthorization: false,
            sockets: [
                { transport: 'udp4', address: '0.0.0.0', port: config.port },
                { transport: 'udp6', address: '::', port: config.port }
            ]
        };
    }

    waitForReceiverSockets(receiver = this.receiver) {
        const sockets = Object.values(receiver?.listener?.sockets || {});
        if (sockets.length === 0) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let settledCount = 0;
            let done = false;
            const timer = setTimeout(() => {
                done = true;
                resolve();
            }, 200);

            const settle = () => {
                if (done) {
                    return;
                }
                settledCount++;
                if (settledCount >= sockets.length) {
                    done = true;
                    clearTimeout(timer);
                    resolve();
                }
            };

            sockets.forEach(socket => {
                socket.once('listening', settle);
                socket.once('error', error => {
                    if (done) {
                        return;
                    }
                    done = true;
                    clearTimeout(timer);
                    reject(error);
                });
            });
        });
    }

    configureAuthorizer(authorizer, config = {}) {
        const versions = Array.isArray(config.supportedVersions) ? config.supportedVersions : [];

        if (versions.includes('v1') || versions.includes('v2c')) {
            authorizer.addCommunity(config.community || 'public');
        }

        if (versions.includes('v3') && config.v3Username) {
            authorizer.addUser(this.buildV3User(config));
        }
    }

    buildV3User(config = {}) {
        const securityLevelMap = {
            noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
            authNoPriv: snmp.SecurityLevel.authNoPriv,
            authPriv: snmp.SecurityLevel.authPriv
        };
        const authProtocolMap = {
            MD5: snmp.AuthProtocols.md5,
            SHA: snmp.AuthProtocols.sha,
            SHA224: snmp.AuthProtocols.sha224,
            SHA256: snmp.AuthProtocols.sha256,
            SHA384: snmp.AuthProtocols.sha384,
            SHA512: snmp.AuthProtocols.sha512
        };
        const privProtocolMap = {
            DES: snmp.PrivProtocols.des,
            AES: snmp.PrivProtocols.aes,
            AES256: snmp.PrivProtocols.aes256b
        };

        const level = securityLevelMap[config.securityLevel] || snmp.SecurityLevel.noAuthNoPriv;
        const user = {
            name: config.v3Username,
            level
        };

        if (level === snmp.SecurityLevel.authNoPriv || level === snmp.SecurityLevel.authPriv) {
            const authProtocol = authProtocolMap[config.authProtocol];
            if (!authProtocol) {
                throw new Error(`不支持的SNMPv3认证协议: ${config.authProtocol}`);
            }
            user.authProtocol = authProtocol;
            user.authKey = config.authPassword;
        }

        if (level === snmp.SecurityLevel.authPriv) {
            const privProtocol = privProtocolMap[config.privProtocol];
            if (!privProtocol) {
                throw new Error(`不支持的SNMPv3加密协议: ${config.privProtocol}`);
            }
            user.privProtocol = privProtocol;
            user.privKey = config.privPassword;
        }

        return user;
    }

    handleReceiverCallback(error, notification, context = {}) {
        if (
            context.receiver &&
            (this.receiver !== context.receiver ||
                context.runtimeGeneration !== this.runtimeGeneration ||
                context.trapGeneration !== this.trapGeneration ||
                this.runtimeStopping ||
                this.trapStopping)
        ) {
            return;
        }
        if (error) {
            logger.error('SNMP接收器错误:', error);
            this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                type: SnmpConst.SNMP_SUB_EVT_TYPES.TRAP_ERROR,
                data: {
                    error: error.message,
                    sourceIp: error.rinfo?.address || null,
                    sourcePort: error.rinfo?.port || null
                }
            });
            return;
        }

        this.processTrapNotification(notification);
    }

    processTrapNotification(notification) {
        try {
            const pdu = notification?.pdu || {};
            const rinfo = notification?.rinfo || {};
            this.trapCounter++;

            const trapData = this.enrichTrapData({
                id: `trap_${Date.now()}_${this.trapCounter}`,
                timestamp: new Date().toISOString(),
                sourceIp: rinfo.address,
                sourcePort: rinfo.port,
                version: this.getVersionFromPdu(pdu),
                community: pdu.community,
                user: pdu.user,
                pduType: pdu.type,
                pduTypeName: this.getPduTypeName(pdu.type),
                requestId: pdu.id || 0,
                enterpriseOid: pdu.enterprise || this.getTrapOid(pdu),
                trapOid: this.getTrapOid(pdu),
                trapType: this.getTrapType(pdu),
                specificType: pdu.specific,
                genericType: pdu.generic,
                agentAddr: pdu.agentAddr,
                uptime: pdu.upTime,
                contextName: pdu.contextName,
                varbinds: (pdu.varbinds || []).map(varbind => this.mibRegistry.enrichVarbind(varbind)),
                status: 'received',
                rawData: null
            });

            logger.info(`处理Trap: ${trapData.id} 来自 ${rinfo.address}:${rinfo.port}`);

            this.recordTrap(trapData);
            this.enqueueTrapUpdateEvent(trapData);
            this.updateAgentInfo(rinfo.address, trapData);
        } catch (error) {
            logger.error('处理Trap消息失败:', error);
            this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                type: SnmpConst.SNMP_SUB_EVT_TYPES.TRAP_ERROR,
                data: {
                    error: error.message,
                    sourceIp: notification?.rinfo?.address || null,
                    sourcePort: notification?.rinfo?.port || null
                }
            });
        }
    }

    enrichTrapData(trapData) {
        const trapOidInfo = this.mibRegistry.translateOid(trapData.trapOid);
        const enterpriseOidInfo = this.mibRegistry.translateOid(trapData.enterpriseOid);

        return {
            ...trapData,
            trapName: trapOidInfo.moduleQualifiedName || trapOidInfo.objectName || '',
            trapPath: trapOidInfo.pathName || '',
            trapDescription: trapOidInfo.description || '',
            enterpriseName: enterpriseOidInfo.moduleQualifiedName || enterpriseOidInfo.objectName || '',
            enterprisePath: enterpriseOidInfo.pathName || ''
        };
    }

    getVersionFromPdu(pdu) {
        if (pdu.type === snmp.PduType.Trap) {
            return 'v1';
        }

        if (pdu.user) {
            return 'v3';
        }

        return 'v2c';
    }

    getPduTypeName(pduType) {
        return snmp.PduType[pduType] || 'Unknown';
    }

    getTrapOid(pdu) {
        if (pdu.type === snmp.PduType.Trap) {
            if (pdu.generic === 6 && pdu.enterprise && Number.isFinite(Number(pdu.specific))) {
                return `${pdu.enterprise}.${pdu.specific}`;
            }
            return GENERIC_TRAP_OIDS[pdu.generic] || pdu.enterprise || '';
        }

        const trapOidVarbind = (pdu.varbinds || []).find(varbind => varbind.oid === SNMP_TRAP_OID);
        return trapOidVarbind?.value || '';
    }

    /**
     * 获取Trap类型
     */
    getTrapType(pdu) {
        switch (pdu.type) {
            case snmp.PduType.Trap:
                return 'SNMPv1 Trap';
            case snmp.PduType.TrapV2:
                return 'SNMPv2 Trap';
            case snmp.PduType.InformRequest:
                return 'Inform Request';
            default:
                return 'Unknown';
        }
    }

    recordTrap(trapData) {
        this.trapHistory.unshift(trapData);
        if (this.trapHistory.length > this.maxTrapHistory) {
            this.trapHistory.length = this.maxTrapHistory;
        }
    }

    /**
     * 更新代理信息
     */
    updateAgentInfo(agentIp, trapData) {
        try {
            if (!agentIp) {
                return;
            }

            const agentKey = agentIp;
            let agentInfo = this.agentMap.get(agentKey);

            if (!agentInfo) {
                agentInfo = {
                    ip: agentIp,
                    firstSeen: new Date().toISOString(),
                    trapCount: 0,
                    lastTrapTime: null,
                    status: 'online'
                };

                this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                    type: SnmpConst.SNMP_SUB_EVT_TYPES.AGENT_CONNECTION,
                    data: agentInfo
                });
            }

            agentInfo.trapCount++;
            agentInfo.lastTrapTime = trapData.timestamp;
            agentInfo.status = 'online';

            this.agentMap.set(agentKey, agentInfo);
        } catch (error) {
            logger.error('更新代理信息失败:', error);
        }
    }

    filterTrapHistory(query = {}) {
        const filters = query.filters || {};
        let list = this.trapHistory;

        if (filters.version) {
            list = list.filter(trap => trap.version === filters.version);
        }

        if (filters.sourceIp) {
            list = list.filter(trap => trap.sourceIp?.includes(filters.sourceIp));
        }

        if (filters.community) {
            list = list.filter(trap => trap.community?.includes(filters.community));
        }

        if (filters.timeRange?.start && filters.timeRange?.end) {
            const startTime = Date.parse(filters.timeRange.start);
            const endTime = Date.parse(filters.timeRange.end);
            if (!Number.isNaN(startTime) && !Number.isNaN(endTime)) {
                list = list.filter(trap => {
                    const trapTime = Date.parse(trap.timestamp);
                    return !Number.isNaN(trapTime) && trapTime >= startTime && trapTime <= endTime;
                });
            }
        }

        return list;
    }

    getTrapStats() {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const recentStart = now.getTime() - 60 * 60 * 1000;
        const sourceIps = new Set();
        let todayTraps = 0;
        let recentTraps = 0;

        this.trapHistory.forEach(trap => {
            if (trap.sourceIp) {
                sourceIps.add(trap.sourceIp);
            }

            const trapTime = Date.parse(trap.timestamp);
            if (Number.isNaN(trapTime)) {
                return;
            }
            if (trapTime >= todayStart) {
                todayTraps++;
            }
            if (trapTime >= recentStart) {
                recentTraps++;
            }
        });

        return {
            totalTraps: this.trapCounter,
            historyCount: this.trapHistory.length,
            todayTraps,
            recentTraps,
            onlineAgents: sourceIps.size
        };
    }

    getTrapList(messageId, query = {}) {
        if (!this.requireRuntime(messageId)) return;
        const pageSize = Math.max(1, Number(query.pageSize) || 20);
        const totalList = this.filterTrapHistory(query);
        const total = totalList.length;
        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(Math.max(1, Number(query.page) || 1), maxPage);
        const startIndex = (page - 1) * pageSize;
        const list = totalList.slice(startIndex, startIndex + pageSize);

        this.messageHandler.sendSuccessResponse(
            messageId,
            {
                list,
                page,
                pageSize,
                total,
                ...this.getTrapStats(),
                maxTrapHistory: this.maxTrapHistory,
                mib: this.mibRegistry.getSummary()
            },
            '获取Trap列表成功'
        );
    }

    clearTrapHistory(messageId) {
        if (!this.requireRuntime(messageId)) return;
        this.trapHistory = [];
        this.trapCounter = 0;
        this.clearTrapUpdateAggregation();
        this.messageHandler.sendSuccessResponse(messageId, null, 'Trap历史已清空');
        this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
            type: SnmpConst.SNMP_SUB_EVT_TYPES.HISTORY_CLEARED,
            data: {
                totalTraps: 0,
                historyCount: 0
            }
        });
    }

    compileMibs(messageId, data = []) {
        return this.forwardMibRequest(messageId, SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS, data);
    }

    normalizeMibCompileRequest(data = []) {
        if (Array.isArray(data)) {
            return {
                filePaths: data,
                cacheFilePath: '',
                force: false
            };
        }

        return {
            filePaths: data.filePaths || data.requestedFiles || [],
            cacheFilePath: data.cacheFilePath || '',
            force: Boolean(data.force)
        };
    }

    getMibWorker() {
        if (this.mibWorker && this.mibWorker.worker.threadId >= 0) return this.mibWorker;
        this.mibWorker = null;
        const workerPath = path.join(__dirname, 'mibWorker.js');
        const worker = new WorkerWithPromise(workerPath).createLongRunningWorker();
        this.mibWorker = worker;
        this.mibProgressHandler = payload => {
            this.messageHandler.sendEvent(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, payload);
        };
        worker.addEventListener(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, this.mibProgressHandler);
        const cleanupExitedWorker = () => {
            if (this.mibWorker !== worker) return;
            worker.removeEventListener(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, this.mibProgressHandler);
            this.mibWorker = null;
            this.mibProgressHandler = null;
        };
        worker.worker.once('error', cleanupExitedWorker);
        worker.worker.once('exit', cleanupExitedWorker);
        if (this.snmpConfig?.logLevel) {
            worker.sendRequest(LOG_REQ_TYPES.SET_LOG_LEVEL, this.snmpConfig.logLevel).catch(error => {
                logger.warn(`同步日志级别到 MIB worker 失败: ${error.message}`);
            });
        }
        return worker;
    }

    async terminateMibWorker() {
        const worker = this.mibWorker;
        if (!worker) return;
        this.mibWorker = null;
        if (this.mibProgressHandler) {
            worker.removeEventListener(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, this.mibProgressHandler);
        }
        this.mibProgressHandler = null;
        await worker.worker.terminate();
    }

    syncTrapMibRegistry(op, data, workerData) {
        if (op === SnmpConst.MIB_REQ_TYPES.CLEAR_MIBS) {
            this.mibRegistry.reset();
            if (this.snmpConfig) this.snmpConfig.mibFiles = [];
        } else if (
            op === SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS ||
            op === SnmpConst.MIB_REQ_TYPES.GET_MIB_STATUS ||
            op === SnmpConst.MIB_REQ_TYPES.IMPORT_MIB_PROJECT
        ) {
            const requestedFiles =
                workerData?.requestedFiles || data?.filePaths || data?.requestedFiles || this.snmpConfig?.mibFiles || [];
            const cacheFilePath = data?.cacheFilePath || this.snmpConfig?.mibCacheFilePath || '';
            if (this.snmpConfig && Array.isArray(requestedFiles)) {
                this.snmpConfig.mibFiles = [...requestedFiles];
            }
            this.mibRegistry.loadOrCompileMibFiles(requestedFiles, { cacheFilePath });
        } else {
            return;
        }
        this.trapHistory = this.trapHistory.map(trap =>
            this.enrichTrapData({
                ...trap,
                varbinds: (trap.varbinds || []).map(varbind => this.mibRegistry.enrichVarbind(varbind))
            })
        );
    }

    buildMibWorkerRequest(op, data = {}) {
        const request = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
        const runtimeFiles = Array.isArray(this.snmpConfig?.mibFiles) ? this.snmpConfig.mibFiles : [];

        // 缓存和工程目录是运行时启动时由主进程注入的固定 capability，
        // 不允许后续 renderer 请求替换为任意文件系统路径。
        request.cacheFilePath = this.snmpConfig?.mibCacheFilePath || '';
        request.projectRootDir = this.snmpConfig?.mibProjectRootDir || '';

        if (op === SnmpConst.MIB_REQ_TYPES.GET_MIB_SOURCE) {
            request.requestedFiles = [...runtimeFiles];
        } else if (!Array.isArray(request.filePaths) && !Array.isArray(request.requestedFiles)) {
            request.requestedFiles = [...runtimeFiles];
        }
        return request;
    }

    async forwardMibRequest(messageId, op, data = {}) {
        if (!this.requireRuntime(messageId)) return;
        try {
            const worker = this.getMibWorker();
            const request = this.buildMibWorkerRequest(op, data);
            const result = await worker.sendRequest(op, request);
            this.syncTrapMibRegistry(op, request, result.data);
            const threadId = worker.worker.threadId;
            const responseData =
                result.data && typeof result.data === 'object' && !Array.isArray(result.data)
                    ? { ...result.data, mibWorkerThreadId: threadId }
                    : result.data;
            this.messageHandler.sendSuccessResponse(messageId, responseData, result.msg);
        } catch (error) {
            logger.error(`MIB请求失败 (${op}):`, error);
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    normalizeQueryPayload(payload = {}) {
        const request = payload && typeof payload.request === 'object' ? payload.request : payload;
        return {
            config: this.snmpConfig || {},
            request: request && typeof request === 'object' ? request : {}
        };
    }

    createQueryContext(payload, oidLabel) {
        const { config, request } = this.normalizeQueryPayload(payload);
        const targetHost = String(config.targetHost || SnmpConst.DEFAULT_SNMP_SETTINGS.targetHost).trim();
        const oid = String(request.oid || '')
            .trim()
            .replace(/\.$/, '');
        const version = this.getConfiguredSessionVersion(config);
        const community = config.community || 'public';
        const port = Number(config.queryPort) || SnmpConst.DEFAULT_SNMP_SETTINGS.queryPort;
        if (!targetHost) throw new Error('请输入目标地址');
        if (!oid) throw new Error(`请输入${oidLabel}`);
        const snmpVersion = this.getSessionVersion(version);
        if (snmpVersion === null) {
            throw new Error(`当前${oidLabel}暂支持SNMPv1/v2c，请在SNMP配置中启用SNMPv1或SNMPv2c`);
        }
        return { config, request, targetHost, oid, version, community, port, snmpVersion };
    }

    createSession(context) {
        const session = snmp.createSession(context.targetHost, context.community, {
            port: context.port,
            version: context.snmpVersion,
            timeout: Number(context.request.timeout) || SnmpConst.DEFAULT_SNMP_SETTINGS.timeout,
            retries: Number(context.request.retries) || 0
        });
        this.activeSessions.add(session);
        return session;
    }

    closeSession(session) {
        if (!session) return;
        this.activeSessions.delete(session);
        try {
            session.close();
        } catch (error) {
            logger.warn(`关闭SNMP查询会话失败: ${error.message}`);
        }
    }

    closeActiveSessions() {
        Array.from(this.activeSessions).forEach(session => this.closeSession(session));
        this.activeSessions.clear();
    }

    async sendGetRequest(messageId, payload = {}) {
        if (!this.requireRuntime(messageId)) return;
        let session = null;
        try {
            const context = this.createQueryContext(payload, 'GET OID');
            session = this.createSession(context);
            const varbinds = await this.sendGetOids(session, [context.oid]);
            const firstError = varbinds.find(varbind => snmp.isVarbindError(varbind));
            if (firstError) throw new Error('GET失败: ' + snmp.varbindError(firstError));
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    targetHost: context.targetHost,
                    targetPort: context.port,
                    version: context.version,
                    varbinds: varbinds.map(varbind => this.formatSessionVarbind(varbind))
                },
                'GET查询成功'
            );
        } catch (error) {
            logger.error('发送SNMP GET失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '发送SNMP GET失败: ' + error.message);
        } finally {
            this.closeSession(session);
        }
    }

    async sendGetNextRequest(messageId, payload = {}) {
        if (!this.requireRuntime(messageId)) return;
        let session = null;
        try {
            const context = this.createQueryContext(payload, 'GET-NEXT OID');
            session = this.createSession(context);
            const varbinds = await this.sendGetNextOids(session, [context.oid]);
            const firstError = varbinds.find(varbind => snmp.isVarbindError(varbind));
            if (firstError) throw new Error('GET-NEXT失败: ' + snmp.varbindError(firstError));
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    targetHost: context.targetHost,
                    targetPort: context.port,
                    version: context.version,
                    varbinds: varbinds.map(varbind => this.formatSessionVarbind(varbind))
                },
                'GET-NEXT查询成功'
            );
        } catch (error) {
            logger.error('发送SNMP GET-NEXT失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '发送SNMP GET-NEXT失败: ' + error.message);
        } finally {
            this.closeSession(session);
        }
    }

    async sendSetRequest(messageId, payload = {}) {
        if (!this.requireRuntime(messageId)) return;
        let session = null;
        try {
            const context = this.createQueryContext(payload, 'SET OID');
            const objectType = this.getSetObjectType(context.request.type);
            const value = this.castSetValue(objectType, context.request.value);
            session = this.createSession(context);
            const varbinds = await this.sendSetVarbinds(session, [
                { oid: context.oid, type: objectType, value }
            ]);
            const firstError = varbinds.find(varbind => snmp.isVarbindError(varbind));
            if (firstError) throw new Error('SET失败: ' + snmp.varbindError(firstError));
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    targetHost: context.targetHost,
                    targetPort: context.port,
                    version: context.version,
                    varbinds: varbinds.map(varbind => this.formatSessionVarbind(varbind))
                },
                'SET发送成功'
            );
        } catch (error) {
            logger.error('发送SNMP SET失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '发送SNMP SET失败: ' + error.message);
        } finally {
            this.closeSession(session);
        }
    }

    async runWalk(messageId, payload, instanceMode) {
        if (!this.requireRuntime(messageId)) return;
        let session = null;
        try {
            const label = instanceMode ? '实例枚举OID' : 'WALK起始OID';
            const context = this.createQueryContext(payload, label);
            const limitMax = instanceMode ? 500 : 1000;
            const limit = Math.max(1, Math.min(Number(context.request.limit) || 100, limitMax));
            const maxRepetitions = Math.max(1, Math.min(Number(context.request.maxRepetitions) || 20, 50));
            session = this.createSession(context);
            const summary =
                context.version === 'v2c'
                    ? await this.listOidInstancesWithBulk(session, context.oid, limit, maxRepetitions)
                    : await this.listOidInstancesWithGetNext(session, context.oid, limit);
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    targetHost: context.targetHost,
                    targetPort: context.port,
                    version: context.version,
                    baseOid: context.oid,
                    limit,
                    maxRepetitions,
                    ...summary
                },
                instanceMode ? '实例枚举完成' : 'WALK查询完成'
            );
        } catch (error) {
            const action = instanceMode ? '枚举SNMP实例' : '发送SNMP WALK';
            logger.error(`${action}失败:`, error);
            this.messageHandler.sendErrorResponse(messageId, `${action}失败: ${error.message}`);
        } finally {
            this.closeSession(session);
        }
    }

    sendWalkRequest(messageId, payload = {}) {
        return this.runWalk(messageId, payload, false);
    }

    listOidInstances(messageId, payload = {}) {
        return this.runWalk(messageId, payload, true);
    }

    sendGetOids(session, oids) {
        return new Promise((resolve, reject) => {
            session.get(oids, (error, result) => (error ? reject(error) : resolve(result || [])));
        });
    }

    sendGetNextOids(session, oids) {
        return new Promise((resolve, reject) => {
            session.getNext(oids, (error, result) => (error ? reject(error) : resolve(result || [])));
        });
    }

    sendGetBulkOids(session, oids, nonRepeaters, maxRepetitions) {
        return new Promise((resolve, reject) => {
            session.getBulk(oids, nonRepeaters, maxRepetitions, (error, result) =>
                error ? reject(error) : resolve(result || [])
            );
        });
    }

    sendSetVarbinds(session, varbinds) {
        return new Promise((resolve, reject) => {
            session.set(varbinds, (error, result) => (error ? reject(error) : resolve(result || [])));
        });
    }

    async listOidInstancesWithGetNext(session, baseOid, limit) {
        const rows = [];
        let currentOid = baseOid;
        let stoppedBy = 'endOfSubtree';
        while (rows.length < limit) {
            const varbind = (await this.sendGetNextOids(session, [currentOid]))[0];
            const result = this.acceptInstanceVarbind(baseOid, currentOid, varbind);
            if (!result.accepted) {
                stoppedBy = result.reason;
                break;
            }
            rows.push(result.row);
            currentOid = varbind.oid;
        }
        return { rows, stoppedBy: rows.length >= limit ? 'limit' : stoppedBy, limitReached: rows.length >= limit };
    }

    async listOidInstancesWithBulk(session, baseOid, limit, maxRepetitions) {
        const rows = [];
        let currentOid = baseOid;
        let stoppedBy = 'endOfSubtree';
        while (rows.length < limit) {
            const groups = await this.sendGetBulkOids(
                session,
                [currentOid],
                0,
                Math.min(maxRepetitions, limit - rows.length)
            );
            const varbinds = Array.isArray(groups[0]) ? groups[0] : groups;
            if (!Array.isArray(varbinds) || varbinds.length === 0) {
                stoppedBy = 'emptyResponse';
                break;
            }
            let acceptedCount = 0;
            for (const varbind of varbinds) {
                const result = this.acceptInstanceVarbind(baseOid, currentOid, varbind);
                if (!result.accepted) {
                    return { rows, stoppedBy: result.reason, limitReached: false };
                }
                rows.push(result.row);
                currentOid = varbind.oid;
                acceptedCount++;
                if (rows.length >= limit) break;
            }
            if (acceptedCount === 0) {
                stoppedBy = 'emptyResponse';
                break;
            }
        }
        return { rows, stoppedBy: rows.length >= limit ? 'limit' : stoppedBy, limitReached: rows.length >= limit };
    }

    acceptInstanceVarbind(baseOid, previousOid, varbind) {
        if (!varbind) return { accepted: false, reason: 'emptyResponse' };
        if (snmp.isVarbindError(varbind)) {
            return { accepted: false, reason: snmp.varbindError(varbind) || 'varbindError' };
        }
        if (!this.isOidInSubtree(baseOid, varbind.oid)) return { accepted: false, reason: 'endOfSubtree' };
        if (this.compareOids(varbind.oid, previousOid) <= 0) {
            return { accepted: false, reason: 'nonIncreasingOid' };
        }
        return {
            accepted: true,
            row: { ...this.formatSessionVarbind(varbind), instance: this.getOidInstanceSuffix(baseOid, varbind.oid) }
        };
    }

    isOidInSubtree(baseOid, oid) {
        return oid === baseOid || String(oid || '').startsWith(`${baseOid}.`);
    }

    getOidInstanceSuffix(baseOid, oid) {
        return !this.isOidInSubtree(baseOid, oid) || oid === baseOid ? '' : String(oid).slice(baseOid.length + 1);
    }

    compareOids(left, right) {
        const leftParts = String(left || '').split('.').map(Number);
        const rightParts = String(right || '').split('.').map(Number);
        for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
            const delta = (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
            if (delta !== 0) return delta;
        }
        return 0;
    }

    formatSessionVarbind(varbind) {
        const shouldFormatValue = Buffer.isBuffer(varbind.value) || typeof varbind.value === 'bigint';
        const formattedValue = shouldFormatValue ? formatSnmpValue(varbind.value) : { value: varbind.value };
        return { oid: varbind.oid, type: snmp.ObjectType[varbind.type] || varbind.type, ...formattedValue };
    }

    getSessionVersion(version) {
        return { v1: snmp.Version1, v2c: snmp.Version2c }[version] ?? null;
    }

    getConfiguredSessionVersion(config = {}) {
        const versions = Array.isArray(config.supportedVersions) ? config.supportedVersions : [];
        if (versions.length === 0 || !versions[0]) return 'v2c';
        return ['v1', 'v2c'].includes(versions[0]) ? versions[0] : '';
    }

    getSetObjectType(type = '') {
        const normalized = String(type || '').replace(/[\s_-]+/g, '').toLowerCase();
        const typeMap = {
            integer: snmp.ObjectType.Integer,
            integer32: snmp.ObjectType.Integer,
            boolean: snmp.ObjectType.Integer,
            truthvalue: snmp.ObjectType.Integer,
            rowstatus: snmp.ObjectType.Integer,
            octetstring: snmp.ObjectType.OctetString,
            displaystring: snmp.ObjectType.OctetString,
            string: snmp.ObjectType.OctetString,
            objectidentifier: snmp.ObjectType.OID,
            oid: snmp.ObjectType.OID,
            ipaddress: snmp.ObjectType.IpAddress,
            counter: snmp.ObjectType.Counter,
            counter32: snmp.ObjectType.Counter,
            gauge: snmp.ObjectType.Gauge,
            gauge32: snmp.ObjectType.Gauge,
            unsigned32: snmp.ObjectType.Gauge,
            timeticks: snmp.ObjectType.TimeTicks,
            counter64: snmp.ObjectType.Counter64
        };
        const objectType = typeMap[normalized];
        if (!objectType) throw new Error(`不支持的SET类型: ${type || '-'}`);
        return objectType;
    }

    castSetValue(objectType, value) {
        if (value === null || value === undefined || value === '') throw new Error('请输入SET值');
        if (
            [
                snmp.ObjectType.Integer,
                snmp.ObjectType.Counter,
                snmp.ObjectType.Gauge,
                snmp.ObjectType.TimeTicks,
                snmp.ObjectType.Counter64
            ].includes(objectType)
        ) {
            const numberValue = Number(value);
            if (!Number.isFinite(numberValue)) throw new Error('数值类型必须输入数字');
            return numberValue;
        }
        return String(value);
    }

    stopTrapInternal() {
        if (this.trapStopPromise) return this.trapStopPromise;
        let currentPromise;
        currentPromise = (async () => {
            this.trapStopping = true;
            this.trapGeneration++;
            this.flushTrapUpdateEvents();
            try {
                await this.closeReceiver();
                this.trapRunning = false;
                this.trapConfig = null;
                this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                    type: SnmpConst.SNMP_SUB_EVT_TYPES.SERVER_STATUS,
                    data: { status: 'stopped' }
                });
            } finally {
                this.trapStopping = false;
                this.emitRuntimeState();
            }
        })().finally(() => {
            if (this.trapStopPromise === currentPromise) this.trapStopPromise = null;
        });
        this.trapStopPromise = currentPromise;
        return currentPromise;
    }

    async stopTrap(messageId) {
        if (!this.requireRuntime(messageId)) return;
        if (this.trapStopping) {
            this.messageHandler.sendErrorResponse(messageId, 'SNMP Trap服务正在停止');
            return;
        }
        if (!this.receiver && !this.trapRunning) {
            this.messageHandler.sendErrorResponse(messageId, 'SNMP Trap服务未启动');
            return;
        }
        try {
            await this.stopTrapInternal();
            this.messageHandler.sendSuccessResponse(messageId, this.getRuntimeState(), 'SNMP Trap服务停止成功');
        } catch (error) {
            logger.error('停止SNMP Trap服务失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'SNMP Trap服务停止失败: ' + error.message);
        }
    }

    async stopSnmp(messageId) {
        if (!this.requireRuntime(messageId)) return;
        this.runtimeStopping = true;
        this.runtimeGeneration++;
        this.emitRuntimeState();
        try {
            if (this.receiver || this.trapRunning) await this.stopTrapInternal();
            this.closeActiveSessions();
            await this.terminateMibWorker();
            this.snmpConfig = null;
            this.runtimeReady = false;
            this.runtimeStopping = false;
            this.trapRunning = false;
            this.trapStopping = false;
            this.trapConfig = null;
            this.agentMap.clear();
            this.trapHistory = [];
            this.trapCounter = 0;
            this.clearTrapUpdateAggregation();
            this.mibRegistry.reset();
            this.emitRuntimeState();
            logger.info('SNMP运行时停止成功');
            this.messageHandler.sendSuccessResponse(messageId, this.getRuntimeState(), 'SNMP运行时停止成功');
        } catch (error) {
            this.runtimeStopping = false;
            logger.error('停止SNMP运行时失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'SNMP运行时停止失败: ' + error.message);
        }
    }

    closeReceiver(receiver = this.receiver) {
        if (!receiver) {
            return Promise.resolve();
        }
        const existingClose = this.receiverClosePromises.get(receiver);
        if (existingClose) return existingClose;

        const closePromise = new Promise(resolve => {
            const sockets = Object.values(receiver.listener?.sockets || {});
            const socketCount = sockets.length;
            let closedCount = 0;
            let resolved = false;

            const finish = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                if (this.receiver === receiver) {
                    this.receiver = null;
                    this.trapRunning = false;
                }
                resolve();
            };

            if (socketCount === 0) {
                finish();
                return;
            }

            const timer = setTimeout(finish, 500);
            const markClosed = () => {
                closedCount++;
                if (closedCount >= socketCount) {
                    clearTimeout(timer);
                    finish();
                }
            };
            sockets.forEach(socket => {
                try {
                    socket.close(() => {
                        markClosed();
                    });
                } catch (error) {
                    logger.warn(`关闭SNMP Trap socket失败: ${error.message}`);
                    markClosed();
                }
            });
        });
        this.receiverClosePromises.set(receiver, closePromise);
        return closePromise;
    }
}

new SnmpWorker(); // 启动监听
