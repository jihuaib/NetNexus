'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const { parentPort } = require('worker_threads');
const { XMLParser } = require('fast-xml-parser');
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
    BASE_NAMESPACE,
    NETCONF_NOTIFICATION_NAMESPACE,
    assertSafeXml,
    parseXml,
    findRoot,
    childValues,
    childText,
    getAttribute,
    localName,
    rpcReplyDataToConfig
} = require('../../utils/netconf');
const { parseYang } = require('../../utils/yang');
const { NETCONF_REQ_TYPES, YANG_EVT_TYPES, NETCONF_CAPABILITIES, NETCONF_LIMITS } = require('../../const/yangConst');

const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
const MAX_RECONNECT_DELAY = 30000;
const orderedXmlParser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    commentPropName: '#comment',
    cdataPropName: '#cdata'
});

function orderedElement(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const name = Object.keys(item).find(key => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'));
    if (!name) return null;
    return {
        name,
        children: Array.isArray(item[name]) ? item[name] : [],
        attributes: item[':@'] && typeof item[':@'] === 'object' ? item[':@'] : {}
    };
}

function extendNamespaces(parentNamespaces, attributes) {
    const namespaces = new Map(parentNamespaces || []);
    for (const [name, value] of Object.entries(attributes || {})) {
        if (name === '@_xmlns') namespaces.set('', String(value));
        else if (name.startsWith('@_xmlns:')) namespaces.set(name.slice('@_xmlns:'.length), String(value));
    }
    return namespaces;
}

function resolveOrderedElement(element, parentNamespaces = null) {
    if (!element) return null;
    const namespaces = extendNamespaces(parentNamespaces, element.attributes);
    const separator = element.name.indexOf(':');
    const prefix = separator < 0 ? '' : element.name.slice(0, separator);
    return {
        ...element,
        localName: separator < 0 ? element.name : element.name.slice(separator + 1),
        namespace: namespaces.get(prefix) || '',
        namespaces
    };
}

function orderedRoot(xml) {
    const document = orderedXmlParser.parse(xml);
    for (const item of document || []) {
        const root = resolveOrderedElement(orderedElement(item));
        if (root) return root;
    }
    return null;
}

function directOperationDescriptor(xml) {
    const root = orderedRoot(xml);
    if (!root) return null;
    if (root.localName !== 'rpc') return root;
    if (root.namespace !== BASE_NAMESPACE) return null;
    for (const item of root.children) {
        const operation = resolveOrderedElement(orderedElement(item), root.namespaces);
        if (operation) return operation;
    }
    return null;
}

function supportsCapability(capabilities, expected) {
    return (capabilities || []).some(capability => capability === expected || capability.startsWith(`${expected}?`));
}

function capabilitySupportFrom(capabilities) {
    return {
        notification: supportsCapability(capabilities, NETCONF_CAPABILITIES.NOTIFICATION),
        interleave: supportsCapability(capabilities, NETCONF_CAPABILITIES.INTERLEAVE)
    };
}

function profileSummary(entry) {
    return {
        profileName: entry?.profile?.name || entry?.profileId || '',
        host: entry?.profile?.host || '',
        port: Number(entry?.profile?.port) || 830
    };
}

function normalizeFilter(filter) {
    if (filter === undefined || filter === null || filter === '') return null;
    if (typeof filter === 'string') {
        const xml = filter.trim();
        if (!/^<(?:[A-Za-z_][\w.-]*:)?filter\b/i.test(xml)) {
            return { type: 'subtree', content: xml };
        }
        try {
            const root = findRoot(parseXml(xml));
            const node = root?.name === 'filter' ? root.value : null;
            if (!node) return { type: 'subtree', xml };
            const type = getAttribute(node, 'type') || 'subtree';
            return type === 'xpath' ? { type, select: getAttribute(node, 'select') || '', xml } : { type, xml };
        } catch (_error) {
            return { type: 'subtree', xml };
        }
    }
    if (typeof filter !== 'object' || Array.isArray(filter)) return null;
    const type = filter.type || 'subtree';
    if (type === 'xpath') {
        return {
            type,
            select: filter.select || '',
            namespaces: filter.namespaces && typeof filter.namespaces === 'object' ? { ...filter.namespaces } : {}
        };
    }
    return {
        type,
        ...(filter.document && typeof filter.document === 'object'
            ? { document: filter.document }
            : { content: filter.xml !== undefined ? filter.xml : filter.content || '' })
    };
}

function directCreateSubscriptionNode(xml) {
    const document = parseXml(xml);
    const operation = directOperationDescriptor(xml);
    if (operation?.localName !== 'create-subscription' || operation.namespace !== NETCONF_NOTIFICATION_NAMESPACE) {
        return null;
    }
    const root = findRoot(document);
    if (!root) return null;
    if (root.name === 'create-subscription') {
        return root.value && typeof root.value === 'object' ? root.value : {};
    }
    if (root.name !== 'rpc') return null;
    const nodes = childValues(root.value, 'create-subscription');
    if (nodes.length === 0) return null;
    return nodes[0] && typeof nodes[0] === 'object' ? nodes[0] : {};
}

function rawSubscriptionParameters(xml) {
    const node = directCreateSubscriptionNode(xml);
    if (node === null) return null;
    const filterNodes = childValues(node, 'filter');
    const filterNode = filterNodes.length > 0 ? filterNodes[0] : null;
    let filter = null;
    if (filterNode) {
        const type = getAttribute(filterNode, 'type') || 'subtree';
        filter =
            type === 'xpath'
                ? { type, select: getAttribute(filterNode, 'select') || '' }
                : { type, document: filterNode };
    }
    return {
        stream: childText(node, 'stream') || 'NETCONF',
        filter,
        startTime: childText(node, 'startTime'),
        stopTime: childText(node, 'stopTime')
    };
}

function notificationEventDescriptor(notification) {
    try {
        const root = orderedRoot(notification?.xml || '');
        if (root?.localName === 'notification') {
            for (const item of root.children) {
                const event = resolveOrderedElement(orderedElement(item), root.namespaces);
                if (event && event.localName !== 'eventTime') {
                    return { name: event.localName, namespace: event.namespace };
                }
            }
        }
    } catch (_error) {
        // The NETCONF client has already parsed the message. Fall back to its document.
    }
    const root = notification?.root || findRoot(notification?.document || {})?.value;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return { name: null, namespace: '' };
    const key = Object.keys(root).find(name => {
        if (name.startsWith('@_') || name.startsWith('#')) return false;
        return localName(name) !== 'eventTime';
    });
    return { name: key ? localName(key) : null, namespace: '' };
}

function errorData(error) {
    return {
        name: error?.name || 'Error',
        code: error?.code || 'NETCONF_WORKER_ERROR',
        message: error?.message || String(error),
        errors: error?.errors || [],
        messageId: error?.messageId || null,
        requestXml: error?.requestXml || null,
        replyXml: error?.replyXml || null,
        subscription: error?.subscription || null
    };
}

class NetconfWorkerService {
    constructor(port = parentPort, options = {}) {
        this.port = port;
        this.clientFactory = options.clientFactory || (clientOptions => new NetconfClient(clientOptions));
        this.sessions = new Map();
        this.subscriptions = new Map();
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
            case NETCONF_REQ_TYPES.GET_SUBSCRIPTIONS:
                return this.getSubscriptions(data.profileId);
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
            reconnectTimer: null,
            activeSubscriptionId: null,
            subscriptionPending: false
        };
    }

    publicState(entry) {
        if (!entry) {
            return {
                profileId: null,
                status: 'disconnected',
                connected: false,
                capabilities: [],
                supportsNotification: false,
                supportsInterleave: false,
                capabilitySupport: { notification: false, interleave: false },
                subscription: null,
                activeSubscription: null,
                subscriptionActive: false
            };
        }
        const info = entry.client?.connected ? entry.client.sessionInfo() : {};
        const capabilitySupport = capabilitySupportFrom(info.capabilities || []);
        const activeSubscription = this.publicSubscription(this.activeSubscription(entry));
        return {
            profileId: entry.profileId,
            ...profileSummary(entry),
            status: entry.status,
            state: entry.status,
            connected: entry.status === 'connected' && Boolean(entry.client?.connected),
            sessionId: info.sessionId || null,
            baseVersion: info.baseVersion || null,
            capabilities: info.capabilities || [],
            serverCapabilities: info.capabilities || [],
            supportsNotification: capabilitySupport.notification,
            supportsInterleave: capabilitySupport.interleave,
            capabilitySupport,
            subscription: activeSubscription,
            activeSubscription,
            subscriptionActive: Boolean(activeSubscription),
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

    publicSubscription(subscription) {
        if (!subscription) return null;
        return {
            ...subscription,
            filter: subscription.filter ? { ...subscription.filter } : null,
            capabilitySupport: { ...subscription.capabilitySupport }
        };
    }

    activeSubscription(entry) {
        if (!entry?.activeSubscriptionId) return null;
        const subscription = this.subscriptions.get(entry.activeSubscriptionId) || null;
        return subscription?.state === 'ACTIVE' ? subscription : null;
    }

    subscriptionForSession(entry, sessionId) {
        const active = this.activeSubscription(entry);
        if (active?.sessionId === sessionId) return active;
        const history = [...this.subscriptions.values()];
        for (let index = history.length - 1; index >= 0; index -= 1) {
            const subscription = history[index];
            if (subscription.profileId === entry?.profileId && subscription.sessionId === sessionId) {
                return subscription;
            }
        }
        return null;
    }

    emitSubscription(subscription) {
        this.emit(YANG_EVT_TYPES.SUBSCRIPTION_EVENT, this.publicSubscription(subscription));
    }

    assertCanCreateSubscription(entry) {
        const info = entry.client?.sessionInfo?.() || {};
        const capabilities = info.capabilities || [];
        if (!supportsCapability(capabilities, NETCONF_CAPABILITIES.NOTIFICATION)) {
            const error = new Error('设备未声明 NETCONF :notification 能力，不能建立 RFC 5277 订阅');
            error.code = 'NETCONF_NOTIFICATION_NOT_SUPPORTED';
            throw error;
        }
        const active = this.activeSubscription(entry);
        if (active || entry.subscriptionPending) {
            const error = new Error(
                entry.subscriptionPending
                    ? '当前 NETCONF Session 正在建立 RFC 5277 订阅'
                    : '当前 NETCONF Session 已有活动的 RFC 5277 订阅'
            );
            error.code = 'NETCONF_SUBSCRIPTION_ALREADY_ACTIVE';
            error.subscription = this.publicSubscription(active);
            throw error;
        }
    }

    activateSubscription(entry, parameters, requestXml, messageId, sessionInfo = null) {
        const info = sessionInfo || entry.client?.sessionInfo?.() || {};
        const capabilitySupport = capabilitySupportFrom(info.capabilities || []);
        // History is kept by the renderer across worker restarts, so a process-local
        // counter would eventually overwrite an older subscription record.
        const id = `rfc5277-${randomUUID()}`;
        const subscription = {
            id,
            subscriptionId: id,
            profileId: entry.profileId,
            ...profileSummary(entry),
            sessionId: info.sessionId || null,
            baseVersion: info.baseVersion || null,
            type: 'rfc5277',
            subscriptionType: 'rfc5277',
            state: 'ACTIVE',
            stream: parameters.stream || 'NETCONF',
            filter: normalizeFilter(parameters.filter),
            startTime: parameters.startTime || null,
            stopTime: parameters.stopTime || null,
            messageId: messageId || null,
            requestXml: requestXml || null,
            capabilitySupport,
            createdAt: new Date().toISOString(),
            terminatedAt: null,
            terminationReason: null,
            error: null
        };
        this.subscriptions.set(id, subscription);
        entry.activeSubscriptionId = id;
        this.emitSubscription(subscription);
        this.emitState(entry, { subscriptionChanged: true });
        return this.publicSubscription(subscription);
    }

    terminateActiveSubscription(entry, reason, error = null) {
        const subscription = this.activeSubscription(entry);
        if (!subscription) return null;
        subscription.state = 'TERMINATED';
        subscription.terminatedAt = new Date().toISOString();
        subscription.terminationReason = reason || 'session-closed';
        subscription.error = error ? errorData(error) : null;
        entry.activeSubscriptionId = null;
        this.emitSubscription(subscription);
        this.emitState(entry, { subscriptionChanged: true });
        return this.publicSubscription(subscription);
    }

    getSubscriptions(profileId = null) {
        const normalizedProfileId =
            profileId === undefined || profileId === null || profileId === '' ? null : String(profileId);
        const subscriptions = [...this.subscriptions.values()]
            .filter(subscription => !normalizedProfileId || subscription.profileId === normalizedProfileId)
            .map(subscription => this.publicSubscription(subscription))
            .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
        return {
            profileId: normalizedProfileId,
            subscriptions,
            activeCount: subscriptions.filter(subscription => subscription.state === 'ACTIVE').length,
            total: subscriptions.length,
            queriedAt: new Date().toISOString()
        };
    }

    bindClient(entry, client) {
        client.on('notification', notification => {
            const receivedAt = new Date().toISOString();
            const emitNotification = () => {
                const info = client.sessionInfo?.() || {};
                const activeSubscription = this.activeSubscription(entry);
                const subscription =
                    (activeSubscription?.sessionId === (info.sessionId || null) ? activeSubscription : null) ||
                    (entry.client !== client ? this.subscriptionForSession(entry, info.sessionId || null) : null);
                const event = notificationEventDescriptor(notification);
                const eventName = event.name;
                this.emit(YANG_EVT_TYPES.NOTIFICATION, {
                    profileId: entry.profileId,
                    ...profileSummary(entry),
                    sessionId: info.sessionId || subscription?.sessionId || null,
                    baseVersion: info.baseVersion || subscription?.baseVersion || null,
                    capabilitySupport: capabilitySupportFrom(info.capabilities || []),
                    subscriptionId: subscription?.subscriptionId || null,
                    subscriptionType: subscription?.subscriptionType || null,
                    state: subscription?.state || 'UNSUBSCRIBED',
                    receivedAt,
                    eventTime: notification.eventTime,
                    eventName,
                    namespace: event.namespace,
                    xml: notification.xml,
                    document: notification.document
                });
                if (
                    eventName === 'notificationComplete' &&
                    event.namespace === NETCONF_NOTIFICATION_NAMESPACE &&
                    subscription?.id === entry.activeSubscriptionId
                ) {
                    this.terminateActiveSubscription(entry, 'notification-complete');
                }
            };
            // A server may put the first notification in the same transport read as the
            // successful rpc-reply. Let the waiting RPC continuation register the
            // subscription first so that notification keeps its Session association.
            if (entry.subscriptionPending) setImmediate(emitNotification);
            else emitNotification();
        });
        client.on('protocol-error', error => {
            entry.lastError = errorData(error);
            this.emitState(entry, { protocolError: entry.lastError });
        });
        client.on('close', error => {
            if (entry.client !== client) return;
            this.terminateActiveSubscription(
                entry,
                entry.manualClose ? (this.closing ? 'application-close' : 'session-disconnected') : 'connection-lost',
                entry.manualClose ? null : error
            );
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
        if (reconnecting) this.terminateActiveSubscription(entry, 'session-reconnected');
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
            const capabilitySupport = capabilitySupportFrom(info.capabilities || []);
            return {
                ...info,
                ...observed,
                profileId: profile?.id ? String(profile.id) : null,
                profileName: profile?.name || profile?.id || '',
                host: profile?.host || '',
                port: Number(profile?.port) || 830,
                connected: true,
                status: 'connected',
                supportsNotification: capabilitySupport.notification,
                supportsInterleave: capabilitySupport.interleave,
                capabilitySupport
            };
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
        const normalizedProfileId = String(profileId || '');
        const entry = this.sessions.get(normalizedProfileId);
        return entry ? this.publicState(entry) : { ...this.publicState(null), profileId: normalizedProfileId || null };
    }

    async disconnect(profileId) {
        const entry = this.sessions.get(String(profileId || ''));
        if (!entry) return { ...this.publicState(null), profileId: profileId || null };
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
        this.terminateActiveSubscription(entry, this.closing ? 'application-close' : 'session-disconnected');
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
        const subscriptionParameters =
            request.operation === 'create-subscription'
                ? {
                      stream: request.stream || 'NETCONF',
                      filter: request.filter || null,
                      startTime: request.startTime || null,
                      stopTime: request.stopTime || null
                  }
                : null;
        return this.performRpc(entry, rpc, { ...request, subscriptionParameters });
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
        const subscriptionParameters = rawSubscriptionParameters(rpc);
        return this.performRpc(entry, rpc, { ...request, subscriptionParameters });
    }

    async performRpc(entry, rpc, options = {}) {
        const startedAt = Date.now();
        const client = entry.client;
        const sessionInfo = client?.sessionInfo?.() || {};
        const isSubscription = Boolean(options.subscriptionParameters);
        if (isSubscription) {
            this.assertCanCreateSubscription(entry);
            entry.subscriptionPending = true;
        }
        let reply;
        try {
            reply = await client.rpc(rpc, {
                timeout:
                    Number(options.timeout) || Number(entry.profile.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT,
                messageId: options.messageId,
                rejectOnRpcError: false
            });
        } finally {
            if (isSubscription) entry.subscriptionPending = false;
        }
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
        if (isSubscription && reply.ok && (!Array.isArray(reply.errors) || reply.errors.length === 0)) {
            result.subscription = this.activateSubscription(
                entry,
                options.subscriptionParameters,
                result.requestXml,
                result.messageId,
                sessionInfo
            );
            if (entry.client !== client || !client.connected || entry.status !== 'connected') {
                result.subscription = this.terminateActiveSubscription(entry, 'connection-lost');
            }
        } else if (isSubscription) {
            result.subscription = null;
        }
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
