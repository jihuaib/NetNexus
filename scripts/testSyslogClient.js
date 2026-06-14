#!/usr/bin/env node
/**
 * Syslog 客户端上报脚本
 *
 * 覆盖服务端已实现的主要处理场景：
 *   1. UDP 单报文上报
 *   2. TCP 换行分帧
 *   3. TCP NUL 分帧
 *   4. TCP octet-counting 分帧 (RFC 6587)
 *   5. TCP octet-counting 拆包重组
 *   6. TCP 连接关闭时刷新未分隔报文
 *   7. RFC3164 解析
 *   8. RFC5424 解析（含结构化数据、NILVALUE、多结构化数据）
 *   9. RAW / 缺少 PRI / 非法 PRI / RFC5424 异常结构
 *   10. 超长消息截断或 octet-counting 超限错误
 *
 * 使用方法：
 *   node scripts/testSyslogClient.js [选项]
 *
 * 选项：
 *   --server <ip>        Syslog服务器地址，默认 127.0.0.1；使用 --v6 时默认 ::1
 *   --port <n>           Syslog服务器端口，默认 514
 *   --timeout <ms>       TCP连接/写入超时，默认 3000
 *   --v6                 强制使用 IPv6
 *   --udp-only           仅发送 UDP 场景
 *   --tcp-only           仅发送 TCP 场景
 *   --no-error-cases     跳过格式异常、超长、TCP错误帧场景
 *   --oversize-bytes <n> 超长消息正文长度，默认 9000
 *   --dry-run            只打印将发送的场景，不实际发送
 *   --list-scenarios     打印消息场景并退出
 *
 * 示例：
 *   node scripts/testSyslogClient.js --port 1514
 *   node scripts/testSyslogClient.js --server ::1 --port 1514 --v6
 *   node scripts/testSyslogClient.js --port 1514 --tcp-only
 *   node scripts/testSyslogClient.js --port 1514 --no-error-cases
 */

'use strict';

const dgram = require('dgram');
const net = require('net');

const args = process.argv.slice(2);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hasFlag(name) {
    return args.includes(name);
}

function getArg(name, defaultValue) {
    const index = args.indexOf(name);
    return index !== -1 && args[index + 1] ? args[index + 1] : defaultValue;
}

function parsePortArg(name, defaultValue) {
    const raw = getArg(name, String(defaultValue));
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${name} 端口非法: ${raw}`);
    }
    return port;
}

function parsePositiveInt(name, defaultValue) {
    const raw = getArg(name, String(defaultValue));
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} 参数非法: ${raw}`);
    }
    return value;
}

function padNumber(value, width = 2, pad = '0') {
    return String(value).padStart(width, pad);
}

function formatRfc3164Timestamp(date = new Date()) {
    return (
        `${MONTHS[date.getMonth()]} ${padNumber(date.getDate(), 2, ' ')} ` +
        `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`
    );
}

function formatRfc5424Timestamp(date = new Date()) {
    return date.toISOString();
}

function octetFrame(message) {
    const length = Buffer.byteLength(message);
    return Buffer.from(`${length} ${message}`, 'utf8');
}

function delayed(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const HAS_V6_FLAG = hasFlag('--v6');
const SERVER_ADDR = getArg('--server', HAS_V6_FLAG ? '::1' : '127.0.0.1');
const SERVER_PORT = parsePortArg('--port', 514);
const TIMEOUT_MS = parsePositiveInt('--timeout', 3000);
const OVERSIZE_BYTES = parsePositiveInt('--oversize-bytes', 9000);
const USE_IPV6 = HAS_V6_FLAG || net.isIPv6(SERVER_ADDR);
const UDP_ONLY = hasFlag('--udp-only');
const TCP_ONLY = hasFlag('--tcp-only');
const INCLUDE_ERROR_CASES = !hasFlag('--no-error-cases');
const DRY_RUN = hasFlag('--dry-run');
const LIST_SCENARIOS = hasFlag('--list-scenarios');

if (UDP_ONLY && TCP_ONLY) {
    throw new Error('--udp-only 和 --tcp-only 不能同时使用');
}
if (USE_IPV6 && net.isIPv4(SERVER_ADDR)) {
    throw new Error(`--v6 模式下 --server 必须是 IPv6 地址，当前值: ${SERVER_ADDR}`);
}

function buildScenarios() {
    const rfc3164Time = formatRfc3164Timestamp();
    const rfc5424Time = formatRfc5424Timestamp();
    const oversizedText = 'x'.repeat(OVERSIZE_BYTES);

    const normalScenarios = [
        {
            id: 'rfc3164-with-tag',
            title: 'RFC3164 + tag/procId',
            expected: 'format=RFC3164, facility=auth, severity=critical',
            message: `<34>${rfc3164Time} netnexus-client authdemo[4242]: RFC3164 auth critical sample`
        },
        {
            id: 'rfc3164-no-procid',
            title: 'RFC3164 + tag',
            expected: 'format=RFC3164, facility=user, severity=notice',
            message: `<13>${rfc3164Time} netnexus-client app: RFC3164 notice sample`
        },
        {
            id: 'rfc5424-structured',
            title: 'RFC5424 + structured data',
            expected: 'format=RFC5424, facility=local4, severity=notice',
            message:
                `<165>1 ${rfc5424Time} netnexus-client syslog-demo 4242 ID47 ` +
                '[exampleSDID@32473 iut="3" eventSource="client-script"] RFC5424 structured data sample'
        },
        {
            id: 'rfc5424-nil-values',
            title: 'RFC5424 + NILVALUE',
            expected: 'format=RFC5424, facility=user, severity=info',
            message: `<14>1 ${rfc5424Time} netnexus-client syslog-demo - - - RFC5424 nil value sample`
        },
        {
            id: 'rfc5424-multi-sd',
            title: 'RFC5424 + multiple structured data blocks',
            expected: 'format=RFC5424, multiple structuredData blocks',
            message:
                `<30>1 ${rfc5424Time} netnexus-client multi-sd 777 MSG99 ` +
                '[meta@32473 env="lab"][trace@32473 request="abc-123"] RFC5424 multiple structured data sample'
        }
    ];

    const errorScenarios = [
        {
            id: 'raw-missing-pri',
            title: 'RAW missing PRI',
            expected: 'status=invalid, parseError=缺少PRI字段',
            message: 'message without priority from syslog client script'
        },
        {
            id: 'invalid-pri-range',
            title: 'PRI out of range',
            expected: 'status=invalid, parseError=PRI范围应为0-191',
            message: `<999>${rfc3164Time} netnexus-client badpri[999]: invalid PRI range sample`
        },
        {
            id: 'rfc5424-missing-sd',
            title: 'RFC5424 missing structured data marker',
            expected: 'status=invalid, parseError=RFC5424结构化数据缺失',
            message: `<14>1 ${rfc5424Time} netnexus-client app 123 MSGID message without structured data marker`
        },
        {
            id: 'rfc5424-incomplete-fields',
            title: 'RFC5424 incomplete fields',
            expected: 'status=invalid, parseError=RFC5424字段不足',
            message: `<14>1 ${rfc5424Time} netnexus-client`
        },
        {
            id: 'rfc5424-broken-sd',
            title: 'RFC5424 incomplete structured data',
            expected: 'status=invalid, parseError=RFC5424结构化数据不完整',
            message: `<14>1 ${rfc5424Time} netnexus-client app - MSGID [broken event started`
        },
        {
            id: 'oversize-message',
            title: 'Oversize message',
            expected: 'UDP/newline/NUL status=truncated；octet-counting 单独发送超限错误帧',
            message: `<14>1 ${rfc5424Time} netnexus-client bigmsg - BIG - ${oversizedText}`
        }
    ];

    return INCLUDE_ERROR_CASES ? normalScenarios.concat(errorScenarios) : normalScenarios;
}

function printScenarioList(scenarios) {
    console.log('Syslog 消息场景:');
    scenarios.forEach((scenario, index) => {
        console.log(`${padNumber(index + 1, 2)}. ${scenario.id}`);
        console.log(`    ${scenario.title}`);
        console.log(`    预期: ${scenario.expected}`);
        console.log(`    长度: ${Buffer.byteLength(scenario.message)} bytes`);
    });

    if (INCLUDE_ERROR_CASES) {
        console.log('\nTCP 专用错误/边界场景:');
        console.log('  - tcp-octet-split: octet-counting 帧拆成两次 write，验证缓冲重组');
        console.log('  - tcp-close-flush: 无分隔符报文在连接关闭时落表');
        console.log('  - tcp-octet-zero-length: octet-counting 长度为 0，触发错误记录');
        console.log('  - tcp-octet-over-limit: octet-counting 长度超过服务端单条限制，触发错误记录');
    }
}

function sendUdpMessage(message, label) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket({ type: USE_IPV6 ? 'udp6' : 'udp4', reuseAddr: true });
        const payload = Buffer.from(message, 'utf8');
        socket.once('error', error => {
            socket.close();
            reject(error);
        });
        socket.send(payload, 0, payload.length, SERVER_PORT, SERVER_ADDR, error => {
            socket.close();
            if (error) {
                reject(error);
                return;
            }
            resolve({ label, bytes: payload.length });
        });
    });
}

function sendTcpPayload(payload, label, options = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({
            host: SERVER_ADDR,
            port: SERVER_PORT,
            family: USE_IPV6 ? 6 : 4
        });
        let settled = false;
        let connected = false;
        const buffers = Array.isArray(payload) ? payload : [payload];
        const timeout = setTimeout(() => {
            finish(new Error(`TCP发送超时 (${TIMEOUT_MS} ms)`));
            socket.destroy();
        }, TIMEOUT_MS);

        function finish(error, data) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            socket.removeAllListeners();
            if (error) {
                reject(error);
                return;
            }
            resolve(data);
        }

        socket.on('connect', async () => {
            connected = true;
            try {
                for (const buffer of buffers) {
                    socket.write(buffer);
                    if (options.chunkDelayMs) {
                        await delayed(options.chunkDelayMs);
                    }
                }
                if (options.end !== false) {
                    socket.end();
                }
            } catch (error) {
                finish(error);
            }
        });

        socket.on('error', error => {
            if (connected && options.allowReset && ['ECONNRESET', 'EPIPE'].includes(error.code)) {
                finish(null, { label, bytes: Buffer.concat(buffers).length, reset: true });
                return;
            }
            finish(error);
        });

        socket.on('close', hadError => {
            if (hadError && !options.allowReset) {
                return;
            }
            finish(null, { label, bytes: Buffer.concat(buffers).length, reset: hadError });
        });
    });
}

async function runUdpScenarios(scenarios) {
    let sent = 0;
    for (const scenario of scenarios) {
        const result = await sendUdpMessage(scenario.message, `UDP/${scenario.id}`);
        sent += 1;
        console.log(`  ✓ ${result.label} (${result.bytes} bytes)`);
    }
    return sent;
}

async function runTcpDelimitedScenarios(scenarios, delimiterName, delimiter) {
    const payload = Buffer.from(scenarios.map(scenario => scenario.message).join(delimiter) + delimiter, 'utf8');
    const result = await sendTcpPayload(payload, `TCP/${delimiterName}`);
    console.log(`  ✓ ${result.label} (${scenarios.length} messages, ${result.bytes} bytes)`);
    return scenarios.length;
}

async function runTcpOctetScenarios(scenarios) {
    const safeScenarios = scenarios.filter(scenario => scenario.id !== 'oversize-message');
    const payload = Buffer.concat(safeScenarios.map(scenario => octetFrame(scenario.message)));
    const result = await sendTcpPayload(payload, 'TCP/octet-counting');
    console.log(`  ✓ ${result.label} (${safeScenarios.length} messages, ${result.bytes} bytes)`);
    return safeScenarios.length;
}

async function runTcpBoundaryScenarios() {
    const timestamp = formatRfc5424Timestamp();
    let sent = 0;

    const splitMessage = `<14>1 ${timestamp} netnexus-client tcp-split 100 SPLIT - TCP octet-counting split frame sample`;
    const splitFrame = octetFrame(splitMessage);
    const splitAt = Math.max(1, Math.floor(splitFrame.length / 2));
    const splitResult = await sendTcpPayload(
        [splitFrame.slice(0, splitAt), splitFrame.slice(splitAt)],
        'TCP/octet-counting-split',
        { chunkDelayMs: 50 }
    );
    console.log(`  ✓ ${splitResult.label} (1 message, ${splitResult.bytes} bytes)`);
    sent += 1;

    const closeFlushMessage = `<13>${formatRfc3164Timestamp()} netnexus-client closeflush[100]: TCP close flush sample`;
    const closeFlushResult = await sendTcpPayload(Buffer.from(closeFlushMessage, 'utf8'), 'TCP/close-flush');
    console.log(`  ✓ ${closeFlushResult.label} (1 message, ${closeFlushResult.bytes} bytes)`);
    sent += 1;

    if (!INCLUDE_ERROR_CASES) {
        return sent;
    }

    const zeroLengthResult = await sendTcpPayload(Buffer.from('0 ', 'utf8'), 'TCP/octet-zero-length', {
        allowReset: true
    });
    console.log(`  ✓ ${zeroLengthResult.label} (expected error record, ${zeroLengthResult.bytes} bytes)`);
    sent += 1;

    const overLimitFrame = Buffer.from(`999999 ${splitMessage}`, 'utf8');
    const overLimitResult = await sendTcpPayload(overLimitFrame, 'TCP/octet-over-limit', {
        allowReset: true
    });
    console.log(`  ✓ ${overLimitResult.label} (expected error record, ${overLimitResult.bytes} bytes)`);
    sent += 1;

    return sent;
}

async function main() {
    const scenarios = buildScenarios();

    if (LIST_SCENARIOS) {
        printScenarioList(scenarios);
        return;
    }

    console.log('============================================================');
    console.log('  Syslog 客户端上报脚本');
    console.log('============================================================');
    console.log(`  服务器地址:   ${SERVER_ADDR}:${SERVER_PORT}`);
    console.log(`  地址族:       ${USE_IPV6 ? 'IPv6' : 'IPv4'}`);
    console.log(`  UDP场景:      ${TCP_ONLY ? '跳过' : '启用'}`);
    console.log(`  TCP场景:      ${UDP_ONLY ? '跳过' : '启用'}`);
    console.log(`  异常场景:     ${INCLUDE_ERROR_CASES ? '启用' : '跳过'}`);
    console.log(`  超长正文长度: ${OVERSIZE_BYTES} bytes`);
    console.log(`  Dry Run:      ${DRY_RUN ? 'yes' : 'no'}`);
    console.log('============================================================');

    printScenarioList(scenarios);

    if (DRY_RUN) {
        return;
    }

    let sentActions = 0;

    if (!TCP_ONLY) {
        console.log('\n[UDP] 单报文场景');
        sentActions += await runUdpScenarios(scenarios);
    }

    if (!UDP_ONLY) {
        console.log('\n[TCP] 换行分帧');
        sentActions += await runTcpDelimitedScenarios(scenarios, 'newline', '\n');

        console.log('\n[TCP] NUL 分帧');
        sentActions += await runTcpDelimitedScenarios(scenarios, 'nul', '\0');

        console.log('\n[TCP] octet-counting 分帧');
        sentActions += await runTcpOctetScenarios(scenarios);

        console.log('\n[TCP] 边界/错误场景');
        sentActions += await runTcpBoundaryScenarios();
    }

    console.log('\n============================================================');
    console.log(`  发送动作完成: ${sentActions}`);
    console.log('  Syslog 协议无应用层响应，请在 NetNexus 的 Syslog 消息日志页查看解析结果。');
    console.log('============================================================');
}

main().catch(error => {
    console.error('执行失败:', error.message);
    process.exit(1);
});
