const dgram = require('dgram');
const net = require('net');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const SyslogConst = require('../../const/syslogConst');
const { parseSyslogBuffer } = require('../../utils/syslogParser');

function formatTime(ms = Date.now()) {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}

function buildStartErrorMessage(error, port) {
    let hint = '';
    if (error.code === 'EACCES' || error.code === 'EPERM') {
        hint = `（绑定 ${port} 端口需要管理员/root 权限）`;
    } else if (error.code === 'EADDRINUSE') {
        hint = `（${port} 端口已被占用，可修改监听端口后重试）`;
    }
    return 'Syslog服务器启动失败: ' + error.message + hint;
}

function trimTcpFrame(frame) {
    let end = frame.length;
    while (end > 0 && (frame[end - 1] === 0x0a || frame[end - 1] === 0x0d || frame[end - 1] === 0x00)) {
        end -= 1;
    }
    return end === frame.length ? frame : frame.slice(0, end);
}

function findFrameDelimiter(buffer) {
    const newlineIndex = buffer.indexOf(0x0a);
    const nullIndex = buffer.indexOf(0x00);

    if (newlineIndex === -1) {
        return nullIndex;
    }
    if (nullIndex === -1) {
        return newlineIndex;
    }
    return Math.min(newlineIndex, nullIndex);
}

function readOctetCountingPrefix(buffer) {
    if (!buffer.length || buffer[0] < 0x30 || buffer[0] > 0x39) {
        return null;
    }

    let pos = 0;
    while (pos < buffer.length && buffer[pos] >= 0x30 && buffer[pos] <= 0x39 && pos < 10) {
        pos += 1;
    }

    if (pos === 0 || pos === buffer.length) {
        return null;
    }

    if (buffer[pos] !== 0x20) {
        return null;
    }

    const length = Number(buffer.toString('ascii', 0, pos));
    if (!Number.isInteger(length) || length <= 0) {
        return { invalid: true, message: 'TCP octet-counting长度无效' };
    }

    return {
        prefixLength: pos + 1,
        length
    };
}

class SyslogWorker {
    constructor() {
        this.udp4Server = null;
        this.udp6Server = null;
        this.tcp4Server = null;
        this.tcp6Server = null;
        this.tcpClients = new Set();
        this.syslogConfig = null;
        this.messageHistory = [];
        this.messageCounter = 0;
        this.totalReceived = 0;
        this.historyLimit = SyslogConst.DEFAULT_SYSLOG_SETTINGS.maxHistory;

        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.messageHandler.registerHandler(SyslogConst.SYSLOG_REQ_TYPES.START_SYSLOG, this.startSyslog.bind(this));
        this.messageHandler.registerHandler(SyslogConst.SYSLOG_REQ_TYPES.STOP_SYSLOG, this.stopSyslog.bind(this));
        this.messageHandler.registerHandler(
            SyslogConst.SYSLOG_REQ_TYPES.GET_MESSAGE_LIST,
            this.getMessageList.bind(this)
        );
        this.messageHandler.registerHandler(
            SyslogConst.SYSLOG_REQ_TYPES.GET_MESSAGE_DETAIL,
            this.getMessageDetail.bind(this)
        );
        this.messageHandler.registerHandler(
            SyslogConst.SYSLOG_REQ_TYPES.CLEAR_MESSAGE_HISTORY,
            this.clearMessageHistory.bind(this)
        );
    }

    normalizeConfig(config) {
        const mergedConfig = {
            ...SyslogConst.DEFAULT_SYSLOG_CONFIG,
            ...(config || {})
        };

        return {
            ...mergedConfig,
            port: Number(mergedConfig.port),
            enableUdp: Boolean(mergedConfig.enableUdp),
            enableTcp: Boolean(mergedConfig.enableTcp),
            maxMessageLength: Number(mergedConfig.maxMessageLength)
        };
    }

    validateConfig(config) {
        if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
            throw new Error('监听端口范围应为 1-65535');
        }
        if (!config.enableUdp && !config.enableTcp) {
            throw new Error('请至少启用 UDP 或 TCP 一种传输协议');
        }
        if (
            !Number.isInteger(config.maxMessageLength) ||
            config.maxMessageLength < 128 ||
            config.maxMessageLength > 65535
        ) {
            throw new Error('单条消息最大长度范围应为 128-65535 字节');
        }
    }

    async startSyslog(messageId, config) {
        try {
            this.syslogConfig = this.normalizeConfig(config || {});
            if (this.syslogConfig.logLevel) {
                logger.setLevel(this.syslogConfig.logLevel);
                logger.info(`Worker log level set to: ${this.syslogConfig.logLevel}`);
            }
            this.validateConfig(this.syslogConfig);

            this.messageHistory = [];
            this.messageCounter = 0;
            this.totalReceived = 0;

            if (this.syslogConfig.enableUdp) {
                await this.startUdp4Server();
                await this.tryStartUdp6Server();
            }
            if (this.syslogConfig.enableTcp) {
                await this.startTcp4Server();
                await this.tryStartTcp6Server();
            }

            const data = {
                port: this.syslogConfig.port,
                enableUdp: this.syslogConfig.enableUdp,
                enableTcp: this.syslogConfig.enableTcp,
                maxMessageLength: this.syslogConfig.maxMessageLength,
                messageCount: 0,
                totalReceived: 0
            };

            this.messageHandler.sendSuccessResponse(
                messageId,
                data,
                `Syslog服务器启动成功，监听端口 ${this.syslogConfig.port}`
            );
            this.messageHandler.sendEvent(SyslogConst.SYSLOG_EVT_TYPES.SYSLOG_EVT, {
                type: SyslogConst.SYSLOG_SUB_EVT_TYPES.SERVER_STATUS,
                data: { status: 'running', ...data }
            });
        } catch (error) {
            await this.closeSockets();
            logger.error('启动Syslog服务器失败:', error);
            const port = this.syslogConfig ? this.syslogConfig.port : SyslogConst.DEFAULT_SYSLOG_CONFIG.port;
            this.messageHandler.sendErrorResponse(messageId, buildStartErrorMessage(error, port));
        }
    }

    startUdp4Server() {
        return new Promise((resolve, reject) => {
            this.udp4Server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            let listening = false;

            this.udp4Server.on('message', (msg, rinfo) => {
                this.recordMessage(msg, {
                    transport: SyslogConst.SYSLOG_TRANSPORT.UDP,
                    ipVersion: 'IPv4',
                    clientAddress: rinfo.address,
                    clientPort: rinfo.port
                });
            });

            this.udp4Server.once('error', err => {
                if (!listening) {
                    reject(err);
                    return;
                }
                logger.error('Syslog UDP IPv4 服务器错误:', err);
            });

            this.udp4Server.once('listening', () => {
                listening = true;
                const address = this.udp4Server.address();
                logger.info(`Syslog UDP IPv4服务器监听: ${address.address}:${address.port}`);
                resolve();
            });

            this.udp4Server.bind(this.syslogConfig.port, '0.0.0.0');
        });
    }

    async tryStartUdp6Server() {
        try {
            await new Promise((resolve, reject) => {
                this.udp6Server = dgram.createSocket({ type: 'udp6', reuseAddr: true });
                let listening = false;

                this.udp6Server.on('message', (msg, rinfo) => {
                    this.recordMessage(msg, {
                        transport: SyslogConst.SYSLOG_TRANSPORT.UDP,
                        ipVersion: 'IPv6',
                        clientAddress: rinfo.address,
                        clientPort: rinfo.port
                    });
                });

                this.udp6Server.once('error', err => {
                    if (!listening) {
                        reject(err);
                        return;
                    }
                    logger.error('Syslog UDP IPv6 服务器错误:', err);
                });

                this.udp6Server.once('listening', () => {
                    listening = true;
                    const address = this.udp6Server.address();
                    logger.info(`Syslog UDP IPv6服务器监听: ${address.address}:${address.port}`);
                    resolve();
                });

                this.udp6Server.bind(this.syslogConfig.port, '::');
            });
        } catch (error) {
            if (this.udp6Server) {
                this.udp6Server.close();
                this.udp6Server = null;
            }
            logger.warn(`Syslog UDP IPv6服务器未启动: ${error.message}`);
        }
    }

    startTcp4Server() {
        return new Promise((resolve, reject) => {
            this.tcp4Server = net.createServer(socket => this.handleTcpConnection(socket, 'IPv4'));
            let listening = false;
            const onError = err => {
                if (!listening) {
                    reject(err);
                    return;
                }
                logger.error('Syslog TCP IPv4 服务器错误:', err);
            };

            this.tcp4Server.once('error', onError);
            this.tcp4Server.once('listening', () => {
                listening = true;
                this.tcp4Server.off('error', onError);
                this.tcp4Server.on('error', err => logger.error('Syslog TCP IPv4 服务器错误:', err));
                const address = this.tcp4Server.address();
                logger.info(`Syslog TCP IPv4服务器监听: ${address.address}:${address.port}`);
                resolve();
            });
            this.tcp4Server.listen({ port: this.syslogConfig.port, host: '0.0.0.0' });
        });
    }

    async tryStartTcp6Server() {
        try {
            await new Promise((resolve, reject) => {
                this.tcp6Server = net.createServer(socket => this.handleTcpConnection(socket, 'IPv6'));
                let listening = false;
                const onError = err => {
                    if (!listening) {
                        reject(err);
                        return;
                    }
                    logger.error('Syslog TCP IPv6 服务器错误:', err);
                };

                this.tcp6Server.once('error', onError);
                this.tcp6Server.once('listening', () => {
                    listening = true;
                    this.tcp6Server.off('error', onError);
                    this.tcp6Server.on('error', err => logger.error('Syslog TCP IPv6 服务器错误:', err));
                    const address = this.tcp6Server.address();
                    logger.info(`Syslog TCP IPv6服务器监听: ${address.address}:${address.port}`);
                    resolve();
                });
                this.tcp6Server.listen({ port: this.syslogConfig.port, host: '::', ipv6Only: true });
            });
        } catch (error) {
            if (this.tcp6Server) {
                this.tcp6Server.close();
                this.tcp6Server = null;
            }
            logger.warn(`Syslog TCP IPv6服务器未启动: ${error.message}`);
        }
    }

    handleTcpConnection(socket, ipVersion) {
        socket.syslogBuffer = Buffer.alloc(0);
        socket.syslogClientAddress = socket.remoteAddress || '-';
        socket.syslogClientPort = socket.remotePort || 0;
        socket.setTimeout(SyslogConst.DEFAULT_SYSLOG_SETTINGS.tcpIdleTimeoutMs);
        this.tcpClients.add(socket);

        socket.on('data', chunk => this.handleTcpData(socket, chunk, ipVersion));
        socket.on('timeout', () => socket.end());
        socket.on('error', error => {
            logger.warn(
                `Syslog TCP客户端错误 ${socket.syslogClientAddress}:${socket.syslogClientPort}: ${error.message}`
            );
        });
        socket.on('close', () => {
            const pending = socket.syslogBuffer;
            if (pending && pending.length > 0) {
                this.recordMessage(trimTcpFrame(pending), {
                    transport: SyslogConst.SYSLOG_TRANSPORT.TCP,
                    ipVersion,
                    clientAddress: socket.syslogClientAddress,
                    clientPort: socket.syslogClientPort
                });
            }
            this.tcpClients.delete(socket);
        });
    }

    handleTcpData(socket, chunk, ipVersion) {
        const maxTcpBufferLength = SyslogConst.DEFAULT_SYSLOG_SETTINGS.maxTcpBufferLength;
        let buffer = Buffer.concat([socket.syslogBuffer || Buffer.alloc(0), chunk]);
        if (buffer.length > maxTcpBufferLength) {
            this.recordErrorMessage(buffer.slice(0, this.syslogConfig.maxMessageLength), {
                transport: SyslogConst.SYSLOG_TRANSPORT.TCP,
                ipVersion,
                clientAddress: socket.syslogClientAddress,
                clientPort: socket.syslogClientPort,
                note: 'TCP缓冲区超过限制，连接已关闭'
            });
            socket.syslogBuffer = Buffer.alloc(0);
            socket.destroy();
            return;
        }

        while (buffer.length > 0) {
            const counted = readOctetCountingPrefix(buffer);
            if (counted && counted.invalid) {
                this.recordErrorMessage(buffer, {
                    transport: SyslogConst.SYSLOG_TRANSPORT.TCP,
                    ipVersion,
                    clientAddress: socket.syslogClientAddress,
                    clientPort: socket.syslogClientPort,
                    note: counted.message
                });
                socket.syslogBuffer = Buffer.alloc(0);
                socket.destroy();
                return;
            }

            if (counted) {
                if (counted.length > this.syslogConfig.maxMessageLength) {
                    this.recordErrorMessage(
                        buffer.slice(0, Math.min(buffer.length, this.syslogConfig.maxMessageLength)),
                        {
                            transport: SyslogConst.SYSLOG_TRANSPORT.TCP,
                            ipVersion,
                            clientAddress: socket.syslogClientAddress,
                            clientPort: socket.syslogClientPort,
                            note: 'TCP octet-counting长度超过单条消息限制，连接已关闭'
                        }
                    );
                    socket.syslogBuffer = Buffer.alloc(0);
                    socket.destroy();
                    return;
                }

                const frameEnd = counted.prefixLength + counted.length;
                if (buffer.length < frameEnd) {
                    break;
                }

                const frame = buffer.slice(counted.prefixLength, frameEnd);
                this.recordMessage(frame, {
                    transport: SyslogConst.SYSLOG_TRANSPORT.TCP,
                    ipVersion,
                    clientAddress: socket.syslogClientAddress,
                    clientPort: socket.syslogClientPort
                });
                buffer = buffer.slice(frameEnd);
                continue;
            }

            const delimiterIndex = findFrameDelimiter(buffer);
            if (delimiterIndex !== -1) {
                const frame = trimTcpFrame(buffer.slice(0, delimiterIndex));
                if (frame.length > 0) {
                    this.recordMessage(frame, {
                        transport: SyslogConst.SYSLOG_TRANSPORT.TCP,
                        ipVersion,
                        clientAddress: socket.syslogClientAddress,
                        clientPort: socket.syslogClientPort
                    });
                }
                buffer = buffer.slice(delimiterIndex + 1);
                continue;
            }

            if (buffer.length > this.syslogConfig.maxMessageLength) {
                const frame = buffer.slice(0, this.syslogConfig.maxMessageLength);
                this.recordMessage(frame, {
                    transport: SyslogConst.SYSLOG_TRANSPORT.TCP,
                    ipVersion,
                    clientAddress: socket.syslogClientAddress,
                    clientPort: socket.syslogClientPort,
                    truncated: true,
                    note: 'TCP消息超过最大长度，已按限制截断'
                });
                buffer = buffer.slice(this.syslogConfig.maxMessageLength);
                continue;
            }

            break;
        }

        socket.syslogBuffer = buffer;
    }

    recordMessage(inputBuffer, context) {
        const sourceBuffer = Buffer.isBuffer(inputBuffer)
            ? inputBuffer
            : Buffer.from(String(inputBuffer || ''), 'utf8');
        const maxLength = this.syslogConfig.maxMessageLength;
        const truncated = Boolean(context.truncated) || sourceBuffer.length > maxLength;
        const buffer = truncated ? sourceBuffer.slice(0, maxLength) : sourceBuffer;

        try {
            const parsed = parseSyslogBuffer(buffer);
            const status = truncated
                ? SyslogConst.SYSLOG_MESSAGE_STATUS.TRUNCATED
                : parsed.parseError
                  ? SyslogConst.SYSLOG_MESSAGE_STATUS.INVALID
                  : SyslogConst.SYSLOG_MESSAGE_STATUS.RECEIVED;
            const note = context.note || parsed.parseError || (truncated ? '消息超过最大长度，已截断' : '接收成功');

            const receivedAt = formatTime();
            const record = {
                id: ++this.messageCounter,
                clientAddress: context.clientAddress || '-',
                clientPort: context.clientPort || '-',
                ipVersion: context.ipVersion || '-',
                transport: context.transport || '-',
                byteLength: sourceBuffer.length,
                status,
                note,
                ...parsed,
                timestamp: receivedAt,
                receivedAt,
                syslogTimestamp: parsed.timestamp,
                message: parsed.message || '',
                summary: this.buildSummary(parsed.message || parsed.rawMessage)
            };

            this.storeRecord(record);
        } catch (error) {
            logger.error('解析Syslog消息失败:', error);
            this.recordErrorMessage(buffer, {
                ...context,
                note: '解析失败: ' + error.message
            });
        }
    }

    recordErrorMessage(buffer, context) {
        const sourceBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8');
        const rawMessage = sourceBuffer.toString('utf8');
        const receivedAt = formatTime();
        const record = {
            id: ++this.messageCounter,
            timestamp: receivedAt,
            receivedAt,
            clientAddress: context.clientAddress || '-',
            clientPort: context.clientPort || '-',
            ipVersion: context.ipVersion || '-',
            transport: context.transport || '-',
            byteLength: sourceBuffer.length,
            status: SyslogConst.SYSLOG_MESSAGE_STATUS.ERROR,
            note: context.note || '处理失败',
            rawMessage,
            priority: null,
            facilityCode: null,
            facilityName: '-',
            severityCode: null,
            severityName: '-',
            format: 'RAW',
            version: '-',
            syslogTimestamp: '-',
            hostname: '-',
            appName: '-',
            procId: '-',
            msgId: '-',
            structuredData: '-',
            tag: '-',
            message: rawMessage,
            parseError: context.note || '处理失败',
            summary: this.buildSummary(rawMessage)
        };

        this.storeRecord(record);
    }

    storeRecord(record) {
        this.totalReceived += 1;
        this.messageHistory.unshift(record);
        if (this.messageHistory.length > this.historyLimit) {
            this.messageHistory.length = this.historyLimit;
        }

        this.messageHandler.sendEvent(SyslogConst.SYSLOG_EVT_TYPES.SYSLOG_EVT, {
            type: SyslogConst.SYSLOG_SUB_EVT_TYPES.MESSAGE_RECEIVED,
            data: this.toMessageSummary(record),
            stats: this.buildStats(record)
        });
    }

    buildStats(record = null) {
        return {
            messageCount: this.messageHistory.length,
            totalReceived: this.totalReceived,
            lastMessageAt: record ? record.timestamp : '-',
            lastClient: record ? `${record.clientAddress}:${record.clientPort}` : '-',
            lastSeverity: record ? record.severityName : '-',
            lastFacility: record ? record.facilityName : '-'
        };
    }

    buildSummary(message) {
        const normalized = String(message || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (normalized.length <= 160) {
            return normalized;
        }
        return normalized.slice(0, 157) + '...';
    }

    toMessageSummary(record) {
        return {
            id: record.id,
            timestamp: record.timestamp,
            clientAddress: record.clientAddress,
            clientPort: record.clientPort,
            ipVersion: record.ipVersion,
            transport: record.transport,
            byteLength: record.byteLength,
            status: record.status,
            format: record.format,
            priority: record.priority,
            facilityName: record.facilityName,
            severityName: record.severityName,
            syslogTimestamp: record.syslogTimestamp,
            hostname: record.hostname,
            appName: record.appName,
            summary: record.summary,
            note: record.note
        };
    }

    normalizePageQuery(query = {}) {
        const page = Number(query.page ?? 1);
        const pageSize = Number(query.pageSize ?? 20);

        return {
            page: Number.isInteger(page) && page > 0 ? page : 1,
            pageSize: Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20
        };
    }

    getMessageList(messageId, query = {}) {
        const { page, pageSize } = this.normalizePageQuery(query);
        const total = this.messageHistory.length;
        const start = (page - 1) * pageSize;
        const list = this.messageHistory.slice(start, start + pageSize).map(record => this.toMessageSummary(record));

        this.messageHandler.sendSuccessResponse(
            messageId,
            {
                list,
                total,
                page,
                pageSize
            },
            '获取Syslog消息日志成功'
        );
    }

    getMessageDetail(messageId, id) {
        const messageIdNumber = Number(id);
        if (!Number.isInteger(messageIdNumber) || messageIdNumber <= 0) {
            this.messageHandler.sendErrorResponse(messageId, '消息ID非法');
            return;
        }

        const record = this.messageHistory.find(item => item.id === messageIdNumber);
        if (!record) {
            this.messageHandler.sendErrorResponse(messageId, '消息不存在或已被清理');
            return;
        }

        this.messageHandler.sendSuccessResponse(messageId, record, '获取Syslog消息详情成功');
    }

    clearMessageHistory(messageId) {
        this.messageHistory = [];
        this.messageHandler.sendSuccessResponse(messageId, null, 'Syslog消息日志已清空');
        this.messageHandler.sendEvent(SyslogConst.SYSLOG_EVT_TYPES.SYSLOG_EVT, {
            type: SyslogConst.SYSLOG_SUB_EVT_TYPES.HISTORY_CLEARED,
            data: null,
            stats: {
                messageCount: 0,
                totalReceived: this.totalReceived,
                lastMessageAt: '-',
                lastClient: '-',
                lastSeverity: '-',
                lastFacility: '-'
            }
        });
    }

    async stopSyslog(messageId) {
        await this.closeSockets();
        this.messageHistory = [];
        this.messageHandler.sendSuccessResponse(messageId, null, 'Syslog服务器已停止');
        this.messageHandler.sendEvent(SyslogConst.SYSLOG_EVT_TYPES.SYSLOG_EVT, {
            type: SyslogConst.SYSLOG_SUB_EVT_TYPES.SERVER_STATUS,
            data: {
                status: 'stopped',
                port: this.syslogConfig ? this.syslogConfig.port : SyslogConst.DEFAULT_SYSLOG_CONFIG.port,
                messageCount: 0,
                totalReceived: this.totalReceived
            }
        });
        this.syslogConfig = null;
    }

    closeServer(server) {
        return new Promise(resolve => {
            if (!server) {
                resolve();
                return;
            }
            server.close(() => resolve());
        });
    }

    async closeSockets() {
        this.tcpClients.forEach(socket => {
            socket.destroy();
        });
        this.tcpClients.clear();

        const closeTasks = [];
        if (this.udp4Server) {
            closeTasks.push(this.closeServer(this.udp4Server));
            this.udp4Server = null;
        }
        if (this.udp6Server) {
            closeTasks.push(this.closeServer(this.udp6Server));
            this.udp6Server = null;
        }
        if (this.tcp4Server) {
            closeTasks.push(this.closeServer(this.tcp4Server));
            this.tcp4Server = null;
        }
        if (this.tcp6Server) {
            closeTasks.push(this.closeServer(this.tcp6Server));
            this.tcp6Server = null;
        }
        await Promise.all(closeTasks);
    }
}

new SyslogWorker();
