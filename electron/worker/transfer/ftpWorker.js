const net = require('net');
const util = require('util');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const FtpSession = require('./ftpSession');
const FtpConst = require('../../const/ftpConst');
class FtpWorker {
    constructor() {
        this.server = null;
        this.ipv6Server = null;
        this.socket = null;

        this.ftpConfig = null; // ftp配置数据
        this.userConfig = null; // ftp用户配置数据

        this.ftpSessionMap = new Map(); // ftp会话map

        // 创建消息处理器
        this.messageHandler = new WorkerMessageHandler();
        // 初始化消息处理器
        this.messageHandler.init();
        // 注册消息处理器
        this.messageHandler.registerHandler(FtpConst.FTP_REQ_TYPES.START_FTP, this.startFtp.bind(this));
        this.messageHandler.registerHandler(FtpConst.FTP_REQ_TYPES.STOP_FTP, this.stopFtp.bind(this));
        this.messageHandler.registerHandler(FtpConst.FTP_REQ_TYPES.GET_CLIENT_LIST, this.getClientList.bind(this));
    }

    async startTcpServer(messageId) {
        try {
            this.server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv4 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv4 localAddress: ${socket.localAddress}:${socket.localPort}`);

                const sessionKey = FtpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const ftpSession = this.ftpSessionMap.get(sessionKey);
                    if (!ftpSession) {
                        logger.error(`ipv4 Client ${clientAddress}:${clientPort} not found in ftpSessionMap`);
                        socket.destroy();
                        return;
                    }
                    ftpSession.recvMsg(data);
                });

                socket.on('end', () => {
                    const ftpSession = this.ftpSessionMap.get(sessionKey);
                    if (!ftpSession) {
                        logger.error(`ipv4 Client ${clientAddress}:${clientPort} not found in ftpSessionMap`);
                        socket.destroy();
                        return;
                    } else {
                        ftpSession.closeSession();
                        this.ftpSessionMap.delete(sessionKey);
                    }
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} end`);
                });

                socket.on('close', () => {
                    const ftpSession = this.ftpSessionMap.get(sessionKey);
                    if (!ftpSession) {
                        logger.error(`ipv4 Client ${clientAddress}:${clientPort} not found in ftpSessionMap`);
                        socket.destroy();
                        return;
                    } else {
                        ftpSession.closeSession();
                        this.ftpSessionMap.delete(sessionKey);
                    }
                    logger.info(`ipv4 Client ${clientAddress}:${clientPort} close`);
                });

                socket.on('error', err => {
                    const ftpSession = this.ftpSessionMap.get(sessionKey);
                    if (!ftpSession) {
                        logger.error(`ipv4 Client ${clientAddress}:${clientPort} not found in ftpSessionMap`);
                        socket.destroy();
                        return;
                    } else {
                        ftpSession.closeSession();
                        this.ftpSessionMap.delete(sessionKey);
                    }
                    logger.error(`ipv4 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                });

                // 创建FTP会话
                let ftpSession = null;
                ftpSession = this.ftpSessionMap.get(sessionKey);
                if (ftpSession) {
                    ftpSession.closeSession();
                    this.ftpSessionMap.delete(sessionKey);
                } else {
                    ftpSession = new FtpSession(this.messageHandler, this);
                }
                this.ftpSessionMap.set(sessionKey, ftpSession);

                ftpSession.socket = socket;
                ftpSession.localIp = socket.localAddress;
                ftpSession.localPort = socket.localPort;
                ftpSession.remoteIp = clientAddress;
                ftpSession.remotePort = clientPort;

                ftpSession.sendMsg(Buffer.from('220  Welcome to the Mini Tools FTP server'));

                this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.FTP_EVT, {
                    type: FtpConst.FTP_SUB_EVT_TYPES.FTP_SUB_EVT_CONNCET,
                    opType: 'add',
                    data: ftpSession.getClientInfo()
                });
            });

            this.ipv6Server = net.createServer(socket => {
                const clientAddress = socket.remoteAddress;
                const clientPort = socket.remotePort;

                logger.info(`ipv6 Client connected from ${clientAddress}:${clientPort}`);
                logger.info(`ipv6 localAddress: ${socket.localAddress}:${socket.localPort}`);

                // 当接收到数据时处理数据
                socket.on('data', data => {
                    const ftpSession = this.ftpSessionMap.get(
                        FtpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort)
                    );
                    if (!ftpSession) {
                        logger.error(`ipv6 Client ${clientAddress}:${clientPort} not found in ftpSessionMap`);
                        socket.destroy();
                        return;
                    }
                    ftpSession.recvMsg(data);
                });

                socket.on('end', () => {
                    const sessionKey = FtpSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const ftpSession = this.ftpSessionMap.get(sessionKey);
                    if (!ftpSession) {
                        logger.error(`ipv6 Client ${clientAddress}:${clientPort} not found in ftpSessionMap`);
                        socket.destroy();
                        return;
                    } else {
                        ftpSession.closeSession();
                        this.ftpSessionMap.delete(sessionKey);
                    }
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} end`);
                });

                socket.on('close', () => {
                    const sessionKey = FtpSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const ftpSession = this.ftpSessionMap.get(sessionKey);
                    if (!ftpSession) {
                        logger.error(`ipv6 Client ${clientAddress}:${clientPort} not found in ftpSessionMap`);
                        socket.destroy();
                        return;
                    } else {
                        ftpSession.closeSession();
                        this.ftpSessionMap.delete(sessionKey);
                    }
                    logger.info(`ipv6 Client ${clientAddress}:${clientPort} close`);
                });

                socket.on('error', err => {
                    const sessionKey = FtpSession.makeKey(
                        socket.localAddress,
                        socket.localPort,
                        clientAddress,
                        clientPort
                    );
                    const ftpSession = this.ftpSessionMap.get(sessionKey);
                    if (!ftpSession) {
                        logger.error(`ipv6 Client ${clientAddress}:${clientPort} not found in ftpSessionMap`);
                        socket.destroy();
                        return;
                    } else {
                        ftpSession.closeSession();
                        this.ftpSessionMap.delete(sessionKey);
                    }
                    logger.error(`ipv6 TCP Error from ${clientAddress}:${clientPort}: ${err.message}`);
                });

                // 创建FTP会话
                let ftpSession = null;
                const sessionKey = FtpSession.makeKey(socket.localAddress, socket.localPort, clientAddress, clientPort);
                ftpSession = this.ftpSessionMap.get(sessionKey);
                if (ftpSession) {
                    ftpSession.closeSession();
                    this.ftpSessionMap.delete(sessionKey);
                } else {
                    ftpSession = new FtpSession(this.messageHandler, this);
                }
                this.ftpSessionMap.set(sessionKey, ftpSession);

                ftpSession.socket = socket;
                ftpSession.localIp = socket.localAddress;
                ftpSession.localPort = socket.localPort;
                ftpSession.remoteIp = clientAddress;
                ftpSession.remotePort = clientPort;

                ftpSession.sendMsg(Buffer.from('220 Welcome to the Mini Tools FTP server'));

                this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.FTP_EVT, {
                    type: FtpConst.FTP_SUB_EVT_TYPES.FTP_SUB_EVT_CONNCET,
                    opType: 'add',
                    data: ftpSession.getClientInfo()
                });
            });

            // 启动ipv4服务器并监听端口
            const listenPormise = util.promisify(this.server.listen).bind(this.server);
            await listenPormise(this.ftpConfig.port, '0.0.0.0');
            logger.info(`TCP Server listening on port ${this.ftpConfig.port} at 0.0.0.0`);

            // 启动ipv6服务器并监听端口
            const ipv6ListenPormise = util.promisify(this.ipv6Server.listen).bind(this.ipv6Server);
            await ipv6ListenPormise(this.ftpConfig.port, '::');
            logger.info(`TCP Server listening on port ${this.ftpConfig.port} at ::`);

            logger.info(`ftp协议启动成功`);
            this.messageHandler.sendSuccessResponse(messageId, null, 'ftp协议启动成功');
        } catch (err) {
            logger.error(`Error starting TCP server: ${err.message}`);
            this.messageHandler.sendErrorResponse(messageId, 'ftp协议启动失败');
        }
    }

    startFtp(messageId, ftpConfigData) {
        this.ftpConfig = ftpConfigData.ftpConfig;
        this.userConfig = ftpConfigData.userConfig;

        // 设置日志级别
        if (this.ftpConfig.logLevel) {
            logger.setLevel(this.ftpConfig.logLevel);
            logger.info(`Worker log level set to: ${this.ftpConfig.logLevel}`);
        }
        // 启动tcp服务器
        this.startTcpServer(messageId);
    }

    stopFtp(messageId) {
        if (this.server) {
            this.server.close();
            this.server = null;
        }

        if (this.ipv6Server) {
            this.ipv6Server.close();
            this.ipv6Server = null;
        }

        // 清空配置数据
        this.ftpConfig = null;
        this.userConfig = null;

        // 清空会话
        this.ftpSessionMap.forEach((session, _) => {
            session.closeSession();
        });
        this.ftpSessionMap.clear();
        this.messageHandler.sendSuccessResponse(messageId, null, 'ftp协议停止成功');
    }

    getClientList(messageId) {
        const clientList = [];
        this.ftpSessionMap.forEach((session, _) => {
            clientList.push(session.getClientInfo());
        });
        this.messageHandler.sendSuccessResponse(messageId, clientList, '获取客户端列表成功');
    }
}

new FtpWorker(); // 启动监听
