const { errorResponse, successResponse } = require('./common');

const grpcPageApiScript = [
    '    window.grpcApi = {',
    "        startRuntime: () => call('grpc.startRuntime'),",
    "        stopRuntime: () => call('grpc.stopRuntime'),",
    "        getRuntimeState: () => call('grpc.getRuntimeState'),",
    "        getProtoConfig: () => call('grpc.getProtoConfig'),",
    "        selectProtoFiles: () => call('grpc.selectProtoFiles'),",
    "        selectProtoDirectory: () => call('grpc.selectProtoDirectory'),",
    "        compileProtos: payload => call('grpc.compileProtos', payload),",
    "        getProtoCatalog: () => call('grpc.getProtoCatalog'),",
    "        clearProtos: () => call('grpc.clearProtos'),",
    "        getProtoTreeChildren: parentKey => call('grpc.getProtoTreeChildren', parentKey),",
    "        getProtoNode: key => call('grpc.getProtoNode', key),",
    "        saveProtoProject: payload => call('grpc.saveProtoProject', payload),",
    "        listProtoProjects: () => call('grpc.listProtoProjects'),",
    "        importProtoProject: payload => call('grpc.importProtoProject', payload),",
    "        exportProtoProject: payload => call('grpc.exportProtoProject', payload),",
    "        removeProtoProject: payload => call('grpc.removeProtoProject', payload),",
    "        selectDirectory: payload => call('grpc.selectDirectory', payload),",
    "        getMessageTemplate: typeName => call('grpc.getMessageTemplate', typeName),",
    "        saveServerConfig: config => call('grpc.saveServerConfig', config),",
    "        getServerConfig: () => call('grpc.getServerConfig'),",
    "        startServer: config => call('grpc.startServer', config),",
    "        stopServer: () => call('grpc.stopServer'),",
    "        getServerStatus: () => call('grpc.getServerStatus'),",
    "        getMessageList: query => call('grpc.getMessageList', query),",
    "        getMessageDetail: id => call('grpc.getMessageDetail', id),",
    "        clearMessageHistory: () => call('grpc.clearMessageHistory'),",
    "        getStreamList: () => call('grpc.getStreamList'),",
    "        sendStreamMessage: payload => call('grpc.sendStreamMessage', payload),",
    "        closeStream: payload => call('grpc.closeStream', payload),",
    "        saveClientConfig: config => call('grpc.saveClientConfig', config),",
    "        getClientConfig: () => call('grpc.getClientConfig'),",
    "        clientStartCall: payload => call('grpc.clientStartCall', payload),",
    "        clientSendMessage: payload => call('grpc.clientSendMessage', payload),",
    "        clientEndCall: payload => call('grpc.clientEndCall', payload),",
    "        clientCancelCall: payload => call('grpc.clientCancelCall', payload),",
    "        getClientCallList: () => call('grpc.getClientCallList')",
    '    };'
].join('\n');

const GRPC_SUB_EVT_TYPES = {
    MESSAGE_RECEIVED: 1,
    SERVER_STATUS: 2,
    HISTORY_CLEARED: 3,
    STATS_UPDATED: 4,
    STREAM_UPDATED: 5,
    CLIENT_CALL_UPDATED: 6
};

const TEMPLATES = {
    'gnmi.GetRequest': { path: [{ elem: [{ name: '' }] }], type: 'ALL', encoding: 'JSON' },
    'gnmi.GetResponse': { notification: [] },
    'gnmi.SubscribeRequest': { subscribe: { subscription: [] } },
    'gnmi.SubscribeResponse': { update: { timestamp: '0', update: [] } },
    'huawei_dialout.serviceArgs': { ReqId: '0', data: '', errors: '' }
};

const services = [
    {
        fullName: 'gnmi.gNMI',
        file: 'gnmi.proto',
        methods: [
            {
                name: 'Get',
                fullName: 'gnmi.gNMI.Get',
                kind: 'unary',
                requestType: 'gnmi.GetRequest',
                responseType: 'gnmi.GetResponse'
            },
            {
                name: 'Subscribe',
                fullName: 'gnmi.gNMI.Subscribe',
                kind: 'bidi-stream',
                requestType: 'gnmi.SubscribeRequest',
                responseType: 'gnmi.SubscribeResponse'
            }
        ]
    },
    {
        fullName: 'huawei_dialout.gRPCDataservice',
        file: 'huawei-grpc-dialout.proto',
        methods: [
            {
                name: 'dataPublish',
                fullName: 'huawei_dialout.gRPCDataservice.dataPublish',
                kind: 'bidi-stream',
                requestType: 'huawei_dialout.serviceArgs',
                responseType: 'huawei_dialout.serviceArgs'
            }
        ]
    }
];

const findMethod = fullName =>
    services
        .flatMap(service => service.methods.map(method => ({ service, method })))
        .find(item => item.method.fullName === fullName);

function createGrpcPageState(now) {
    return {
        now,
        runtime: { running: true, starting: false, serverRunning: false },
        clientConfig: null,
        serverConfig: null,
        serverRunning: false,
        calls: [],
        streams: [],
        messages: [],
        messageCounter: 0,
        callCounter: 0,
        streamCounter: 0,
        totalReceived: 0,
        totalSent: 0
    };
}

function buildStats(grpc) {
    return {
        messageCount: grpc.messages.length,
        totalReceived: grpc.totalReceived,
        totalSent: grpc.totalSent,
        activeStreams: grpc.streams.filter(stream => stream.state === 'open').length
    };
}

function emitGrpc(controller, type, data) {
    controller.emitEvent('grpc:event', successResponse({ type, data, stats: buildStats(controller.state.grpc) }));
}

function pushMessage(grpc, input) {
    grpc.messageCounter += 1;
    const record = {
        id: grpc.messageCounter,
        timestamp: grpc.now,
        role: input.role,
        direction: input.direction,
        peer: input.peer,
        fullName: input.fullName,
        kind: input.kind,
        typeName: input.typeName,
        streamId: input.streamId || null,
        callId: input.callId || null,
        metadata: input.metadata || null,
        byteLength: JSON.stringify(input.decoded).length,
        rawHex: '0a0b0c',
        decoded: input.decoded,
        warnings: input.warnings || [],
        status: input.direction === 'outbound' ? 'sent' : 'decoded',
        error: '',
        summary: JSON.stringify(input.decoded)
    };
    grpc.messages.unshift(record);
    if (input.direction === 'inbound') grpc.totalReceived += 1;
    else grpc.totalSent += 1;
    return record;
}

const toMessageSummary = record => {
    const summary = { ...record };
    ['decoded', 'rawHex', 'warnings', 'metadata'].forEach(key => delete summary[key]);
    return summary;
};

function buildStreamSummary(stream) {
    return {
        ...stream,
        canSend: stream.state === 'open' && (stream.kind === 'bidi-stream' || stream.kind === 'server-stream')
    };
}

function handlePageCall(controller, method, args) {
    const grpc = controller.state.grpc;
    const payload = args[0] || {};

    if (method === 'grpc.getRuntimeState') return successResponse({ ...grpc.runtime });
    if (method === 'grpc.startRuntime' || method === 'grpc.stopRuntime') {
        grpc.runtime.running = method === 'grpc.startRuntime';
        controller.emitEvent('grpc:runtimeChanged', { ...grpc.runtime });
        return successResponse({ ...grpc.runtime });
    }
    if (method === 'grpc.getProtoConfig' || method === 'grpc.getProtoCatalog') {
        return successResponse({ compiled: true, files: [], services, summary: { services: services.length } });
    }
    if (method === 'grpc.getProtoNode') {
        const found = findMethod(args[0]);
        if (found) {
            return successResponse({
                node: { kind: 'method', fullName: found.method.fullName, title: found.method.name },
                detail: {
                    kind: found.method.kind,
                    path: `/${found.service.fullName}/${found.method.name}`,
                    requestType: found.method.requestType,
                    responseType: found.method.responseType,
                    comment: ''
                }
            });
        }
        const service = services.find(item => item.fullName === args[0]);
        if (!service) return errorResponse('节点不存在');
        return successResponse({
            node: { kind: 'service', fullName: service.fullName, title: service.fullName },
            detail: { file: service.file, methods: service.methods }
        });
    }
    if (method === 'grpc.getMessageTemplate') {
        return successResponse({ typeName: args[0], template: TEMPLATES[args[0]] || {} });
    }

    // ------------------------------------------------------------------ 配置
    if (method === 'grpc.getClientConfig') return successResponse(grpc.clientConfig);
    if (method === 'grpc.saveClientConfig') {
        grpc.clientConfig = payload;
        return successResponse(null);
    }
    if (method === 'grpc.getServerConfig') return successResponse(grpc.serverConfig);
    if (method === 'grpc.saveServerConfig') {
        grpc.serverConfig = payload;
        return successResponse(null);
    }

    // ------------------------------------------------------------------ 客户端
    if (method === 'grpc.clientStartCall') {
        const found = findMethod(payload.method);
        if (!found) return errorResponse('方法不存在: ' + payload.method);
        grpc.callCounter += 1;
        const call = {
            id: grpc.callCounter,
            target: payload.target,
            tlsEnabled: Boolean(payload.tlsEnabled),
            fullName: found.method.fullName,
            kind: found.method.kind,
            requestType: found.method.requestType,
            responseType: found.method.responseType,
            state: 'open',
            reason: '',
            startedAt: grpc.now,
            endedAt: '-',
            durationMs: 12,
            requests: 0,
            responses: 0,
            statusCode: null,
            statusName: '',
            statusDetails: '',
            responseMetadata: {},
            trailers: {},
            lastResponseId: null,
            lastError: null,
            canSend: found.method.kind === 'bidi-stream' || found.method.kind === 'client-stream',
            requestMetadata: Array.isArray(payload.metadata) ? payload.metadata : []
        };
        grpc.calls.unshift(call);
        const messageBase = {
            role: 'client',
            peer: payload.target,
            fullName: call.fullName,
            kind: call.kind,
            callId: call.id
        };
        if (call.kind === 'unary' || call.kind === 'server-stream') {
            pushMessage(grpc, {
                ...messageBase,
                direction: 'outbound',
                typeName: call.requestType,
                decoded: payload.message || {}
            });
            call.requests = 1;
            const response = pushMessage(grpc, {
                ...messageBase,
                direction: 'inbound',
                typeName: call.responseType,
                decoded: { notification: [{ timestamp: '1700000000', update: [{ path: 'system/hostname' }] }] }
            });
            call.responses = 1;
            call.lastResponseId = response.id;
            call.responseMetadata = { 'content-type': 'application/grpc', 'x-e2e': 'mock' };
            call.trailers = { 'grpc-status': '0' };
            call.state = 'closed';
            call.statusCode = 0;
            call.statusName = 'OK';
            call.endedAt = grpc.now;
            call.canSend = false;
        }
        setTimeout(() => emitGrpc(controller, GRPC_SUB_EVT_TYPES.CLIENT_CALL_UPDATED, { ...call }), 20);
        return successResponse({ id: call.id }, '调用已发起');
    }
    if (method === 'grpc.clientSendMessage') {
        const call = grpc.calls.find(item => item.id === Number(payload.callId));
        if (!call || call.state !== 'open') return errorResponse('调用不存在或已结束');
        pushMessage(grpc, {
            role: 'client',
            peer: call.target,
            fullName: call.fullName,
            kind: call.kind,
            callId: call.id,
            direction: 'outbound',
            typeName: call.requestType,
            decoded: payload.message || {}
        });
        call.requests += 1;
        const response = pushMessage(grpc, {
            role: 'client',
            peer: call.target,
            fullName: call.fullName,
            kind: call.kind,
            callId: call.id,
            direction: 'inbound',
            typeName: call.responseType,
            decoded: { update: { timestamp: '1700000001', update: [{ path: 'interfaces/interface' }] } }
        });
        call.responses += 1;
        call.lastResponseId = response.id;
        setTimeout(() => emitGrpc(controller, GRPC_SUB_EVT_TYPES.CLIENT_CALL_UPDATED, { ...call }), 20);
        return successResponse({ id: response.id }, '消息已发送');
    }
    if (method === 'grpc.clientEndCall' || method === 'grpc.clientCancelCall') {
        const call = grpc.calls.find(item => item.id === Number(payload.callId));
        if (!call || call.state !== 'open') return errorResponse('调用不存在或已结束');
        call.state = 'closed';
        call.canSend = false;
        call.statusCode = method === 'grpc.clientEndCall' ? 0 : 1;
        call.statusName = method === 'grpc.clientEndCall' ? 'OK' : 'CANCELLED';
        call.reason = method === 'grpc.clientEndCall' ? '' : '本地取消';
        call.endedAt = grpc.now;
        call.trailers = { 'grpc-status': String(call.statusCode) };
        setTimeout(() => emitGrpc(controller, GRPC_SUB_EVT_TYPES.CLIENT_CALL_UPDATED, { ...call }), 20);
        return successResponse(null);
    }
    if (method === 'grpc.getClientCallList') {
        return successResponse({ list: grpc.calls.map(call => ({ ...call })), total: grpc.calls.length });
    }

    // ------------------------------------------------------------------ 服务器
    if (method === 'grpc.getServerStatus') {
        return successResponse({
            running: grpc.serverRunning,
            status: {
                status: grpc.serverRunning ? 'running' : 'stopped',
                boundPort: grpc.serverRunning ? Number(grpc.serverConfig?.port) || 57400 : null,
                stats: buildStats(grpc)
            }
        });
    }
    if (method === 'grpc.startServer') {
        grpc.serverRunning = true;
        grpc.runtime.serverRunning = true;
        grpc.serverConfig = payload;
        const status = { status: 'running', boundPort: Number(payload.port) || 57400, stats: buildStats(grpc) };
        // 模拟一台设备接入并上报一条消息
        setTimeout(() => {
            const serviceName = (payload.services || [])[0];
            const service = services.find(item => item.fullName === serviceName) || services[1];
            const streamMethod = service.methods.find(item => item.kind !== 'unary') || service.methods[0];
            grpc.streamCounter += 1;
            const stream = {
                id: grpc.streamCounter,
                peer: '192.0.2.10:40001',
                fullName: streamMethod.fullName,
                kind: streamMethod.kind,
                requestType: streamMethod.requestType,
                responseType: streamMethod.responseType,
                state: 'open',
                startedAt: grpc.now,
                inbound: 0,
                outbound: 0,
                metadata: { 'user-agent': 'grpc-e2e-device' }
            };
            grpc.streams.push(stream);
            pushMessage(grpc, {
                role: 'server',
                peer: stream.peer,
                fullName: stream.fullName,
                kind: stream.kind,
                streamId: stream.id,
                direction: 'inbound',
                typeName: stream.requestType,
                decoded: { ReqId: '1', data: { sensor_path: 'huawei-ifm:ifm/interfaces/interface' } }
            });
            stream.inbound += 1;
            emitGrpc(controller, GRPC_SUB_EVT_TYPES.STREAM_UPDATED, buildStreamSummary(stream));
        }, 30);
        emitGrpc(controller, GRPC_SUB_EVT_TYPES.SERVER_STATUS, status);
        return successResponse(status, 'gRPC服务器启动成功');
    }
    if (method === 'grpc.stopServer') {
        grpc.serverRunning = false;
        grpc.runtime.serverRunning = false;
        grpc.streams.forEach(stream => (stream.state = 'closed'));
        grpc.streams = [];
        const status = { status: 'stopped', boundPort: null, stats: buildStats(grpc) };
        emitGrpc(controller, GRPC_SUB_EVT_TYPES.SERVER_STATUS, status);
        return successResponse(status, 'gRPC服务器已停止');
    }
    if (method === 'grpc.getStreamList') {
        return successResponse({ list: grpc.streams.map(buildStreamSummary), total: grpc.streams.length });
    }
    if (method === 'grpc.sendStreamMessage') {
        const stream = grpc.streams.find(item => item.id === Number(payload.streamId));
        if (!stream || stream.state !== 'open') return errorResponse('流不存在或已结束');
        pushMessage(grpc, {
            role: 'server',
            peer: stream.peer,
            fullName: stream.fullName,
            kind: stream.kind,
            streamId: stream.id,
            direction: 'outbound',
            typeName: stream.responseType,
            decoded: payload.message || {}
        });
        stream.outbound += 1;
        setTimeout(() => emitGrpc(controller, GRPC_SUB_EVT_TYPES.STREAM_UPDATED, buildStreamSummary(stream)), 20);
        return successResponse(null, '消息已下发');
    }
    if (method === 'grpc.closeStream') {
        const stream = grpc.streams.find(item => item.id === Number(payload.streamId));
        if (!stream) return errorResponse('流不存在');
        stream.state = 'closed';
        grpc.streams = grpc.streams.filter(item => item.id !== stream.id);
        setTimeout(() => emitGrpc(controller, GRPC_SUB_EVT_TYPES.STREAM_UPDATED, buildStreamSummary(stream)), 20);
        return successResponse(null, '流已关闭');
    }

    // ------------------------------------------------------------------ 消息
    if (method === 'grpc.getMessageList') {
        const query = payload;
        const callId = Number(query.callId) || 0;
        const streamId = Number(query.streamId) || 0;
        const list = grpc.messages.filter(
            record =>
                (!query.role || record.role === query.role) &&
                (!query.direction || record.direction === query.direction) &&
                (!callId || record.callId === callId) &&
                (!streamId || record.streamId === streamId)
        );
        const pageSize = Number(query.pageSize) || 20;
        return successResponse({
            list: list.slice(0, pageSize).map(toMessageSummary),
            total: list.length,
            page: 1,
            pageSize,
            stats: buildStats(grpc)
        });
    }
    if (method === 'grpc.getMessageDetail') {
        const record = grpc.messages.find(item => item.id === Number(args[0]));
        return record ? successResponse(record) : errorResponse('消息不存在');
    }
    if (method === 'grpc.clearMessageHistory') {
        grpc.messages = [];
        emitGrpc(controller, GRPC_SUB_EVT_TYPES.HISTORY_CLEARED, null);
        return successResponse(null);
    }
    return successResponse(null);
}

module.exports = {
    createGrpcPageState,
    grpcPageApiScript,
    handlePageCall
};
