/**
 * UDP 工具功能验证脚本 (跨平台，纯 Node.js)
 *
 * 直接复用 electron/utils/udpClientManager.js 的 UDP 收发管理器，
 * 搭建一个本地回显 UDP 服务端，对以下场景做端到端验证：
 *   1. open -> 推送 opening / listening 状态事件（含本地绑定端口）
 *   2. send (文本/十六进制编码) -> 服务端收到正确字节
 *   3. 服务端回包 -> 推送 udpData 事件 (hex/text/length/来源地址端口)
 *   4. close -> 推送 closed 状态事件并从表中移除
 *   5. open 参数校验 (地址/端口)
 *   6. send/close 针对非法 socket 的错误处理
 *   7. send 时按 host/port 覆盖默认目标
 *
 * 运行: node test/ci/udp_tool_lifecycle.js (或 npm test 自动发现执行)
 */

const assert = require('assert');
const dgram = require('dgram');
const path = require('path');

process.env.NODE_ENV = 'test';

const { UdpClientManager } = require(
    path.join(__dirname, '..', '..', 'electron', 'utils', 'udpClientManager.js')
);
const { UDP_TOOL_STATE, UDP_TOOL_EVT_TYPES } = require(
    path.join(__dirname, '..', '..', 'electron', 'const', 'toolsConst.js')
);

const HOST = '127.0.0.1';

function waitFor(predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                reject(new Error('waitFor timeout'));
            }
        }, 10);
    });
}

// 启动一个回显 UDP 服务端（收到数据报后原样回发给来源）
function startEchoServer() {
    return new Promise((resolve, reject) => {
        const received = [];
        const server = dgram.createSocket('udp4');
        server.on('error', reject);
        server.on('message', (msg, rinfo) => {
            received.push(Buffer.from(msg));
            server.send(msg, rinfo.port, rinfo.address);
        });
        server.bind(0, HOST, () => {
            resolve({ server, port: server.address().port, received });
        });
    });
}

function createCollector() {
    const states = [];
    const dataEvents = [];
    const emit = (eventType, data) => {
        if (eventType === UDP_TOOL_EVT_TYPES.STATE_CHANGE) {
            states.push(data);
        } else if (eventType === UDP_TOOL_EVT_TYPES.DATA) {
            dataEvents.push(data);
        }
    };
    return { states, dataEvents, emit };
}

async function testOpenValidation() {
    const { emit } = createCollector();
    const manager = new UdpClientManager(emit);
    assert.throws(() => manager.open({ host: '', port: 80 }), /目标地址/, '空地址未抛错');
    assert.throws(() => manager.open({ host: HOST, port: 0 }), /端口/, '非法端口未抛错');
    assert.throws(() => manager.open({ host: HOST, port: 70000 }), /端口/, '越界端口未抛错');

    console.log('  ✓ open 参数校验');
}

async function testSendCloseErrors() {
    const { emit } = createCollector();
    const manager = new UdpClientManager(emit);
    await assert.rejects(() => manager.send('not-exist', { data: 'x' }), /socket 不存在/, '非法 socket 发送未抛错');
    assert.deepStrictEqual(manager.close('not-exist'), { id: 'not-exist', closed: false }, '关闭不存在 socket 应返回 false');

    console.log('  ✓ send/close 错误处理');
}

async function testLifecycle() {
    const { server, port, received } = await startEchoServer();
    const { states, dataEvents, emit } = createCollector();
    const manager = new UdpClientManager(emit);

    try {
        const { id } = manager.open({ host: HOST, port });
        assert.ok(id, '应返回 socket id');

        // opening 事件应立即推送
        assert.ok(states.some(s => s.id === id && s.state === UDP_TOOL_STATE.OPENING), '缺少 opening 状态事件');

        // 等待绑定就绪
        await waitFor(() => states.some(s => s.id === id && s.state === UDP_TOOL_STATE.LISTENING));
        const listeningState = states.find(s => s.id === id && s.state === UDP_TOOL_STATE.LISTENING);
        assert.ok(listeningState.localPort > 0, '就绪事件应包含本地端口');

        const conn = manager.getConnection(id);
        assert.strictEqual(conn.ready, true, 'socket 状态应为 ready');

        // 发送文本报文
        const sendResult = await manager.send(id, { data: 'ping', encoding: 'utf8' });
        assert.strictEqual(sendResult.length, 4, '发送长度错误');
        assert.strictEqual(sendResult.bytesSent, 4, '累计发送字节错误');

        // 发送十六进制报文
        await manager.send(id, { data: 'deadbeef', encoding: 'hex' });

        // 等待服务端收到两份数据报
        await waitFor(() => received.length >= 2);
        assert.strictEqual(received[0].toString('utf8'), 'ping', '服务端未收到正确文本');
        assert.strictEqual(received[1].toString('hex'), 'deadbeef', '服务端未收到正确 hex');

        // 等待回显数据事件
        await waitFor(() => dataEvents.length >= 2);
        const echoedHex = dataEvents.map(e => e.dataHex).join(',');
        assert.ok(echoedHex.includes('deadbeef'), '回显事件缺少 hex 数据');
        const lastData = dataEvents[dataEvents.length - 1];
        assert.strictEqual(lastData.sourceAddress, HOST, 'data 事件缺少正确来源地址');
        assert.strictEqual(lastData.sourcePort, port, 'data 事件缺少正确来源端口');
        assert.ok(lastData.totalReceived >= 8, 'totalReceived 累计错误');

        // 关闭 socket
        const closeResult = manager.close(id);
        assert.strictEqual(closeResult.closed, true, '关闭应返回 true');

        await waitFor(() => states.some(s => s.id === id && s.state === UDP_TOOL_STATE.CLOSED));
        assert.strictEqual(manager.getConnection(id), null, '关闭后 socket 应被移除');

        console.log('  ✓ open/send/recv/close 完整生命周期');
    } finally {
        manager.closeAll();
        await new Promise(resolve => server.close(resolve));
    }
}

async function testSendOverrideTarget() {
    const { server, port, received } = await startEchoServer();
    const { emit } = createCollector();
    const manager = new UdpClientManager(emit);
    // 默认目标是一个无人监听的端口，发送时用 host/port 覆盖到真实回显服务端
    const { id } = manager.open({ host: HOST, port: port + 1 });

    try {
        await waitFor(() => manager.getConnection(id)?.ready === true);
        await manager.send(id, { data: 'override', encoding: 'utf8', host: HOST, port });
        await waitFor(() => received.length >= 1);
        assert.strictEqual(received[0].toString('utf8'), 'override', '覆盖目标发送未生效');
        console.log('  ✓ send 覆盖默认目标');
    } finally {
        manager.closeAll();
        await new Promise(resolve => server.close(resolve));
    }
}

async function main() {
    console.log('UDP tool tests:');
    await testOpenValidation();
    await testSendCloseErrors();
    await testLifecycle();
    await testSendOverrideTarget();
    console.log('UDP tool tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
