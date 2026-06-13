const dgram = require('dgram');
const fs = require('fs');
const logger = require('../log/logger');
const WorkerMessageHandler = require('./workerMessageHandler');
const TftpSession = require('./tftpSession');
const TftpConst = require('../const/tftpConst');

const OP = TftpConst.TFTP_OPCODES;

function buildStartErrorMessage(error, port) {
    let hint = '';
    if (error.code === 'EACCES' || error.code === 'EPERM') {
        hint = `（绑定 UDP ${port} 端口需要管理员/root 权限）`;
    } else if (error.code === 'EADDRINUSE') {
        hint = `（UDP ${port} 端口已被占用，可修改监听端口后重试）`;
    }
    return 'TFTP服务器启动失败: ' + error.message + hint;
}

class TftpWorker {
    constructor() {
        this.server = null;
        this.ipv6Server = null;
        this.tftpConfig = null;

        this.sessions = new Set();
        this.transferHistory = [];
        this.transferMap = new Map(); // transferId -> record
        this.transferCounter = 0;
        this.historyLimit = TftpConst.DEFAULT_TFTP_SETTINGS.maxHistory;

        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.messageHandler.registerHandler(TftpConst.TFTP_REQ_TYPES.START_TFTP, this.startTftp.bind(this));
        this.messageHandler.registerHandler(TftpConst.TFTP_REQ_TYPES.STOP_TFTP, this.stopTftp.bind(this));
        this.messageHandler.registerHandler(
            TftpConst.TFTP_REQ_TYPES.GET_TRANSFER_LIST,
            this.getTransferList.bind(this)
        );
        this.messageHandler.registerHandler(
            TftpConst.TFTP_REQ_TYPES.CLEAR_TRANSFER_HISTORY,
            this.clearTransferHistory.bind(this)
        );
    }

    validateConfig(config) {
        const port = Number(config.port);
        const blockSize = Number(config.blockSize);
        const timeout = Number(config.timeout);
        const retries = Number(config.retries);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('监听端口范围应为 1-65535');
        }
        if (
            !Number.isInteger(blockSize) ||
            blockSize < TftpConst.TFTP_BLOCK_SIZE.MIN ||
            blockSize > TftpConst.TFTP_BLOCK_SIZE.MAX
        ) {
            throw new Error(`块大小范围应为 ${TftpConst.TFTP_BLOCK_SIZE.MIN}-${TftpConst.TFTP_BLOCK_SIZE.MAX}`);
        }
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 255) {
            throw new Error('超时时间范围应为 1-255 秒');
        }
        if (!Number.isInteger(retries) || retries < 0 || retries > 20) {
            throw new Error('重传次数范围应为 0-20');
        }
        if (!config.rootDir) {
            throw new Error('请配置根目录');
        }
        let stat;
        try {
            stat = fs.statSync(config.rootDir);
        } catch (_e) {
            throw new Error('根目录不存在');
        }
        if (!stat.isDirectory()) {
            throw new Error('根目录不是有效的目录');
        }
    }

    async startTftp(messageId, config) {
        try {
            const mergedConfig = {
                ...TftpConst.DEFAULT_TFTP_CONFIG,
                ...config
            };
            this.tftpConfig = mergedConfig;
            if (this.tftpConfig.logLevel) {
                logger.setLevel(this.tftpConfig.logLevel);
                logger.info(`Worker log level set to: ${this.tftpConfig.logLevel}`);
            }
            this.validateConfig(mergedConfig);

            this.transferHistory = [];
            this.transferMap.clear();
            this.transferCounter = 0;

            await this.startUdp4Server();
            await this.tryStartUdp6Server();

            const data = {
                port: this.tftpConfig.port,
                rootDir: this.tftpConfig.rootDir,
                blockSize: this.tftpConfig.blockSize
            };

            this.messageHandler.sendSuccessResponse(
                messageId,
                data,
                `TFTP服务器启动成功，监听端口 ${this.tftpConfig.port}`
            );
            this.messageHandler.sendEvent(TftpConst.TFTP_EVT_TYPES.TFTP_EVT, {
                type: TftpConst.TFTP_SUB_EVT_TYPES.SERVER_STATUS,
                data: { status: 'running', ...data }
            });
        } catch (error) {
            await this.closeSockets();
            logger.error('启动TFTP服务器失败:', error);
            const port = this.tftpConfig ? this.tftpConfig.port : TftpConst.DEFAULT_TFTP_CONFIG.port;
            this.messageHandler.sendErrorResponse(messageId, buildStartErrorMessage(error, port));
        }
    }

    startUdp4Server() {
        return new Promise((resolve, reject) => {
            this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            let listening = false;

            this.server.on('message', (msg, rinfo) => {
                this.handleRequest(msg, rinfo, 'udp4', 'IPv4');
            });

            this.server.once('error', err => {
                if (!listening) {
                    reject(err);
                    return;
                }
                logger.error('TFTP IPv4 服务器错误:', err);
            });

            this.server.once('listening', () => {
                listening = true;
                const address = this.server.address();
                logger.info(`TFTP IPv4服务器监听: ${address.address}:${address.port}`);
                resolve();
            });

            this.server.bind(this.tftpConfig.port, '0.0.0.0');
        });
    }

    async tryStartUdp6Server() {
        try {
            await new Promise((resolve, reject) => {
                this.ipv6Server = dgram.createSocket({ type: 'udp6', reuseAddr: true });
                let listening = false;

                this.ipv6Server.on('message', (msg, rinfo) => {
                    this.handleRequest(msg, rinfo, 'udp6', 'IPv6');
                });

                this.ipv6Server.once('error', err => {
                    if (!listening) {
                        reject(err);
                        return;
                    }
                    logger.error('TFTP IPv6 服务器错误:', err);
                });

                this.ipv6Server.once('listening', () => {
                    listening = true;
                    const address = this.ipv6Server.address();
                    logger.info(`TFTP IPv6服务器监听: ${address.address}:${address.port}`);
                    resolve();
                });

                this.ipv6Server.bind(this.tftpConfig.port, '::');
            });
        } catch (error) {
            if (this.ipv6Server) {
                this.ipv6Server.close();
                this.ipv6Server = null;
            }
            logger.warn(`TFTP IPv6服务器未启动: ${error.message}`);
        }
    }

    handleRequest(msg, rinfo, family, ipVersion) {
        if (msg.length < 2) {
            return;
        }
        const opcode = msg.readUInt16BE(0);
        // 主监听 socket 只接受初始的 RRQ/WRQ，其余报文走会话自身的 socket
        if (opcode !== OP.RRQ && opcode !== OP.WRQ) {
            return;
        }

        const transferId = ++this.transferCounter;
        const session = new TftpSession({
            config: this.tftpConfig,
            family,
            ipVersion,
            transferId,
            onUpdate: (id, patch) => this.recordTransfer(id, patch),
            onClose: s => this.sessions.delete(s)
        });
        this.sessions.add(session);

        try {
            session.start(opcode, msg, rinfo);
        } catch (error) {
            logger.error(`处理TFTP请求失败: ${error.message}`);
            this.sessions.delete(session);
        }
    }

    recordTransfer(transferId, patch) {
        let record = this.transferMap.get(transferId);
        if (!record) {
            record = {
                id: transferId,
                timestamp: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
                bytes: 0,
                totalSize: 0,
                blocks: 0,
                status: TftpConst.TFTP_TRANSFER_STATUS.TRANSFERRING
            };
            this.transferMap.set(transferId, record);
            this.transferHistory.unshift(record);
            if (this.transferHistory.length > this.historyLimit) {
                const removed = this.transferHistory.pop();
                if (removed) {
                    this.transferMap.delete(removed.id);
                }
            }
        }

        Object.assign(record, patch);

        this.messageHandler.sendEvent(TftpConst.TFTP_EVT_TYPES.TFTP_EVT, {
            type: TftpConst.TFTP_SUB_EVT_TYPES.TRANSFER_UPDATE,
            data: { ...record },
            stats: {
                transferCount: this.transferHistory.length,
                lastTransferAt: record.timestamp,
                lastClient: `${record.clientAddress}:${record.clientPort}`
            }
        });
    }

    getTransferList(messageId) {
        this.messageHandler.sendSuccessResponse(messageId, this.transferHistory, '获取TFTP传输日志成功');
    }

    clearTransferHistory(messageId) {
        this.transferHistory = [];
        this.transferMap.clear();
        this.messageHandler.sendSuccessResponse(messageId, null, 'TFTP传输日志已清空');
        this.messageHandler.sendEvent(TftpConst.TFTP_EVT_TYPES.TFTP_EVT, {
            type: TftpConst.TFTP_SUB_EVT_TYPES.HISTORY_CLEARED,
            data: null,
            stats: { transferCount: 0, lastTransferAt: '-', lastClient: '-' }
        });
    }

    abortSessions() {
        this.sessions.forEach(session => {
            session.cleanup();
        });
        this.sessions.clear();
    }

    async stopTftp(messageId) {
        this.abortSessions();
        await this.closeSockets();
        this.transferHistory = [];
        this.transferMap.clear();
        this.messageHandler.sendSuccessResponse(messageId, null, 'TFTP服务器已停止');
        this.messageHandler.sendEvent(TftpConst.TFTP_EVT_TYPES.TFTP_EVT, {
            type: TftpConst.TFTP_SUB_EVT_TYPES.SERVER_STATUS,
            data: {
                status: 'stopped',
                port: this.tftpConfig ? this.tftpConfig.port : TftpConst.DEFAULT_TFTP_CONFIG.port
            }
        });
        this.tftpConfig = null;
    }

    async closeSockets() {
        const closeTasks = [];
        if (this.server) {
            closeTasks.push(new Promise(resolve => this.server.close(() => resolve())));
            this.server = null;
        }
        if (this.ipv6Server) {
            closeTasks.push(new Promise(resolve => this.ipv6Server.close(() => resolve())));
            this.ipv6Server = null;
        }
        await Promise.all(closeTasks);
    }
}

new TftpWorker();
