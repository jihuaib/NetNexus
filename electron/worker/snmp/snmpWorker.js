const snmp = require('net-snmp');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const SnmpConst = require('../../const/snmpConst');
const MibRegistry = require('../../utils/mibRegistry');

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
        this.snmpConfig = null;
        this.sessionMap = new Map(); // SNMP会话映射
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

        // 创建消息处理器
        this.messageHandler = new WorkerMessageHandler();
        // 初始化消息处理器
        this.messageHandler.init();
        // 注册消息处理器
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.START_SNMP, this.startSnmp.bind(this));
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.STOP_SNMP, this.stopSnmp.bind(this));
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.GET_TRAP_LIST, this.getTrapList.bind(this));
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.CLEAR_TRAP_HISTORY,
            this.clearTrapHistory.bind(this)
        );
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.COMPILE_MIBS, this.compileMibs.bind(this));
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

    /**
     * 启动SNMP服务器
     */
    async startSnmp(messageId, config = {}) {
        try {
            this.snmpConfig = config;
            this.maxTrapHistory = Number(config.maxTrapHistory) || SnmpConst.DEFAULT_SNMP_SETTINGS.maxTrapHistory;
            this.trapHistory = [];
            this.trapCounter = 0;
            this.clearTrapUpdateAggregation();

            if (this.snmpConfig.logLevel) {
                logger.setLevel(this.snmpConfig.logLevel);
                logger.info(`Worker log level set to: ${this.snmpConfig.logLevel}`);
            }

            const mibSummary = this.mibRegistry.loadOrCompileMibFiles(config.mibFiles || [], {
                cacheFilePath: config.mibCacheFilePath || ''
            });
            if (mibSummary.failedFiles.length > 0) {
                logger.warn(`部分MIB编译失败: ${JSON.stringify(mibSummary.failedFiles)}`);
            }

            this.receiver = snmp.createReceiver(
                this.buildReceiverOptions(config),
                this.handleReceiverCallback.bind(this)
            );
            this.configureAuthorizer(this.receiver.getAuthorizer(), config);
            await this.waitForReceiverSockets();

            logger.info(`SNMP Trap服务器启动成功，监听端口: ${config.port}`);
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    mib: mibSummary
                },
                'SNMP Trap服务启动成功'
            );

            this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                type: SnmpConst.SNMP_SUB_EVT_TYPES.SERVER_STATUS,
                data: {
                    status: 'running',
                    port: config.port,
                    supportedVersions: config.supportedVersions,
                    mib: mibSummary
                }
            });
        } catch (error) {
            logger.error('启动SNMP服务器失败:', error);
            await this.closeReceiver();
            this.messageHandler.sendErrorResponse(messageId, 'SNMP协议启动失败: ' + error.message);
        }
    }

    buildReceiverOptions(config) {
        const port = Number(config.port) || SnmpConst.DEFAULT_SNMP_SETTINGS.port;
        return {
            includeAuthentication: true,
            disableAuthorization: false,
            sockets: [
                { transport: 'udp4', address: '0.0.0.0', port },
                { transport: 'udp6', address: '::', port }
            ]
        };
    }

    waitForReceiverSockets() {
        const sockets = Object.values(this.receiver?.listener?.sockets || {});
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

    handleReceiverCallback(error, notification) {
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
        try {
            const request = this.normalizeMibCompileRequest(data);
            const summary = this.mibRegistry.loadOrCompileMibFiles(request.filePaths, {
                cacheFilePath: request.cacheFilePath,
                force: request.force
            });
            this.trapHistory = this.trapHistory.map(trap =>
                this.enrichTrapData({
                    ...trap,
                    varbinds: (trap.varbinds || []).map(varbind => this.mibRegistry.enrichVarbind(varbind))
                })
            );
            this.messageHandler.sendSuccessResponse(messageId, summary, 'MIB编译完成');
        } catch (error) {
            logger.error('MIB编译失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'MIB编译失败: ' + error.message);
        }
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

    /**
     * 停止SNMP服务器
     */
    async stopSnmp(messageId) {
        try {
            this.flushTrapUpdateEvents();
            await this.closeReceiver();

            this.snmpConfig = null;
            this.sessionMap.clear();
            this.agentMap.clear();
            this.trapHistory = [];
            this.trapCounter = 0;
            this.clearTrapUpdateAggregation();

            logger.info('SNMP服务器停止成功');
            this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                type: SnmpConst.SNMP_SUB_EVT_TYPES.SERVER_STATUS,
                data: {
                    status: 'stopped'
                }
            });
            // 先通知所有 renderer，再完成请求；主进程收到响应后会释放 worker 监听。
            this.messageHandler.sendSuccessResponse(messageId, null, 'SNMP协议停止成功');
        } catch (error) {
            logger.error('停止SNMP服务器失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'SNMP协议停止失败: ' + error.message);
        }
    }

    closeReceiver() {
        if (!this.receiver) {
            return Promise.resolve();
        }

        return new Promise(resolve => {
            const receiver = this.receiver;
            const sockets = Object.values(receiver.listener?.sockets || {});
            const socketCount = sockets.length;
            let closedCount = 0;
            let resolved = false;

            const finish = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                this.receiver = null;
                resolve();
            };

            if (socketCount === 0) {
                finish();
                return;
            }

            const timer = setTimeout(finish, 500);
            receiver.close(() => {
                closedCount++;
                if (closedCount >= socketCount) {
                    clearTimeout(timer);
                    finish();
                }
            });
        });
    }
}

new SnmpWorker(); // 启动监听
