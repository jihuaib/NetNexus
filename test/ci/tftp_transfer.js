/**
 * TFTP 功能验证脚本 (跨平台，纯 Node.js)
 *
 * 直接复用 electron/worker/tftpSession.js 的传输状态机搭建一个 TFTP 服务端，
 * 并实现一个最小化的 TFTP 客户端，对以下场景做端到端验证：
 *   1. WRQ 上传 (octet, 默认 512 块) -> 校验落盘文件
 *   2. RRQ 下载 -> 校验下载内容
 *   3. blksize 选项协商 (OACK) + 多块大文件上传/下载
 *   4. 文件大小恰为块大小整数倍 (含空尾块) 的下载
 *   5. RRQ 下载不存在文件 -> 期望 ERROR(1) FILE_NOT_FOUND
 *   6. allowWrite=false 时 WRQ -> 期望 ERROR(2) ACCESS_VIOLATION
 *   7. 路径穿越 (../) -> 期望 ERROR(2) ACCESS_VIOLATION
 *   8. IPv6 (::1) 端到端上传/下载 (环境不支持 IPv6 时自动跳过)
 *
 * 运行: node test/ci/tftp_transfer.js (或 npm test 自动发现执行)
 */

const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const TftpSession = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'tftpSession.js'));
const TftpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'tftpConst.js'));

const OP = TftpConst.TFTP_OPCODES;
const HOST = '127.0.0.1';

// ============ 报文工具 ============

function buildRequest(opcode, filename, mode, options) {
    const segs = [Buffer.from([0x00, opcode]), Buffer.from(filename, 'ascii'), Buffer.from([0]), Buffer.from(mode, 'ascii'), Buffer.from([0])];
    for (const [k, v] of Object.entries(options || {})) {
        segs.push(Buffer.from(k, 'ascii'), Buffer.from([0]), Buffer.from(String(v), 'ascii'), Buffer.from([0]));
    }
    return Buffer.concat(segs);
}

function buildAck(block) {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(OP.ACK, 0);
    b.writeUInt16BE(block & 0xffff, 2);
    return b;
}

function buildData(block, data) {
    const b = Buffer.alloc(4 + data.length);
    b.writeUInt16BE(OP.DATA, 0);
    b.writeUInt16BE(block & 0xffff, 2);
    data.copy(b, 4);
    return b;
}

function parseOptions(msg) {
    const parts = [];
    let start = 2;
    for (let i = 2; i < msg.length; i++) {
        if (msg[i] === 0) {
            parts.push(msg.toString('ascii', start, i));
            start = i + 1;
        }
    }
    const opts = {};
    for (let i = 0; i + 1 < parts.length; i += 2) {
        opts[parts[i].toLowerCase()] = parts[i + 1];
    }
    return opts;
}

// ============ 最小 TFTP 客户端 ============

function tftpDownload(port, family, host, filename, options = {}) {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket(family);
        let blksize = options.blksize ? parseInt(options.blksize, 10) : 512;
        let serverTid = null;
        let oackSeen = false;
        const chunks = [];
        let done = false;

        const finish = (err, data) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sock.close();
            err ? reject(err) : resolve({ data, oackSeen });
        };
        const timer = setTimeout(() => finish(new Error('下载超时')), 5000);

        sock.on('error', e => finish(e));
        sock.on('message', (msg, rinfo) => {
            serverTid = rinfo.port;
            const op = msg.readUInt16BE(0);
            if (op === OP.ERROR) {
                const code = msg.readUInt16BE(2);
                const e = new Error(msg.toString('ascii', 4, msg.length - 1));
                e.tftpCode = code;
                finish(e);
            } else if (op === OP.OACK) {
                oackSeen = true;
                const opts = parseOptions(msg);
                if (opts.blksize) blksize = parseInt(opts.blksize, 10);
                sock.send(buildAck(0), serverTid, host);
            } else if (op === OP.DATA) {
                const block = msg.readUInt16BE(2);
                const data = msg.slice(4);
                chunks.push(Buffer.from(data));
                sock.send(buildAck(block), serverTid, host);
                if (data.length < blksize) {
                    finish(null, Buffer.concat(chunks));
                }
            }
        });

        sock.send(buildRequest(OP.RRQ, filename, 'octet', options), port, host);
    });
}

function tftpUpload(port, family, host, filename, content, options = {}) {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket(family);
        let blksize = options.blksize ? parseInt(options.blksize, 10) : 512;
        let serverTid = null;
        let oackSeen = false;
        let lastBlockSent = 0;
        let finalSent = false;
        let done = false;

        const finish = (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sock.close();
            err ? reject(err) : resolve({ oackSeen });
        };
        const timer = setTimeout(() => finish(new Error('上传超时')), 5000);

        const sendBlock = block => {
            const offset = (block - 1) * blksize;
            const chunk = content.slice(offset, Math.min(offset + blksize, content.length));
            sock.send(buildData(block, chunk), serverTid, host);
            return chunk.length;
        };

        sock.on('error', e => finish(e));
        sock.on('message', (msg, rinfo) => {
            serverTid = rinfo.port;
            const op = msg.readUInt16BE(0);
            if (op === OP.ERROR) {
                const code = msg.readUInt16BE(2);
                const e = new Error(msg.toString('ascii', 4, msg.length - 1));
                e.tftpCode = code;
                finish(e);
            } else if (op === OP.OACK) {
                oackSeen = true;
                const opts = parseOptions(msg);
                if (opts.blksize) blksize = parseInt(opts.blksize, 10);
                lastBlockSent = 1;
                finalSent = sendBlock(1) < blksize;
            } else if (op === OP.ACK) {
                const acked = msg.readUInt16BE(2);
                if (finalSent && acked === lastBlockSent) {
                    finish(null);
                    return;
                }
                if (acked === lastBlockSent) {
                    lastBlockSent += 1;
                    finalSent = sendBlock(lastBlockSent) < blksize;
                }
            }
        });

        sock.send(buildRequest(OP.WRQ, filename, 'octet', options), port, host);
    });
}

// ============ 服务端 (复用 TftpSession) ============

function startServer(config, family = 'udp4', host = HOST) {
    return new Promise((resolve, reject) => {
        const sessions = new Set();
        let counter = 0;
        const ipVersion = family === 'udp6' ? 'IPv6' : 'IPv4';
        const server = dgram.createSocket(family);

        server.on('error', reject);
        server.on('message', (msg, rinfo) => {
            const op = msg.readUInt16BE(0);
            if (op !== OP.RRQ && op !== OP.WRQ) return;
            const session = new TftpSession({
                config,
                family,
                ipVersion,
                transferId: ++counter,
                onUpdate: () => {},
                onClose: s => sessions.delete(s)
            });
            sessions.add(session);
            try {
                session.start(op, msg, rinfo);
            } catch (e) {
                sessions.delete(session);
            }
        });

        server.bind(0, host, () => {
            resolve({
                port: server.address().port,
                close: () => {
                    sessions.forEach(s => s.cleanup());
                    server.close();
                }
            });
        });
    });
}

// 检测当前环境是否支持 IPv6 回环 (::1)，CI 环境可能未启用 IPv6
function ipv6LoopbackAvailable() {
    return new Promise(resolve => {
        const probe = dgram.createSocket('udp6');
        probe.once('error', () => {
            probe.close();
            resolve(false);
        });
        probe.bind(0, '::1', () => {
            probe.close();
            resolve(true);
        });
    });
}

// ============ 测试运行器 ============

let passed = 0;
let failed = 0;

function assert(cond, name, detail = '') {
    if (cond) {
        passed += 1;
        console.log(`  ✓ ${name}`);
    } else {
        failed += 1;
        console.log(`  ✗ ${name} ${detail}`);
    }
}

async function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tftp-verify-'));
    const config = {
        rootDir: tmpRoot,
        blockSize: 512,
        timeout: 2,
        retries: 3,
        allowRead: true,
        allowWrite: true
    };

    const server = await startServer(config);
    console.log(`TFTP 测试服务器监听端口: ${server.port}, 根目录: ${tmpRoot}\n`);

    try {
        // --- 1. 上传 (小文件，默认块大小) ---
        console.log('[1] WRQ 上传 (小文件, 默认 512 块)');
        const small = Buffer.from('Hello TFTP! 你好，TFTP！\n', 'utf8');
        await tftpUpload(server.port, 'udp4', HOST, 'small.txt', small);
        const onDisk = fs.readFileSync(path.join(tmpRoot, 'small.txt'));
        assert(onDisk.equals(small), '上传内容与落盘文件一致');

        // --- 2. 下载刚上传的文件 ---
        console.log('[2] RRQ 下载小文件');
        const dl = await tftpDownload(server.port, 'udp4', HOST, 'small.txt');
        assert(dl.data.equals(small), '下载内容与原文件一致');

        // --- 3. blksize 协商 + 多块大文件 ---
        console.log('[3] blksize 选项协商 + 多块大文件 (5000 字节, blksize=1024)');
        const big = crypto.randomBytes(5000);
        const up3 = await tftpUpload(server.port, 'udp4', HOST, 'big.bin', big, { blksize: '1024', tsize: '5000' });
        assert(up3.oackSeen, '上传收到 OACK 选项确认');
        const big3 = fs.readFileSync(path.join(tmpRoot, 'big.bin'));
        assert(big3.equals(big), '多块上传内容一致 (5000 字节)');
        const dl3 = await tftpDownload(server.port, 'udp4', HOST, 'big.bin', { blksize: '1024', tsize: '0' });
        assert(dl3.oackSeen, '下载收到 OACK 选项确认');
        assert(dl3.data.equals(big), '多块下载内容一致 (5000 字节)');

        // --- 4. 文件大小恰为块大小整数倍 (空尾块) ---
        console.log('[4] 整数倍块大小下载 (1024 字节, blksize=512 -> 含空尾块)');
        const exact = crypto.randomBytes(1024);
        fs.writeFileSync(path.join(tmpRoot, 'exact.bin'), exact);
        const dl4 = await tftpDownload(server.port, 'udp4', HOST, 'exact.bin');
        assert(dl4.data.equals(exact), '整数倍块大小下载内容一致 (1024 字节)');

        // --- 5. 下载不存在文件 ---
        console.log('[5] RRQ 下载不存在的文件');
        let err5 = null;
        try {
            await tftpDownload(server.port, 'udp4', HOST, 'no-such-file.txt');
        } catch (e) {
            err5 = e;
        }
        assert(
            err5 && err5.tftpCode === TftpConst.TFTP_ERROR_CODES.FILE_NOT_FOUND,
            '返回 ERROR(1) FILE_NOT_FOUND',
            err5 ? `(实际 code=${err5.tftpCode})` : '(未收到错误)'
        );

        // --- 6. 禁止写入 ---
        console.log('[6] allowWrite=false 时上传');
        const roServer = await startServer({ ...config, allowWrite: false });
        let err6 = null;
        try {
            await tftpUpload(roServer.port, 'udp4', HOST, 'blocked.txt', Buffer.from('x'));
        } catch (e) {
            err6 = e;
        }
        roServer.close();
        assert(
            err6 && err6.tftpCode === TftpConst.TFTP_ERROR_CODES.ACCESS_VIOLATION,
            '返回 ERROR(2) ACCESS_VIOLATION',
            err6 ? `(实际 code=${err6.tftpCode})` : '(未收到错误)'
        );

        // --- 7. 路径穿越防护 ---
        console.log('[7] 路径穿越 (../../etc/passwd) 防护');
        let err7 = null;
        try {
            await tftpDownload(server.port, 'udp4', HOST, '../../../../etc/passwd');
        } catch (e) {
            err7 = e;
        }
        assert(
            err7 && err7.tftpCode === TftpConst.TFTP_ERROR_CODES.ACCESS_VIOLATION,
            '路径穿越被拒绝 ERROR(2)',
            err7 ? `(实际 code=${err7.tftpCode})` : '(未收到错误)'
        );

        // --- 8. IPv6 端到端 (上传 + 多块下载) ---
        console.log('[8] IPv6 (::1) 端到端上传/下载');
        const hasIpv6 = await ipv6LoopbackAvailable();
        if (!hasIpv6) {
            console.log('  ⊘ 跳过: 当前环境不支持 IPv6 回环 (::1)');
        } else {
            const v6Server = await startServer(config, 'udp6', '::1');
            try {
                const v6Data = crypto.randomBytes(3000);
                const up8 = await tftpUpload(v6Server.port, 'udp6', '::1', 'v6.bin', v6Data, {
                    blksize: '1024',
                    tsize: '3000'
                });
                assert(up8.oackSeen, 'IPv6 上传收到 OACK 选项确认');
                const v6OnDisk = fs.readFileSync(path.join(tmpRoot, 'v6.bin'));
                assert(v6OnDisk.equals(v6Data), 'IPv6 多块上传内容一致 (3000 字节)');
                const dl8 = await tftpDownload(v6Server.port, 'udp6', '::1', 'v6.bin', { blksize: '1024' });
                assert(dl8.data.equals(v6Data), 'IPv6 多块下载内容一致 (3000 字节)');
            } finally {
                v6Server.close();
            }
        }
    } finally {
        server.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    console.log(`\n==== 结果: ${passed} 通过, ${failed} 失败 ====`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('验证脚本异常:', err);
    process.exit(1);
});
