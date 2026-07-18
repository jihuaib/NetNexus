'use strict';

const fs = require('fs');
const { parentPort } = require('worker_threads');
const {
    NetconfClient,
    calculateFingerprints,
    createHostVerifier,
    buildGet,
    buildGetConfig,
    buildEditConfig,
    buildCopyConfig,
    buildDeleteConfig,
    buildLock,
    buildUnlock,
    buildValidate,
    buildCommit,
    buildCancelCommit,
    buildDiscardChanges,
    buildKillSession,
    buildCreateSubscription,
    assertSafeXml,
    rpcReplyDataToConfig
} = require('../../utils/netconf');
const { parseYang } = require('../../utils/yang');
const { NETCONF_REQ_TYPES, YANG_EVT_TYPES, NETCONF_LIMITS } = require('../../const/yangConst');

const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
const MAX_RECONNECT_DELAY = 30000;

function errorData(error) {
    return {
        name: error?.name || 'Error',
        code: error?.code || 'NETCONF_WORKER_ERROR',
        message: error?.message || String(error),
        errors: error?.errors || [],
        messageId: error?.messageId || null,
        requestXml: error?.requestXml || null,
        replyXml: error?.replyXml || null
    };
}

class NetconfWorkerService {
    constructor(port = parentPort, options = {}) {
        this.port = port;
        this.clientFactory = options.clientFactory || (clientOptions => new NetconfClient(clientOptions));
        this.sessions = new Map();
        this.closing = false;
        if (this.port) this.port.on('message', message => this.handleMessage(message));
    }

    sendResponse(messageId, status, data = null, msg = '', code = null) {
        if (!this.port) return;
        this.port.postMessage({ messageId, status, data, msg, code });
    }

    emit(eventName, data) {
        if (this.port) this.port.postMessage({ eventName, data });
    }

    async handleMessage(message = {}) {
        const { messageId, op, data } = message;
        if (op === '__cancel__') return;
        try {
            const result = await this.dispatch(op, data || {});
            this.sendResponse(messageId, 'success', result);
        } catch (error) {
            const detail = errorData(error);
            this.sendResponse(messageId, 'error', detail, detail.message, detail.code);
        }
    }

    async dispatch(operation, data) {
        switch (operation) {
            case NETCONF_REQ_TYPES.TEST_CONNECTION:
                return this.testConnection(data);
            case NETCONF_REQ_TYPES.CONNECT:
                return this.connect(data);
            case NETCONF_REQ_TYPES.DISCONNECT:
                return this.disconnect(data.profileId);
            case NETCONF_REQ_TYPES.DISCONNECT_ALL:
                return this.disconnectAll();
            case NETCONF_REQ_TYPES.GET_SESSION_STATE:
                return this.getSessionState(data.profileId);
            case NETCONF_REQ_TYPES.DISCOVER_MODULES:
                return this.discoverModules(data.profileId);
            case NETCONF_REQ_TYPES.GET_SCHEMA:
                return this.getSchema(data.profileId, data.module || data);
            case NETCONF_REQ_TYPES.EXECUTE_OPERATION:
                return this.executeOperation(data.profileId, data);
            case NETCONF_REQ_TYPES.SEND_RPC:
                return this.sendRpc(data.profileId, data);
            default: {
                const error = new Error(`不支持的NETCONF Worker操作: ${operation}`);
                error.code = 'NETCONF_UNKNOWN_OPERATION';
                throw error;
            }
        }
    }

    readPrivateKey(filePath) {
        const stats = fs.lstatSync(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error('SSH私钥必须是普通文件，不能使用符号链接');
        }
        if (stats.size <= 0 || stats.size > MAX_PRIVATE_KEY_BYTES) {
            throw new Error(`SSH私钥大小必须在1到${MAX_PRIVATE_KEY_BYTES}字节之间`);
        }
        return fs.readFileSync(filePath);
    }

    prepareProfile(profile, observed = {}) {
        const runtime = {
            ...profile,
            readyTimeout: Number(profile.connectTimeout || profile.readyTimeout) || 15000,
            keepaliveInterval: Number(profile.keepaliveInterval) || 0,
            keepaliveCountMax: Number(profile.keepaliveCountMax) || 3
        };
        if (runtime.authMethod === 'privateKey' && !runtime.privateKey && runtime.privateKeyPath) {
            runtime.privateKey = this.readPrivateKey(runtime.privateKeyPath);
        }
        if (runtime.authMethod === 'agent' && !runtime.agent) {
            runtime.agent = process.env.SSH_AUTH_SOCK;
        }

        const expected = String(runtime.hostKeyFingerprint || '').trim();
        if (runtime.hostKeyPolicy === 'strict' && !expected) {
            const error = new Error('严格主机密钥校验需要预先配置指纹');
            error.code = 'NETCONF_HOST_VERIFICATION_REQUIRED';
            throw error;
        }
        const verifier = expected ? createHostVerifier(expected) : null;
        runtime.hostVerifier = key => {
            const fingerprints = calculateFingerprints(key);
            observed.hostKeyFingerprint = fingerprints.sha256;
            return verifier ? verifier(key) : runtime.hostKeyPolicy !== 'strict';
        };
        return runtime;
    }

    createEntry(profile) {
        return {
            profileId: String(profile.id),
            profile,
            client: null,
            status: 'disconnected',
            connectedAt: null,
            disconnectedAt: null,
            lastError: null,
            observed: {},
            manualClose: false,
            reconnectAttempt: 0,
            reconnectTimer: null
        };
    }

    publicState(entry) {
        if (!entry) return { profileId: null, status: 'disconnected', connected: false, capabilities: [] };
        const info = entry.client?.connected ? entry.client.sessionInfo() : {};
        return {
            profileId: entry.profileId,
            status: entry.status,
            state: entry.status,
            connected: entry.status === 'connected' && Boolean(entry.client?.connected),
            sessionId: info.sessionId || null,
            baseVersion: info.baseVersion || null,
            capabilities: info.capabilities || [],
            serverCapabilities: info.capabilities || [],
            connectedAt: entry.connectedAt,
            disconnectedAt: entry.disconnectedAt,
            reconnectAttempt: entry.reconnectAttempt,
            hostKeyFingerprint: entry.observed.hostKeyFingerprint || entry.profile.hostKeyFingerprint || '',
            lastError: entry.lastError
        };
    }

    scrubEntrySecrets(entry) {
        if (!entry?.profile) return;
        const profile = { ...entry.profile };
        delete profile.password;
        delete profile.passphrase;
        delete profile.privateKey;
        entry.profile = profile;
    }

    emitState(entry, extra = {}) {
        this.emit(YANG_EVT_TYPES.SESSION_EVENT, { ...this.publicState(entry), ...extra });
    }

    bindClient(entry, client) {
        client.on('notification', notification => {
            this.emit(YANG_EVT_TYPES.NOTIFICATION, {
                profileId: entry.profileId,
                eventTime: notification.eventTime,
                xml: notification.xml,
                document: notification.document
            });
        });
        client.on('protocol-error', error => {
            entry.lastError = errorData(error);
            this.emitState(entry, { protocolError: entry.lastError });
        });
        client.on('close', error => {
            if (entry.client !== client) return;
            entry.client = null;
            entry.connectedAt = null;
            entry.disconnectedAt = new Date().toISOString();
            entry.lastError = entry.manualClose ? null : errorData(error);
            entry.status = 'disconnected';
            this.emitState(entry);
            if (!entry.manualClose && entry.profile.autoReconnect && !this.closing) this.scheduleReconnect(entry);
            else this.scrubEntrySecrets(entry);
        });
    }

    async connectEntry(entry, reconnecting = false) {
        entry.manualClose = false;
        entry.status = reconnecting ? 'reconnecting' : 'connecting';
        entry.lastError = null;
        entry.observed = {};
        this.emitState(entry);
        const runtime = this.prepareProfile(entry.profile, entry.observed);
        const client = this.clientFactory({
            rpcTimeout: Number(runtime.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT,
            helloTimeout: Number(runtime.connectTimeout) || NETCONF_LIMITS.DEFAULT_CONNECT_TIMEOUT,
            maxMessageSize: NETCONF_LIMITS.MAX_MESSAGE_BYTES
        });
        entry.client = client;
        this.bindClient(entry, client);
        try {
            await client.connect(runtime);
            if (!entry.profile.hostKeyFingerprint && entry.observed.hostKeyFingerprint) {
                entry.profile = {
                    ...entry.profile,
                    hostKeyFingerprint: entry.observed.hostKeyFingerprint
                };
            }
            entry.status = 'connected';
            entry.connectedAt = new Date().toISOString();
            entry.disconnectedAt = null;
            entry.reconnectAttempt = 0;
            this.emitState(entry);
            return this.publicState(entry);
        } catch (error) {
            if (entry.client === client) entry.client = null;
            entry.lastError = errorData(error);
            if (entry.profile.autoReconnect && !entry.manualClose && !this.closing) this.scheduleReconnect(entry);
            entry.status = entry.reconnectTimer ? 'reconnecting' : 'error';
            this.emitState(entry);
            throw error;
        }
    }

    scheduleReconnect(entry) {
        if (entry.reconnectTimer || entry.manualClose || this.closing) return;
        entry.reconnectAttempt += 1;
        const delay = Math.min(MAX_RECONNECT_DELAY, 1000 * 2 ** Math.min(entry.reconnectAttempt - 1, 5));
        entry.status = 'reconnecting';
        this.emitState(entry, { reconnectDelay: delay });
        entry.reconnectTimer = setTimeout(async () => {
            entry.reconnectTimer = null;
            try {
                await this.connectEntry(entry, true);
            } catch (_error) {
                // connectEntry schedules the next bounded retry.
            }
        }, delay);
    }

    async testConnection(profile) {
        const observed = {};
        const runtime = this.prepareProfile(profile, observed);
        const client = this.clientFactory({
            rpcTimeout: Number(runtime.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT,
            helloTimeout: Number(runtime.connectTimeout) || NETCONF_LIMITS.DEFAULT_CONNECT_TIMEOUT,
            maxMessageSize: NETCONF_LIMITS.MAX_MESSAGE_BYTES
        });
        try {
            const info = await client.connect(runtime);
            return { ...info, ...observed, connected: true, status: 'connected' };
        } finally {
            if (client.connected) {
                try {
                    await client.closeSession({ timeout: 5000 });
                } catch (_error) {
                    client.disconnect('connection test complete');
                }
            } else {
                client.disconnect('connection test complete');
            }
        }
    }

    async connect(profile) {
        if (!profile?.id) throw new Error('NETCONF连接缺少profile id');
        const profileId = String(profile.id);
        const existing = this.sessions.get(profileId);
        if (existing?.client?.connected) return this.publicState(existing);
        if (existing) await this.disconnect(profileId);
        const entry = this.createEntry(profile);
        this.sessions.set(profileId, entry);
        return this.connectEntry(entry);
    }

    requireConnected(profileId) {
        const entry = this.sessions.get(String(profileId || ''));
        if (!entry?.client?.connected || entry.status !== 'connected') {
            const error = new Error('NETCONF会话未连接');
            error.code = 'NETCONF_NOT_CONNECTED';
            throw error;
        }
        return entry;
    }

    getSessionState(profileId) {
        return this.publicState(this.sessions.get(String(profileId || '')));
    }

    async disconnect(profileId) {
        const entry = this.sessions.get(String(profileId || ''));
        if (!entry) return { profileId: profileId || null, status: 'disconnected', connected: false, capabilities: [] };
        entry.manualClose = true;
        if (entry.reconnectTimer) {
            clearTimeout(entry.reconnectTimer);
            entry.reconnectTimer = null;
        }
        entry.status = 'disconnecting';
        this.emitState(entry);
        const client = entry.client;
        if (client?.connected) {
            try {
                await client.closeSession({ timeout: 5000 });
            } catch (_error) {
                client.disconnect('session disconnected');
            }
        } else if (client) {
            client.disconnect('session disconnected');
        }
        entry.client = null;
        entry.status = 'disconnected';
        entry.connectedAt = null;
        entry.disconnectedAt = new Date().toISOString();
        entry.lastError = null;
        this.scrubEntrySecrets(entry);
        this.emitState(entry);
        return this.publicState(entry);
    }

    async disconnectAll() {
        this.closing = true;
        try {
            const states = [];
            for (const profileId of this.sessions.keys()) states.push(await this.disconnect(profileId));
            return states;
        } finally {
            this.closing = false;
        }
    }

    async discoverModules(profileId) {
        const entry = this.requireConnected(profileId);
        const inventory = await entry.client.discoverSchemas({ timeout: 120000 });
        return {
            ...inventory,
            profileId: entry.profileId,
            discoveredAt: new Date().toISOString()
        };
    }

    async getSchema(profileId, module = {}) {
        const entry = this.requireConnected(profileId);
        const identifier = module.identifier || module.name;
        if (!identifier) throw new Error('下载YANG模型需要模块名');
        if ((module.format || 'yang').toLowerCase() !== 'yang') throw new Error('当前仅支持下载YANG格式模型');
        const result = await entry.client.getSchema({
            identifier,
            version: module.version || module.revision || undefined,
            format: 'yang',
            timeout: 120000
        });
        if (Buffer.byteLength(result.content, 'utf8') > NETCONF_LIMITS.MAX_SCHEMA_BYTES) {
            const error = new Error('设备返回的YANG模型超过大小限制');
            error.code = 'NETCONF_SCHEMA_TOO_LARGE';
            throw error;
        }
        const parsed = parseYang(result.content, {
            sourceName: `${identifier}${result.version ? `@${result.version}` : ''}.yang`
        });
        const dependencies = [
            ...(parsed.metadata?.imports || []).map(item => ({ ...item, kind: 'module' })),
            ...(parsed.metadata?.includes || []).map(item => ({ ...item, kind: 'submodule' }))
        ];
        return {
            ...result,
            dependencies,
            source: `netconf://${entry.profileId}/${identifier}${result.version ? `@${result.version}` : ''}`
        };
    }

    buildOperation(request) {
        switch (request.operation) {
            case 'get':
                return buildGet(request);
            case 'get-config':
                return buildGetConfig(request);
            case 'edit-config':
                return buildEditConfig(request);
            case 'copy-config':
                return buildCopyConfig(request);
            case 'delete-config':
                return buildDeleteConfig(request);
            case 'lock':
                return buildLock(request);
            case 'unlock':
                return buildUnlock(request);
            case 'validate':
                return buildValidate(request);
            case 'commit':
                return buildCommit(request);
            case 'cancel-commit':
                return buildCancelCommit(request);
            case 'discard-changes':
                return buildDiscardChanges(request);
            case 'kill-session':
                return buildKillSession(request.sessionId, request);
            case 'create-subscription':
                return buildCreateSubscription(request);
            default: {
                const error = new Error(`不支持的NETCONF操作: ${request.operation}`);
                error.code = 'NETCONF_UNSUPPORTED_OPERATION';
                throw error;
            }
        }
    }

    async executeOperation(profileId, request) {
        const entry = this.requireConnected(profileId);
        const rpc = this.buildOperation(request);
        return this.performRpc(entry, rpc, request);
    }

    async sendRpc(profileId, request) {
        const entry = this.requireConnected(profileId);
        const rpc = String(request.rpc || request.xml || '').trim();
        if (!rpc) throw new Error('请输入NETCONF RPC XML');
        if (Buffer.byteLength(rpc, 'utf8') > NETCONF_LIMITS.MAX_RAW_RPC_BYTES) {
            const error = new Error('NETCONF RPC超过大小限制');
            error.code = 'NETCONF_RPC_TOO_LARGE';
            throw error;
        }
        assertSafeXml(rpc, { maxXmlSize: NETCONF_LIMITS.MAX_RAW_RPC_BYTES });
        return this.performRpc(entry, rpc, request);
    }

    async performRpc(entry, rpc, options = {}) {
        const startedAt = Date.now();
        const reply = await entry.client.rpc(rpc, {
            timeout: Number(options.timeout) || Number(entry.profile.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT,
            messageId: options.messageId,
            rejectOnRpcError: false
        });
        const result = {
            rpc,
            requestXml: reply.requestXml || rpc,
            reply: reply.xml,
            xml: reply.xml,
            messageId: reply.messageId,
            ok: reply.ok,
            data: reply.data,
            errors: reply.errors,
            duration: Date.now() - startedAt
        };
        if (options.operation === 'get-config' && (!Array.isArray(reply.errors) || reply.errors.length === 0)) {
            Object.assign(
                result,
                rpcReplyDataToConfig(reply.xml, {
                    maxXmlSize: NETCONF_LIMITS.MAX_RAW_RPC_BYTES
                })
            );
        }
        return result;
    }
}

if (parentPort) new NetconfWorkerService(parentPort);

module.exports = NetconfWorkerService;
