'use strict';

const { EventEmitter } = require('events');
const { NETCONF_LIMITS } = require('../../const/yangConst');
const { DelimiterFramer, createFramer, encodeMessage } = require('./framing');
const {
    DEFAULT_CLIENT_CAPABILITIES,
    BASE_CAPABILITY_PREFIX,
    buildHello,
    buildRpc,
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
    buildEstablishSubscription,
    buildModifySubscription,
    buildDeleteSubscription,
    buildKillSubscription,
    buildResyncSubscription
} = require('./builders');
const { assertSafeXml, parseXml, parseNetconfMessage, decodeXmlText, NetconfRpcError } = require('./xml');
const { createSshTransport } = require('./sshTransport');

class NetconfConnectionError extends Error {
    constructor(message, code = 'NETCONF_CONNECTION_ERROR', cause = null) {
        super(message);
        this.name = 'NetconfConnectionError';
        this.code = code;
        if (cause) {
            this.cause = cause;
        }
    }
}

class NetconfProtocolError extends Error {
    constructor(message, code = 'NETCONF_PROTOCOL_ERROR', cause = null) {
        super(message);
        this.name = 'NetconfProtocolError';
        this.code = code;
        if (cause) {
            this.cause = cause;
        }
    }
}

class NetconfTimeoutError extends Error {
    constructor(messageId, timeout) {
        super(`NETCONF RPC ${messageId} timed out after ${timeout} ms`);
        this.name = 'NetconfTimeoutError';
        this.code = 'NETCONF_RPC_TIMEOUT';
        this.messageId = messageId;
        this.timeout = timeout;
    }
}

function withRpcContext(error, requestXml, messageId) {
    const source = error instanceof Error ? error : new Error(String(error));
    const contextualError = Object.create(Object.getPrototypeOf(source));
    Object.defineProperties(contextualError, Object.getOwnPropertyDescriptors(source));
    contextualError.requestXml = requestXml || contextualError.requestXml || null;
    contextualError.messageId = messageId || contextualError.messageId || null;
    return contextualError;
}

function isTransport(value) {
    return Boolean(value && typeof value.on === 'function' && typeof value.write === 'function');
}

function capabilitySet(capabilities) {
    if (!Array.isArray(capabilities)) {
        throw new TypeError('clientCapabilities must be an array');
    }
    return [...new Set(capabilities.map(value => String(value).trim()).filter(Boolean))];
}

function supportsBase(capabilities, version) {
    const expected = `${BASE_CAPABILITY_PREFIX}${version}`;
    return capabilities.some(capability => capability === expected || capability.startsWith(`${expected}?`));
}

function extractRpcMessageId(xml) {
    const openingTag = /^\s*<(?:[A-Za-z_][\w.-]*:)?rpc\b[^>]*>/i.exec(xml);
    if (!openingTag) {
        return null;
    }
    const match = /\b(?:[A-Za-z_][\w.-]*:)?message-id\s*=\s*(["'])(.*?)\1/i.exec(openingTag[0]);
    return match ? decodeXmlText(match[2]) : null;
}

function ensureRpcEnvelope(operationOrRpc, messageId) {
    const xml = assertSafeXml(operationOrRpc).trim();
    if (!/^<(?:[A-Za-z_][\w.-]*:)?rpc\b/i.test(xml)) {
        const rpcXml = buildRpc(xml, { messageId });
        parseXml(rpcXml);
        return { xml: rpcXml, messageId: String(messageId) };
    }

    const existingId = extractRpcMessageId(xml);
    if (existingId !== null) {
        if (messageId !== undefined && messageId !== null && String(messageId) !== existingId) {
            throw new TypeError(`RPC message-id ${existingId} does not match requested message-id ${messageId}`);
        }
        parseXml(xml);
        return { xml, messageId: existingId };
    }

    if (messageId === undefined || messageId === null) {
        throw new TypeError('RPC envelope has no message-id');
    }
    const withMessageId = xml.replace(
        /^(\s*<(?:[A-Za-z_][\w.-]*:)?rpc)\b/i,
        `$1 message-id="${String(messageId).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
    );
    parseXml(withMessageId);
    return { xml: withMessageId, messageId: String(messageId) };
}

class NetconfClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.clientCapabilities = capabilitySet(options.clientCapabilities || DEFAULT_CLIENT_CAPABILITIES);
        this.transportFactory = options.transportFactory || createSshTransport;
        this.transport = options.transport || null;
        this.rpcTimeout = options.rpcTimeout === undefined ? 30000 : Number(options.rpcTimeout);
        this.helloTimeout = options.helloTimeout === undefined ? 20000 : Number(options.helloTimeout);
        this.maxMessageSize = options.maxMessageSize;
        this.maxChunkSize = options.maxChunkSize;
        this.chunkSize = options.chunkSize;

        if (!Number.isFinite(this.rpcTimeout) || this.rpcTimeout <= 0) {
            throw new TypeError('rpcTimeout must be a positive number');
        }
        if (!Number.isFinite(this.helloTimeout) || this.helloTimeout <= 0) {
            throw new TypeError('helloTimeout must be a positive number');
        }
        if (!supportsBase(this.clientCapabilities, '1.0') && !supportsBase(this.clientCapabilities, '1.1')) {
            throw new TypeError('clientCapabilities must advertise NETCONF base:1.0 or base:1.1');
        }

        this.state = 'idle';
        this.sessionId = null;
        this.capabilities = [];
        this.serverCapabilities = this.capabilities;
        this.baseVersion = null;
        this.pending = new Map();
        this.nextMessageId = options.initialMessageId === undefined ? 1 : Number(options.initialMessageId);
        if (!Number.isSafeInteger(this.nextMessageId) || this.nextMessageId < 0) {
            throw new TypeError('initialMessageId must be a non-negative safe integer');
        }

        this._helloFramer = null;
        this._framer = null;
        this._helloTimer = null;
        this._helloResolve = null;
        this._helloReject = null;
        this._connectPromise = null;
        this._transportListeners = null;
        this._closeEmitted = false;
        this._inboundMessageSequence = 0;
    }

    get connected() {
        return this.state === 'connected';
    }

    _framerOptions() {
        return {
            maxMessageSize: this.maxMessageSize,
            maxChunkSize: this.maxChunkSize
        };
    }

    async connect(profileOrTransport = {}) {
        if (this.connected) {
            return this.sessionInfo();
        }
        if (this._connectPromise) {
            return this._connectPromise;
        }
        if (!['idle', 'closed'].includes(this.state)) {
            throw new NetconfConnectionError(`Cannot connect while client is ${this.state}`, 'NETCONF_INVALID_STATE');
        }

        this.state = 'connecting';
        this._closeEmitted = false;
        this._connectPromise = this._connect(profileOrTransport);
        try {
            return await this._connectPromise;
        } finally {
            this._connectPromise = null;
        }
    }

    async _connect(profileOrTransport) {
        try {
            let transport = null;
            if (isTransport(profileOrTransport)) {
                transport = profileOrTransport;
            } else if (profileOrTransport && isTransport(profileOrTransport.transport)) {
                transport = profileOrTransport.transport;
            } else if (isTransport(this.transport)) {
                transport = this.transport;
            } else {
                transport = await this.transportFactory(profileOrTransport || {});
                if (transport && isTransport(transport.transport)) {
                    transport = transport.transport;
                }
            }
            if (!isTransport(transport)) {
                throw new NetconfConnectionError(
                    'transportFactory did not return an EventEmitter-compatible writable transport',
                    'NETCONF_INVALID_TRANSPORT'
                );
            }

            this.transport = transport;
            this._inboundMessageSequence = 0;
            this._bindTransport(transport);
            this._helloFramer = new DelimiterFramer(this._framerOptions());
            this._framer = null;
            this.state = 'hello';

            const helloPromise = new Promise((resolve, reject) => {
                this._helloResolve = resolve;
                this._helloReject = reject;
                this._helloTimer = setTimeout(() => {
                    this._failProtocol(
                        new NetconfConnectionError(
                            `NETCONF server hello timed out after ${this.helloTimeout} ms`,
                            'NETCONF_HELLO_TIMEOUT'
                        )
                    );
                }, this.helloTimeout);
            });

            this._write(encodeMessage(buildHello(this.clientCapabilities), '1.0'));
            return await helloPromise;
        } catch (error) {
            if (this.state !== 'closed') {
                this._terminate(
                    error instanceof Error
                        ? error
                        : new NetconfConnectionError(String(error), 'NETCONF_CONNECT_FAILED'),
                    true
                );
            }
            throw error;
        }
    }

    _bindTransport(transport) {
        this._unbindTransport();
        const listeners = {
            data: chunk => this._handleData(chunk),
            error: error => {
                this._terminate(
                    new NetconfConnectionError(
                        `NETCONF transport error: ${error.message}`,
                        'NETCONF_TRANSPORT_ERROR',
                        error
                    )
                );
            },
            end: () => {
                this._terminate(new NetconfConnectionError('NETCONF transport ended', 'NETCONF_TRANSPORT_ENDED'));
            },
            close: error => {
                this._terminate(
                    error instanceof Error
                        ? new NetconfConnectionError(
                              `NETCONF transport closed: ${error.message}`,
                              'NETCONF_TRANSPORT_CLOSED',
                              error
                          )
                        : new NetconfConnectionError('NETCONF transport closed', 'NETCONF_TRANSPORT_CLOSED')
                );
            }
        };
        for (const [event, listener] of Object.entries(listeners)) {
            transport.on(event, listener);
        }
        this._transportListeners = { transport, listeners };
    }

    _unbindTransport() {
        if (!this._transportListeners) {
            return;
        }
        const { transport, listeners } = this._transportListeners;
        for (const [event, listener] of Object.entries(listeners)) {
            if (typeof transport.removeListener === 'function') {
                transport.removeListener(event, listener);
            }
        }
        this._transportListeners = null;
    }

    _write(data) {
        if (!this.transport || typeof this.transport.write !== 'function') {
            throw new NetconfConnectionError('NETCONF transport is not writable', 'NETCONF_TRANSPORT_CLOSED');
        }
        try {
            this.transport.write(data);
        } catch (error) {
            throw new NetconfConnectionError(
                `Unable to write NETCONF message: ${error.message}`,
                'NETCONF_WRITE_FAILED',
                error
            );
        }
    }

    _handleData(chunk) {
        try {
            if (this.state === 'hello') {
                const messages = this._helloFramer.push(chunk, 1);
                if (messages.length === 0) {
                    return;
                }
                const remainder = this._helloFramer.takeBuffered();
                this._handleServerHello(messages[0]);
                if (remainder.length > 0 && this.connected) {
                    this._decodeEstablishedData(remainder);
                }
                return;
            }
            if (this.connected) {
                this._decodeEstablishedData(chunk);
            }
        } catch (error) {
            this._failProtocol(
                error instanceof NetconfProtocolError
                    ? error
                    : new NetconfProtocolError(
                          `Invalid NETCONF message: ${error.message}`,
                          'NETCONF_PROTOCOL_ERROR',
                          error
                      )
            );
        }
    }

    _decodeEstablishedData(chunk) {
        const messages = this._framer.push(chunk);
        for (const xml of messages) {
            this._handleMessage(xml);
        }
    }

    _handleServerHello(xml) {
        const hello = parseNetconfMessage(xml, { maxXmlSize: this.maxMessageSize });
        if (hello.type !== 'hello') {
            throw new NetconfProtocolError(
                `Expected NETCONF hello but received ${hello.type}`,
                'NETCONF_EXPECTED_HELLO'
            );
        }
        if (!hello.sessionId) {
            throw new NetconfProtocolError('Server hello has no session-id', 'NETCONF_HELLO_NO_SESSION_ID');
        }

        const serverSupports11 = supportsBase(hello.capabilities, '1.1');
        const serverSupports10 = supportsBase(hello.capabilities, '1.0');
        const clientSupports11 = supportsBase(this.clientCapabilities, '1.1');
        const clientSupports10 = supportsBase(this.clientCapabilities, '1.0');
        if (serverSupports11 && clientSupports11) {
            this.baseVersion = '1.1';
        } else if (serverSupports10 && clientSupports10) {
            this.baseVersion = '1.0';
        } else {
            throw new NetconfProtocolError(
                'Client and server have no common NETCONF base capability',
                'NETCONF_NO_COMMON_BASE'
            );
        }

        this.sessionId = hello.sessionId;
        this.capabilities = Object.freeze([...hello.capabilities]);
        this.serverCapabilities = this.capabilities;
        this._framer = createFramer(this.baseVersion, this._framerOptions());
        this.state = 'connected';
        this._clearHelloTimer();
        const info = this.sessionInfo();
        const resolve = this._helloResolve;
        this._helloResolve = null;
        this._helloReject = null;
        if (resolve) {
            resolve(info);
        }
        this.emit('connected', info);
    }

    _handleMessage(xml) {
        const message = parseNetconfMessage(xml, {
            maxXmlSize: this.maxMessageSize,
            // Preserve the long-standing object form for ordinary replies, but
            // avoid expanding a large <data> payload into a huge object graph.
            opaqueRpcReplyData: Buffer.byteLength(xml, 'utf8') > NETCONF_LIMITS.MAX_INLINE_RPC_REPLY_BYTES
        });
        message.transportSequence = ++this._inboundMessageSequence;
        if (message.type === 'rpc-reply') {
            if (!message.messageId || !this.pending.has(message.messageId)) {
                this.emit('orphan-reply', message);
                return;
            }
            const pending = this.pending.get(message.messageId);
            this.pending.delete(message.messageId);
            clearTimeout(pending.timer);
            if (message.errors.length > 0 && pending.rejectOnRpcError) {
                pending.reject(
                    new NetconfRpcError(message.errors, {
                        messageId: message.messageId,
                        replyXml: message.xml,
                        requestXml: pending.requestXml
                    })
                );
            } else {
                pending.resolve({
                    ...message,
                    requestXml: pending.requestXml
                });
            }
            return;
        }
        if (message.type === 'notification') {
            this.emit('notification', message);
            return;
        }
        this.emit('message', message);
    }

    rpc(operationOrRpc, options = {}) {
        if (!this.connected) {
            return Promise.reject(
                new NetconfConnectionError(`Cannot send RPC while client is ${this.state}`, 'NETCONF_NOT_CONNECTED')
            );
        }
        if (typeof operationOrRpc !== 'string' && !Buffer.isBuffer(operationOrRpc)) {
            return Promise.reject(new TypeError('RPC operation must be an XML string or Buffer'));
        }

        let requestedMessageId = options.messageId;
        const rawXml = Buffer.isBuffer(operationOrRpc) ? operationOrRpc.toString('utf8') : operationOrRpc;
        const existingMessageId = extractRpcMessageId(rawXml);
        if (existingMessageId !== null && requestedMessageId === undefined) {
            requestedMessageId = existingMessageId;
        }
        if (requestedMessageId === undefined || requestedMessageId === null) {
            requestedMessageId = String(this.nextMessageId++);
        } else {
            requestedMessageId = String(requestedMessageId);
        }

        let envelope;
        try {
            envelope = ensureRpcEnvelope(rawXml, requestedMessageId);
        } catch (error) {
            return Promise.reject(error);
        }
        const messageId = envelope.messageId;
        if (this.pending.has(messageId)) {
            return Promise.reject(
                new NetconfProtocolError(
                    `RPC message-id ${messageId} is already pending`,
                    'NETCONF_DUPLICATE_MESSAGE_ID'
                )
            );
        }

        const timeout =
            options.timeout === undefined || options.timeout === null ? this.rpcTimeout : Number(options.timeout);
        if (!Number.isFinite(timeout) || timeout <= 0) {
            return Promise.reject(new TypeError('RPC timeout must be a positive number'));
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending.has(messageId)) {
                    return;
                }
                this.pending.delete(messageId);
                reject(withRpcContext(new NetconfTimeoutError(messageId, timeout), envelope.xml, messageId));
            }, timeout);
            this.pending.set(messageId, {
                resolve,
                reject,
                timer,
                requestXml: envelope.xml,
                rejectOnRpcError: options.rejectOnRpcError !== false
            });
            try {
                this._write(
                    encodeMessage(envelope.xml, this.baseVersion, {
                        chunkSize: this.chunkSize
                    })
                );
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(messageId);
                reject(withRpcContext(error, envelope.xml, messageId));
            }
        });
    }

    get(options = {}, rpcOptions = {}) {
        return this.rpc(buildGet(options), rpcOptions);
    }

    getConfig(options = {}, rpcOptions = {}) {
        return this.rpc(buildGetConfig(options), rpcOptions);
    }

    editConfig(options = {}, rpcOptions = {}) {
        return this.rpc(buildEditConfig(options), rpcOptions);
    }

    copyConfig(options = {}, rpcOptions = {}) {
        return this.rpc(buildCopyConfig(options), rpcOptions);
    }

    deleteConfig(options = {}, rpcOptions = {}) {
        return this.rpc(buildDeleteConfig(options), rpcOptions);
    }

    lock(options = {}, rpcOptions = {}) {
        return this.rpc(buildLock(options), rpcOptions);
    }

    unlock(options = {}, rpcOptions = {}) {
        return this.rpc(buildUnlock(options), rpcOptions);
    }

    validate(options = {}, rpcOptions = {}) {
        return this.rpc(buildValidate(options), rpcOptions);
    }

    commit(options = {}, rpcOptions = {}) {
        return this.rpc(buildCommit(options), rpcOptions);
    }

    cancelCommit(options = {}, rpcOptions = {}) {
        return this.rpc(buildCancelCommit(options), rpcOptions);
    }

    discardChanges(rpcOptions = {}) {
        return this.rpc(buildDiscardChanges(), rpcOptions);
    }

    killSession(sessionId, rpcOptions = {}) {
        return this.rpc(buildKillSession(sessionId), rpcOptions);
    }

    createSubscription(options = {}, rpcOptions = {}) {
        return this.rpc(buildCreateSubscription(options), rpcOptions);
    }

    establishSubscription(options = {}, rpcOptions = {}) {
        return this.rpc(buildEstablishSubscription(options), rpcOptions);
    }

    modifySubscription(options = {}, rpcOptions = {}) {
        return this.rpc(buildModifySubscription(options), rpcOptions);
    }

    deleteSubscription(idOrOptions, rpcOptions = {}) {
        return this.rpc(buildDeleteSubscription(idOrOptions), rpcOptions);
    }

    killSubscription(idOrOptions, rpcOptions = {}) {
        return this.rpc(buildKillSubscription(idOrOptions), rpcOptions);
    }

    resyncSubscription(idOrOptions, rpcOptions = {}) {
        return this.rpc(buildResyncSubscription(idOrOptions), rpcOptions);
    }

    discoverSchemas(options = {}) {
        return require('./inventory').discoverSchemaInventory(this, options);
    }

    getSchema(identifierOrOptions, maybeOptions = {}) {
        return require('./inventory').getSchema(this, identifierOrOptions, maybeOptions);
    }

    supports(capability) {
        return this.capabilities.includes(capability);
    }

    supportsCapabilityPrefix(prefix) {
        return this.capabilities.some(capability => capability.startsWith(prefix));
    }

    sessionInfo() {
        return {
            sessionId: this.sessionId,
            capabilities: [...this.capabilities],
            baseVersion: this.baseVersion
        };
    }

    async closeSession(options = {}) {
        if (!this.connected) {
            this.disconnect();
            return null;
        }
        let reply = null;
        try {
            reply = await this.rpc('<close-session/>', options);
        } finally {
            this.disconnect();
        }
        return reply;
    }

    disconnect(reason = null) {
        const error =
            reason instanceof Error
                ? reason
                : new NetconfConnectionError(
                      reason ? String(reason) : 'NETCONF client disconnected',
                      'NETCONF_DISCONNECTED'
                  );
        const transport = this.transport;
        this._terminate(error);
        if (transport && typeof transport.end === 'function') {
            try {
                transport.end();
            } catch (_error) {
                // The session is already terminal; transport cleanup is best effort.
            }
        }
    }

    close(reason = null) {
        this.disconnect(reason);
    }

    _clearHelloTimer() {
        if (this._helloTimer) {
            clearTimeout(this._helloTimer);
            this._helloTimer = null;
        }
    }

    _rejectPending(error) {
        for (const [messageId, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(withRpcContext(error, pending.requestXml, messageId));
        }
        this.pending.clear();
    }

    _failProtocol(error) {
        this.emit('protocol-error', error);
        this._terminate(error, true);
    }

    _terminate(error, destroyTransport = false) {
        if (this.state === 'closed' && !this._helloReject && this.pending.size === 0) {
            return;
        }
        const terminalError =
            error instanceof Error ? error : new NetconfConnectionError(String(error || 'NETCONF connection closed'));
        const transport = this.transport;
        this.state = 'closed';
        this._clearHelloTimer();
        if (this._helloReject) {
            const reject = this._helloReject;
            this._helloResolve = null;
            this._helloReject = null;
            reject(terminalError);
        }
        this._rejectPending(terminalError);
        this._unbindTransport();
        if (destroyTransport && transport) {
            try {
                if (typeof transport.destroy === 'function') {
                    transport.destroy(terminalError);
                } else if (typeof transport.end === 'function') {
                    transport.end();
                }
            } catch (_cleanupError) {
                // Preserve the protocol or transport error that made the session terminal.
            }
        }
        if (!this._closeEmitted) {
            this._closeEmitted = true;
            this.emit('close', terminalError);
        }
    }
}

module.exports = {
    NetconfClient,
    NetconfConnectionError,
    NetconfProtocolError,
    NetconfTimeoutError,
    ensureRpcEnvelope,
    extractRpcMessageId,
    supportsBase
};
