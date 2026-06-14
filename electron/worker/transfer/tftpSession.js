const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const logger = require('../../log/logger');
const TftpConst = require('../../const/tftpConst');

const OP = TftpConst.TFTP_OPCODES;
const ERR = TftpConst.TFTP_ERROR_CODES;
const STATUS = TftpConst.TFTP_TRANSFER_STATUS;
const TYPE = TftpConst.TFTP_TRANSFER_TYPE;

/**
 * 单次 TFTP 传输会话。
 * 每个传输按 RFC 1350 使用一个独立的临时 UDP socket (服务端 TID)，
 * 后续的 DATA/ACK/OACK 都在该 socket 与客户端 TID 之间往返。
 */
class TftpSession {
    /**
     * @param {object} options
     * @param {object} options.config 服务器配置 (rootDir, blockSize, timeout, retries, allowRead, allowWrite)
     * @param {'udp4'|'udp6'} options.family 监听到请求的地址族
     * @param {string} options.ipVersion 'IPv4' | 'IPv6'
     * @param {number} options.transferId 传输 ID
     * @param {(transferId:number, patch:object)=>void} options.onUpdate 状态更新回调
     * @param {(session:TftpSession)=>void} options.onClose 会话结束回调
     */
    constructor(options) {
        this.config = options.config;
        this.family = options.family;
        this.ipVersion = options.ipVersion;
        this.transferId = options.transferId;
        this.onUpdate = options.onUpdate || (() => {});
        this.onClose = options.onClose || (() => {});

        this.socket = null;
        this.clientAddress = null;
        this.clientPort = null;

        this.type = null; // 'read' | 'write'
        this.filename = null;
        this.mode = 'octet';
        this.blockSize = TftpConst.TFTP_BLOCK_SIZE.DEFAULT;
        this.timeoutMs = (Number(this.config.timeout) || 3) * 1000;
        this.maxRetries = Number(this.config.retries);
        if (!Number.isFinite(this.maxRetries)) {
            this.maxRetries = 5;
        }

        // 传输状态
        this.fileBuffer = null; // RRQ: 整个文件内容
        this.writeChunks = []; // WRQ: 接收到的数据块
        this.totalSize = 0;
        this.bytes = 0;
        this.blockNumber = 0; // 最近发送的 DATA 块号 (读) / 最近确认的块号 (写)
        this.finalBlock = 0; // 读取时的最后一个块号
        this.expectOackAck = false; // 已发送 OACK，等待 ACK 0
        this.oackOptions = null; // 待确认的选项

        // 重传
        this.lastSent = null;
        this.retries = 0;
        this.timer = null;

        this.closed = false;
        this.startTime = Date.now();
    }

    // ============ 报文解析/构造 ============

    static parseRequest(buffer) {
        // 跳过 2 字节操作码，剩余为以 0x00 分隔的字符串序列
        const parts = [];
        let start = 2;
        for (let i = 2; i < buffer.length; i++) {
            if (buffer[i] === 0) {
                parts.push(buffer.toString('ascii', start, i));
                start = i + 1;
            }
        }
        const [filename, mode, ...rest] = parts;
        const options = {};
        for (let i = 0; i + 1 < rest.length; i += 2) {
            options[rest[i].toLowerCase()] = rest[i + 1];
        }
        return { filename, mode: (mode || 'octet').toLowerCase(), options };
    }

    buildData(blockNumber, data) {
        const buf = Buffer.alloc(4 + data.length);
        buf.writeUInt16BE(OP.DATA, 0);
        buf.writeUInt16BE(blockNumber & 0xffff, 2);
        data.copy(buf, 4);
        return buf;
    }

    buildAck(blockNumber) {
        const buf = Buffer.alloc(4);
        buf.writeUInt16BE(OP.ACK, 0);
        buf.writeUInt16BE(blockNumber & 0xffff, 2);
        return buf;
    }

    buildError(code, message) {
        const msgBuf = Buffer.from(String(message || ''), 'ascii');
        const buf = Buffer.alloc(4 + msgBuf.length + 1);
        buf.writeUInt16BE(OP.ERROR, 0);
        buf.writeUInt16BE(code, 2);
        msgBuf.copy(buf, 4);
        buf.writeUInt8(0, 4 + msgBuf.length);
        return buf;
    }

    buildOack(options) {
        const segments = [];
        for (const [key, value] of Object.entries(options)) {
            segments.push(Buffer.from(key, 'ascii'), Buffer.from([0]));
            segments.push(Buffer.from(String(value), 'ascii'), Buffer.from([0]));
        }
        return Buffer.concat([Buffer.from([0x00, OP.OACK]), ...segments]);
    }

    // ============ 路径安全 ============

    resolveSafePath(filename) {
        const rootDir = path.resolve(this.config.rootDir);
        // filename 使用 '/' 分隔，统一交给 path.normalize 处理跨平台
        const target = path.resolve(rootDir, '.' + path.sep + filename);
        const rel = path.relative(rootDir, target);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            return null; // 越界
        }
        return target;
    }

    // ============ 入口 ============

    start(opcode, requestBuffer, rinfo) {
        this.clientAddress = rinfo.address;
        this.clientPort = rinfo.port;

        const { filename, mode, options } = TftpSession.parseRequest(requestBuffer);
        this.filename = filename;
        this.mode = mode;

        this.socket = dgram.createSocket(this.family);
        this.socket.on('message', (msg, sender) => this.onSocketMessage(msg, sender));
        this.socket.on('error', err => {
            logger.error(`TFTP 会话 socket 错误: ${err.message}`);
            this.fail(`socket 错误: ${err.message}`);
        });

        this.socket.bind(0, () => {
            if (opcode === OP.RRQ) {
                this.type = TYPE.READ;
                this.beginRead(filename, options);
            } else {
                this.type = TYPE.WRITE;
                this.beginWrite(filename, options);
            }
        });

        this.emitUpdate({
            status: STATUS.TRANSFERRING,
            message: opcode === OP.RRQ ? '开始下载' : '开始上传'
        });
    }

    // ============ 选项协商 ============

    negotiateOptions(requested, fileSize) {
        const accepted = {};
        if (Object.prototype.hasOwnProperty.call(requested, 'blksize')) {
            let blksize = parseInt(requested.blksize, 10);
            if (Number.isFinite(blksize)) {
                blksize = Math.max(TftpConst.TFTP_BLOCK_SIZE.MIN, Math.min(TftpConst.TFTP_BLOCK_SIZE.MAX, blksize));
                this.blockSize = blksize;
                accepted.blksize = String(blksize);
            }
        }
        if (Object.prototype.hasOwnProperty.call(requested, 'timeout')) {
            const t = parseInt(requested.timeout, 10);
            if (Number.isFinite(t) && t >= 1 && t <= 255) {
                this.timeoutMs = t * 1000;
                accepted.timeout = String(t);
            }
        }
        if (Object.prototype.hasOwnProperty.call(requested, 'tsize')) {
            // RRQ: 服务端回填文件大小; WRQ: 回显客户端声明的大小
            accepted.tsize = fileSize !== null && fileSize !== undefined ? String(fileSize) : requested.tsize;
        }
        return accepted;
    }

    // ============ 读 (RRQ -> 下载) ============

    beginRead(filename, options) {
        if (!this.config.allowRead) {
            this.sendError(ERR.ACCESS_VIOLATION, '服务器禁止读取');
            return;
        }

        const fullPath = this.resolveSafePath(filename);
        if (!fullPath) {
            this.sendError(ERR.ACCESS_VIOLATION, '非法的文件路径');
            return;
        }

        fs.readFile(fullPath, (err, data) => {
            if (this.closed) {
                return;
            }
            if (err) {
                const code = err.code === 'ENOENT' ? ERR.FILE_NOT_FOUND : ERR.ACCESS_VIOLATION;
                this.sendError(code, err.code === 'ENOENT' ? '文件不存在' : '文件不可读');
                return;
            }

            this.fileBuffer = data;
            this.totalSize = data.length;
            // 标准: 块数 = floor(size/blksize) + 1 (最后一块短或空)
            this.emitUpdate({ totalSize: this.totalSize });

            const accepted = this.negotiateOptions(options, this.totalSize);
            this.finalBlock = Math.floor(this.totalSize / this.blockSize) + 1;

            if (Object.keys(accepted).length > 0) {
                // 先发 OACK，等待客户端 ACK 0
                this.expectOackAck = true;
                this.oackOptions = accepted;
                this.sendPacket(this.buildOack(accepted));
            } else {
                this.sendDataBlock(1);
            }
        });
    }

    sendDataBlock(blockNumber) {
        const offset = (blockNumber - 1) * this.blockSize;
        const end = Math.min(offset + this.blockSize, this.totalSize);
        const chunk = this.fileBuffer.slice(offset, end);
        this.blockNumber = blockNumber;
        this.sendPacket(this.buildData(blockNumber, chunk));
    }

    // ============ 写 (WRQ -> 上传) ============

    beginWrite(filename, options) {
        if (!this.config.allowWrite) {
            this.sendError(ERR.ACCESS_VIOLATION, '服务器禁止写入');
            return;
        }

        const fullPath = this.resolveSafePath(filename);
        if (!fullPath) {
            this.sendError(ERR.ACCESS_VIOLATION, '非法的文件路径');
            return;
        }
        this.writePath = fullPath;
        this.writeChunks = [];
        this.bytes = 0;
        this.blockNumber = 0; // 期望的下一个数据块号为 1

        const declaredSize = options.tsize !== undefined ? parseInt(options.tsize, 10) : null;
        if (Number.isFinite(declaredSize)) {
            this.totalSize = declaredSize;
            this.emitUpdate({ totalSize: declaredSize });
        }

        const accepted = this.negotiateOptions(options, declaredSize);
        if (Object.keys(accepted).length > 0) {
            // OACK 等同于对 块0 的确认，客户端随后发送 DATA 块1
            this.sendPacket(this.buildOack(accepted));
        } else {
            this.sendPacket(this.buildAck(0));
        }
    }

    // ============ socket 消息处理 ============

    onSocketMessage(msg, sender) {
        if (this.closed) {
            return;
        }
        // TID 校验: 只接受来自原客户端地址/端口的报文
        if (sender.address !== this.clientAddress || sender.port !== this.clientPort) {
            const errPkt = this.buildError(ERR.UNKNOWN_TID, 'Unknown transfer ID');
            this.socket.send(errPkt, sender.port, sender.address);
            return;
        }

        if (msg.length < 4 && msg.length < 2) {
            return;
        }
        const opcode = msg.readUInt16BE(0);

        if (opcode === OP.ERROR) {
            const code = msg.length >= 4 ? msg.readUInt16BE(2) : 0;
            this.fail(`客户端错误 (${code})`);
            return;
        }

        if (this.type === TYPE.READ) {
            this.handleReadAck(msg, opcode);
        } else if (this.type === TYPE.WRITE) {
            this.handleWriteData(msg, opcode);
        }
    }

    handleReadAck(msg, opcode) {
        if (opcode !== OP.ACK || msg.length < 4) {
            return;
        }
        const acked = msg.readUInt16BE(2);

        if (this.expectOackAck) {
            if (acked === 0) {
                this.expectOackAck = false;
                this.clearTimer();
                this.sendDataBlock(1);
            }
            return;
        }

        if (acked !== this.blockNumber) {
            return; // 重复/过期 ACK，忽略 (定时器负责重传)
        }

        this.clearTimer();
        this.retries = 0;
        this.bytes = Math.min(acked * this.blockSize, this.totalSize);

        if (acked >= this.finalBlock) {
            this.complete(`下载完成 (${this.totalSize} 字节)`);
            return;
        }
        this.emitUpdate({ bytes: this.bytes, blocks: acked });
        this.sendDataBlock(acked + 1);
    }

    handleWriteData(msg, opcode) {
        if (opcode !== OP.DATA || msg.length < 4) {
            return;
        }
        const block = msg.readUInt16BE(2);
        const data = msg.slice(4);
        const expected = (this.blockNumber + 1) & 0xffff;

        if (block === expected) {
            this.writeChunks.push(Buffer.from(data));
            this.bytes += data.length;
            this.blockNumber = block;
            this.clearTimer();
            this.retries = 0;

            const isLast = data.length < this.blockSize;
            if (isLast) {
                // 最后一块: 先落盘再发送 ACK，确保客户端收到 ACK 时数据已持久化 (RFC 1350)
                this.flushWriteFile(block);
            } else {
                this.sendPacket(this.buildAck(block), true);
                this.emitUpdate({ bytes: this.bytes, blocks: block });
            }
        } else if (block === this.blockNumber) {
            // 重复块，重发上一个 ACK
            this.socket.send(this.buildAck(block), this.clientPort, this.clientAddress);
        }
    }

    flushWriteFile(lastBlock) {
        const content = Buffer.concat(this.writeChunks);
        fs.writeFile(this.writePath, content, err => {
            if (this.closed) {
                return;
            }
            if (err) {
                const code = err.code === 'ENOSPC' ? ERR.DISK_FULL : ERR.ACCESS_VIOLATION;
                this.sendError(code, '写入文件失败');
                return;
            }
            this.totalSize = content.length;
            // 数据已落盘，再发送最后一个 ACK；UDP send 为异步，需在回调中再 complete()
            if (this.socket && !this.closed) {
                this.socket.send(this.buildAck(lastBlock), this.clientPort, this.clientAddress, () => {
                    this.complete(`上传完成 (${content.length} 字节)`);
                });
            } else {
                this.complete(`上传完成 (${content.length} 字节)`);
            }
        });
    }

    // ============ 发送/重传 ============

    /**
     * 发送报文并(可选)启动重传定时器。
     * @param {Buffer} buffer
     * @param {boolean} expectReply 是否需要等待对端回应 (启动重传)
     */
    sendPacket(buffer, expectReply = true) {
        if (this.closed || !this.socket) {
            return;
        }
        this.lastSent = buffer;
        this.socket.send(buffer, this.clientPort, this.clientAddress, err => {
            if (err) {
                logger.error(`TFTP 发送失败: ${err.message}`);
            }
        });
        this.clearTimer();
        if (expectReply) {
            this.armTimer();
        }
    }

    armTimer() {
        this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
    }

    clearTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    onTimeout() {
        if (this.closed) {
            return;
        }
        if (this.retries >= this.maxRetries) {
            this.fail('传输超时');
            return;
        }
        this.retries += 1;
        if (this.lastSent && this.socket) {
            this.socket.send(this.lastSent, this.clientPort, this.clientAddress);
        }
        this.armTimer();
    }

    // ============ 结束 ============

    sendError(code, message) {
        // UDP send 为异步操作，必须在发送回调中再关闭 socket，否则报文可能在 flush 前被丢弃
        if (this.socket && !this.closed) {
            this.socket.send(this.buildError(code, message), this.clientPort, this.clientAddress, () => {
                this.fail(message);
            });
        } else {
            this.fail(message);
        }
    }

    complete(message) {
        if (this.closed) {
            return;
        }
        this.emitUpdate({ status: STATUS.COMPLETED, bytes: this.totalSize, message });
        this.cleanup();
    }

    fail(message) {
        if (this.closed) {
            return;
        }
        this.emitUpdate({ status: STATUS.ERROR, message });
        this.cleanup();
    }

    cleanup() {
        this.closed = true;
        this.clearTimer();
        if (this.socket) {
            try {
                this.socket.close();
            } catch (_e) {
                // 忽略关闭错误
            }
            this.socket = null;
        }
        this.fileBuffer = null;
        this.writeChunks = [];
        this.onClose(this);
    }

    emitUpdate(patch) {
        this.onUpdate(this.transferId, {
            type: this.type,
            filename: this.filename,
            mode: this.mode,
            blockSize: this.blockSize,
            clientAddress: this.clientAddress,
            clientPort: this.clientPort,
            ipVersion: this.ipVersion,
            ...patch
        });
    }
}

module.exports = TftpSession;
