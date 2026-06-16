const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const path = require('path');

process.env.NODE_ENV = 'test';

const WorkerMessageHandler = require(
    path.join(__dirname, '..', '..', 'electron', 'worker', 'core', 'workerMessageHandler.js')
);

WorkerMessageHandler.prototype.init = function initForUnitTest() {};

const SyslogConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'syslogConst.js'));

function patchSyslogWorkerSource(source) {
    const sourcePatched = source.replace(/new SyslogWorker\(\);\s*$/u, 'module.exports = SyslogWorker;');
    if (sourcePatched !== source) {
        return sourcePatched;
    }

    const minifiedAliasPatched = source.replace(
        /([$A-Z_a-z][\w$]*)\(([$A-Z_a-z][\w$]*),"SyslogWorker"\);let SyslogWorker=\2;new SyslogWorker;?\s*$/u,
        (_match, keepNameHelper, classRef) =>
            `${keepNameHelper}(${classRef},"SyslogWorker");let SyslogWorker=${classRef};module.exports=SyslogWorker;`
    );
    if (minifiedAliasPatched !== source) {
        return minifiedAliasPatched;
    }

    const minifiedPatched = source.replace(
        /([$A-Z_a-z][\w$]*)\(([$A-Z_a-z][\w$]*),"SyslogWorker"\);new \2;?\s*$/u,
        (_match, keepNameHelper, classRef) =>
            `${keepNameHelper}(${classRef},"SyslogWorker");module.exports=${classRef};`
    );
    if (minifiedPatched !== source) {
        return minifiedPatched;
    }

    return source;
}

function loadSyslogWorkerClass() {
    const filePath = path.join(__dirname, '..', '..', 'electron', 'worker', 'services', 'syslogWorker.js');
    const source = fs.readFileSync(filePath, 'utf8');
    const patched = patchSyslogWorkerSource(source);
    if (patched === source) {
        const sourceTail = source.slice(-240).replace(/\s+/g, ' ');
        throw new Error(`failed to patch syslogWorker.js auto-start line; tail=${sourceTail}`);
    }

    const mod = new Module(filePath, module);
    mod.filename = filePath;
    mod.paths = Module._nodeModulePaths(path.dirname(filePath));
    mod._compile(patched, filePath);
    return mod.exports;
}

class MockSocket extends EventEmitter {
    constructor() {
        super();
        this.destroyed = false;
        this.ended = false;
        this.remoteAddress = '127.0.0.1';
        this.remotePort = 55100;
        this.syslogBuffer = Buffer.alloc(0);
    }

    setTimeout(ms) {
        this.timeoutMs = ms;
    }

    end() {
        this.ended = true;
        this.emit('close');
    }

    destroy() {
        this.destroyed = true;
        this.emit('close');
    }
}

async function main() {
    const SyslogWorker = loadSyslogWorkerClass();
    const worker = new SyslogWorker();
    const responses = [];
    const events = [];

    worker.messageHandler.sendSuccessResponse = (messageId, data, msg) => responses.push({ messageId, data, msg });
    worker.messageHandler.sendEvent = (type, payload) => events.push({ type, payload });
    worker.syslogConfig = worker.normalizeConfig({
        port: 5514,
        enableUdp: false,
        enableTcp: true,
        maxMessageLength: 2048
    });

    const clientSocket = new MockSocket();
    worker.handleTcpConnection(clientSocket, 'IPv4');
    assert.strictEqual(worker.tcpClients.has(clientSocket), true, 'Syslog TCP client should be tracked on connect');

    clientSocket.syslogBuffer = Buffer.from('<13>Jun 13 08:00:01 host app: pending');
    clientSocket.emit('close');

    assert.strictEqual(worker.tcpClients.has(clientSocket), false, 'Syslog TCP client should be removed on close');
    assert.strictEqual(worker.messageHistory.length, 1, 'Syslog TCP close should flush pending frame as a message');
    assert.strictEqual(worker.messageHistory[0].transport, SyslogConst.SYSLOG_TRANSPORT.TCP);

    const stopSocket = new MockSocket();
    worker.tcpClients.add(stopSocket);
    worker.messageHistory.push({ id: 999, rawMessage: 'old message' });
    await worker.stopSyslog('stop-syslog');

    assert.strictEqual(stopSocket.destroyed, true, 'Syslog stop should destroy active TCP clients');
    assert.strictEqual(worker.tcpClients.size, 0, 'Syslog stop should clear tracked TCP clients');
    assert.strictEqual(worker.messageHistory.length, 0, 'Syslog stop should clear message history');
    assert.strictEqual(responses[0].messageId, 'stop-syslog');
    assert.strictEqual(responses[0].msg, 'Syslog服务器已停止');
    const statusEvent = events.find(event => event.payload.type === SyslogConst.SYSLOG_SUB_EVT_TYPES.SERVER_STATUS);
    assert.ok(statusEvent, 'Syslog stop should publish server status event');
    assert.strictEqual(statusEvent.type, SyslogConst.SYSLOG_EVT_TYPES.SYSLOG_EVT);
    assert.strictEqual(statusEvent.payload.data.status, 'stopped');

    console.log('Syslog TCP lifecycle tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
