const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const WorkerMessageHandler = require(
    path.join(__dirname, '..', '..', 'electron', 'worker', 'core', 'workerMessageHandler.js')
);

const responses = new Map();
const events = [];

WorkerMessageHandler.prototype.init = function initForUnitTest() {
    this.parentEndpoint = {
        on() {},
        postMessage: message => {
            if (message.eventName) {
                events.push(message.data);
                return;
            }
            const resolve = responses.get(message.messageId);
            if (resolve) {
                responses.delete(message.messageId);
                resolve(message);
            }
        }
    };
};

const GrpcWorker = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'grpc', 'grpcWorker.js'));
const GrpcConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'grpcConst.js'));

const { GRPC_REQ_TYPES, GRPC_SUB_EVT_TYPES, GRPC_PROTO_PRESETS, GRPC_STREAM_STATE } = GrpcConst;

let sequence = 0;
function request(worker, op, data = null) {
    return new Promise(resolve => {
        sequence += 1;
        const messageId = `grpc-ci-${sequence}`;
        responses.set(messageId, resolve);
        const handler = worker.messageHandler.handlers.get(op);
        assert(handler, `handler for op ${op} must be registered`);
        Promise.resolve(handler(messageId, data)).catch(error => {
            responses.delete(messageId);
            resolve({ messageId, status: 'error', msg: error.message });
        });
    });
}

function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) {
                resolve();
                return;
            }
            if (Date.now() - startedAt > timeoutMs) {
                reject(new Error(`timeout waiting for ${label}`));
                return;
            }
            setTimeout(tick, 20);
        };
        tick();
    });
}

function presetFiles(worker, presetId) {
    const preset = GRPC_PROTO_PRESETS.find(item => item.id === presetId);
    return preset.files.map(name => worker.registry.resolveBuiltinFile(name));
}

async function main() {
    const worker = new GrpcWorker();
    const huaweiPreset = GRPC_PROTO_PRESETS.find(item => item.id === 'huawei-dialout');

    // 未编译时启动服务器必须失败
    let result = await request(worker, GRPC_REQ_TYPES.START_SERVER, { port: 0, services: ['x.Y'] });
    assert.strictEqual(result.status, 'error');
    assert(result.msg.includes('请先编译'), result.msg);

    result = await request(worker, GRPC_REQ_TYPES.COMPILE_PROTOS, {
        filePaths: [...presetFiles(worker, 'huawei-dialout'), ...presetFiles(worker, 'gnmi')]
    });
    assert.strictEqual(result.status, 'success', result.msg);
    assert.strictEqual(result.data.compiled, true);

    result = await request(worker, GRPC_REQ_TYPES.GET_MESSAGE_TEMPLATE, { typeName: 'gnmi.GetRequest' });
    assert.strictEqual(result.status, 'success');
    assert(Array.isArray(result.data.template.path));

    // 启动通用服务器：同时托管华为 dial-out（bidi）与 gNMI（含 unary）
    result = await request(worker, GRPC_REQ_TYPES.START_SERVER, {
        host: '127.0.0.1',
        port: 0,
        services: ['huawei_dialout.gRPCDataservice', 'gnmi.gNMI'],
        decodeRules: huaweiPreset.decodeRules,
        unaryReplyTemplates: {
            'gnmi.gNMI.Capabilities': { gNMI_version: '0.8.0', supported_encodings: ['JSON', 'PROTO'] }
        }
    });
    assert.strictEqual(result.status, 'success', result.msg);
    const port = result.data.boundPort;
    assert(Number.isInteger(port) && port > 0, 'server must bind an ephemeral port');
    assert(
        events.some(event => event.type === GRPC_SUB_EVT_TYPES.SERVER_STATUS && event.data.status === 'running'),
        'running status event must be emitted'
    );

    result = await request(worker, GRPC_REQ_TYPES.START_SERVER, { port: 0, services: ['gnmi.gNMI'] });
    assert.strictEqual(result.status, 'error', 'second start must be rejected');

    // Unary：客户端调用 -> 服务端按模板回复
    result = await request(worker, GRPC_REQ_TYPES.CLIENT_START_CALL, {
        target: `127.0.0.1:${port}`,
        method: 'gnmi.gNMI.Capabilities',
        message: {},
        timeoutMs: 5000
    });
    assert.strictEqual(result.status, 'success', result.msg);
    const unaryCallId = result.data.id;
    await waitFor(
        () =>
            events.some(
                event =>
                    event.type === GRPC_SUB_EVT_TYPES.CLIENT_CALL_UPDATED &&
                    event.data.id === unaryCallId &&
                    event.data.state !== GRPC_STREAM_STATE.OPEN
            ),
        5000,
        'unary call completion'
    );
    result = await request(worker, GRPC_REQ_TYPES.GET_CLIENT_CALL_LIST);
    const unaryCall = result.data.list.find(call => call.id === unaryCallId);
    assert.strictEqual(unaryCall.state, GRPC_STREAM_STATE.CLOSED);
    assert.strictEqual(unaryCall.statusName, 'OK');
    assert.strictEqual(unaryCall.responses, 1);

    result = await request(worker, GRPC_REQ_TYPES.GET_MESSAGE_DETAIL, unaryCall.lastResponseId);
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.data.decoded.gNMI_version, '0.8.0');
    assert.deepStrictEqual(result.data.decoded.supported_encodings, ['JSON', 'PROTO']);

    // Bidi：模拟设备 dial-out 上报，服务端按规则解码并向流下发
    result = await request(worker, GRPC_REQ_TYPES.CLIENT_START_CALL, {
        target: `127.0.0.1:${port}`,
        method: 'huawei_dialout.gRPCDataservice.dataPublish',
        metadata: [{ key: 'username', value: 'admin' }]
    });
    assert.strictEqual(result.status, 'success', result.msg);
    const bidiCallId = result.data.id;

    const telemetry = worker.registry.encodeMessage('telemetry.Telemetry', {
        node_id_str: 'router-1',
        sensor_path: 'huawei-ifm:ifm/interfaces/interface',
        proto_path: 'huawei_ifm.Ifm.interfaces.interface',
        data_gpb: { row: [{ timestamp: '1700000000000', content: Buffer.from([0x0a, 0x01, 0x41]).toString('base64') }] }
    });
    result = await request(worker, GRPC_REQ_TYPES.CLIENT_SEND_MESSAGE, {
        callId: bidiCallId,
        message: { ReqId: '7', data: telemetry.toString('base64') }
    });
    assert.strictEqual(result.status, 'success', result.msg);

    await waitFor(() => worker.streams.size === 1, 5000, 'server stream registration');
    await waitFor(() => Array.from(worker.streams.values())[0].inbound === 1, 5000, 'server inbound message on stream');
    result = await request(worker, GRPC_REQ_TYPES.GET_STREAM_LIST);
    assert.strictEqual(result.data.total, 1);
    const stream = result.data.list[0];
    assert.strictEqual(stream.fullName, 'huawei_dialout.gRPCDataservice.dataPublish');
    assert.strictEqual(stream.metadata.username, 'admin', 'request metadata must be captured');
    assert.strictEqual(stream.canSend, true);

    result = await request(worker, GRPC_REQ_TYPES.GET_MESSAGE_LIST, { page: 1, pageSize: 50, role: 'server' });
    const inbound = result.data.list.find(item => item.direction === 'inbound' && item.streamId === stream.id);
    assert(inbound, 'server inbound record must exist');
    assert.strictEqual(inbound.status, 'partial', 'unknown proto_path type keeps raw bytes with a warning');
    result = await request(worker, GRPC_REQ_TYPES.GET_MESSAGE_DETAIL, inbound.id);
    assert.strictEqual(result.data.decoded.data.$type, 'telemetry.Telemetry');
    assert.strictEqual(result.data.decoded.data.value.node_id_str, 'router-1');
    assert.strictEqual(result.data.decoded.data.value.data_gpb.row[0].content, '0a0141');
    assert.strictEqual(result.data.warnings.length, 1);

    // 服务端下发
    result = await request(worker, GRPC_REQ_TYPES.SEND_STREAM_MESSAGE, {
        streamId: stream.id,
        message: { ReqId: '7', errors: 'ack' }
    });
    assert.strictEqual(result.status, 'success', result.msg);
    await waitFor(
        () =>
            events.some(
                event =>
                    event.type === GRPC_SUB_EVT_TYPES.CLIENT_CALL_UPDATED &&
                    event.data.id === bidiCallId &&
                    event.data.responses === 1
            ),
        5000,
        'client receives downlink message'
    );
    result = await request(worker, GRPC_REQ_TYPES.GET_MESSAGE_LIST, { page: 1, pageSize: 50, role: 'client' });
    const downlink = result.data.list.find(item => item.direction === 'inbound' && item.callId === bidiCallId);
    assert(downlink, 'client inbound record must exist');
    assert(downlink.summary.includes('"errors":"ack"'), downlink.summary);

    // 非法消息不会写入流
    result = await request(worker, GRPC_REQ_TYPES.SEND_STREAM_MESSAGE, {
        streamId: stream.id,
        message: { ReqId: 'not-a-number' }
    });
    assert.strictEqual(result.status, 'error');
    assert(result.msg.includes('校验失败'), result.msg);

    // 客户端结束发送 -> 服务端关闭流 -> 调用 OK 结束
    result = await request(worker, GRPC_REQ_TYPES.CLIENT_END_CALL, { callId: bidiCallId });
    assert.strictEqual(result.status, 'success', result.msg);
    await waitFor(() => worker.streams.size === 0, 5000, 'server stream closed');
    await waitFor(() => worker.clientCalls.get(bidiCallId).state !== GRPC_STREAM_STATE.OPEN, 5000, 'bidi call closed');
    assert.strictEqual(worker.clientCalls.get(bidiCallId).statusName, 'OK');

    // 清空历史
    result = await request(worker, GRPC_REQ_TYPES.CLEAR_MESSAGE_HISTORY);
    assert.strictEqual(result.status, 'success');
    result = await request(worker, GRPC_REQ_TYPES.GET_MESSAGE_LIST, { page: 1, pageSize: 10 });
    assert.strictEqual(result.data.total, 0);
    assert(events.some(event => event.type === GRPC_SUB_EVT_TYPES.HISTORY_CLEARED));

    // 停止服务器后再次调用必须失败
    result = await request(worker, GRPC_REQ_TYPES.STOP_SERVER);
    assert.strictEqual(result.status, 'success', result.msg);
    assert(
        events.some(event => event.type === GRPC_SUB_EVT_TYPES.SERVER_STATUS && event.data.status === 'stopped'),
        'stopped status event must be emitted'
    );
    result = await request(worker, GRPC_REQ_TYPES.CLIENT_START_CALL, {
        target: `127.0.0.1:${port}`,
        method: 'gnmi.gNMI.Capabilities',
        message: {},
        timeoutMs: 1500
    });
    assert.strictEqual(result.status, 'success');
    const failedCallId = result.data.id;
    await waitFor(
        () => worker.clientCalls.get(failedCallId).state === GRPC_STREAM_STATE.ERROR,
        10000,
        'call against stopped server fails'
    );
    assert(worker.clientCalls.get(failedCallId).statusName, 'failed call must carry a gRPC status name');

    await worker.dispose();
    console.log('gRPC worker lifecycle test passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
