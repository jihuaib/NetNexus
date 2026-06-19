#!/usr/bin/env node

/**
 * 交互式 TCP 服务端 —— 用于联调「工具集 -> TCP工具」
 *
 * TCP 工具是一个 TCP 客户端，本脚本启动一个 TCP 服务端供其连接，
 * 你可以在终端里实时查看工具发来的报文，并手动回发数据进行交互测试。
 *
 * 启动:
 *   npm run mock:tcp                       # 监听 127.0.0.1:9000
 *   npm run mock:tcp -- --port 8888        # 自定义端口
 *   npm run mock:tcp -- --host 0.0.0.0     # 监听所有网卡
 *   npm run mock:tcp -- --echo             # 自动回显收到的报文
 *
 * 在 TCP 工具中：目标地址填 127.0.0.1，端口填上面监听的端口，建立连接。
 *
 * 交互命令（在本脚本终端输入后回车）：
 *   <任意文本>        以 UTF-8 文本发送给当前连接
 *   /hex deadbeef    以十六进制发送（空格/冒号会被忽略）
 *   /echo on|off     开关自动回显
 *   /clients         列出当前已连接的客户端
 *   /to <序号>       切换当前发送目标（多个客户端时）
 *   /quit            退出
 */

const net = require('net');
const readline = require('readline');

const DEFAULT_OPTIONS = {
    host: '127.0.0.1',
    port: 9000,
    echo: false
};

function getArgValue(name, defaultValue) {
    const prefix = `--${name}`;
    const index = process.argv.indexOf(prefix);
    if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
        return process.argv[index + 1];
    }
    const inlineArg = process.argv.find(item => item.startsWith(`${prefix}=`));
    if (inlineArg) {
        return inlineArg.slice(prefix.length + 1);
    }
    return defaultValue;
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}

function parseOptions() {
    return {
        host: getArgValue('host', DEFAULT_OPTIONS.host),
        port: Number(getArgValue('port', DEFAULT_OPTIONS.port)),
        echo: hasFlag('echo') || DEFAULT_OPTIONS.echo
    };
}

function hexToBuffer(input) {
    const cleaned = String(input).replace(/[\s:,-]/g, '');
    if (cleaned.length === 0) {
        throw new Error('十六进制内容为空');
    }
    if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
        throw new Error('无效的十六进制内容');
    }
    return Buffer.from(cleaned, 'hex');
}

function timestamp() {
    const d = new Date();
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

const options = parseOptions();
let autoEcho = options.echo;

const clients = new Map(); // id -> socket
let nextClientId = 1;
let currentTargetId = null;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'tcp> '
});

function log(line) {
    // 先清掉当前 prompt 行，打印日志后再恢复 prompt
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(`${line}\n`);
    rl.prompt(true);
}

function clientLabel(socket) {
    return `${socket.remoteAddress}:${socket.remotePort}`;
}

function getTargetSocket() {
    if (currentTargetId && clients.has(currentTargetId)) {
        return { id: currentTargetId, socket: clients.get(currentTargetId) };
    }
    const first = clients.entries().next();
    if (!first.done) {
        currentTargetId = first.value[0];
        return { id: first.value[0], socket: first.value[1] };
    }
    return null;
}

function sendToCurrent(buffer) {
    const target = getTargetSocket();
    if (!target) {
        log('⚠ 当前没有已连接的客户端');
        return;
    }
    target.socket.write(buffer);
    log(`→ [#${target.id}] 已发送 ${buffer.length} 字节: ${buffer.toString('hex')}`);
}

function handleCommand(line) {
    const text = line.trimEnd();
    if (text.length === 0) {
        return;
    }

    if (text === '/quit') {
        shutdown();
        return;
    }
    if (text === '/clients') {
        if (clients.size === 0) {
            log('（无已连接客户端）');
        } else {
            for (const [id, socket] of clients) {
                const mark = id === currentTargetId ? '*' : ' ';
                log(`${mark} #${id}  ${clientLabel(socket)}`);
            }
        }
        return;
    }
    if (text.startsWith('/to ')) {
        const id = Number(text.slice(4).trim());
        if (clients.has(id)) {
            currentTargetId = id;
            log(`已切换发送目标为 #${id}`);
        } else {
            log(`⚠ 不存在客户端 #${id}`);
        }
        return;
    }
    if (text.startsWith('/echo')) {
        const arg = text.slice(5).trim();
        if (arg === 'on') {
            autoEcho = true;
        } else if (arg === 'off') {
            autoEcho = false;
        }
        log(`自动回显: ${autoEcho ? '开启' : '关闭'}`);
        return;
    }
    if (text.startsWith('/hex ')) {
        try {
            sendToCurrent(hexToBuffer(text.slice(5)));
        } catch (error) {
            log(`⚠ ${error.message}`);
        }
        return;
    }
    if (text.startsWith('/')) {
        log(`⚠ 未知命令: ${text}`);
        return;
    }

    // 普通文本，按 UTF-8 发送
    sendToCurrent(Buffer.from(text, 'utf8'));
}

const server = net.createServer(socket => {
    const id = nextClientId++;
    clients.set(id, socket);
    if (currentTargetId === null) {
        currentTargetId = id;
    }
    log(`✓ [${timestamp()}] 客户端 #${id} 已连接: ${clientLabel(socket)}（当前共 ${clients.size} 个）`);

    socket.on('data', chunk => {
        const hex = chunk.toString('hex');
        const textPreview = chunk.toString('utf8').replace(/[^\x20-\x7e]/g, '.');
        log(`← [${timestamp()}] [#${id}] 收到 ${chunk.length} 字节: ${hex}  |  ${textPreview}`);
        if (autoEcho) {
            socket.write(chunk);
            log(`→ [#${id}] 自动回显 ${chunk.length} 字节`);
        }
    });

    socket.on('close', () => {
        clients.delete(id);
        if (currentTargetId === id) {
            currentTargetId = clients.size > 0 ? clients.keys().next().value : null;
        }
        log(`✗ [${timestamp()}] 客户端 #${id} 已断开（剩余 ${clients.size} 个）`);
    });

    socket.on('error', error => {
        log(`⚠ [#${id}] 连接错误: ${error.message}`);
    });
});

function shutdown() {
    log('正在关闭服务端...');
    for (const socket of clients.values()) {
        socket.destroy();
    }
    server.close(() => process.exit(0));
    // 兜底：1 秒后强制退出
    setTimeout(() => process.exit(0), 1000).unref();
}

server.on('error', error => {
    console.error(`服务端启动失败: ${error.message}`);
    process.exit(1);
});

server.listen(options.port, options.host, () => {
    console.log('========================================');
    console.log(` 交互式 TCP 服务端已启动`);
    console.log(` 监听地址: ${options.host}:${options.port}`);
    console.log(` 自动回显: ${autoEcho ? '开启' : '关闭'}`);
    console.log(` 在 TCP 工具中连接 ${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}`);
    console.log(` 输入 /quit 退出，输入文本或 /hex <十六进制> 发送数据`);
    console.log('========================================');
    rl.prompt();
});

rl.on('line', line => {
    handleCommand(line);
    rl.prompt();
});

rl.on('SIGINT', shutdown);
