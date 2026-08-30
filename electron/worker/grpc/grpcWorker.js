const fs = require('fs');
const grpc = require('@grpc/grpc-js');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const GrpcConst = require('../../const/grpcConst');
const { ProtoRegistry, toHex, stripLeadingDot } = require('./protoRegistry');
const { ProtoProjectStore } = require('./protoProjectStore');

const {
    GRPC_EVT_TYPES,
    GRPC_SUB_EVT_TYPES,
    GRPC_REQ_TYPES,
    GRPC_MESSAGE_DIRECTION,
    GRPC_MESSAGE_ROLE,
    GRPC_MESSAGE_STATUS,
    GRPC_STREAM_STATE,
    GRPC_METHOD_KIND,
    DEFAULT_GRPC_SERVER_CONFIG,
    DEFAULT_GRPC_CLIENT_CONFIG,
    DEFAULT_GRPC_SETTINGS
} = GrpcConst;

const SUMMARY_MAX_LENGTH = 160;
const SERVER_SHUTDOWN_TIMEOUT_MS = 3000;

function formatTime(ms = Date.now()) {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}

function buildStartErrorMessage(error, port) {
    const text = String(error && error.message ? error.message : error);
    let hint = '';
    if (/EACCES|EPERM|permission denied/iu.test(text)) {
        hint = `（绑定 ${port} 端口需要管理员/root 权限）`;
    } else if (/EADDRINUSE|address already in use|No address added out of total/iu.test(text)) {
        hint = `（${port} 端口可能已被占用，可修改监听端口后重试）`;
    }
    return 'gRPC服务器启动失败: ' + text + hint;
}

function readFileOrThrow(filePath, label) {
    const normalized = String(filePath || '').trim();
    if (!normalized) {
        throw new Error(`${label}不能为空`);
    }
    if (!fs.existsSync(normalized)) {
        throw new Error(`${label}不存在: ${normalized}`);
    }
    return fs.readFileSync(normalized);
}

function summarizeJson(value) {
    let text;
    try {
        text = JSON.stringify(value);
    } catch (_error) {
        text = String(value);
    }
    text = String(text || '').replace(/\s+/g, ' ');
    if (text.length <= SUMMARY_MAX_LENGTH) {
        return text;
    }
    return text.slice(0, SUMMARY_MAX_LENGTH - 3) + '...';
}

function parseTarget(target) {
    const text = String(target || '').trim();
    if (!text) {
        throw new Error('目标地址不能为空');
    }
    return text;
}

function metadataToObject(metadata) {
    if (!metadata || typeof metadata.getMap !== 'function') {
        return {};
    }
    const output = {};
    const map = metadata.getMap();
    for (const key of Object.keys(map)) {
        const value = map[key];
        output[key] = Buffer.isBuffer(value) ? value.toString('base64') : String(value);
    }
    return output;
}

function buildMetadata(entries) {
    const metadata = new grpc.Metadata();
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || entry.enabled === false) {
            continue;
        }
        const key = String(entry.key || '')
            .trim()
            .toLowerCase();
        if (!key) {
            continue;
        }
        const value = entry.value === undefined || entry.value === null ? '' : String(entry.value);
        if (key.endsWith('-bin')) {
            metadata.add(key, Buffer.from(value, 'base64'));
        } else {
            metadata.add(key, value);
        }
    }
    return metadata;
}

function describeGrpcError(error) {
    if (!error) {
        return null;
    }
    return {
        code: Number.isInteger(error.code) ? error.code : null,
        codeName: Number.isInteger(error.code) ? grpc.status[error.code] || String(error.code) : '',
        details: error.details || error.message || String(error),
        metadata: metadataToObject(error.metadata)
    };
}

class GrpcWorker {
    constructor() {
        this.registry = new ProtoRegistry();
        this.projectStore = new ProtoProjectStore(this.registry);
        this.settings = { ...DEFAULT_GRPC_SETTINGS };
        this.serverConfig = null;
        this.server = null;
        this.boundPort = null;
        this.serverStartedAt = null;

        this.messageHistory = [];
        this.messageCounter = 0;
        this.totalReceived = 0;
        this.totalSent = 0;
        this.lastRecord = null;

        this.streams = new Map();
        this.streamCounter = 0;
        this.clientCalls = new Map();
        this.clientCallCounter = 0;

        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.registerHandlers();
    }

    registerHandlers() {
        const bind = (op, fn) => this.messageHandler.registerHandler(op, fn.bind(this));
        bind(GRPC_REQ_TYPES.COMPILE_PROTOS, this.compileProtos);
        bind(GRPC_REQ_TYPES.GET_PROTO_CATALOG, this.getProtoCatalog);
        bind(GRPC_REQ_TYPES.GET_MESSAGE_TEMPLATE, this.getMessageTemplate);
        bind(GRPC_REQ_TYPES.START_SERVER, this.startServer);
        bind(GRPC_REQ_TYPES.STOP_SERVER, this.stopServer);
        bind(GRPC_REQ_TYPES.GET_MESSAGE_LIST, this.getMessageList);
        bind(GRPC_REQ_TYPES.GET_MESSAGE_DETAIL, this.getMessageDetail);
        bind(GRPC_REQ_TYPES.CLEAR_MESSAGE_HISTORY, this.clearMessageHistory);
        bind(GRPC_REQ_TYPES.GET_STREAM_LIST, this.getStreamList);
        bind(GRPC_REQ_TYPES.SEND_STREAM_MESSAGE, this.sendStreamMessage);
        bind(GRPC_REQ_TYPES.CLOSE_STREAM, this.closeStream);
        bind(GRPC_REQ_TYPES.CLIENT_START_CALL, this.clientStartCall);
        bind(GRPC_REQ_TYPES.CLIENT_SEND_MESSAGE, this.clientSendMessage);
        bind(GRPC_REQ_TYPES.CLIENT_END_CALL, this.clientEndCall);
        bind(GRPC_REQ_TYPES.CLIENT_CANCEL_CALL, this.clientCancelCall);
        bind(GRPC_REQ_TYPES.GET_CLIENT_CALL_LIST, this.getClientCallList);
        bind(GRPC_REQ_TYPES.GET_PROTO_TREE_CHILDREN, this.getProtoTreeChildren);
        bind(GRPC_REQ_TYPES.GET_PROTO_NODE, this.getProtoNode);
        bind(GRPC_REQ_TYPES.SAVE_PROTO_PROJECT, this.saveProtoProject);
        bind(GRPC_REQ_TYPES.LIST_PROTO_PROJECTS, this.listProtoProjects);
        bind(GRPC_REQ_TYPES.IMPORT_PROTO_PROJECT, this.importProtoProject);
        bind(GRPC_REQ_TYPES.EXPORT_PROTO_PROJECT, this.exportProtoProject);
        bind(GRPC_REQ_TYPES.REMOVE_PROTO_PROJECT, this.removeProtoProject);
        bind(GRPC_REQ_TYPES.CLEAR_PROTOS, this.clearProtos);
    }

    emit(type, data, extra = {}) {
        this.messageHandler.sendEvent(GRPC_EVT_TYPES.GRPC_EVT, { type, data, ...extra });
    }

    // ------------------------------------------------------------------
    // Proto 编译
    // ------------------------------------------------------------------

    compileProtos(messageId, request = {}) {
        try {
            if (request && request.logLevel) {
                logger.setLevel(request.logLevel);
            }
            if (this.server) {
                throw new Error('gRPC服务器运行中，请先停止服务器再重新编译');
            }
            const filePaths = Array.isArray(request?.filePaths) ? request.filePaths : [];
            const includeDirs = Array.isArray(request?.includeDirs) ? request.includeDirs : [];
            const catalog = this.registry.loadOrCompile({
                filePaths,
                includeDirs,
                cacheFilePath: request?.cacheFilePath || '',
                force: Boolean(request?.force)
            });
            this.messageHandler.sendSuccessResponse(
                messageId,
                this.buildCatalogResponse(),
                this.registry.cacheHit
                    ? `已从缓存加载 proto：${catalog.summary.serviceCount} 个服务，${catalog.summary.messageCount} 个消息`
                    : `proto 编译成功：${catalog.summary.serviceCount} 个服务，${catalog.summary.messageCount} 个消息`
            );
        } catch (error) {
            logger.error('proto 编译失败:', error);
            this.messageHandler.sendErrorResponse(messageId, error.message, {
                file: error.file || '',
                line: error.line ?? null
            });
        }
    }

    getProtoCatalog(messageId) {
        this.messageHandler.sendSuccessResponse(messageId, this.buildCatalogResponse(), '获取 proto 状态成功');
    }

    /**
     * 只返回轻量状态（文件、服务、汇总）；消息/字段树通过 getProtoTreeChildren 按需加载。
     */
    buildCatalogResponse() {
        return this.registry.getStatus();
    }

    getProtoTreeChildren(messageId, request = {}) {
        try {
            const parentKey = typeof request === 'string' ? request : request?.parentKey || '';
            this.messageHandler.sendSuccessResponse(
                messageId,
                this.registry.getTreeChildren(parentKey),
                '获取 proto 树节点成功'
            );
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    getProtoNode(messageId, request = {}) {
        try {
            const key = typeof request === 'string' ? request : request?.key || request?.fullName || '';
            this.messageHandler.sendSuccessResponse(messageId, this.registry.getTreeNode(key), '获取节点详情成功');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    clearProtos(messageId, request = {}) {
        try {
            if (this.server) {
                throw new Error('gRPC服务器运行中，请先停止服务器');
            }
            this.registry.clearCache(request?.cacheFilePath || '');
            this.registry.clear();
            this.messageHandler.sendSuccessResponse(messageId, this.buildCatalogResponse(), 'proto 配置已清空');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    saveProtoProject(messageId, request = {}) {
        try {
            const result = this.projectStore.save({
                name: request?.name,
                rootDir: request?.projectRootDir,
                cacheFilePath: request?.cacheFilePath
            });
            this.messageHandler.sendSuccessResponse(messageId, result, 'proto 工程保存成功');
        } catch (error) {
            logger.error('保存 proto 工程失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '保存 proto 工程失败: ' + error.message);
        }
    }

    listProtoProjects(messageId, request = {}) {
        try {
            const result = this.projectStore.list({ rootDir: request?.projectRootDir });
            this.messageHandler.sendSuccessResponse(messageId, result, 'proto 工程列表获取成功');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, '获取 proto 工程列表失败: ' + error.message);
        }
    }

    importProtoProject(messageId, request = {}) {
        try {
            if (this.server) {
                throw new Error('gRPC服务器运行中，请先停止服务器再导入工程');
            }
            const result = this.projectStore.import({
                name: request?.name,
                directory: request?.directory,
                rootDir: request?.projectRootDir,
                cacheFilePath: request?.cacheFilePath
            });
            this.messageHandler.sendSuccessResponse(
                messageId,
                { ...result, status: this.buildCatalogResponse() },
                this.registry.cacheHit ? 'proto 工程导入成功（缓存命中）' : 'proto 工程导入成功'
            );
        } catch (error) {
            logger.error('导入 proto 工程失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '导入 proto 工程失败: ' + error.message);
        }
    }

    exportProtoProject(messageId, request = {}) {
        try {
            const result = this.projectStore.export({
                name: request?.name,
                rootDir: request?.projectRootDir,
                targetDir: request?.targetDir
            });
            this.messageHandler.sendSuccessResponse(messageId, result, `proto 工程已导出到 ${result.directory}`);
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, '导出 proto 工程失败: ' + error.message);
        }
    }

    removeProtoProject(messageId, request = {}) {
        try {
            const result = this.projectStore.remove({ name: request?.name, rootDir: request?.projectRootDir });
            this.messageHandler.sendSuccessResponse(messageId, result, 'proto 工程已删除');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, '删除 proto 工程失败: ' + error.message);
        }
    }

    getMessageTemplate(messageId, request = {}) {
        try {
            const typeName = String(request?.typeName || '').trim();
            const template = this.registry.createTemplate(typeName);
            this.messageHandler.sendSuccessResponse(messageId, { typeName, template }, '生成消息模板成功');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, error.message);
        }
    }

    // ------------------------------------------------------------------
    // 服务器
    // ------------------------------------------------------------------

    normalizeServerConfig(config) {
        const merged = { ...DEFAULT_GRPC_SERVER_CONFIG, ...(config || {}) };
        const services = Array.from(
            new Set((Array.isArray(merged.services) ? merged.services : []).map(item => stripLeadingDot(item)))
        ).filter(Boolean);
        const decodeRules = (Array.isArray(merged.decodeRules) ? merged.decodeRules : [])
            .filter(rule => rule && rule.messageType && rule.field && rule.targetType)
            .map(rule => ({
                messageType: stripLeadingDot(rule.messageType),
                field: String(rule.field).trim(),
                targetType: String(rule.targetType).trim()
            }));
        const unaryReplyTemplates = {};
        for (const [key, value] of Object.entries(merged.unaryReplyTemplates || {})) {
            unaryReplyTemplates[stripLeadingDot(key)] = value;
        }
        return {
            host: String(merged.host || DEFAULT_GRPC_SERVER_CONFIG.host).trim() || DEFAULT_GRPC_SERVER_CONFIG.host,
            port: Number(merged.port),
            services,
            decodeRules,
            unaryReplyTemplates,
            tlsEnabled: Boolean(merged.tlsEnabled),
            tlsCertPath: String(merged.tlsCertPath || '').trim(),
            tlsKeyPath: String(merged.tlsKeyPath || '').trim(),
            tlsCaPath: String(merged.tlsCaPath || '').trim(),
            tlsRequireClientCert: Boolean(merged.tlsRequireClientCert),
            maxMessageBytes: Number(merged.maxMessageBytes) || DEFAULT_GRPC_SERVER_CONFIG.maxMessageBytes,
            logLevel: merged.logLevel
        };
    }

    validateServerConfig(config) {
        if (!this.registry.isCompiled()) {
            throw new Error('请先编译 proto 文件');
        }
        if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
            throw new Error('监听端口范围应为 0-65535');
        }
        if (config.services.length === 0) {
            throw new Error('请至少选择一个要托管的 gRPC 服务');
        }
        if (
            !Number.isInteger(config.maxMessageBytes) ||
            config.maxMessageBytes < 1024 ||
            config.maxMessageBytes > 1024 * 1024 * 1024
        ) {
            throw new Error('最大消息长度范围应为 1KB-1GB');
        }
        const available = (this.registry.getCatalog()?.services || []).map(service => service.fullName);
        const missing = config.services.filter(serviceName => !available.includes(serviceName));
        if (missing.length > 0) {
            throw new Error(
                `当前编译结果中不存在服务 ${missing.join('、')}（可用：${available.join('、') || '无'}），请重新编译包含该服务的 proto 或取消勾选`
            );
        }
    }

    buildServerCredentials(config) {
        if (!config.tlsEnabled) {
            return grpc.ServerCredentials.createInsecure();
        }
        const certChain = readFileOrThrow(config.tlsCertPath, 'TLS 证书文件');
        const privateKey = readFileOrThrow(config.tlsKeyPath, 'TLS 私钥文件');
        const rootCerts = config.tlsCaPath ? readFileOrThrow(config.tlsCaPath, 'TLS CA 文件') : null;
        return grpc.ServerCredentials.createSsl(
            rootCerts,
            [{ private_key: privateKey, cert_chain: certChain }],
            Boolean(config.tlsRequireClientCert)
        );
    }

    async startServer(messageId, config) {
        let normalized = null;
        try {
            if (this.server) {
                throw new Error('gRPC服务器已经启动');
            }
            normalized = this.normalizeServerConfig(config);
            if (normalized.logLevel) {
                logger.setLevel(normalized.logLevel);
            }
            this.validateServerConfig(normalized);

            const server = new grpc.Server({
                'grpc.max_receive_message_length': normalized.maxMessageBytes,
                'grpc.max_send_message_length': normalized.maxMessageBytes
            });
            const hosted = [];
            for (const serviceName of normalized.services) {
                const { serviceFullName, definition, service } = this.registry.buildServiceDefinition(serviceName);
                const implementation = {};
                for (const method of service.methodsArray) {
                    implementation[method.name] = this.createServerHandler(
                        serviceFullName,
                        method,
                        definition[method.name]
                    );
                }
                server.addService(definition, implementation);
                hosted.push({
                    fullName: serviceFullName,
                    methods: service.methodsArray.map(method => `${serviceFullName}.${method.name}`)
                });
            }

            const credentials = this.buildServerCredentials(normalized);
            const address = `${normalized.host}:${normalized.port}`;
            const boundPort = await new Promise((resolve, reject) => {
                server.bindAsync(address, credentials, (error, port) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(port);
                });
            });

            this.server = server;
            this.serverConfig = normalized;
            this.boundPort = boundPort;
            this.serverStartedAt = Date.now();
            this.messageHistory = [];
            this.messageCounter = 0;
            this.totalReceived = 0;
            this.totalSent = 0;
            this.lastRecord = null;

            const data = this.buildServerStatus('running', hosted);
            logger.info(`gRPC服务器启动成功: ${address} (bound ${boundPort})`);
            this.messageHandler.sendSuccessResponse(messageId, data, `gRPC服务器启动成功，监听 ${address}`);
            this.emit(GRPC_SUB_EVT_TYPES.SERVER_STATUS, data);
        } catch (error) {
            logger.error('启动gRPC服务器失败:', error);
            const port = normalized ? normalized.port : DEFAULT_GRPC_SERVER_CONFIG.port;
            this.messageHandler.sendErrorResponse(messageId, buildStartErrorMessage(error, port));
        }
    }

    buildServerStatus(status, hosted = null) {
        const config = this.serverConfig || DEFAULT_GRPC_SERVER_CONFIG;
        return {
            status,
            host: config.host,
            port: config.port,
            boundPort: this.boundPort,
            tlsEnabled: Boolean(config.tlsEnabled),
            services: hosted || (config.services || []).map(fullName => ({ fullName, methods: [] })),
            startedAt: this.serverStartedAt ? formatTime(this.serverStartedAt) : '-',
            stats: this.buildStats()
        };
    }

    async stopServer(messageId) {
        try {
            await this.shutdownServer();
            this.messageHandler.sendSuccessResponse(messageId, null, 'gRPC服务器已停止');
        } catch (error) {
            logger.error('停止gRPC服务器失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '停止gRPC服务器失败: ' + error.message);
        }
    }

    async shutdownServer() {
        const server = this.server;
        if (!server) {
            return;
        }
        this.server = null;

        for (const stream of Array.from(this.streams.values())) {
            this.finishStream(stream, GRPC_STREAM_STATE.CLOSED, '服务器停止');
        }

        await new Promise(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };
            const timer = setTimeout(() => {
                try {
                    server.forceShutdown();
                } catch (_error) {
                    // ignore
                }
                finish();
            }, SERVER_SHUTDOWN_TIMEOUT_MS);
            server.tryShutdown(() => {
                clearTimeout(timer);
                finish();
            });
        });

        const data = this.buildServerStatus('stopped');
        this.serverConfig = null;
        this.boundPort = null;
        this.serverStartedAt = null;
        this.messageHistory = [];
        this.lastRecord = null;
        this.emit(GRPC_SUB_EVT_TYPES.SERVER_STATUS, data);
        logger.info('gRPC服务器已停止');
    }

    createServerHandler(serviceFullName, method, methodDefinition) {
        const kind = methodDefinition.requestStream
            ? methodDefinition.responseStream
                ? GRPC_METHOD_KIND.BIDI_STREAM
                : GRPC_METHOD_KIND.CLIENT_STREAM
            : methodDefinition.responseStream
              ? GRPC_METHOD_KIND.SERVER_STREAM
              : GRPC_METHOD_KIND.UNARY;
        const methodInfo = {
            service: serviceFullName,
            method: method.name,
            fullName: `${serviceFullName}.${method.name}`,
            path: methodDefinition.path,
            kind,
            requestType: method.resolvedRequestType,
            responseType: method.resolvedResponseType
        };

        switch (kind) {
            case GRPC_METHOD_KIND.UNARY:
                return (call, callback) => this.handleUnary(methodInfo, call, callback);
            case GRPC_METHOD_KIND.SERVER_STREAM:
                return call => this.handleServerStream(methodInfo, call);
            case GRPC_METHOD_KIND.CLIENT_STREAM:
                return (call, callback) => this.handleClientStream(methodInfo, call, callback);
            default:
                return call => this.handleBidiStream(methodInfo, call);
        }
    }

    handleUnary(methodInfo, call, callback) {
        const peer = this.safePeer(call);
        this.recordInbound(methodInfo, call.request, {
            peer,
            role: GRPC_MESSAGE_ROLE.SERVER,
            metadata: metadataToObject(call.metadata)
        });
        try {
            const reply = this.buildUnaryReply(methodInfo);
            this.recordOutbound(methodInfo, reply.object, reply.buffer, {
                peer,
                role: GRPC_MESSAGE_ROLE.SERVER
            });
            callback(null, reply.buffer);
        } catch (error) {
            logger.error(`gRPC unary 回复失败 (${methodInfo.fullName}):`, error);
            callback({ code: grpc.status.INTERNAL, details: error.message });
        }
    }

    buildUnaryReply(methodInfo) {
        const templates = (this.serverConfig && this.serverConfig.unaryReplyTemplates) || {};
        const template = templates[methodInfo.fullName];
        const object = template && typeof template === 'object' ? template : {};
        const buffer = this.registry.encodeMessage(methodInfo.responseType, object);
        return { object, buffer };
    }

    handleServerStream(methodInfo, call) {
        const stream = this.registerStream(methodInfo, call);
        this.recordInbound(methodInfo, call.request, {
            peer: stream.peer,
            role: GRPC_MESSAGE_ROLE.SERVER,
            streamId: stream.id,
            metadata: stream.metadata
        });
        this.attachStreamLifecycle(stream, call);
    }

    handleClientStream(methodInfo, call, callback) {
        const stream = this.registerStream(methodInfo, call);
        stream.callback = callback;
        call.on('data', request => {
            this.recordInbound(methodInfo, request, {
                peer: stream.peer,
                role: GRPC_MESSAGE_ROLE.SERVER,
                streamId: stream.id
            });
        });
        call.on('end', () => {
            if (stream.state !== GRPC_STREAM_STATE.OPEN) {
                return;
            }
            try {
                const reply = this.buildUnaryReply(methodInfo);
                this.recordOutbound(methodInfo, reply.object, reply.buffer, {
                    peer: stream.peer,
                    role: GRPC_MESSAGE_ROLE.SERVER,
                    streamId: stream.id
                });
                callback(null, reply.buffer);
                this.finishStream(stream, GRPC_STREAM_STATE.CLOSED, '客户端已结束发送');
            } catch (error) {
                callback({ code: grpc.status.INTERNAL, details: error.message });
                this.finishStream(stream, GRPC_STREAM_STATE.ERROR, error.message);
            }
        });
        call.on('error', error => this.finishStream(stream, GRPC_STREAM_STATE.ERROR, error.message));
        call.on('cancelled', () => this.finishStream(stream, GRPC_STREAM_STATE.CLOSED, '客户端取消'));
    }

    handleBidiStream(methodInfo, call) {
        const stream = this.registerStream(methodInfo, call);
        call.on('data', request => {
            this.recordInbound(methodInfo, request, {
                peer: stream.peer,
                role: GRPC_MESSAGE_ROLE.SERVER,
                streamId: stream.id
            });
        });
        call.on('end', () => {
            // 对端结束发送后关闭我方发送端，避免半开流长期占用
            this.finishStream(stream, GRPC_STREAM_STATE.CLOSED, '客户端已结束发送');
        });
        this.attachStreamLifecycle(stream, call);
    }

    attachStreamLifecycle(stream, call) {
        call.on('error', error => this.finishStream(stream, GRPC_STREAM_STATE.ERROR, error.message));
        call.on('cancelled', () => this.finishStream(stream, GRPC_STREAM_STATE.CLOSED, '客户端取消'));
        call.on('close', () => this.finishStream(stream, GRPC_STREAM_STATE.CLOSED, '连接关闭'));
    }

    safePeer(call) {
        try {
            return call.getPeer();
        } catch (_error) {
            return '-';
        }
    }

    registerStream(methodInfo, call) {
        this.streamCounter += 1;
        const stream = {
            id: this.streamCounter,
            call,
            callback: null,
            service: methodInfo.service,
            method: methodInfo.method,
            fullName: methodInfo.fullName,
            kind: methodInfo.kind,
            requestType: stripLeadingDot(methodInfo.requestType.fullName),
            responseType: stripLeadingDot(methodInfo.responseType.fullName),
            responseTypeRef: methodInfo.responseType,
            peer: this.safePeer(call),
            metadata: metadataToObject(call.metadata),
            state: GRPC_STREAM_STATE.OPEN,
            reason: '',
            startedAt: formatTime(),
            startedAtMs: Date.now(),
            endedAt: '-',
            inbound: 0,
            outbound: 0
        };
        this.streams.set(stream.id, stream);
        this.emit(GRPC_SUB_EVT_TYPES.STREAM_UPDATED, this.toStreamSummary(stream), { stats: this.buildStats() });
        return stream;
    }

    finishStream(stream, state, reason) {
        if (!stream || stream.state !== GRPC_STREAM_STATE.OPEN) {
            return;
        }
        stream.state = state;
        stream.reason = reason || '';
        stream.endedAt = formatTime();
        this.streams.delete(stream.id);
        try {
            if (typeof stream.callback === 'function' && state !== GRPC_STREAM_STATE.CLOSED) {
                stream.callback({ code: grpc.status.CANCELLED, details: reason || 'stream closed' });
            } else if (typeof stream.call.end === 'function' && !stream.call.writableEnded) {
                stream.call.end();
            }
        } catch (_error) {
            // ignore close errors
        }
        this.emit(GRPC_SUB_EVT_TYPES.STREAM_UPDATED, this.toStreamSummary(stream), { stats: this.buildStats() });
    }

    toStreamSummary(stream) {
        return {
            id: stream.id,
            service: stream.service,
            method: stream.method,
            fullName: stream.fullName,
            kind: stream.kind,
            requestType: stream.requestType,
            responseType: stream.responseType,
            peer: stream.peer,
            metadata: stream.metadata,
            state: stream.state,
            reason: stream.reason,
            startedAt: stream.startedAt,
            endedAt: stream.endedAt,
            inbound: stream.inbound,
            outbound: stream.outbound,
            canSend:
                stream.state === GRPC_STREAM_STATE.OPEN &&
                (stream.kind === GRPC_METHOD_KIND.BIDI_STREAM || stream.kind === GRPC_METHOD_KIND.SERVER_STREAM)
        };
    }

    getStreamList(messageId) {
        const list = Array.from(this.streams.values()).map(stream => this.toStreamSummary(stream));
        this.messageHandler.sendSuccessResponse(messageId, { list, total: list.length }, '获取流列表成功');
    }

    sendStreamMessage(messageId, request = {}) {
        try {
            const stream = this.streams.get(Number(request?.streamId));
            if (!stream || stream.state !== GRPC_STREAM_STATE.OPEN) {
                throw new Error('流不存在或已关闭');
            }
            if (stream.kind !== GRPC_METHOD_KIND.BIDI_STREAM && stream.kind !== GRPC_METHOD_KIND.SERVER_STREAM) {
                throw new Error('该方法不支持服务端主动发送消息');
            }
            const object = request?.message && typeof request.message === 'object' ? request.message : {};
            const buffer = this.registry.encodeMessage(stream.responseTypeRef, object);
            stream.call.write(buffer);
            const record = this.recordOutbound(
                {
                    service: stream.service,
                    method: stream.method,
                    fullName: stream.fullName,
                    kind: stream.kind,
                    responseType: stream.responseTypeRef
                },
                object,
                buffer,
                { peer: stream.peer, role: GRPC_MESSAGE_ROLE.SERVER, streamId: stream.id }
            );
            this.emit(GRPC_SUB_EVT_TYPES.STREAM_UPDATED, this.toStreamSummary(stream), { stats: this.buildStats() });
            this.messageHandler.sendSuccessResponse(messageId, this.toMessageSummary(record), '消息已下发');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, '下发消息失败: ' + error.message);
        }
    }

    closeStream(messageId, request = {}) {
        const stream = this.streams.get(Number(request?.streamId));
        if (!stream) {
            this.messageHandler.sendErrorResponse(messageId, '流不存在或已关闭');
            return;
        }
        this.finishStream(stream, GRPC_STREAM_STATE.CLOSED, '服务端关闭');
        this.messageHandler.sendSuccessResponse(messageId, null, '流已关闭');
    }

    // ------------------------------------------------------------------
    // 消息记录
    // ------------------------------------------------------------------

    recordInbound(methodInfo, request, options = {}) {
        const raw = request && Buffer.isBuffer(request.raw) ? request.raw : Buffer.alloc(0);
        const message = request && request.message ? request.message : null;
        let decoded = null;
        let warnings = [];
        let status = GRPC_MESSAGE_STATUS.DECODED;
        let error = '';
        try {
            const result = this.registry.decodeMessage(methodInfo.requestType, message || raw, {
                decodeRules: this.serverConfig ? this.serverConfig.decodeRules : [],
                maxRawHexBytes: this.settings.maxRawHexBytes
            });
            decoded = result.value;
            warnings = result.warnings;
            if (warnings.length > 0) {
                status = GRPC_MESSAGE_STATUS.PARTIAL;
            }
        } catch (decodeError) {
            status = GRPC_MESSAGE_STATUS.ERROR;
            error = decodeError.message;
        }

        const record = this.createRecord({
            role: options.role || GRPC_MESSAGE_ROLE.SERVER,
            direction: GRPC_MESSAGE_DIRECTION.INBOUND,
            peer: options.peer || '-',
            methodInfo,
            typeName: stripLeadingDot(methodInfo.requestType.fullName),
            streamId: options.streamId || null,
            callId: options.callId || null,
            metadata: options.metadata || null,
            raw,
            decoded,
            warnings,
            status,
            error
        });
        if (options.streamId && this.streams.has(options.streamId)) {
            this.streams.get(options.streamId).inbound += 1;
        }
        this.totalReceived += 1;
        this.storeRecord(record);
        return record;
    }

    recordOutbound(methodInfo, object, buffer, options = {}) {
        const record = this.createRecord({
            role: options.role || GRPC_MESSAGE_ROLE.SERVER,
            direction: GRPC_MESSAGE_DIRECTION.OUTBOUND,
            peer: options.peer || '-',
            methodInfo,
            typeName: stripLeadingDot(
                (options.typeName && options.typeName) ||
                    (methodInfo.responseType ? methodInfo.responseType.fullName : '')
            ),
            streamId: options.streamId || null,
            callId: options.callId || null,
            metadata: options.metadata || null,
            raw: buffer,
            decoded: object,
            warnings: [],
            status: GRPC_MESSAGE_STATUS.SENT,
            error: ''
        });
        if (options.streamId && this.streams.has(options.streamId)) {
            this.streams.get(options.streamId).outbound += 1;
        }
        this.totalSent += 1;
        this.storeRecord(record);
        return record;
    }

    createRecord(input) {
        this.messageCounter += 1;
        const now = Date.now();
        return {
            id: this.messageCounter,
            timestamp: formatTime(now),
            timestampMs: now,
            role: input.role,
            direction: input.direction,
            peer: input.peer,
            service: input.methodInfo.service,
            method: input.methodInfo.method,
            fullName: input.methodInfo.fullName,
            kind: input.methodInfo.kind,
            typeName: input.typeName,
            streamId: input.streamId,
            callId: input.callId,
            metadata: input.metadata,
            byteLength: input.raw ? input.raw.length : 0,
            rawHex: toHex(input.raw, this.settings.maxRawHexBytes),
            decoded: input.decoded,
            warnings: input.warnings,
            status: input.status,
            error: input.error,
            summary: input.error ? input.error : summarizeJson(input.decoded)
        };
    }

    storeRecord(record) {
        this.messageHistory.unshift(record);
        if (this.messageHistory.length > this.settings.maxHistory) {
            this.messageHistory.length = this.settings.maxHistory;
        }
        this.lastRecord = record;
        this.emit(GRPC_SUB_EVT_TYPES.MESSAGE_RECEIVED, this.toMessageSummary(record), { stats: this.buildStats() });
    }

    toMessageSummary(record) {
        return {
            id: record.id,
            timestamp: record.timestamp,
            role: record.role,
            direction: record.direction,
            peer: record.peer,
            service: record.service,
            method: record.method,
            fullName: record.fullName,
            kind: record.kind,
            typeName: record.typeName,
            streamId: record.streamId,
            callId: record.callId,
            byteLength: record.byteLength,
            status: record.status,
            summary: record.summary
        };
    }

    buildStats() {
        return {
            messageCount: this.messageHistory.length,
            totalReceived: this.totalReceived,
            totalSent: this.totalSent,
            activeStreams: this.streams.size,
            activeClientCalls: Array.from(this.clientCalls.values()).filter(
                call => call.state === GRPC_STREAM_STATE.OPEN
            ).length,
            lastMessageAt: this.lastRecord ? this.lastRecord.timestamp : '-',
            lastPeer: this.lastRecord ? this.lastRecord.peer : '-',
            lastMethod: this.lastRecord ? this.lastRecord.fullName : '-'
        };
    }

    getMessageList(messageId, query = {}) {
        const page = Math.max(1, Number(query?.page) || 1);
        const pageSize = Math.min(500, Math.max(1, Number(query?.pageSize) || 20));
        const role = query?.role ? String(query.role) : '';
        const direction = query?.direction ? String(query.direction) : '';
        const callId = Number(query?.callId) || 0;
        const streamId = Number(query?.streamId) || 0;
        const keyword = String(query?.keyword || '')
            .trim()
            .toLowerCase();

        const filtered = this.messageHistory.filter(record => {
            if (role && record.role !== role) {
                return false;
            }
            if (direction && record.direction !== direction) {
                return false;
            }
            if (callId && record.callId !== callId) {
                return false;
            }
            if (streamId && record.streamId !== streamId) {
                return false;
            }
            if (keyword) {
                const haystack = `${record.fullName} ${record.peer} ${record.summary}`.toLowerCase();
                if (!haystack.includes(keyword)) {
                    return false;
                }
            }
            return true;
        });
        const start = (page - 1) * pageSize;
        this.messageHandler.sendSuccessResponse(
            messageId,
            {
                list: filtered.slice(start, start + pageSize).map(record => this.toMessageSummary(record)),
                total: filtered.length,
                page,
                pageSize,
                stats: this.buildStats()
            },
            '获取gRPC消息列表成功'
        );
    }

    getMessageDetail(messageId, id) {
        const recordId = Number(id);
        const record = this.messageHistory.find(item => item.id === recordId);
        if (!record) {
            this.messageHandler.sendErrorResponse(messageId, '消息不存在或已被清理');
            return;
        }
        this.messageHandler.sendSuccessResponse(messageId, record, '获取gRPC消息详情成功');
    }

    clearMessageHistory(messageId) {
        this.messageHistory = [];
        this.lastRecord = null;
        this.messageHandler.sendSuccessResponse(messageId, null, 'gRPC消息记录已清空');
        this.emit(GRPC_SUB_EVT_TYPES.HISTORY_CLEARED, null, { stats: this.buildStats() });
    }

    // ------------------------------------------------------------------
    // 客户端（下发）
    // ------------------------------------------------------------------

    normalizeClientConfig(request) {
        const merged = { ...DEFAULT_GRPC_CLIENT_CONFIG, ...(request || {}) };
        return {
            target: parseTarget(merged.target),
            tlsEnabled: Boolean(merged.tlsEnabled),
            tlsCaPath: String(merged.tlsCaPath || '').trim(),
            tlsCertPath: String(merged.tlsCertPath || '').trim(),
            tlsKeyPath: String(merged.tlsKeyPath || '').trim(),
            tlsServerName: String(merged.tlsServerName || '').trim(),
            metadata: Array.isArray(merged.metadata) ? merged.metadata : [],
            timeoutMs: Number(merged.timeoutMs) || 0,
            method: stripLeadingDot(merged.method),
            message: merged.message && typeof merged.message === 'object' ? merged.message : {},
            decodeRules: Array.isArray(merged.decodeRules) ? merged.decodeRules : [],
            maxMessageBytes: Number(merged.maxMessageBytes) || DEFAULT_GRPC_SERVER_CONFIG.maxMessageBytes
        };
    }

    buildClientCredentials(config) {
        if (!config.tlsEnabled) {
            return grpc.credentials.createInsecure();
        }
        const rootCerts = config.tlsCaPath ? readFileOrThrow(config.tlsCaPath, 'TLS CA 文件') : null;
        const privateKey = config.tlsKeyPath ? readFileOrThrow(config.tlsKeyPath, 'TLS 私钥文件') : null;
        const certChain = config.tlsCertPath ? readFileOrThrow(config.tlsCertPath, 'TLS 证书文件') : null;
        return grpc.credentials.createSsl(rootCerts, privateKey, certChain);
    }

    clientStartCall(messageId, request = {}) {
        let config = null;
        try {
            if (!this.registry.isCompiled()) {
                throw new Error('请先编译 proto 文件');
            }
            config = this.normalizeClientConfig(request);
            if (!config.method) {
                throw new Error('请选择要调用的方法');
            }
            const { service, method } = this.registry.findMethod(config.method);
            const serviceFullName = stripLeadingDot(service.fullName);
            const { definition } = this.registry.buildServiceDefinition(serviceFullName);
            const methodDefinition = definition[method.name];
            const kind = methodDefinition.requestStream
                ? methodDefinition.responseStream
                    ? GRPC_METHOD_KIND.BIDI_STREAM
                    : GRPC_METHOD_KIND.CLIENT_STREAM
                : methodDefinition.responseStream
                  ? GRPC_METHOD_KIND.SERVER_STREAM
                  : GRPC_METHOD_KIND.UNARY;
            const methodInfo = {
                service: serviceFullName,
                method: method.name,
                fullName: `${serviceFullName}.${method.name}`,
                path: methodDefinition.path,
                kind,
                requestType: method.resolvedRequestType,
                responseType: method.resolvedResponseType
            };

            const channelOptions = {
                'grpc.max_receive_message_length': config.maxMessageBytes,
                'grpc.max_send_message_length': config.maxMessageBytes
            };
            if (config.tlsServerName) {
                channelOptions['grpc.ssl_target_name_override'] = config.tlsServerName;
                channelOptions['grpc.default_authority'] = config.tlsServerName;
            }
            const client = new grpc.Client(config.target, this.buildClientCredentials(config), channelOptions);
            const metadata = buildMetadata(config.metadata);
            const callOptions = {};
            if (config.timeoutMs > 0) {
                callOptions.deadline = new Date(Date.now() + config.timeoutMs);
            }

            this.clientCallCounter += 1;
            const callRecord = {
                id: this.clientCallCounter,
                client,
                call: null,
                target: config.target,
                tlsEnabled: config.tlsEnabled,
                methodInfo,
                fullName: methodInfo.fullName,
                kind,
                requestType: stripLeadingDot(method.resolvedRequestType.fullName),
                responseType: stripLeadingDot(method.resolvedResponseType.fullName),
                decodeRules: config.decodeRules,
                state: GRPC_STREAM_STATE.OPEN,
                startedAt: formatTime(),
                startedAtMs: Date.now(),
                endedAt: '-',
                durationMs: null,
                requests: 0,
                responses: 0,
                statusCode: null,
                statusName: '',
                statusDetails: '',
                responseMetadata: {},
                trailers: {},
                lastResponseId: null,
                lastError: null
            };
            this.clientCalls.set(callRecord.id, callRecord);
            this.trimClientCalls();

            const deserializer = buffer => methodDefinition.responseDeserialize(buffer);
            const serializer = value => methodDefinition.requestSerialize(value);
            const onStatus = status => {
                callRecord.statusCode = status.code;
                callRecord.statusName = grpc.status[status.code] || String(status.code);
                callRecord.statusDetails = status.details || '';
                callRecord.trailers = metadataToObject(status.metadata);
                this.finishClientCall(
                    callRecord,
                    status.code === grpc.status.OK ? GRPC_STREAM_STATE.CLOSED : GRPC_STREAM_STATE.ERROR,
                    status.details || ''
                );
            };
            const onMetadata = responseMetadata => {
                callRecord.responseMetadata = metadataToObject(responseMetadata);
                this.emitClientCall(callRecord);
            };
            const onResponse = response => {
                const record = this.recordClientResponse(callRecord, response);
                callRecord.responses += 1;
                callRecord.lastResponseId = record.id;
                this.emitClientCall(callRecord);
            };
            const onError = error => {
                callRecord.lastError = describeGrpcError(error);
                callRecord.statusCode = callRecord.lastError.code;
                callRecord.statusName = callRecord.lastError.codeName;
                callRecord.statusDetails = callRecord.lastError.details;
                callRecord.trailers = callRecord.lastError.metadata;
                this.finishClientCall(callRecord, GRPC_STREAM_STATE.ERROR, callRecord.lastError.details);
            };

            let initialBuffer = null;
            if (kind === GRPC_METHOD_KIND.UNARY || kind === GRPC_METHOD_KIND.SERVER_STREAM) {
                initialBuffer = this.registry.encodeMessage(method.resolvedRequestType, config.message);
            }

            if (kind === GRPC_METHOD_KIND.UNARY) {
                callRecord.call = client.makeUnaryRequest(
                    methodDefinition.path,
                    serializer,
                    deserializer,
                    initialBuffer,
                    metadata,
                    callOptions,
                    (error, response) => {
                        if (error) {
                            onError(error);
                            return;
                        }
                        onResponse(response);
                    }
                );
                callRecord.call.on('metadata', onMetadata);
                callRecord.call.on('status', status => {
                    callRecord.trailers = metadataToObject(status.metadata);
                    if (status.code === grpc.status.OK) {
                        onStatus(status);
                    }
                });
            } else if (kind === GRPC_METHOD_KIND.SERVER_STREAM) {
                callRecord.call = client.makeServerStreamRequest(
                    methodDefinition.path,
                    serializer,
                    deserializer,
                    initialBuffer,
                    metadata,
                    callOptions
                );
                callRecord.call.on('data', onResponse);
                callRecord.call.on('metadata', onMetadata);
                callRecord.call.on('error', onError);
                callRecord.call.on('status', onStatus);
            } else if (kind === GRPC_METHOD_KIND.CLIENT_STREAM) {
                callRecord.call = client.makeClientStreamRequest(
                    methodDefinition.path,
                    serializer,
                    deserializer,
                    metadata,
                    callOptions,
                    (error, response) => {
                        if (error) {
                            onError(error);
                            return;
                        }
                        onResponse(response);
                    }
                );
                callRecord.call.on('metadata', onMetadata);
                callRecord.call.on('status', status => {
                    if (status.code === grpc.status.OK) {
                        onStatus(status);
                    }
                });
            } else {
                callRecord.call = client.makeBidiStreamRequest(
                    methodDefinition.path,
                    serializer,
                    deserializer,
                    metadata,
                    callOptions
                );
                callRecord.call.on('data', onResponse);
                callRecord.call.on('metadata', onMetadata);
                callRecord.call.on('error', onError);
                callRecord.call.on('status', onStatus);
            }

            if (initialBuffer) {
                this.recordOutbound(methodInfo, config.message, initialBuffer, {
                    peer: config.target,
                    role: GRPC_MESSAGE_ROLE.CLIENT,
                    callId: callRecord.id,
                    typeName: callRecord.requestType
                });
                callRecord.requests += 1;
            } else if (config.message && Object.keys(config.message).length > 0) {
                this.writeClientMessage(callRecord, config.message);
            }

            this.emitClientCall(callRecord);
            this.messageHandler.sendSuccessResponse(messageId, this.toClientCallSummary(callRecord), '调用已发起');
        } catch (error) {
            logger.error('gRPC 客户端调用失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '调用失败: ' + error.message);
        }
    }

    trimClientCalls() {
        const limit = Math.max(1, Number(this.settings.maxClientCalls) || DEFAULT_GRPC_SETTINGS.maxClientCalls);
        if (this.clientCalls.size <= limit) {
            return;
        }
        for (const [id, call] of this.clientCalls) {
            if (this.clientCalls.size <= limit) {
                break;
            }
            if (call.state !== GRPC_STREAM_STATE.OPEN) {
                this.clientCalls.delete(id);
            }
        }
    }

    writeClientMessage(callRecord, message) {
        const buffer = this.registry.encodeMessage(callRecord.methodInfo.requestType, message);
        callRecord.call.write(buffer);
        callRecord.requests += 1;
        return this.recordOutbound(callRecord.methodInfo, message, buffer, {
            peer: callRecord.target,
            role: GRPC_MESSAGE_ROLE.CLIENT,
            callId: callRecord.id,
            typeName: callRecord.requestType
        });
    }

    recordClientResponse(callRecord, response) {
        const raw = response && Buffer.isBuffer(response.raw) ? response.raw : Buffer.alloc(0);
        const message = response && response.message ? response.message : null;
        let decoded = null;
        let warnings = [];
        let status = GRPC_MESSAGE_STATUS.DECODED;
        let error = '';
        try {
            const result = this.registry.decodeMessage(callRecord.methodInfo.responseType, message || raw, {
                decodeRules: callRecord.decodeRules,
                maxRawHexBytes: this.settings.maxRawHexBytes
            });
            decoded = result.value;
            warnings = result.warnings;
            if (warnings.length > 0) {
                status = GRPC_MESSAGE_STATUS.PARTIAL;
            }
        } catch (decodeError) {
            status = GRPC_MESSAGE_STATUS.ERROR;
            error = decodeError.message;
        }
        const record = this.createRecord({
            role: GRPC_MESSAGE_ROLE.CLIENT,
            direction: GRPC_MESSAGE_DIRECTION.INBOUND,
            peer: callRecord.target,
            methodInfo: callRecord.methodInfo,
            typeName: callRecord.responseType,
            streamId: null,
            callId: callRecord.id,
            metadata: null,
            raw,
            decoded,
            warnings,
            status,
            error
        });
        this.totalReceived += 1;
        this.storeRecord(record);
        return record;
    }

    finishClientCall(callRecord, state, reason) {
        if (callRecord.state !== GRPC_STREAM_STATE.OPEN) {
            return;
        }
        callRecord.state = state;
        callRecord.endedAt = formatTime();
        callRecord.durationMs = Math.max(0, Date.now() - (callRecord.startedAtMs || Date.now()));
        callRecord.reason = reason || '';
        try {
            callRecord.client.close();
        } catch (_error) {
            // ignore
        }
        this.emitClientCall(callRecord);
    }

    emitClientCall(callRecord) {
        this.emit(GRPC_SUB_EVT_TYPES.CLIENT_CALL_UPDATED, this.toClientCallSummary(callRecord), {
            stats: this.buildStats()
        });
    }

    toClientCallSummary(callRecord) {
        return {
            id: callRecord.id,
            target: callRecord.target,
            tlsEnabled: callRecord.tlsEnabled,
            fullName: callRecord.fullName,
            kind: callRecord.kind,
            requestType: callRecord.requestType,
            responseType: callRecord.responseType,
            state: callRecord.state,
            reason: callRecord.reason || '',
            startedAt: callRecord.startedAt,
            endedAt: callRecord.endedAt,
            durationMs: callRecord.durationMs ?? Math.max(0, Date.now() - (callRecord.startedAtMs || Date.now())),
            requests: callRecord.requests,
            responses: callRecord.responses,
            statusCode: callRecord.statusCode,
            statusName: callRecord.statusName,
            statusDetails: callRecord.statusDetails,
            responseMetadata: callRecord.responseMetadata,
            trailers: callRecord.trailers,
            lastResponseId: callRecord.lastResponseId,
            lastError: callRecord.lastError,
            canSend:
                callRecord.state === GRPC_STREAM_STATE.OPEN &&
                (callRecord.kind === GRPC_METHOD_KIND.CLIENT_STREAM || callRecord.kind === GRPC_METHOD_KIND.BIDI_STREAM)
        };
    }

    clientSendMessage(messageId, request = {}) {
        try {
            const callRecord = this.clientCalls.get(Number(request?.callId));
            if (!callRecord || callRecord.state !== GRPC_STREAM_STATE.OPEN) {
                throw new Error('调用不存在或已结束');
            }
            if (
                callRecord.kind !== GRPC_METHOD_KIND.CLIENT_STREAM &&
                callRecord.kind !== GRPC_METHOD_KIND.BIDI_STREAM
            ) {
                throw new Error('该方法不支持继续发送消息');
            }
            const message = request?.message && typeof request.message === 'object' ? request.message : {};
            const record = this.writeClientMessage(callRecord, message);
            this.emitClientCall(callRecord);
            this.messageHandler.sendSuccessResponse(messageId, this.toMessageSummary(record), '消息已发送');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, '发送消息失败: ' + error.message);
        }
    }

    clientEndCall(messageId, request = {}) {
        const callRecord = this.clientCalls.get(Number(request?.callId));
        if (!callRecord || callRecord.state !== GRPC_STREAM_STATE.OPEN) {
            this.messageHandler.sendErrorResponse(messageId, '调用不存在或已结束');
            return;
        }
        try {
            if (typeof callRecord.call.end === 'function') {
                callRecord.call.end();
            }
            this.messageHandler.sendSuccessResponse(messageId, this.toClientCallSummary(callRecord), '已结束发送');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, '结束发送失败: ' + error.message);
        }
    }

    clientCancelCall(messageId, request = {}) {
        const callRecord = this.clientCalls.get(Number(request?.callId));
        if (!callRecord) {
            this.messageHandler.sendErrorResponse(messageId, '调用不存在');
            return;
        }
        try {
            if (callRecord.state === GRPC_STREAM_STATE.OPEN && typeof callRecord.call.cancel === 'function') {
                callRecord.call.cancel();
            }
            this.finishClientCall(callRecord, GRPC_STREAM_STATE.CLOSED, '本地取消');
            this.messageHandler.sendSuccessResponse(messageId, this.toClientCallSummary(callRecord), '调用已取消');
        } catch (error) {
            this.messageHandler.sendErrorResponse(messageId, '取消调用失败: ' + error.message);
        }
    }

    getClientCallList(messageId) {
        const list = Array.from(this.clientCalls.values())
            .map(call => this.toClientCallSummary(call))
            .sort((a, b) => b.id - a.id);
        this.messageHandler.sendSuccessResponse(messageId, { list, total: list.length }, '获取调用列表成功');
    }

    async dispose() {
        for (const callRecord of this.clientCalls.values()) {
            if (callRecord.state === GRPC_STREAM_STATE.OPEN) {
                try {
                    callRecord.call.cancel();
                } catch (_error) {
                    // ignore
                }
                this.finishClientCall(callRecord, GRPC_STREAM_STATE.CLOSED, 'worker 退出');
            }
        }
        await this.shutdownServer();
    }
}

module.exports = GrpcWorker;

if (require.main === module || process.env.NETNEXUS_PROTOCOL_SERVICE) {
    new GrpcWorker();
}
