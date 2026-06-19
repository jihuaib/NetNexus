/**
 * TCP 工具功能验证脚本 (跨平台，纯 Node.js)
 *
 * 直接复用 electron/utils/tcpClientManager.js 的 TCP 客户端连接管理器，
 * 搭建一个本地回显 TCP 服务端，对以下场景做端到端验证：
 *   1. connect -> 推送 connecting / connected 状态事件
 *   2. send (文本/十六进制编码) -> 服务端收到正确字节
 *   3. 服务端回包 -> 推送 tcpData 事件 (hex/text/length)
 *   4. close -> 推送 closed 状态事件并从连接表移除
 *   5. parsePayload 编码与非法输入校验
 *   6. send/close 针对非法连接的错误处理
 *   7. connect 参数校验 (地址/端口)
 *   8. 连接失败 (端口未监听) -> 推送 error 状态事件
 *
 * 运行: node test/ci/tcp_tool_lifecycle.js (或 npm test 自动发现执行)
 */

const assert = require('assert');
const net = require('net');
const path = require('path');

process.env.NODE_ENV = 'test';

const { TcpClientManager, parsePayload } = require(
    path.join(__dirname, '..', '..', 'electron', 'utils', 'tcpClientManager.js')
);
const { TCP_TOOL_STATE, TCP_TOOL_EVT_TYPES } = require(
    path.join(__dirname, '..', '..', 'electron', 'const', 'toolsConst.js')
);

const HOST = '127.0.0.1';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

// 启动一个回显 TCP 服务端（收到数据后原样返回）
function startEchoServer() {
    return new Promise((resolve, reject) => {
        const received = [];
        const server = net.createServer(socket => {
            socket.on('data', chunk => {
                received.push(Buffer.from(chunk));
                socket.write(chunk);
            });
        });
        server.on('error', reject);
        server.listen(0, HOST, () => {
            resolve({ server, port: server.address().port, received });
        });
    });
}

// 收集 TcpClientManager 推送的事件
function createCollector() {
    const states = [];
    const dataEvents = [];
    const emit = (eventType, data) => {
        if (eventType === TCP_TOOL_EVT_TYPES.STATE_CHANGE) {
            states.push(data);
        } else if (eventType === TCP_TOOL_EVT_TYPES.DATA) {
            dataEvents.push(data);
        }
    };
    return { states, dataEvents, emit };
}

async function testParsePayload() {
    assert.strictEqual(parsePayload('hello', 'utf8').toString('utf8'), 'hello', 'utf8 编码错误');
    assert.deepStrictEqual([...parsePayload('ff00ab', 'hex')], [0xff, 0x00, 0xab], 'hex 编码错误');
    assert.deepStrictEqual([...parsePayload('ff:00 ab', 'hex')], [0xff, 0x00, 0xab], 'hex 分隔符未清理');
    assert.strictEqual(parsePayload('aGVsbG8=', 'base64').toString('utf8'), 'hello', 'base64 编码错误');
    assert.strictEqual(parsePayload('', 'hex').length, 0, '空 hex 应为空 buffer');
    assert.strictEqual(parsePayload(null, 'utf8').length, 0, 'null 应为空 buffer');
    assert.throws(() => parsePayload('xyz', 'hex'), /十六进制/, '非法 hex 未抛错');
    assert.throws(() => parsePayload('abc', 'hex'), /十六进制/, '奇数长度 hex 未抛错');

    console.log('  ✓ parsePayload 编码与校验');
}

async function testConnectValidation() {
    const { emit } = createCollector();
    const manager = new TcpClientManager(emit);
    assert.throws(() => manager.connect({ host: '', port: 80 }), /目标地址/, '空地址未抛错');
    assert.throws(() => manager.connect({ host: HOST, port: 0 }), /端口/, '非法端口未抛错');
    assert.throws(() => manager.connect({ host: HOST, port: 70000 }), /端口/, '越界端口未抛错');

    console.log('  ✓ connect 参数校验');
}

async function testSendCloseErrors() {
    const { emit } = createCollector();
    const manager = new TcpClientManager(emit);
    assert.throws(() => manager.send('not-exist', { data: 'x' }), /连接不存在/, '非法连接发送未抛错');
    assert.deepStrictEqual(manager.close('not-exist'), { id: 'not-exist', closed: false }, '关闭不存在连接应返回 false');

    console.log('  ✓ send/close 错误处理');
}

async function testLifecycle() {
    const { server, port, received } = await startEchoServer();
    const { states, dataEvents, emit } = createCollector();
    const manager = new TcpClientManager(emit);

    try {
        const { id } = manager.connect({ host: HOST, port });
        assert.ok(id, '应返回连接 id');

        // connecting 事件应立即推送
        assert.ok(
            states.some(s => s.id === id && s.state === TCP_TOOL_STATE.CONNECTING),
            '缺少 connecting 状态事件'
        );

        // 等待连接建立
        await waitFor(() => states.some(s => s.id === id && s.state === TCP_TOOL_STATE.CONNECTED));

        const conn = manager.getConnection(id);
        assert.strictEqual(conn.connected, true, '连接状态应为 connected');

        // 发送文本报文
        const sendResult = manager.send(id, { data: 'ping', encoding: 'utf8' });
        assert.strictEqual(sendResult.length, 4, '发送长度错误');
        assert.strictEqual(sendResult.bytesSent, 4, '累计发送字节错误');

        // 发送十六进制报文
        manager.send(id, { data: 'deadbeef', encoding: 'hex' });

        // 等待服务端收到全部数据
        await waitFor(() => Buffer.concat(received).length >= 8);
        const allReceived = Buffer.concat(received);
        assert.strictEqual(allReceived.slice(0, 4).toString('utf8'), 'ping', '服务端未收到正确文本');
        assert.strictEqual(allReceived.slice(4, 8).toString('hex'), 'deadbeef', '服务端未收到正确 hex');

        // 等待回显数据事件
        await waitFor(() => dataEvents.reduce((sum, e) => sum + e.length, 0) >= 8);
        const echoedHex = dataEvents.map(e => e.dataHex).join('');
        assert.ok(echoedHex.includes('deadbeef'), '回显事件缺少 hex 数据');
        const lastData = dataEvents[dataEvents.length - 1];
        assert.strictEqual(typeof lastData.dataText, 'string', 'data 事件缺少 text 字段');
        assert.ok(lastData.totalReceived >= 8, 'totalReceived 累计错误');

        // 关闭连接
        const closeResult = manager.close(id);
        assert.strictEqual(closeResult.closed, true, '关闭应返回 true');

        // 等待 closed 状态事件，且连接被移除
        await waitFor(() => states.some(s => s.id === id && s.state === TCP_TOOL_STATE.CLOSED));
        assert.strictEqual(manager.getConnection(id), null, '关闭后连接应被移除');

        console.log('  ✓ connect/send/recv/close 完整生命周期');
    } finally {
        manager.closeAll();
        await new Promise(resolve => server.close(resolve));
    }
}

async function testConnectFailure() {
    // 找一个未监听的端口：先监听拿到端口再关闭
    const { server, port } = await startEchoServer();
    await new Promise(resolve => server.close(resolve));

    const { states, emit } = createCollector();
    const manager = new TcpClientManager(emit);
    const { id } = manager.connect({ host: HOST, port, timeout: 1000 });

    await waitFor(
        () => states.some(s => s.id === id && s.state === TCP_TOOL_STATE.ERROR),
        2000
    );
    assert.ok(
        states.some(s => s.id === id && s.state === TCP_TOOL_STATE.ERROR),
        '连接失败应推送 error 状态事件'
    );

    manager.closeAll();
    await delay(20);
    console.log('  ✓ 连接失败错误事件');
}

async function main() {
    console.log('TCP tool tests:');
    await testParsePayload();
    await testConnectValidation();
    await testSendCloseErrors();
    await testLifecycle();
    await testConnectFailure();
    console.log('TCP tool tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
