const dgram = require('dgram');
const logger = require('../log/logger');
const WorkerMessageHandler = require('./workerMessageHandler');
const NtpConst = require('../const/ntpConst');

const NTP_EPOCH_OFFSET_MS = 2208988800000;
const NTP_FRACTION_SCALE = 0x100000000;
const NTP_SHORT_SCALE = 0x10000;

function writeTimestamp(buffer, offset, ms) {
    const ntpMs = ms + NTP_EPOCH_OFFSET_MS;
    const seconds = Math.floor(ntpMs / 1000);
    const remainderMs = ntpMs - seconds * 1000;
    const fraction = Math.floor((remainderMs / 1000) * NTP_FRACTION_SCALE);

    buffer.writeUInt32BE(seconds >>> 0, offset);
    buffer.writeUInt32BE(fraction >>> 0, offset + 4);
}

function readTimestamp(buffer, offset) {
    if (!buffer || buffer.length < offset + 8) {
        return null;
    }

    const seconds = buffer.readUInt32BE(offset);
    const fraction = buffer.readUInt32BE(offset + 4);
    if (seconds === 0 && fraction === 0) {
        return null;
    }

    const ms = seconds * 1000 - NTP_EPOCH_OFFSET_MS + Math.round((fraction / NTP_FRACTION_SCALE) * 1000);
    return ms;
}

function writeShortFormat(buffer, offset, ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    const value = Math.min(0xffffffff, Math.round((safeMs / 1000) * NTP_SHORT_SCALE));
    buffer.writeUInt32BE(value >>> 0, offset);
}

function formatTime(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) {
        return '-';
    }
    return new Date(ms).toISOString();
}

function sanitizeReferenceId(referenceId) {
    const source = String(referenceId || NtpConst.DEFAULT_NTP_CONFIG.referenceId).slice(0, 4);
    const buffer = Buffer.alloc(4, 0);
    buffer.write(source, 0, 'ascii');
    return buffer;
}

function modeName(mode) {
    const names = {
        [NtpConst.NTP_MODES.RESERVED]: 'Reserved',
        [NtpConst.NTP_MODES.SYMMETRIC_ACTIVE]: 'Sym Active',
        [NtpConst.NTP_MODES.SYMMETRIC_PASSIVE]: 'Sym Passive',
        [NtpConst.NTP_MODES.CLIENT]: 'Client',
        [NtpConst.NTP_MODES.SERVER]: 'Server',
        [NtpConst.NTP_MODES.BROADCAST]: 'Broadcast',
        [NtpConst.NTP_MODES.CONTROL]: 'Control',
        [NtpConst.NTP_MODES.PRIVATE]: 'Private'
    };
    return names[mode] || `Mode-${mode}`;
}

function buildStartErrorMessage(error, port) {
    let hint = '';
    if (error.code === 'EACCES' || error.code === 'EPERM') {
        hint = `（绑定 UDP ${port} 端口需要管理员/root 权限）`;
    } else if (error.code === 'EADDRINUSE') {
        hint = `（UDP ${port} 端口已被占用，可修改监听端口后重试）`;
    }
    return 'NTP服务器启动失败: ' + error.message + hint;
}

class NtpWorker {
    constructor() {
        this.server = null;
        this.ipv6Server = null;
        this.ntpConfig = null;
        this.requestHistory = [];
        this.requestCounter = 0;
        this.historyLimit = NtpConst.DEFAULT_NTP_SETTINGS.maxHistory;

        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.messageHandler.registerHandler(NtpConst.NTP_REQ_TYPES.START_NTP, this.startNtp.bind(this));
        this.messageHandler.registerHandler(NtpConst.NTP_REQ_TYPES.STOP_NTP, this.stopNtp.bind(this));
        this.messageHandler.registerHandler(NtpConst.NTP_REQ_TYPES.GET_REQUEST_LIST, this.getRequestList.bind(this));
        this.messageHandler.registerHandler(
            NtpConst.NTP_REQ_TYPES.CLEAR_REQUEST_HISTORY,
            this.clearRequestHistory.bind(this)
        );
    }

    validateConfig(config) {
        const port = Number(config.port);
        const stratum = Number(config.stratum);
        const timeOffsetMs = Number(config.timeOffsetMs);
        const rootDelayMs = Number(config.rootDelayMs);
        const rootDispersionMs = Number(config.rootDispersionMs);
        const referenceId = String(config.referenceId || '').trim();

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('监听端口范围应为 1-65535');
        }
        if (!Number.isInteger(stratum) || stratum < 1 || stratum > 15) {
            throw new Error('Stratum 范围应为 1-15');
        }
        if (!Number.isFinite(timeOffsetMs)) {
            throw new Error('时间偏移必须为有效数字');
        }
        if (!Number.isFinite(rootDelayMs) || rootDelayMs < 0) {
            throw new Error('Root Delay 不能小于 0');
        }
        if (!Number.isFinite(rootDispersionMs) || rootDispersionMs < 0) {
            throw new Error('Root Dispersion 不能小于 0');
        }
        if (!/^[\x20-\x7e]{1,4}$/.test(referenceId)) {
            throw new Error('Reference ID 需为 1-4 位 ASCII 字符');
        }
    }

    async startNtp(messageId, config) {
        try {
            const mergedConfig = {
                ...NtpConst.DEFAULT_NTP_CONFIG,
                ...config
            };
            this.ntpConfig = mergedConfig;
            if (this.ntpConfig.logLevel) {
                logger.setLevel(this.ntpConfig.logLevel);
                logger.info(`Worker log level set to: ${this.ntpConfig.logLevel}`);
            }
            this.validateConfig(mergedConfig);
            this.requestHistory = [];
            this.requestCounter = 0;

            await this.startUdp4Server();
            await this.tryStartUdp6Server();

            const data = {
                port: this.ntpConfig.port,
                stratum: this.ntpConfig.stratum,
                referenceId: this.ntpConfig.referenceId,
                timeOffsetMs: this.ntpConfig.timeOffsetMs,
                requestCount: this.requestHistory.length
            };

            this.messageHandler.sendSuccessResponse(
                messageId,
                data,
                `NTP服务器启动成功，监听端口 ${this.ntpConfig.port}`
            );
            this.messageHandler.sendEvent(NtpConst.NTP_EVT_TYPES.NTP_EVT, {
                type: NtpConst.NTP_SUB_EVT_TYPES.SERVER_STATUS,
                data: {
                    status: 'running',
                    ...data
                }
            });
        } catch (error) {
            await this.closeSockets();
            logger.error('启动NTP服务器失败:', error);
            this.messageHandler.sendErrorResponse(messageId, buildStartErrorMessage(error, this.ntpConfig.port));
        }
    }

    startUdp4Server() {
        return new Promise((resolve, reject) => {
            this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            let listening = false;

            this.server.on('message', (msg, rinfo) => {
                this.handleNtpMessage(msg, rinfo, 'IPv4');
            });

            this.server.once('error', err => {
                if (!listening) {
                    reject(err);
                    return;
                }
                logger.error('NTP IPv4 服务器错误:', err);
            });

            this.server.once('listening', () => {
                listening = true;
                const address = this.server.address();
                logger.info(`NTP IPv4服务器监听: ${address.address}:${address.port}`);
                resolve();
            });

            this.server.bind(this.ntpConfig.port, '0.0.0.0');
        });
    }

    async tryStartUdp6Server() {
        try {
            await new Promise((resolve, reject) => {
                this.ipv6Server = dgram.createSocket({ type: 'udp6', reuseAddr: true });
                let listening = false;

                this.ipv6Server.on('message', (msg, rinfo) => {
                    this.handleNtpMessage(msg, rinfo, 'IPv6');
                });

                this.ipv6Server.once('error', err => {
                    if (!listening) {
                        reject(err);
                        return;
                    }
                    logger.error('NTP IPv6 服务器错误:', err);
                });

                this.ipv6Server.once('listening', () => {
                    listening = true;
                    const address = this.ipv6Server.address();
                    logger.info(`NTP IPv6服务器监听: ${address.address}:${address.port}`);
                    resolve();
                });

                this.ipv6Server.bind(this.ntpConfig.port, '::');
            });
        } catch (error) {
            if (this.ipv6Server) {
                this.ipv6Server.close();
                this.ipv6Server = null;
            }
            logger.warn(`NTP IPv6服务器未启动: ${error.message}`);
        }
    }

    handleNtpMessage(message, rinfo, ipVersion) {
        const requestReceivedAt = Date.now();
        const serverClockAtReceive = requestReceivedAt + this.ntpConfig.timeOffsetMs;

        try {
            if (message.length < 48) {
                this.recordRequest({
                    timestamp: formatTime(requestReceivedAt),
                    clientAddress: rinfo.address,
                    clientPort: rinfo.port,
                    ipVersion,
                    version: '-',
                    mode: '-',
                    modeName: '-',
                    status: 'error',
                    message: `报文长度不足 48 字节: ${message.length}`,
                    originateTime: '-',
                    receiveTime: '-',
                    transmitTime: '-',
                    clientTransmitTime: '-',
                    packetLength: message.length
                });
                return;
            }

            const firstByte = message.readUInt8(0);
            const leapIndicator = firstByte >> 6;
            const version = (firstByte >> 3) & 0x07;
            const mode = firstByte & 0x07;
            const clientTransmitMs = readTimestamp(message, 40);

            if (mode !== NtpConst.NTP_MODES.CLIENT) {
                this.recordRequest({
                    timestamp: formatTime(requestReceivedAt),
                    clientAddress: rinfo.address,
                    clientPort: rinfo.port,
                    ipVersion,
                    version,
                    mode,
                    modeName: modeName(mode),
                    status: 'ignored',
                    message: '仅响应 Client 模式请求',
                    originateTime: '-',
                    receiveTime: '-',
                    transmitTime: '-',
                    clientTransmitTime: formatTime(clientTransmitMs),
                    packetLength: message.length,
                    leapIndicator
                });
                return;
            }

            const responseVersion = version >= 1 && version <= 4 ? version : 4;
            const response = Buffer.alloc(48, 0);
            response.writeUInt8((0 << 6) | (responseVersion << 3) | NtpConst.NTP_MODES.SERVER, 0);
            response.writeUInt8(Number(this.ntpConfig.stratum), 1);
            response.writeUInt8(message.readUInt8(2), 2);
            response.writeInt8(NtpConst.DEFAULT_NTP_SETTINGS.precision, 3);
            writeShortFormat(response, 4, this.ntpConfig.rootDelayMs);
            writeShortFormat(response, 8, this.ntpConfig.rootDispersionMs);
            sanitizeReferenceId(this.ntpConfig.referenceId).copy(response, 12);
            writeTimestamp(response, 16, serverClockAtReceive);
            message.copy(response, 24, 40, 48);
            writeTimestamp(response, 32, serverClockAtReceive);

            const responseSocket = ipVersion === 'IPv6' && this.ipv6Server ? this.ipv6Server : this.server;
            const transmitAt = Date.now() + this.ntpConfig.timeOffsetMs;
            writeTimestamp(response, 40, transmitAt);

            responseSocket.send(response, 0, response.length, rinfo.port, rinfo.address, err => {
                if (err) {
                    logger.error(`NTP响应发送失败 ${rinfo.address}:${rinfo.port}: ${err.message}`);
                    this.recordRequest({
                        timestamp: formatTime(requestReceivedAt),
                        clientAddress: rinfo.address,
                        clientPort: rinfo.port,
                        ipVersion,
                        version: responseVersion,
                        mode,
                        modeName: modeName(mode),
                        status: 'error',
                        message: '响应发送失败: ' + err.message,
                        originateTime: formatTime(clientTransmitMs),
                        receiveTime: formatTime(serverClockAtReceive),
                        transmitTime: formatTime(transmitAt),
                        clientTransmitTime: formatTime(clientTransmitMs),
                        packetLength: message.length,
                        leapIndicator
                    });
                    return;
                }

                logger.info(`NTP已响应 ${rinfo.address}:${rinfo.port} version=${responseVersion} mode=${mode}`);
                this.recordRequest({
                    timestamp: formatTime(requestReceivedAt),
                    clientAddress: rinfo.address,
                    clientPort: rinfo.port,
                    ipVersion,
                    version: responseVersion,
                    mode,
                    modeName: modeName(mode),
                    status: 'replied',
                    message: '已成功响应客户端请求',
                    originateTime: formatTime(clientTransmitMs),
                    receiveTime: formatTime(serverClockAtReceive),
                    transmitTime: formatTime(transmitAt),
                    clientTransmitTime: formatTime(clientTransmitMs),
                    packetLength: message.length,
                    leapIndicator
                });
            });
        } catch (error) {
            logger.error('处理NTP请求失败:', error);
            this.recordRequest({
                timestamp: formatTime(requestReceivedAt),
                clientAddress: rinfo.address,
                clientPort: rinfo.port,
                ipVersion,
                version: '-',
                mode: '-',
                modeName: '-',
                status: 'error',
                message: '处理失败: ' + error.message,
                originateTime: '-',
                receiveTime: '-',
                transmitTime: '-',
                clientTransmitTime: '-',
                packetLength: message.length
            });
        }
    }

    recordRequest(entry) {
        const record = {
            id: ++this.requestCounter,
            ...entry
        };
        this.requestHistory.unshift(record);
        if (this.requestHistory.length > this.historyLimit) {
            this.requestHistory.length = this.historyLimit;
        }

        this.messageHandler.sendEvent(NtpConst.NTP_EVT_TYPES.NTP_EVT, {
            type: NtpConst.NTP_SUB_EVT_TYPES.REQUEST_RECEIVED,
            data: record,
            stats: {
                requestCount: this.requestHistory.length,
                lastRequestAt: record.timestamp,
                lastClient: `${record.clientAddress}:${record.clientPort}`
            }
        });
    }

    getRequestList(messageId) {
        this.messageHandler.sendSuccessResponse(messageId, this.requestHistory, '获取NTP请求日志成功');
    }

    clearRequestHistory(messageId) {
        this.requestHistory = [];
        this.messageHandler.sendSuccessResponse(messageId, null, 'NTP请求日志已清空');
        this.messageHandler.sendEvent(NtpConst.NTP_EVT_TYPES.NTP_EVT, {
            type: NtpConst.NTP_SUB_EVT_TYPES.HISTORY_CLEARED,
            data: null,
            stats: {
                requestCount: 0,
                lastRequestAt: '-',
                lastClient: '-'
            }
        });
    }

    stopNtp(messageId) {
        this.closeSockets();
        this.requestHistory = [];
        this.messageHandler.sendSuccessResponse(messageId, null, 'NTP服务器已停止');
        this.messageHandler.sendEvent(NtpConst.NTP_EVT_TYPES.NTP_EVT, {
            type: NtpConst.NTP_SUB_EVT_TYPES.SERVER_STATUS,
            data: {
                status: 'stopped',
                port: this.ntpConfig ? this.ntpConfig.port : NtpConst.DEFAULT_NTP_CONFIG.port,
                stratum: this.ntpConfig ? this.ntpConfig.stratum : NtpConst.DEFAULT_NTP_CONFIG.stratum,
                referenceId: this.ntpConfig ? this.ntpConfig.referenceId : NtpConst.DEFAULT_NTP_CONFIG.referenceId,
                timeOffsetMs: this.ntpConfig ? this.ntpConfig.timeOffsetMs : NtpConst.DEFAULT_NTP_CONFIG.timeOffsetMs,
                requestCount: 0
            }
        });
        this.ntpConfig = null;
    }

    async closeSockets() {
        const closeTasks = [];
        if (this.server) {
            closeTasks.push(
                new Promise(resolve => {
                    this.server.close(() => resolve());
                })
            );
            this.server = null;
        }
        if (this.ipv6Server) {
            closeTasks.push(
                new Promise(resolve => {
                    this.ipv6Server.close(() => resolve());
                })
            );
            this.ipv6Server = null;
        }
        await Promise.all(closeTasks);
    }
}

new NtpWorker();
