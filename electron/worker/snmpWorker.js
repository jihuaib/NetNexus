const snmp = require('net-snmp');
const logger = require('../log/logger');
const WorkerMessageHandler = require('./workerMessageHandler');
const SnmpConst = require('../const/snmpConst');
const MibRegistry = require('../utils/mibRegistry');

const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';
const GENERIC_TRAP_OIDS = {
    0: '1.3.6.1.6.3.1.1.5.1',
    1: '1.3.6.1.6.3.1.1.5.2',
    2: '1.3.6.1.6.3.1.1.5.3',
    3: '1.3.6.1.6.3.1.1.5.4',
    4: '1.3.6.1.6.3.1.1.5.5',
    5: '1.3.6.1.6.3.1.1.5.6'
};

const QUERY_PDU_TYPE_NAMES = {
    [SnmpConst.SNMP_PDU_TYPE.GET_REQUEST]: 'GetRequest',
    [SnmpConst.SNMP_PDU_TYPE.GET_NEXT_REQUEST]: 'GetNextRequest',
    [SnmpConst.SNMP_PDU_TYPE.GET_BULK_REQUEST]: 'GetBulkRequest',
    [SnmpConst.SNMP_PDU_TYPE.SET_REQUEST]: 'SetRequest'
};

const QUERY_OPERATION_NAMES = {
    [SnmpConst.SNMP_PDU_TYPE.GET_REQUEST]: 'GET',
    [SnmpConst.SNMP_PDU_TYPE.GET_NEXT_REQUEST]: 'GETNEXT',
    [SnmpConst.SNMP_PDU_TYPE.GET_BULK_REQUEST]: 'GETBULK',
    [SnmpConst.SNMP_PDU_TYPE.SET_REQUEST]: 'SET'
};

const QUERY_PDU_TYPES = new Set(Object.keys(QUERY_PDU_TYPE_NAMES).map(Number));

class SnmpWorker {
    constructor() {
        this.receiver = null;
        this.agent = null;
        this.agentStartTime = null;
        this.snmpConfig = null;
        this.sessionMap = new Map(); // SNMP会话映射
        this.agentMap = new Map(); // 代理映射
        this.trapCounter = 0;
        this.trapHistory = [];
        this.queryCounter = 0;
        this.queryHistory = [];
        this.maxTrapHistory = SnmpConst.DEFAULT_SNMP_SETTINGS.maxTrapHistory;
        this.maxQueryHistory = SnmpConst.DEFAULT_SNMP_SETTINGS.maxQueryHistory;
        this.pendingTrapUpdateCount = 0;
        this.pendingTrapLatestTrap = null;
        this.pendingTrapSourceIps = new Set();
        this.trapUpdateFlushTimer = null;
        this.trapUpdateFlushIntervalMs = 1000;
        this.pendingQueryUpdateCount = 0;
        this.pendingQueryLatestQuery = null;
        this.pendingQuerySourceIps = new Set();
        this.queryUpdateFlushTimer = null;
        this.queryUpdateFlushIntervalMs = 1000;
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
        this.messageHandler.registerHandler(SnmpConst.SNMP_REQ_TYPES.GET_QUERY_LIST, this.getQueryList.bind(this));
        this.messageHandler.registerHandler(
            SnmpConst.SNMP_REQ_TYPES.CLEAR_QUERY_HISTORY,
            this.clearQueryHistory.bind(this)
        );
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

    enqueueQueryUpdateEvent(queryData) {
        this.pendingQueryUpdateCount++;
        this.pendingQueryLatestQuery = queryData;
        if (queryData.sourceIp) {
            this.pendingQuerySourceIps.add(queryData.sourceIp);
        }
        this.scheduleQueryUpdateFlush();
    }

    scheduleQueryUpdateFlush() {
        if (this.queryUpdateFlushTimer) {
            return;
        }

        this.queryUpdateFlushTimer = setTimeout(() => {
            this.flushQueryUpdateEvents();
        }, this.queryUpdateFlushIntervalMs);
    }

    flushQueryUpdateEvents() {
        if (this.queryUpdateFlushTimer) {
            clearTimeout(this.queryUpdateFlushTimer);
            this.queryUpdateFlushTimer = null;
        }

        if (this.pendingQueryUpdateCount === 0) {
            return;
        }

        const latestQuery = this.pendingQueryLatestQuery;
        const update = {
            changedCount: this.pendingQueryUpdateCount,
            totalQueries: this.queryCounter,
            historyCount: this.queryHistory.length,
            sourceIpCount: this.pendingQuerySourceIps.size,
            latestQueryAt: latestQuery?.timestamp || null,
            latestSourceIp: latestQuery?.sourceIp || null,
            latestOperation: latestQuery?.operation || null
        };

        this.pendingQueryUpdateCount = 0;
        this.pendingQueryLatestQuery = null;
        this.pendingQuerySourceIps.clear();

        this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
            type: SnmpConst.SNMP_SUB_EVT_TYPES.QUERY_BATCH_RECEIVED,
            data: update
        });
    }

    clearQueryUpdateAggregation() {
        if (this.queryUpdateFlushTimer) {
            clearTimeout(this.queryUpdateFlushTimer);
            this.queryUpdateFlushTimer = null;
        }

        this.pendingQueryUpdateCount = 0;
        this.pendingQueryLatestQuery = null;
        this.pendingQuerySourceIps.clear();
    }

    /**
     * 启动SNMP服务器
     */
    async startSnmp(messageId, config = {}) {
        try {
            this.snmpConfig = config;
            this.maxTrapHistory = Number(config.maxTrapHistory) || SnmpConst.DEFAULT_SNMP_SETTINGS.maxTrapHistory;
            this.maxQueryHistory = Number(config.maxQueryHistory) || SnmpConst.DEFAULT_SNMP_SETTINGS.maxQueryHistory;
            this.trapHistory = [];
            this.queryHistory = [];
            this.trapCounter = 0;
            this.queryCounter = 0;
            this.clearTrapUpdateAggregation();
            this.clearQueryUpdateAggregation();

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

            this.receiver = snmp.createReceiver(this.buildReceiverOptions(config), this.handleReceiverCallback.bind(this));
            this.configureAuthorizer(this.receiver.getAuthorizer(), config);
            await this.waitForReceiverSockets();
            const queryAgent = await this.startQueryAgent(config);

            logger.info(`SNMP Trap服务器启动成功，监听端口: ${config.port}`);
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    mib: mibSummary,
                    queryAgent
                },
                'SNMP协议启动成功'
            );

            this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                type: SnmpConst.SNMP_SUB_EVT_TYPES.SERVER_STATUS,
                data: {
                    status: 'running',
                    port: config.port,
                    queryEnabled: queryAgent.enabled,
                    queryPort: queryAgent.port,
                    supportedVersions: config.supportedVersions,
                    mib: mibSummary
                }
            });
        } catch (error) {
            logger.error('启动SNMP服务器失败:', error);
            await this.closeReceiver();
            await this.closeQueryAgent();
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

    waitForAgentSockets() {
        const sockets = Object.values(this.agent?.listener?.sockets || {});
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

    async startQueryAgent(config = {}) {
        const enabled = config.enableQueryMonitor !== false;
        const port = Number(config.queryPort) || SnmpConst.DEFAULT_SNMP_SETTINGS.queryPort;
        const trapPort = Number(config.port) || SnmpConst.DEFAULT_SNMP_SETTINGS.port;

        await this.closeQueryAgent();

        if (!enabled) {
            return {
                enabled: false,
                port: null
            };
        }

        if (port === trapPort) {
            throw new Error('查询监听端口不能与Trap监听端口相同');
        }

        this.agentStartTime = Date.now();
        this.agent = snmp.createAgent(this.buildAgentOptions(config), this.handleAgentCallback.bind(this));
        this.configureAuthorizer(this.agent.getAuthorizer(), config);
        this.registerAgentRequestHooks(this.agent);
        this.registerDefaultAgentProviders(this.agent);
        await this.waitForAgentSockets();

        logger.info(`SNMP查询Agent启动成功，监听端口: ${port}`);
        return {
            enabled: true,
            port
        };
    }

    buildAgentOptions(config = {}) {
        const port = Number(config.queryPort) || SnmpConst.DEFAULT_SNMP_SETTINGS.queryPort;
        return {
            disableAuthorization: false,
            sockets: [
                { transport: 'udp4', address: '0.0.0.0', port },
                { transport: 'udp6', address: '::', port }
            ]
        };
    }

    registerDefaultAgentProviders(agent) {
        const readOnly = snmp.MaxAccess['read-only'];
        const readWrite = snmp.MaxAccess['read-write'];
        const providers = [
            {
                name: 'sysDescr',
                oid: '1.3.6.1.2.1.1.1',
                scalarType: snmp.ObjectType.OctetString,
                maxAccess: readOnly
            },
            {
                name: 'sysObjectID',
                oid: '1.3.6.1.2.1.1.2',
                scalarType: snmp.ObjectType.OID,
                maxAccess: readOnly
            },
            {
                name: 'sysUpTime',
                oid: '1.3.6.1.2.1.1.3',
                scalarType: snmp.ObjectType.TimeTicks,
                maxAccess: readOnly,
                handler: request => {
                    request.instanceNode.value = Math.max(0, Math.floor((Date.now() - this.agentStartTime) / 10));
                    request.done();
                }
            },
            {
                name: 'sysContact',
                oid: '1.3.6.1.2.1.1.4',
                scalarType: snmp.ObjectType.OctetString,
                maxAccess: readWrite
            },
            {
                name: 'sysName',
                oid: '1.3.6.1.2.1.1.5',
                scalarType: snmp.ObjectType.OctetString,
                maxAccess: readWrite
            },
            {
                name: 'sysLocation',
                oid: '1.3.6.1.2.1.1.6',
                scalarType: snmp.ObjectType.OctetString,
                maxAccess: readWrite
            }
        ].map(provider => ({
            ...provider,
            type: snmp.MibProviderType.Scalar
        }));

        providers.forEach(provider => agent.registerProvider(provider));

        const mib = agent.getMib();
        mib.setScalarValue('sysDescr', 'NetNexus SNMP Agent');
        mib.setScalarValue('sysObjectID', '1.3.6.1.4.1.8072.3.2.10');
        mib.setScalarValue('sysUpTime', 0);
        mib.setScalarValue('sysContact', '');
        mib.setScalarValue('sysName', 'NetNexus');
        mib.setScalarValue('sysLocation', '');
    }

    registerAgentRequestHooks(agent) {
        const hooks = [
            ['getRequest', SnmpConst.SNMP_PDU_TYPE.GET_REQUEST],
            ['getNextRequest', SnmpConst.SNMP_PDU_TYPE.GET_NEXT_REQUEST],
            ['getBulkRequest', SnmpConst.SNMP_PDU_TYPE.GET_BULK_REQUEST],
            ['setRequest', SnmpConst.SNMP_PDU_TYPE.SET_REQUEST]
        ];

        hooks.forEach(([methodName, pduType]) => {
            const original = agent[methodName].bind(agent);
            agent[methodName] = (socket, requestMessage, rinfo) => {
                this.recordAgentQueryRequest(pduType, requestMessage, rinfo);
                return original(socket, requestMessage, rinfo);
            };
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

    handleAgentCallback(error) {
        if (!error) {
            return;
        }

        logger.error('SNMP查询Agent错误:', error);
        this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
            type: SnmpConst.SNMP_SUB_EVT_TYPES.QUERY_ERROR,
            data: {
                error: error.message,
                sourceIp: error.rinfo?.address || null,
                sourcePort: error.rinfo?.port || null
            }
        });
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

    recordAgentQueryRequest(pduType, requestMessage, rinfo) {
        try {
            const pdu = requestMessage?.pdu || {};
            if (!QUERY_PDU_TYPES.has(pduType)) {
                return;
            }

            this.queryCounter++;
            const varbinds = (pdu.varbinds || []).map((varbind, index) =>
                this.mibRegistry.enrichVarbind({
                    ...varbind,
                    index: index + 1
                })
            );

            const queryData = {
                id: `query_${Date.now()}_${this.queryCounter}`,
                timestamp: new Date().toISOString(),
                sourceIp: rinfo?.address || '',
                sourcePort: rinfo?.port || '',
                version: this.getVersionFromMessage(requestMessage),
                community: requestMessage?.community || '',
                user: requestMessage?.user?.name || '',
                contextName: pdu.contextName || '',
                pduType,
                pduTypeName: this.getQueryPduTypeName(pduType),
                operation: this.getQueryOperationName(pduType),
                requestId: pdu.id || 0,
                nonRepeaters: pduType === SnmpConst.SNMP_PDU_TYPE.GET_BULK_REQUEST ? pdu.nonRepeaters : undefined,
                maxRepetitions: pduType === SnmpConst.SNMP_PDU_TYPE.GET_BULK_REQUEST ? pdu.maxRepetitions : undefined,
                varbindCount: varbinds.length,
                varbinds,
                status: 'received'
            };

            logger.info(
                `收到SNMP查询: ${queryData.operation} 来自 ${queryData.sourceIp}:${queryData.sourcePort}`
            );
            this.recordQuery(queryData);
            this.enqueueQueryUpdateEvent(queryData);
        } catch (error) {
            logger.error('记录SNMP查询失败:', error);
        }
    }

    getVersionFromMessage(message = {}) {
        const versionMap = {
            [snmp.Version1]: 'v1',
            [snmp.Version2c]: 'v2c',
            [snmp.Version3]: 'v3'
        };
        return versionMap[message.version] || `unknown(${message.version})`;
    }

    getQueryPduTypeName(pduType) {
        return QUERY_PDU_TYPE_NAMES[pduType] || snmp.PduType[pduType] || `Unknown(${pduType})`;
    }

    getQueryOperationName(pduType) {
        return QUERY_OPERATION_NAMES[pduType] || 'UNKNOWN';
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

    enrichQueryData(queryData) {
        return {
            ...queryData,
            varbinds: (queryData.varbinds || []).map((varbind, index) =>
                this.mibRegistry.enrichVarbind({
                    ...varbind,
                    index: varbind.index || index + 1
                })
            )
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

    recordQuery(queryData) {
        this.queryHistory.unshift(queryData);
        if (this.queryHistory.length > this.maxQueryHistory) {
            this.queryHistory.length = this.maxQueryHistory;
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

    filterQueryHistory(query = {}) {
        const filters = query.filters || {};
        let list = this.queryHistory;

        if (filters.operation) {
            list = list.filter(item => item.operation === filters.operation);
        }

        if (filters.sourceIp) {
            list = list.filter(item => item.sourceIp?.includes(filters.sourceIp));
        }

        if (filters.community) {
            list = list.filter(item => item.community?.includes(filters.community));
        }

        if (filters.timeRange?.start && filters.timeRange?.end) {
            const startTime = Date.parse(filters.timeRange.start);
            const endTime = Date.parse(filters.timeRange.end);
            if (!Number.isNaN(startTime) && !Number.isNaN(endTime)) {
                list = list.filter(item => {
                    const queryTime = Date.parse(item.timestamp);
                    return !Number.isNaN(queryTime) && queryTime >= startTime && queryTime <= endTime;
                });
            }
        }

        return list;
    }

    getQueryStats() {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const recentStart = now.getTime() - 60 * 60 * 1000;
        const sourceIps = new Set();
        let todayQueries = 0;
        let recentQueries = 0;

        this.queryHistory.forEach(query => {
            if (query.sourceIp) {
                sourceIps.add(query.sourceIp);
            }

            const queryTime = Date.parse(query.timestamp);
            if (Number.isNaN(queryTime)) {
                return;
            }
            if (queryTime >= todayStart) {
                todayQueries++;
            }
            if (queryTime >= recentStart) {
                recentQueries++;
            }
        });

        return {
            totalQueries: this.queryCounter,
            historyCount: this.queryHistory.length,
            todayQueries,
            recentQueries,
            sourceCount: sourceIps.size
        };
    }

    getQueryList(messageId, query = {}) {
        const pageSize = Math.max(1, Number(query.pageSize) || 20);
        const totalList = this.filterQueryHistory(query);
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
                ...this.getQueryStats(),
                maxQueryHistory: this.maxQueryHistory,
                mib: this.mibRegistry.getSummary()
            },
            '获取查询列表成功'
        );
    }

    clearTrapHistory(messageId) {
        this.trapHistory = [];
        this.trapCounter = 0;
        this.clearTrapUpdateAggregation();
        this.messageHandler.sendSuccessResponse(messageId, null, 'Trap历史已清空');
    }

    clearQueryHistory(messageId) {
        this.queryHistory = [];
        this.queryCounter = 0;
        this.clearQueryUpdateAggregation();
        this.messageHandler.sendSuccessResponse(messageId, null, '查询历史已清空');
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
            this.queryHistory = this.queryHistory.map(query => this.enrichQueryData(query));
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
            this.flushQueryUpdateEvents();
            await this.closeReceiver();
            await this.closeQueryAgent();

            this.snmpConfig = null;
            this.sessionMap.clear();
            this.agentMap.clear();
            this.trapHistory = [];
            this.queryHistory = [];
            this.trapCounter = 0;
            this.queryCounter = 0;
            this.clearTrapUpdateAggregation();
            this.clearQueryUpdateAggregation();

            logger.info('SNMP服务器停止成功');
            this.messageHandler.sendSuccessResponse(messageId, null, 'SNMP协议停止成功');

            this.messageHandler.sendEvent(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, {
                type: SnmpConst.SNMP_SUB_EVT_TYPES.SERVER_STATUS,
                data: {
                    status: 'stopped'
                }
            });
        } catch (error) {
            logger.error('停止SNMP服务器失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'SNMP协议停止失败: ' + error.message);
        }
    }

    closeQueryAgent() {
        if (!this.agent) {
            return Promise.resolve();
        }

        return new Promise(resolve => {
            const agent = this.agent;
            const sockets = Object.values(agent.listener?.sockets || {});
            const socketCount = sockets.length;
            let closedCount = 0;
            let resolved = false;

            const finish = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                this.agent = null;
                this.agentStartTime = null;
                resolve();
            };

            if (socketCount === 0) {
                finish();
                return;
            }

            const timer = setTimeout(finish, 500);
            agent.close(() => {
                closedCount++;
                if (closedCount >= socketCount) {
                    clearTimeout(timer);
                    finish();
                }
            });
        });
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
