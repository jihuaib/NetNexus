const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.NODE_ENV = 'test';

/**
 * gRPC 主进程侧运行时生命周期（与 SNMP 一致：进程由用户显式启动/停止）：
 * - 未启动时业务请求被拒绝，不会按需拉起进程
 * - 启动时从持久化的 proto 列表恢复编译
 * - 停止时先停服务器再结束进程，并广播 runtimeChanged
 * - 进程意外退出后状态复位、关闭监控窗口、广播 runtimeChanged
 */
function loadGrpcAppClass(fakes) {
    const originalLoad = Module._load;
    Module._load = function loadWithStubs(request, parent, isMain) {
        if (request === 'electron') {
            return { app: { getPath: () => fakes.userData }, BrowserWindow: {}, dialog: {} };
        }
        if (request === '../log/logger') {
            return { info() {}, warn() {}, error() {} };
        }
        if (request === '../worker/core/workerPathResolver') {
            return { resolveWorkerPath: relative => `/fake/${relative}` };
        }
        if (request === '../worker/core/protocolProcessWithPromise') {
            return fakes.ProtocolProcessWithPromise;
        }
        if (request === '../utils/eventDispatcher') {
            return fakes.EventDispatcher;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return require('../../electron/app/grpcApp');
    } finally {
        Module._load = originalLoad;
    }
}

function createFakes() {
    const workers = [];
    const emitted = [];
    let exitHandler = null;

    class FakeWorker {
        constructor() {
            this.requests = [];
            this.listeners = new Map();
            this.terminated = false;
            this.compiledFail = false;
        }

        async sendRequest(op, data) {
            this.requests.push({ op, data });
            if (op === 4) {
                return { status: 'success', data: { status: 'running', boundPort: 57400 }, msg: 'started' };
            }
            return { status: 'success', data: { compiled: true, ok: true }, msg: 'ok' };
        }

        addEventListener(name, listener) {
            this.listeners.set(name, listener);
        }

        removeEventListener(name) {
            this.listeners.delete(name);
        }

        async terminate() {
            this.terminated = true;
        }
    }

    class ProtocolProcessWithPromise {
        constructor(_path, options) {
            this.options = options;
        }

        createLongRunningProcess() {
            const worker = new FakeWorker();
            workers.push(worker);
            exitHandler = exit => this.options.onExit(1, worker, exit);
            return worker;
        }
    }

    class EventDispatcher {
        constructor() {
            this.webContents = null;
        }

        setWebContents(webContents) {
            this.webContents = webContents;
        }

        emit(type, data) {
            emitted.push({ type, data });
            return 1;
        }

        emitToPrimary(type, data) {
            emitted.push({ type, data, primary: true });
            return 1;
        }

        emitToSubscribers(type, data) {
            emitted.push({ type, data, subscribers: true });
            return 0;
        }

        cleanup() {
            this.webContents = null;
        }
    }

    return {
        userData: '/tmp/netnexus-grpc-runtime-test',
        workers,
        emitted,
        triggerExit: () => exitHandler && exitHandler({ expected: false }),
        ProtocolProcessWithPromise,
        EventDispatcher
    };
}

function createApp(GrpcApp, storedProtoConfig) {
    const handlers = new Map();
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
    const store = {
        data: new Map(storedProtoConfig ? [['grpc-proto-config', storedProtoConfig]] : []),
        get(key) {
            return this.data.get(key);
        },
        set(key, value) {
            this.data.set(key, value);
        }
    };
    const closed = [];
    const app = new GrpcApp(ipcMain, store, { closeMonitorWindows: () => closed.push('closed') });
    const sender = { isDestroyed: () => false, send() {} };
    const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload);
    return { app, invoke, closed, store };
}

async function main() {
    const fakes = createFakes();
    const GrpcApp = loadGrpcAppClass(fakes);
    const { app, invoke, closed } = createApp(GrpcApp, {
        filePaths: ['/protos/huawei-grpc-dialout.proto'],
        includeDirs: ['/protos']
    });

    // 未启动：状态为停止，业务请求被拒绝且不会拉起进程
    let state = await invoke('grpc:getRuntimeState');
    assert.equal(state.status, 'success');
    assert.equal(state.data.running, false);
    const compile = await invoke('grpc:compileProtos', { filePaths: ['/protos/a.proto'] });
    assert.equal(compile.status, 'error');
    assert.match(compile.msg, /未启动/u);
    const template = await invoke('grpc:getMessageTemplate', 'a.B');
    assert.equal(template.status, 'error');
    assert.equal(fakes.workers.length, 0, 'requests must not spawn the process implicitly');
    const protoConfig = await invoke('grpc:getProtoConfig');
    assert.equal(protoConfig.status, 'success');
    assert.equal(protoConfig.data.compiled, false);
    assert.deepEqual(protoConfig.data.filePaths, ['/protos/huawei-grpc-dialout.proto']);

    // 显式启动：创建进程并按持久化配置恢复编译
    const started = await invoke('grpc:startRuntime');
    assert.equal(started.status, 'success', started.msg);
    assert.equal(started.data.running, true);
    assert.equal(fakes.workers.length, 1);
    const worker = fakes.workers[0];
    assert.equal(worker.requests[0].op, 1, 'COMPILE_PROTOS must be sent on start');
    assert.deepEqual(worker.requests[0].data.filePaths, ['/protos/huawei-grpc-dialout.proto']);
    assert.match(worker.requests[0].data.cacheFilePath, /grpc-proto-cache\.json$/u);
    assert(
        fakes.emitted.some(item => item.type === 'grpc:runtimeChanged' && item.data.running === true),
        'runtimeChanged must be emitted after start'
    );
    const startedAgain = await invoke('grpc:startRuntime');
    assert.equal(startedAgain.status, 'success');
    assert.equal(fakes.workers.length, 1, 'starting twice must reuse the process');

    // 启动后业务请求正常转发
    const compiled = await invoke('grpc:compileProtos', { filePaths: ['/protos/a.proto'], includeDirs: [] });
    assert.equal(compiled.status, 'success');
    assert.deepEqual(app.getStoredProtoConfig().filePaths, ['/protos/a.proto']);

    // 启动服务器，然后停止进程：先 STOP_SERVER 再 terminate，并广播 runtimeChanged
    const server = await invoke('grpc:startServer', { port: 57400, services: ['x.Y'] });
    assert.equal(server.status, 'success');
    assert.equal(app.getGrpcRunning(), true);
    fakes.emitted.length = 0;
    const stopped = await invoke('grpc:stopRuntime');
    assert.equal(stopped.status, 'success', stopped.msg);
    assert.equal(stopped.data.running, false);
    assert(
        worker.requests.some(item => item.op === 5),
        'STOP_SERVER must be sent before terminating'
    );
    assert.equal(worker.terminated, true);
    assert.equal(app.hasWorker(), false);
    assert.equal(app.getGrpcRunning(), false);
    assert(closed.length >= 1, 'monitor windows must be closed on stop');
    assert(
        fakes.emitted.some(item => item.type === 'grpc:runtimeChanged' && item.data.running === false),
        'runtimeChanged must be emitted after stop'
    );
    const stoppedAgain = await invoke('grpc:stopRuntime');
    assert.equal(stoppedAgain.status, 'error');

    // 意外退出：状态复位、关闭监控窗口、广播停止
    await invoke('grpc:startRuntime');
    assert.equal(fakes.workers.length, 2);
    await invoke('grpc:startServer', { port: 57400, services: ['x.Y'] });
    fakes.emitted.length = 0;
    closed.length = 0;
    fakes.triggerExit();
    assert.equal(app.hasWorker(), false);
    assert.equal(app.getGrpcRunning(), false);
    assert.equal(closed.length, 1);
    assert(
        fakes.emitted.some(item => item.type === 'grpc:runtimeChanged' && item.data.running === false),
        'runtimeChanged must be emitted after unexpected exit'
    );
    assert(
        fakes.emitted.some(item => item.type === 'grpc:event' && item.data?.data?.data?.status === 'stopped'),
        'server status stopped event must be emitted after unexpected exit'
    );
    state = await invoke('grpc:getRuntimeState');
    assert.equal(state.data.running, false);

    // 应用退出：未启动时 handleShutdown 直接成功
    const shutdown = await app.handleShutdown();
    assert.equal(shutdown.status, 'success');

    console.log('gRPC app runtime lifecycle test passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
