#!/usr/bin/env node

/**
 * 交互式 UDP 服务端 —— 用于联调「工具集 -> UDP工具」
 *
 * UDP 工具向目标地址发送数据报，本脚本启动一个 UDP 服务端接收，
 * 你可以在终端里实时查看工具发来的报文，并手动回发数据进行交互测试。
 *
 * 启动:
 *   npm run mock:udp                       # 监听 127.0.0.1:9000
 *   npm run mock:udp -- --port 8888        # 自定义端口
 *   npm run mock:udp -- --host 0.0.0.0     # 监听所有网卡
 *   npm run mock:udp -- --echo             # 自动回显收到的报文
 *
 * 在 UDP 工具中：目标地址填 127.0.0.1，目标端口填上面监听的端口，打开。
 *
 * 交互命令（在本脚本终端输入后回车）：
 *   <任意文本>        以 UTF-8 文本回发给最近来源
 *   /hex deadbeef    以十六进制回发（空格/冒号会被忽略）
 *   /echo on|off     开关自动回显
 *   /peers           列出已知来源
 *   /to <序号>       切换回发目标
 *   /quit            退出
 */

const dgram = require('dgram');
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

const peers = new Map(); // id -> { address, port }
const peerKeyToId = new Map(); // "addr:port" -> id
let nextPeerId = 1;
let currentTargetId = null;

const server = dgram.createSocket(options.host.includes(':') ? 'udp6' : 'udp4');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'udp> '
});

function log(line) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(`${line}\n`);
    rl.prompt(true);
}

function rememberPeer(rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    if (peerKeyToId.has(key)) {
        const id = peerKeyToId.get(key);
        currentTargetId = id;
        return id;
    }
    const id = nextPeerId++;
    peers.set(id, { address: rinfo.address, port: rinfo.port });
    peerKeyToId.set(key, id);
    currentTargetId = id;
    return id;
}

function getTargetPeer() {
    if (currentTargetId && peers.has(currentTargetId)) {
        return { id: currentTargetId, peer: peers.get(currentTargetId) };
    }
    const first = peers.entries().next();
    if (!first.done) {
        currentTargetId = first.value[0];
        return { id: first.value[0], peer: first.value[1] };
    }
    return null;
}

function sendToCurrent(buffer) {
    const target = getTargetPeer();
    if (!target) {
        log('⚠ 还没有收到任何来源，无法回发');
        return;
    }
    server.send(buffer, target.peer.port, target.peer.address, error => {
        if (error) {
            log(`⚠ 回发失败: ${error.message}`);
            return;
        }
        log(`→ [#${target.id}] 已回发 ${buffer.length} 字节: ${buffer.toString('hex')}`);
    });
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
    if (text === '/peers') {
        if (peers.size === 0) {
            log('（暂无已知来源）');
        } else {
            for (const [id, peer] of peers) {
                const mark = id === currentTargetId ? '*' : ' ';
                log(`${mark} #${id}  ${peer.address}:${peer.port}`);
            }
        }
        return;
    }
    if (text.startsWith('/to ')) {
        const id = Number(text.slice(4).trim());
        if (peers.has(id)) {
            currentTargetId = id;
            log(`已切换回发目标为 #${id}`);
        } else {
            log(`⚠ 不存在来源 #${id}`);
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

    sendToCurrent(Buffer.from(text, 'utf8'));
}

server.on('message', (msg, rinfo) => {
    const id = rememberPeer(rinfo);
    const hex = msg.toString('hex');
    const textPreview = msg.toString('utf8').replace(/[^\x20-\x7e]/g, '.');
    log(
        `← [${timestamp()}] [#${id} ${rinfo.address}:${rinfo.port}] 收到 ${msg.length} 字节: ${hex}  |  ${textPreview}`
    );
    if (autoEcho) {
        server.send(msg, rinfo.port, rinfo.address, () => {
            log(`→ [#${id}] 自动回显 ${msg.length} 字节`);
        });
    }
});

function shutdown() {
    log('正在关闭服务端...');
    try {
        server.close(() => process.exit(0));
    } catch (_error) {
        process.exit(0);
    }
    setTimeout(() => process.exit(0), 1000).unref();
}

server.on('error', error => {
    console.error(`服务端启动失败: ${error.message}`);
    process.exit(1);
});

server.bind(options.port, options.host, () => {
    const address = server.address();
    console.log('========================================');
    console.log(` 交互式 UDP 服务端已启动`);
    console.log(` 监听地址: ${address.address}:${address.port}`);
    console.log(` 自动回显: ${autoEcho ? '开启' : '关闭'}`);
    console.log(` 在 UDP 工具中连接 ${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}`);
    console.log(` 输入 /quit 退出，输入文本或 /hex <十六进制> 回发数据`);
    console.log('========================================');
    rl.prompt();
});

rl.on('line', line => {
    handleCommand(line);
    rl.prompt();
});

rl.on('SIGINT', shutdown);
