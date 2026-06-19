const dgram = require('dgram');
const crypto = require('crypto');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const RadiusConst = require('../../const/radiusConst');
const Radius = require('../../utils/radiusUtils');

const {
    RADIUS_EVT_TYPES,
    RADIUS_SUB_EVT_TYPES,
    RADIUS_REQ_TYPES,
    RADIUS_CODES,
    RADIUS_ATTRIBUTES,
    RADIUS_SERVICE_TYPES,
    RADIUS_AUTH_METHODS,
    RADIUS_REQUEST_STATUS,
    RADIUS_ACCT_STATUS_TYPES,
    RADIUS_ERROR_CAUSES,
    DEFAULT_RADIUS_CONFIG
} = RadiusConst;

const IDENTIFICATION_ATTRIBUTES = new Set([
    RADIUS_ATTRIBUTES.USER_NAME,
    RADIUS_ATTRIBUTES.NAS_IP_ADDRESS,
    RADIUS_ATTRIBUTES.NAS_IDENTIFIER,
    RADIUS_ATTRIBUTES.NAS_PORT,
    RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS,
    RADIUS_ATTRIBUTES.CALLED_STATION_ID,
    RADIUS_ATTRIBUTES.CALLING_STATION_ID,
    RADIUS_ATTRIBUTES.ACCT_SESSION_ID,
    RADIUS_ATTRIBUTES.ACCT_MULTI_SESSION_ID,
    RADIUS_ATTRIBUTES.NAS_PORT_ID,
    RADIUS_ATTRIBUTES.CHARGEABLE_USER_IDENTITY,
    RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS,
    RADIUS_ATTRIBUTES.FRAMED_INTERFACE_ID,
    RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX,
    RADIUS_ATTRIBUTES.VENDOR_SPECIFIC
]);

const COA_AUTHORIZATION_ATTRIBUTES = new Set([
    RADIUS_ATTRIBUTES.SERVICE_TYPE,
    RADIUS_ATTRIBUTES.FILTER_ID,
    RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS,
    RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX,
    RADIUS_ATTRIBUTES.FRAMED_IP_NETMASK,
    RADIUS_ATTRIBUTES.SESSION_TIMEOUT,
    RADIUS_ATTRIBUTES.IDLE_TIMEOUT,
    RADIUS_ATTRIBUTES.CLASS
]);

const META_ATTRIBUTES = new Set([RADIUS_ATTRIBUTES.PROXY_STATE, RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR]);

function formatTime(ms = Date.now()) {
    return new Date(ms).toISOString();
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
    return String(value ?? '').trim();
}

function statusText(statusType) {
    const names = {
        [RADIUS_ACCT_STATUS_TYPES.START]: 'Start',
        [RADIUS_ACCT_STATUS_TYPES.STOP]: 'Stop',
        [RADIUS_ACCT_STATUS_TYPES.INTERIM_UPDATE]: 'Interim-Update',
        [RADIUS_ACCT_STATUS_TYPES.ACCOUNTING_ON]: 'Accounting-On',
        [RADIUS_ACCT_STATUS_TYPES.ACCOUNTING_OFF]: 'Accounting-Off'
    };
    return names[statusType] || `Acct-Status-${statusType}`;
}

function buildStartErrorMessage(error, port) {
    let hint = '';
    if (error.code === 'EACCES' || error.code === 'EPERM') {
        hint = `（绑定 UDP ${port} 端口需要管理员/root 权限）`;
    } else if (error.code === 'EADDRINUSE') {
        hint = `（UDP ${port} 端口已被占用，可修改监听端口后重试）`;
    }
    return 'RADIUS服务器启动失败: ' + error.message + hint;
}

class RadiusWorker {
    constructor() {
        this.authServer = null;
        this.authServer6 = null;
        this.accountingServer = null;
        this.accountingServer6 = null;
        this.coaServer = null;
        this.coaServer6 = null;
        this.config = null;
        this.users = new Map();
        this.clients = [];
        this.requestHistory = [];
        this.activeSessions = new Map();
        this.pendingChallenges = new Map();
        this.responseCache = new Map();
        this.requestCounter = 0;
        this.historyLimit = DEFAULT_RADIUS_CONFIG.maxHistory;

        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.messageHandler.registerHandler(RADIUS_REQ_TYPES.START_RADIUS, this.startRadius.bind(this));
        this.messageHandler.registerHandler(RADIUS_REQ_TYPES.STOP_RADIUS, this.stopRadius.bind(this));
        this.messageHandler.registerHandler(RADIUS_REQ_TYPES.GET_REQUEST_LIST, this.getRequestList.bind(this));
        this.messageHandler.registerHandler(RADIUS_REQ_TYPES.CLEAR_REQUEST_HISTORY, this.clearRequestHistory.bind(this));
        this.messageHandler.registerHandler(RADIUS_REQ_TYPES.GET_SESSION_LIST, this.getSessionList.bind(this));
    }

    normalizeConfig(config = {}) {
        const merged = {
            ...DEFAULT_RADIUS_CONFIG,
            ...config
        };
        merged.authPort = Number(merged.authPort);
        merged.accountingPort = Number(merged.accountingPort);
        merged.coaPort = Number(merged.coaPort);
        merged.maxHistory = Number(merged.maxHistory || DEFAULT_RADIUS_CONFIG.maxHistory);
        merged.duplicateCacheTtlMs = Number(merged.duplicateCacheTtlMs || DEFAULT_RADIUS_CONFIG.duplicateCacheTtlMs);
        merged.bindAddress = normalizeText(merged.bindAddress || DEFAULT_RADIUS_CONFIG.bindAddress);
        merged.bindAddress6 = normalizeText(merged.bindAddress6 || DEFAULT_RADIUS_CONFIG.bindAddress6);
        merged.enableIpv6 = merged.enableIpv6 !== false;
        merged.sharedSecret = String(merged.sharedSecret || DEFAULT_RADIUS_CONFIG.sharedSecret);
        merged.clients = asArray(merged.clients)
            .map(client => ({
                name: normalizeText(client.name) || normalizeText(client.ipAddress) || 'client',
                ipAddress: Radius.normalizeAddress(normalizeText(client.ipAddress)),
                secret: String(client.secret || merged.sharedSecret),
                enabled: client.enabled !== false
            }))
            .filter(client => client.enabled && client.ipAddress);
        merged.users = asArray(merged.users)
            .map(user => ({
                ...user,
                username: normalizeText(user.username),
                password: String(user.password ?? ''),
                authType: normalizeText(user.authType || RADIUS_AUTH_METHODS.PAP).toUpperCase(),
                enabled: user.enabled !== false
            }))
            .filter(user => user.username);
        if (merged.users.length === 0) {
            merged.users = DEFAULT_RADIUS_CONFIG.users;
        }
        return merged;
    }

    validateConfig(config) {
        const allowZeroPort = process.env.NODE_ENV === 'test';
        const validatePort = (value, label) => {
            const min = allowZeroPort ? 0 : 1;
            if (!Number.isInteger(value) || value < min || value > 65535) {
                throw new Error(`${label}范围应为 ${min}-65535`);
            }
        };

        if (!config.enableAuth && !config.enableAccounting && !config.enableDynamicAuth) {
            throw new Error('至少需要启用一种 RADIUS 服务');
        }
        if (!config.sharedSecret) {
            throw new Error('共享密钥不能为空');
        }
        if (config.enableAuth) validatePort(config.authPort, '认证端口');
        if (config.enableAccounting) validatePort(config.accountingPort, '计费端口');
        if (config.enableDynamicAuth) validatePort(config.coaPort, '动态授权端口');

        const enabledPorts = [
            config.enableAuth ? config.authPort : null,
            config.enableAccounting ? config.accountingPort : null,
            config.enableDynamicAuth ? config.coaPort : null
        ].filter(port => port !== null && port !== 0);
        if (new Set(enabledPorts).size !== enabledPorts.length) {
            throw new Error('认证、计费和动态授权端口不能重复');
        }

        config.users.forEach(user => {
            if (!user.password) {
                throw new Error(`用户 ${user.username} 的密码不能为空`);
            }
        });
    }

    async startRadius(messageId, config) {
        try {
            const mergedConfig = this.normalizeConfig(config);
            this.validateConfig(mergedConfig);
            this.config = mergedConfig;
            this.historyLimit = mergedConfig.maxHistory;
            this.requestHistory = [];
            this.activeSessions.clear();
            this.pendingChallenges.clear();
            this.responseCache.clear();
            this.requestCounter = 0;
            this.users = new Map(mergedConfig.users.map(user => [user.username, user]));
            this.clients = mergedConfig.clients;

            if (this.config.logLevel) {
                logger.setLevel(this.config.logLevel);
                logger.info(`Worker log level set to: ${this.config.logLevel}`);
            }

            if (mergedConfig.enableAuth) {
                this.authServer = await this.startUdpServer(
                    mergedConfig.authPort,
                    'auth',
                    'udp4',
                    mergedConfig.bindAddress,
                    this.handleAuthMessage.bind(this)
                );
                if (mergedConfig.enableIpv6) {
                    this.authServer6 = await this.tryStartUdp6Server(
                        mergedConfig.authPort,
                        'auth',
                        this.handleAuthMessage.bind(this)
                    );
                }
            }
            if (mergedConfig.enableAccounting) {
                this.accountingServer = await this.startUdpServer(
                    mergedConfig.accountingPort,
                    'accounting',
                    'udp4',
                    mergedConfig.bindAddress,
                    this.handleAccountingMessage.bind(this)
                );
                if (mergedConfig.enableIpv6) {
                    this.accountingServer6 = await this.tryStartUdp6Server(
                        mergedConfig.accountingPort,
                        'accounting',
                        this.handleAccountingMessage.bind(this)
                    );
                }
            }
            if (mergedConfig.enableDynamicAuth) {
                this.coaServer = await this.startUdpServer(
                    mergedConfig.coaPort,
                    'coa',
                    'udp4',
                    mergedConfig.bindAddress,
                    this.handleCoaMessage.bind(this)
                );
                if (mergedConfig.enableIpv6) {
                    this.coaServer6 = await this.tryStartUdp6Server(
                        mergedConfig.coaPort,
                        'coa',
                        this.handleCoaMessage.bind(this)
                    );
                }
            }

            const data = this.getStatusData('running');
            this.messageHandler.sendSuccessResponse(messageId, data, 'RADIUS服务器启动成功');
            this.sendStatusEvent(data);
        } catch (error) {
            await this.closeSockets();
            logger.error('启动RADIUS服务器失败:', error);
            const port = config?.authPort ?? DEFAULT_RADIUS_CONFIG.authPort;
            this.messageHandler.sendErrorResponse(messageId, buildStartErrorMessage(error, port));
        }
    }

    startUdpServer(port, service, socketType, bindAddress, handler) {
        return new Promise((resolve, reject) => {
            const server = dgram.createSocket(
                socketType === 'udp6'
                    ? { type: 'udp6', reuseAddr: true, ipv6Only: true }
                    : { type: 'udp4', reuseAddr: true }
            );
            let listening = false;

            server.on('message', (msg, rinfo) => handler(server, msg, rinfo));
            server.once('error', err => {
                if (!listening) {
                    reject(err);
                    return;
                }
                logger.error(`RADIUS ${service} UDP服务器错误:`, err);
            });
            server.once('listening', () => {
                listening = true;
                const address = server.address();
                logger.info(`RADIUS ${service} ${socketType}服务器监听: ${address.address}:${address.port}`);
                resolve(server);
            });
            server.bind(port, bindAddress);
        });
    }

    async tryStartUdp6Server(port, service, handler) {
        try {
            return await this.startUdpServer(port, service, 'udp6', this.config.bindAddress6, handler);
        } catch (error) {
            logger.warn(`RADIUS ${service} IPv6监听失败，已继续仅使用IPv4: ${error.message}`);
            return null;
        }
    }

    getStatusData(status) {
        const addressOf = server => (server ? server.address().port : null);
        return {
            status,
            authPort: addressOf(this.authServer) ?? this.config?.authPort ?? DEFAULT_RADIUS_CONFIG.authPort,
            authPort6: addressOf(this.authServer6),
            accountingPort:
                addressOf(this.accountingServer) ?? this.config?.accountingPort ?? DEFAULT_RADIUS_CONFIG.accountingPort,
            accountingPort6: addressOf(this.accountingServer6),
            coaPort: addressOf(this.coaServer) ?? this.config?.coaPort ?? DEFAULT_RADIUS_CONFIG.coaPort,
            coaPort6: addressOf(this.coaServer6),
            enableAuth: Boolean(this.authServer || this.authServer6),
            enableAccounting: Boolean(this.accountingServer || this.accountingServer6),
            enableDynamicAuth: Boolean(this.coaServer || this.coaServer6),
            enableIpv6: Boolean(this.authServer6 || this.accountingServer6 || this.coaServer6),
            requestCount: this.requestHistory.length,
            sessionCount: this.activeSessions.size
        };
    }

    selectClient(rinfo) {
        const address = Radius.normalizeAddress(rinfo.address);
        const client = this.clients.find(item => item.ipAddress === address || item.ipAddress === '*');
        if (client) {
            return client;
        }
        if (this.config.rejectUnknownClients && this.clients.length > 0) {
            return null;
        }
        return {
            name: address,
            ipAddress: address,
            secret: this.config.sharedSecret
        };
    }

    parseIncoming(service, msg, rinfo) {
        const client = this.selectClient(rinfo);
        if (!client) {
            return {
                client: null,
                packet: null,
                error: `未知RADIUS客户端 ${Radius.normalizeAddress(rinfo.address)}`,
                silent: true
            };
        }

        try {
            return {
                client,
                packet: Radius.parsePacket(msg),
                error: null,
                silent: false
            };
        } catch (error) {
            this.recordRequest({
                service,
                timestamp: formatTime(),
                clientAddress: Radius.normalizeAddress(rinfo.address),
                clientPort: rinfo.port,
                code: '-',
                codeName: '-',
                identifier: '-',
                userName: '-',
                authMethod: '-',
                status: RADIUS_REQUEST_STATUS.ERROR,
                message: error.message,
                packetLength: msg.length
            });
            return {
                client,
                packet: null,
                error: error.message,
                silent: true
            };
        }
    }

    getCacheKey(service, packet, rinfo) {
        return `${service}|${Radius.normalizeAddress(rinfo.address)}|${rinfo.port}|${packet.identifier}`;
    }

    getRequestHash(packet) {
        return crypto.createHash('sha256').update(packet.raw).digest('hex');
    }

    sendCachedResponseIfDuplicate(socket, service, packet, rinfo) {
        this.cleanupResponseCache();
        const cacheKey = this.getCacheKey(service, packet, rinfo);
        const hash = this.getRequestHash(packet);
        const cached = this.responseCache.get(cacheKey);
        if (!cached || cached.hash !== hash) {
            return false;
        }
        socket.send(cached.response, rinfo.port, rinfo.address);
        this.recordRequest({
            service,
            timestamp: formatTime(),
            clientAddress: Radius.normalizeAddress(rinfo.address),
            clientPort: rinfo.port,
            code: packet.code,
            codeName: packet.codeName,
            identifier: packet.identifier,
            userName: Radius.getString(packet, RADIUS_ATTRIBUTES.USER_NAME) || '-',
            authMethod: '-',
            status: RADIUS_REQUEST_STATUS.IGNORED,
            message: '重复请求，已重放缓存响应',
            packetLength: packet.length
        });
        return true;
    }

    cacheResponse(service, packet, rinfo, response) {
        const cacheKey = this.getCacheKey(service, packet, rinfo);
        this.responseCache.set(cacheKey, {
            hash: this.getRequestHash(packet),
            response,
            expiresAt: Date.now() + this.config.duplicateCacheTtlMs
        });
    }

    cleanupResponseCache() {
        const now = Date.now();
        for (const [key, value] of this.responseCache.entries()) {
            if (value.expiresAt <= now) {
                this.responseCache.delete(key);
            }
        }
        for (const [key, value] of this.pendingChallenges.entries()) {
            if (value.expiresAt <= now) {
                this.pendingChallenges.delete(key);
            }
        }
    }

    handleAuthMessage(socket, msg, rinfo) {
        const { client, packet, error, silent } = this.parseIncoming('auth', msg, rinfo);
        if (!packet) {
            if (error && client === null) {
                logger.warn(error);
            }
            return;
        }
        if (packet.code !== RADIUS_CODES.ACCESS_REQUEST) {
            this.recordIgnored('auth', packet, rinfo, `认证端口忽略 ${packet.codeName}`);
            return;
        }
        if (this.sendCachedResponseIfDuplicate(socket, 'auth', packet, rinfo)) {
            return;
        }
        if (silent) {
            return;
        }

        const secret = client.secret;
        const hasMessageAuthenticator = Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR);

        if (hasMessageAuthenticator && !Radius.verifyAccessMessageAuthenticator(packet, secret)) {
            this.recordIgnored('auth', packet, rinfo, 'Message-Authenticator 校验失败');
            return;
        }
        if (this.config.requireMessageAuthenticator && !hasMessageAuthenticator) {
            this.recordIgnored('auth', packet, rinfo, '缺少 Message-Authenticator');
            return;
        }

        const userName = Radius.getString(packet, RADIUS_ATTRIBUTES.USER_NAME);
        const user = this.users.get(userName);
        const authMethod = this.detectAuthMethod(packet);
        let responseCode = RADIUS_CODES.ACCESS_REJECT;
        let responseAttrs = [];
        let status = RADIUS_REQUEST_STATUS.REJECTED;
        let message = '';

        try {
            const validationError = this.validateAccessRequest(packet);
            if (validationError) {
                message = validationError;
                responseAttrs = this.buildRejectAttributes(packet, message);
            } else if (!user || !user.enabled) {
                message = `用户 ${userName || '-'} 不存在或已禁用`;
                responseAttrs = this.buildRejectAttributes(packet, 'Access rejected');
            } else if (this.isAuthorizeOnly(packet)) {
                responseCode = RADIUS_CODES.ACCESS_ACCEPT;
                status = RADIUS_REQUEST_STATUS.ACCEPTED;
                message = 'Authorize-Only 请求已接受';
                responseAttrs = this.buildAcceptAttributes(packet, user);
            } else if (user.authType === RADIUS_AUTH_METHODS.CHALLENGE) {
                const challengeResult = this.handleChallengeAuth(packet, user, secret);
                responseCode = challengeResult.code;
                responseAttrs = challengeResult.attributes;
                status = challengeResult.status;
                message = challengeResult.message;
            } else if (this.verifyUserAuth(packet, user, authMethod, secret)) {
                responseCode = RADIUS_CODES.ACCESS_ACCEPT;
                status = RADIUS_REQUEST_STATUS.ACCEPTED;
                message = 'Access accepted';
                responseAttrs = this.buildAcceptAttributes(packet, user);
            } else {
                message = '用户认证失败';
                responseAttrs = this.buildRejectAttributes(packet, 'Access rejected');
            }
        } catch (err) {
            logger.error('处理RADIUS认证请求失败:', err);
            message = `处理失败: ${err.message}`;
            responseAttrs = this.buildRejectAttributes(packet, 'Access rejected');
        }

        const response = Radius.buildResponsePacket(
            responseCode,
            packet.identifier,
            packet.authenticator,
            responseAttrs,
            secret,
            {
                includeMessageAuthenticator: hasMessageAuthenticator
            }
        );
        socket.send(response, rinfo.port, rinfo.address);
        this.cacheResponse('auth', packet, rinfo, response);

        this.recordRequest({
            service: 'auth',
            timestamp: formatTime(),
            clientAddress: Radius.normalizeAddress(rinfo.address),
            clientPort: rinfo.port,
            code: packet.code,
            codeName: packet.codeName,
            responseCode,
            responseCodeName: Radius.codeName(responseCode),
            identifier: packet.identifier,
            userName: userName || '-',
            authMethod,
            status,
            message,
            packetLength: packet.length,
            attributes: Radius.summarizeAttributes(packet)
        });
    }

    detectAuthMethod(packet) {
        if (Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.CHAP_PASSWORD)) {
            return RADIUS_AUTH_METHODS.CHAP;
        }
        if (Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.USER_PASSWORD)) {
            return RADIUS_AUTH_METHODS.PAP;
        }
        if (Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.STATE)) {
            return RADIUS_AUTH_METHODS.CHALLENGE;
        }
        return RADIUS_AUTH_METHODS.UNKNOWN;
    }

    validateAccessRequest(packet) {
        const hasUserPassword = Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.USER_PASSWORD);
        const hasChapPassword = Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.CHAP_PASSWORD);
        const hasState = Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.STATE);

        if (hasUserPassword && hasChapPassword) {
            return 'Access-Request 不能同时包含 User-Password 和 CHAP-Password';
        }
        if (!hasUserPassword && !hasChapPassword && !hasState) {
            return 'Access-Request 缺少 User-Password、CHAP-Password 或 State';
        }
        if (Radius.getAttributes(packet, RADIUS_ATTRIBUTES.STATE).length > 1) {
            return 'Access-Request 不能包含多个 State 属性';
        }
        if (
            !Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.NAS_IP_ADDRESS) &&
            !Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS) &&
            !Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.NAS_IDENTIFIER)
        ) {
            return 'Access-Request 缺少 NAS-IP-Address、NAS-IPv6-Address 或 NAS-Identifier';
        }
        return '';
    }

    verifyUserAuth(packet, user, authMethod, secret) {
        if (user.authType === RADIUS_AUTH_METHODS.PAP && authMethod !== RADIUS_AUTH_METHODS.PAP) {
            return false;
        }
        if (user.authType === RADIUS_AUTH_METHODS.CHAP && authMethod !== RADIUS_AUTH_METHODS.CHAP) {
            return false;
        }
        if (authMethod === RADIUS_AUTH_METHODS.PAP) {
            const passwordAttr = Radius.getFirstAttribute(packet, RADIUS_ATTRIBUTES.USER_PASSWORD);
            const password = Radius.decryptUserPassword(passwordAttr.value, secret, packet.authenticator);
            return password === user.password;
        }
        if (authMethod === RADIUS_AUTH_METHODS.CHAP) {
            return Radius.verifyChapPassword(packet, user.password);
        }
        return false;
    }

    handleChallengeAuth(packet, user, secret) {
        const stateAttr = Radius.getFirstAttribute(packet, RADIUS_ATTRIBUTES.STATE);
        if (!stateAttr) {
            const state = crypto.randomBytes(16);
            this.pendingChallenges.set(state.toString('hex'), {
                username: user.username,
                response: String(user.challengeResponse || user.password),
                expiresAt: Date.now() + 5 * 60 * 1000
            });
            return {
                code: RADIUS_CODES.ACCESS_CHALLENGE,
                status: RADIUS_REQUEST_STATUS.CHALLENGED,
                message: 'Access-Challenge 已发送',
                attributes: [
                    Radius.stringAttr(
                        RADIUS_ATTRIBUTES.REPLY_MESSAGE,
                        user.challengePrompt || 'Enter challenge response'
                    ),
                    Radius.attr(RADIUS_ATTRIBUTES.STATE, state),
                    ...Radius.getProxyStateAttributes(packet)
                ]
            };
        }

        const pending = this.pendingChallenges.get(stateAttr.value.toString('hex'));
        if (!pending || pending.username !== user.username) {
            return {
                code: RADIUS_CODES.ACCESS_REJECT,
                status: RADIUS_REQUEST_STATUS.REJECTED,
                message: 'State 不存在或已过期',
                attributes: this.buildRejectAttributes(packet, 'Access rejected')
            };
        }
        this.pendingChallenges.delete(stateAttr.value.toString('hex'));

        const passwordAttr = Radius.getFirstAttribute(packet, RADIUS_ATTRIBUTES.USER_PASSWORD);
        if (!passwordAttr) {
            return {
                code: RADIUS_CODES.ACCESS_REJECT,
                status: RADIUS_REQUEST_STATUS.REJECTED,
                message: 'Challenge 响应缺少 User-Password',
                attributes: this.buildRejectAttributes(packet, 'Access rejected')
            };
        }
        const response = Radius.decryptUserPassword(passwordAttr.value, secret, packet.authenticator);
        if (response !== pending.response) {
            return {
                code: RADIUS_CODES.ACCESS_REJECT,
                status: RADIUS_REQUEST_STATUS.REJECTED,
                message: 'Challenge 响应错误',
                attributes: this.buildRejectAttributes(packet, 'Access rejected')
            };
        }
        return {
            code: RADIUS_CODES.ACCESS_ACCEPT,
            status: RADIUS_REQUEST_STATUS.ACCEPTED,
            message: 'Challenge 认证通过',
            attributes: this.buildAcceptAttributes(packet, user)
        };
    }

    isAuthorizeOnly(packet) {
        return Radius.getInteger(packet, RADIUS_ATTRIBUTES.SERVICE_TYPE) === RADIUS_SERVICE_TYPES.AUTHORIZE_ONLY;
    }

    buildRejectAttributes(packet, message) {
        const attrs = [];
        if (message) {
            attrs.push(Radius.stringAttr(RADIUS_ATTRIBUTES.REPLY_MESSAGE, message));
        }
        return attrs.concat(Radius.getProxyStateAttributes(packet));
    }

    buildAcceptAttributes(packet, user) {
        const attrs = [];
        if (user.replyMessage) {
            attrs.push(Radius.stringAttr(RADIUS_ATTRIBUTES.REPLY_MESSAGE, user.replyMessage));
        }
        if (user.serviceType) {
            attrs.push(Radius.integerAttr(RADIUS_ATTRIBUTES.SERVICE_TYPE, user.serviceType));
        }
        if (user.framedProtocol) {
            attrs.push(Radius.integerAttr(RADIUS_ATTRIBUTES.FRAMED_PROTOCOL, user.framedProtocol));
        }
        if (user.framedIpAddress) {
            attrs.push(Radius.ipAttr(RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS, user.framedIpAddress));
        }
        if (user.framedIpv6Prefix) {
            attrs.push(Radius.ipv6PrefixAttr(RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX, user.framedIpv6Prefix));
        }
        if (user.framedIpNetmask) {
            attrs.push(Radius.ipAttr(RADIUS_ATTRIBUTES.FRAMED_IP_NETMASK, user.framedIpNetmask));
        }
        if (user.sessionTimeout) {
            attrs.push(Radius.integerAttr(RADIUS_ATTRIBUTES.SESSION_TIMEOUT, user.sessionTimeout));
        }
        if (user.idleTimeout) {
            attrs.push(Radius.integerAttr(RADIUS_ATTRIBUTES.IDLE_TIMEOUT, user.idleTimeout));
        }
        if (user.classAttribute) {
            attrs.push(Radius.stringAttr(RADIUS_ATTRIBUTES.CLASS, user.classAttribute));
        }
        asArray(user.filterIds).forEach(filterId => attrs.push(Radius.stringAttr(RADIUS_ATTRIBUTES.FILTER_ID, filterId)));
        asArray(user.vendorAttributes).forEach(vsa => {
            attrs.push(Radius.vendorSpecificAttr(vsa.vendorId, vsa.vendorType || vsa.type, vsa.value || ''));
        });
        return attrs.concat(Radius.getProxyStateAttributes(packet));
    }

    handleAccountingMessage(socket, msg, rinfo) {
        const { client, packet } = this.parseIncoming('accounting', msg, rinfo);
        if (!packet) return;
        if (packet.code !== RADIUS_CODES.ACCOUNTING_REQUEST) {
            this.recordIgnored('accounting', packet, rinfo, `计费端口忽略 ${packet.codeName}`);
            return;
        }
        if (this.sendCachedResponseIfDuplicate(socket, 'accounting', packet, rinfo)) {
            return;
        }
        if (!Radius.verifyAccountingLikeRequest(packet, client.secret)) {
            this.recordIgnored('accounting', packet, rinfo, 'Accounting-Request Authenticator 校验失败');
            return;
        }

        const statusTypeValue = Radius.getInteger(packet, RADIUS_ATTRIBUTES.ACCT_STATUS_TYPE);
        const session = this.updateSessionFromAccounting(packet, rinfo, statusTypeValue);
        const responseAttrs = Radius.getProxyStateAttributes(packet);
        const response = Radius.buildResponsePacket(
            RADIUS_CODES.ACCOUNTING_RESPONSE,
            packet.identifier,
            packet.authenticator,
            responseAttrs,
            client.secret
        );
        socket.send(response, rinfo.port, rinfo.address);
        this.cacheResponse('accounting', packet, rinfo, response);

        this.recordRequest({
            service: 'accounting',
            timestamp: formatTime(),
            clientAddress: Radius.normalizeAddress(rinfo.address),
            clientPort: rinfo.port,
            code: packet.code,
            codeName: packet.codeName,
            responseCode: RADIUS_CODES.ACCOUNTING_RESPONSE,
            responseCodeName: Radius.codeName(RADIUS_CODES.ACCOUNTING_RESPONSE),
            identifier: packet.identifier,
            userName: Radius.getString(packet, RADIUS_ATTRIBUTES.USER_NAME) || '-',
            authMethod: '-',
            status: RADIUS_REQUEST_STATUS.ACCOUNTED,
            message: statusText(statusTypeValue),
            packetLength: packet.length,
            sessionKey: session?.key || '-',
            attributes: Radius.summarizeAttributes(packet)
        });
    }

    getNasAddress(packet, rinfo) {
        return (
            Radius.getIp(packet, RADIUS_ATTRIBUTES.NAS_IP_ADDRESS) ||
            Radius.getIpv6(packet, RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS) ||
            Radius.normalizeAddress(rinfo.address)
        );
    }

    updateSessionFromAccounting(packet, rinfo, statusType) {
        const sessionKey = this.getSessionKey(packet, rinfo);
        const now = formatTime();
        const nasIpAddress = Radius.getIp(packet, RADIUS_ATTRIBUTES.NAS_IP_ADDRESS);
        const nasIpv6Address = Radius.getIpv6(packet, RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS);
        const framedIpAddress = Radius.getIp(packet, RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS);
        const framedIpv6Prefix = Radius.getIpv6Prefix(packet, RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX);
        const base = {
            key: sessionKey,
            userName: Radius.getString(packet, RADIUS_ATTRIBUTES.USER_NAME) || '-',
            acctSessionId: Radius.getString(packet, RADIUS_ATTRIBUTES.ACCT_SESSION_ID) || '',
            acctMultiSessionId: Radius.getString(packet, RADIUS_ATTRIBUTES.ACCT_MULTI_SESSION_ID) || '',
            nasAddress: nasIpAddress || nasIpv6Address || Radius.normalizeAddress(rinfo.address),
            nasIpAddress,
            nasIpv6Address,
            nasIdentifier: Radius.getString(packet, RADIUS_ATTRIBUTES.NAS_IDENTIFIER) || '',
            nasPort: Radius.getInteger(packet, RADIUS_ATTRIBUTES.NAS_PORT),
            nasPortId: Radius.getString(packet, RADIUS_ATTRIBUTES.NAS_PORT_ID) || '',
            framedIpAddress,
            framedIpv6Prefix,
            callingStationId: Radius.getString(packet, RADIUS_ATTRIBUTES.CALLING_STATION_ID) || '',
            calledStationId: Radius.getString(packet, RADIUS_ATTRIBUTES.CALLED_STATION_ID) || '',
            lastStatusType: statusType,
            lastStatusText: statusText(statusType),
            lastUpdateAt: now,
            attributes: Radius.summarizeAttributes(packet)
        };

        if (statusType === RADIUS_ACCT_STATUS_TYPES.STOP) {
            const existing = this.activeSessions.get(sessionKey);
            this.activeSessions.delete(sessionKey);
            this.sendSessionEvent();
            return existing || base;
        }
        if (statusType === RADIUS_ACCT_STATUS_TYPES.ACCOUNTING_OFF) {
            this.clearSessionsForNas(base);
            this.sendSessionEvent();
            return base;
        }
        if ([RADIUS_ACCT_STATUS_TYPES.START, RADIUS_ACCT_STATUS_TYPES.INTERIM_UPDATE].includes(statusType)) {
            const existing = this.activeSessions.get(sessionKey);
            this.activeSessions.set(sessionKey, {
                ...(existing || {}),
                ...base,
                startedAt: existing?.startedAt || now
            });
            this.sendSessionEvent();
            return this.activeSessions.get(sessionKey);
        }
        return base;
    }

    clearSessionsForNas(base) {
        for (const [key, session] of this.activeSessions.entries()) {
            const nasMatches =
                (base.nasAddress && session.nasAddress === base.nasAddress) ||
                (base.nasIpAddress && session.nasIpAddress === base.nasIpAddress) ||
                (base.nasIpv6Address && session.nasIpv6Address === base.nasIpv6Address) ||
                (base.nasIdentifier && session.nasIdentifier === base.nasIdentifier);
            if (nasMatches) {
                this.activeSessions.delete(key);
            }
        }
    }

    getSessionKey(packet, rinfo) {
        const sessionId = Radius.getString(packet, RADIUS_ATTRIBUTES.ACCT_SESSION_ID);
        if (sessionId) {
            return sessionId;
        }
        return [
            Radius.getString(packet, RADIUS_ATTRIBUTES.USER_NAME) || '-',
            this.getNasAddress(packet, rinfo),
            Radius.getInteger(packet, RADIUS_ATTRIBUTES.NAS_PORT) ?? '-',
            Radius.getString(packet, RADIUS_ATTRIBUTES.CALLING_STATION_ID) || '-'
        ].join('|');
    }

    handleCoaMessage(socket, msg, rinfo) {
        const { client, packet } = this.parseIncoming('dynamic-auth', msg, rinfo);
        if (!packet) return;
        if (![RADIUS_CODES.DISCONNECT_REQUEST, RADIUS_CODES.COA_REQUEST].includes(packet.code)) {
            this.recordIgnored('dynamic-auth', packet, rinfo, `动态授权端口忽略 ${packet.codeName}`);
            return;
        }
        if (this.sendCachedResponseIfDuplicate(socket, 'dynamic-auth', packet, rinfo)) {
            return;
        }
        if (!Radius.verifyAccountingLikeRequest(packet, client.secret)) {
            this.recordIgnored('dynamic-auth', packet, rinfo, 'CoA/Disconnect Request Authenticator 校验失败');
            return;
        }
        if (
            Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR) &&
            !Radius.verifyDynamicRequestMessageAuthenticator(packet, client.secret)
        ) {
            this.recordIgnored('dynamic-auth', packet, rinfo, '动态授权 Message-Authenticator 校验失败');
            return;
        }

        const result =
            packet.code === RADIUS_CODES.DISCONNECT_REQUEST
                ? this.processDisconnect(packet)
                : this.processCoa(packet);
        const responseCode =
            packet.code === RADIUS_CODES.DISCONNECT_REQUEST
                ? result.ok
                    ? RADIUS_CODES.DISCONNECT_ACK
                    : RADIUS_CODES.DISCONNECT_NAK
                : result.ok
                  ? RADIUS_CODES.COA_ACK
                  : RADIUS_CODES.COA_NAK;
        const attrs = [];
        if (!result.ok && result.errorCause) {
            attrs.push(Radius.integerAttr(RADIUS_ATTRIBUTES.ERROR_CAUSE, result.errorCause));
        }
        const responseAttrs = attrs.concat(Radius.getProxyStateAttributes(packet));
        const response = Radius.buildResponsePacket(
            responseCode,
            packet.identifier,
            packet.authenticator,
            responseAttrs,
            client.secret,
            {
                includeMessageAuthenticator: Radius.hasAttribute(packet, RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR)
            }
        );
        socket.send(response, rinfo.port, rinfo.address);
        this.cacheResponse('dynamic-auth', packet, rinfo, response);

        this.recordRequest({
            service: 'dynamic-auth',
            timestamp: formatTime(),
            clientAddress: Radius.normalizeAddress(rinfo.address),
            clientPort: rinfo.port,
            code: packet.code,
            codeName: packet.codeName,
            responseCode,
            responseCodeName: Radius.codeName(responseCode),
            identifier: packet.identifier,
            userName: Radius.getString(packet, RADIUS_ATTRIBUTES.USER_NAME) || '-',
            authMethod: '-',
            status: result.ok ? RADIUS_REQUEST_STATUS.ACK : RADIUS_REQUEST_STATUS.NAK,
            message: result.message,
            packetLength: packet.length,
            attributes: Radius.summarizeAttributes(packet)
        });
    }

    processDisconnect(packet) {
        const unsupported = packet.attributes.find(attr => !IDENTIFICATION_ATTRIBUTES.has(attr.type) && !META_ATTRIBUTES.has(attr.type));
        if (unsupported) {
            return {
                ok: false,
                errorCause: RADIUS_ERROR_CAUSES.UNSUPPORTED_ATTRIBUTE,
                message: `Disconnect-Request 不支持属性 ${Radius.attributeName(unsupported.type)}`
            };
        }
        const matches = this.findMatchingSessions(packet);
        if (matches.error) {
            return matches.error;
        }
        matches.sessions.forEach(session => this.activeSessions.delete(session.key));
        this.sendSessionEvent();
        return {
            ok: true,
            message: `Disconnect 已移除 ${matches.sessions.length} 个会话`
        };
    }

    processCoa(packet) {
        const serviceType = Radius.getInteger(packet, RADIUS_ATTRIBUTES.SERVICE_TYPE);
        if (serviceType === RADIUS_SERVICE_TYPES.AUTHORIZE_ONLY) {
            return {
                ok: false,
                errorCause: RADIUS_ERROR_CAUSES.UNSUPPORTED_SERVICE,
                message: 'Authorize-Only CoA 当前不触发新的 Access-Request'
            };
        }
        const unsupported = packet.attributes.find(
            attr => !IDENTIFICATION_ATTRIBUTES.has(attr.type) && !COA_AUTHORIZATION_ATTRIBUTES.has(attr.type) && !META_ATTRIBUTES.has(attr.type)
        );
        if (unsupported) {
            return {
                ok: false,
                errorCause: RADIUS_ERROR_CAUSES.UNSUPPORTED_ATTRIBUTE,
                message: `CoA-Request 不支持属性 ${Radius.attributeName(unsupported.type)}`
            };
        }
        const matches = this.findMatchingSessions(packet);
        if (matches.error) {
            return matches.error;
        }
        matches.sessions.forEach(session => this.applyCoaAttributes(session, packet));
        this.sendSessionEvent();
        return {
            ok: true,
            message: `CoA 已更新 ${matches.sessions.length} 个会话`
        };
    }

    findMatchingSessions(packet) {
        const identificationFilters = packet.attributes.filter(attr => IDENTIFICATION_ATTRIBUTES.has(attr.type));
        const strictFilters =
            packet.code === RADIUS_CODES.COA_REQUEST
                ? identificationFilters.filter(attr => !COA_AUTHORIZATION_ATTRIBUTES.has(attr.type))
                : identificationFilters;
        const filters = strictFilters.length > 0 ? strictFilters : identificationFilters;
        if (filters.length === 0) {
            return {
                error: {
                    ok: false,
                    errorCause: RADIUS_ERROR_CAUSES.MISSING_ATTRIBUTE,
                    message: '缺少会话标识属性'
                }
            };
        }
        const sessions = Array.from(this.activeSessions.values()).filter(session => this.sessionMatches(session, filters));
        if (sessions.length === 0) {
            return {
                error: {
                    ok: false,
                    errorCause: RADIUS_ERROR_CAUSES.SESSION_CONTEXT_NOT_FOUND,
                    message: '未找到匹配会话'
                }
            };
        }
        return { sessions };
    }

    sessionMatches(session, filters) {
        return filters.every(filter => {
            switch (filter.type) {
                case RADIUS_ATTRIBUTES.USER_NAME:
                    return session.userName === filter.value.toString('utf8');
                case RADIUS_ATTRIBUTES.NAS_IP_ADDRESS:
                    return session.nasIpAddress === Radius.bufferToIp(filter.value) || session.nasAddress === Radius.bufferToIp(filter.value);
                case RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS: {
                    const nasIpv6Address = Radius.bufferToIpv6(filter.value);
                    return session.nasIpv6Address === nasIpv6Address || session.nasAddress === nasIpv6Address;
                }
                case RADIUS_ATTRIBUTES.NAS_IDENTIFIER:
                    return session.nasIdentifier === filter.value.toString('utf8');
                case RADIUS_ATTRIBUTES.NAS_PORT:
                    return session.nasPort === filter.value.readUInt32BE(0);
                case RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS:
                    return session.framedIpAddress === Radius.bufferToIp(filter.value);
                case RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX:
                    return session.framedIpv6Prefix === Radius.getIpv6Prefix({ attributes: [filter] }, filter.type);
                case RADIUS_ATTRIBUTES.CALLING_STATION_ID:
                    return session.callingStationId === filter.value.toString('utf8');
                case RADIUS_ATTRIBUTES.CALLED_STATION_ID:
                    return session.calledStationId === filter.value.toString('utf8');
                case RADIUS_ATTRIBUTES.ACCT_SESSION_ID:
                    return session.acctSessionId === filter.value.toString('utf8');
                case RADIUS_ATTRIBUTES.ACCT_MULTI_SESSION_ID:
                    return session.acctMultiSessionId === filter.value.toString('utf8');
                case RADIUS_ATTRIBUTES.NAS_PORT_ID:
                    return session.nasPortId === filter.value.toString('utf8');
                default:
                    return true;
            }
        });
    }

    applyCoaAttributes(session, packet) {
        const filterIds = Radius.getAttributes(packet, RADIUS_ATTRIBUTES.FILTER_ID).map(item => item.value.toString('utf8'));
        if (filterIds.length > 0) {
            session.filterIds = filterIds;
        }
        const framedIp = Radius.getIp(packet, RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS);
        if (framedIp) {
            session.framedIpAddress = framedIp;
        }
        const framedIpv6Prefix = Radius.getIpv6Prefix(packet, RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX);
        if (framedIpv6Prefix) {
            session.framedIpv6Prefix = framedIpv6Prefix;
        }
        const sessionTimeout = Radius.getInteger(packet, RADIUS_ATTRIBUTES.SESSION_TIMEOUT);
        if (sessionTimeout !== null) {
            session.sessionTimeout = sessionTimeout;
        }
        const idleTimeout = Radius.getInteger(packet, RADIUS_ATTRIBUTES.IDLE_TIMEOUT);
        if (idleTimeout !== null) {
            session.idleTimeout = idleTimeout;
        }
        session.lastCoaAt = formatTime();
    }

    recordIgnored(service, packet, rinfo, message) {
        this.recordRequest({
            service,
            timestamp: formatTime(),
            clientAddress: Radius.normalizeAddress(rinfo.address),
            clientPort: rinfo.port,
            code: packet.code,
            codeName: packet.codeName,
            identifier: packet.identifier,
            userName: Radius.getString(packet, RADIUS_ATTRIBUTES.USER_NAME) || '-',
            authMethod: this.detectAuthMethod(packet),
            status: RADIUS_REQUEST_STATUS.IGNORED,
            message,
            packetLength: packet.length,
            attributes: Radius.summarizeAttributes(packet)
        });
    }

    recordRequest(entry) {
        const record = {
            id: ++this.requestCounter,
            ...entry
        };
        this.requestHistory.unshift(record);
        if (this.requestHistory.length > this.historyLimit) {
            this.requestHistory.length = this.historyLimit;
        }
        this.messageHandler.sendEvent(RADIUS_EVT_TYPES.RADIUS_EVT, {
            type: RADIUS_SUB_EVT_TYPES.REQUEST_RECEIVED,
            data: record,
            stats: {
                requestCount: this.requestHistory.length,
                sessionCount: this.activeSessions.size,
                lastRequestAt: record.timestamp,
                lastClient: `${record.clientAddress}:${record.clientPort}`
            }
        });
    }

    sendStatusEvent(data) {
        this.messageHandler.sendEvent(RADIUS_EVT_TYPES.RADIUS_EVT, {
            type: RADIUS_SUB_EVT_TYPES.SERVER_STATUS,
            data
        });
    }

    sendSessionEvent() {
        this.messageHandler.sendEvent(RADIUS_EVT_TYPES.RADIUS_EVT, {
            type: RADIUS_SUB_EVT_TYPES.SESSION_UPDATED,
            data: {
                sessions: Array.from(this.activeSessions.values()),
                sessionCount: this.activeSessions.size
            }
        });
    }

    getRequestList(messageId) {
        this.messageHandler.sendSuccessResponse(messageId, this.requestHistory, '获取RADIUS请求日志成功');
    }

    clearRequestHistory(messageId) {
        this.requestHistory = [];
        this.messageHandler.sendSuccessResponse(messageId, null, 'RADIUS请求日志已清空');
        this.messageHandler.sendEvent(RADIUS_EVT_TYPES.RADIUS_EVT, {
            type: RADIUS_SUB_EVT_TYPES.HISTORY_CLEARED,
            data: null,
            stats: {
                requestCount: 0,
                sessionCount: this.activeSessions.size,
                lastRequestAt: '-',
                lastClient: '-'
            }
        });
    }

    getSessionList(messageId) {
        this.messageHandler.sendSuccessResponse(
            messageId,
            Array.from(this.activeSessions.values()),
            '获取RADIUS会话列表成功'
        );
    }

    async stopRadius(messageId) {
        await this.closeSockets();
        this.requestHistory = [];
        this.activeSessions.clear();
        this.pendingChallenges.clear();
        this.responseCache.clear();
        const data = this.getStatusData('stopped');
        this.messageHandler.sendSuccessResponse(messageId, null, 'RADIUS服务器已停止');
        this.sendStatusEvent(data);
        this.sendSessionEvent();
        this.config = null;
    }

    async closeSockets() {
        const closeTasks = [];
        [
            ['authServer', this.authServer],
            ['authServer6', this.authServer6],
            ['accountingServer', this.accountingServer],
            ['accountingServer6', this.accountingServer6],
            ['coaServer', this.coaServer],
            ['coaServer6', this.coaServer6]
        ].forEach(([property, server]) => {
            if (!server) return;
            closeTasks.push(
                new Promise(resolve => {
                    server.close(() => resolve());
                })
            );
            this[property] = null;
        });
        await Promise.all(closeTasks);
    }
}

new RadiusWorker();
