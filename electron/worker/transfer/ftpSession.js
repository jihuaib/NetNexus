const logger = require('../../log/logger');
const path = require('path');
const fs = require('fs');
const FtpConst = require('../../const/ftpConst');
class FtpSession {
    constructor(messageHandler, ftpWorker) {
        this.socket = null;
        this.messageHandler = messageHandler;
        this.ftpWorker = ftpWorker;
        this.localIp = null;
        this.localPort = null;
        this.remoteIp = null;
        this.remotePort = null;
        this.messageBuffer = Buffer.alloc(0);
        this.sessionId = null;

        // FTP session state
        this.authenticated = false;
        this.username = null;
        this.currentDir = '/';
        this.dataPort = null;
        this.dataHost = null;
        this.passive = false;
        this.passiveServer = null;
        this.dataSocket = null;
        this.dataSocket = null;
        this.transferType = 'ascii'; // default to ASCII
        this.connectedTime = new Date();
    }

    static makeKey(localIp, localPort, remoteIp, remotePort) {
        return `${localIp}|${localPort}|${remoteIp}|${remotePort}`;
    }

    static parseKey(key) {
        const [localIp, localPort, remoteIp, remotePort] = key.split('|');
        return { localIp, localPort, remoteIp, remotePort };
    }

    processMessage(message) {
        try {
            const clientAddress = `${this.remoteIp}:${this.remotePort}`;
            const command = message.toString().trim();
            logger.info(`Received command from ${clientAddress}: ${command}`);

            // Parse FTP command (format: COMMAND [arguments])
            const parts = command.split(' ');
            const cmd = parts[0].toUpperCase();
            const args = parts.slice(1).join(' ');

            this.handleCommand(cmd, args);
        } catch (err) {
            logger.error(`Error processing message:`, err);
            this.sendMsg(Buffer.from('500 Error processing command'));
        }
    }

    handleCommand(cmd, args) {
        const handlers = {
            USER: this.handleUser.bind(this),
            PASS: this.handlePass.bind(this),
            SYST: this.handleSyst.bind(this),
            PWD: this.handlePwd.bind(this),
            TYPE: this.handleType.bind(this),
            PASV: this.handlePasv.bind(this),
            PORT: this.handlePort.bind(this),
            LIST: this.handleList.bind(this),
            CWD: this.handleCwd.bind(this),
            CDUP: this.handleCdup.bind(this),
            RETR: this.handleRetr.bind(this),
            STOR: this.handleStor.bind(this),
            QUIT: this.handleQuit.bind(this),
            FEAT: this.handleFeat.bind(this),
            OPTS: this.handleOpts.bind(this),
            NOOP: this.handleNoop.bind(this),
            DELE: this.handleDele.bind(this),
            RMD: this.handleRmd.bind(this),
            MKD: this.handleMkd.bind(this)
        };

        if (handlers[cmd]) {
            // Check authentication except for USER, PASS, SYST, FEAT, QUIT
            const noAuthRequired = ['USER', 'PASS', 'SYST', 'FEAT', 'QUIT', 'NOOP', 'OPTS'];
            if (!this.authenticated && !noAuthRequired.includes(cmd)) {
                this.sendMsg(Buffer.from('530 Not logged in'));
                return;
            }

            handlers[cmd](args);
        } else {
            this.sendMsg(Buffer.from(`502 Command '${cmd}' not implemented`));
        }
    }

    handleUser(username) {
        const userConfig = this.ftpWorker.userConfig;
        if (userConfig.username === username) {
            this.username = username;
            this.sendMsg(Buffer.from('331 Username OK, password required'));
        } else {
            this.sendMsg(Buffer.from('530 Authentication failed'));
        }
    }

    handlePass(password) {
        // Check username and password against ftpWorker.userConfig
        const userConfig = this.ftpWorker.userConfig;
        if (userConfig.username === this.username && userConfig.password === password) {
            this.authenticated = true;
            this.currentDir = '/';
            this.sendMsg(Buffer.from('230 User logged in, proceed'));

            this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.AUTHENTICATION, {
                success: true,
                username: this.username,
                clientInfo: this.getClientInfo()
            });
        } else {
            this.sendMsg(Buffer.from('530 Authentication failed'));

            this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.AUTHENTICATION, {
                success: false,
                username: this.username,
                clientInfo: this.getClientInfo()
            });
        }
    }

    handleSyst() {
        this.sendMsg(Buffer.from('215 UNIX Type: L8'));
    }

    handlePwd() {
        this.sendMsg(Buffer.from(`257 "${this.currentDir}" is the current directory`));
    }

    handleType(type) {
        if (type === 'A') {
            this.transferType = 'ascii';
            this.sendMsg(Buffer.from('200 Type set to ASCII'));
        } else if (type === 'I') {
            this.transferType = 'binary';
            this.sendMsg(Buffer.from('200 Type set to binary'));
        } else {
            this.sendMsg(Buffer.from('504 Type not implemented'));
        }
    }

    handlePasv() {
        const net = require('net');
        // Close existing passive server if any
        if (this.passiveServer) {
            this.passiveServer.close();
        }

        // Create a passive server
        this.passiveServer = net.createServer(socket => {
            this.dataSocket = socket;

            socket.on('error', err => {
                logger.error(`Data socket error: ${err.message}`);
            });
        });

        // Listen on random port
        this.passiveServer.listen(0, '0.0.0.0', () => {
            const port = this.passiveServer.address().port;
            const ip = this.localIp.split('.').map(Number);

            // Calculate the port bytes (p1 * 256 + p2 = port)
            const p1 = Math.floor(port / 256);
            const p2 = port % 256;

            // Send PASV response with IP and port information
            // Format: 227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)
            if (this.localIp.includes(':')) {
                // IPv6 - use the server's actual IPv4 address if available
                // This is a simplified implementation, in a real app you'd detect the actual IPv4
                const response = `227 Entering Passive Mode (127,0,0,1,${p1},${p2})`;
                this.sendMsg(Buffer.from(response));
            } else {
                const response = `227 Entering Passive Mode (${ip.join(',')},${p1},${p2})`;
                this.sendMsg(Buffer.from(response));
            }

            this.passive = true;
        });

        this.passiveServer.on('error', err => {
            logger.error(`Passive server error: ${err.message}`);
            this.sendMsg(Buffer.from('425 Cannot open passive connection'));
        });
    }

    handlePort(args) {
        const parts = args.split(',');
        if (parts.length !== 6) {
            this.sendMsg(Buffer.from('501 Invalid PORT command'));
            return;
        }

        // Parse IP and port
        this.dataHost = parts.slice(0, 4).join('.');
        this.dataPort = parseInt(parts[4], 10) * 256 + parseInt(parts[5], 10);

        this.passive = false;
        this.sendMsg(Buffer.from('200 PORT command successful'));
    }

    createDataConnection() {
        return new Promise((resolve, reject) => {
            if (this.passive) {
                // In passive mode, the server is already listening for a connection
                if (!this.dataSocket) {
                    // Wait for client to connect
                    const timeout = setTimeout(() => {
                        reject(new Error('Timeout waiting for data connection'));
                    }, 10000);

                    this.passiveServer.once('connection', socket => {
                        clearTimeout(timeout);
                        this.dataSocket = socket;
                        resolve(socket);
                    });
                } else {
                    resolve(this.dataSocket);
                }
            } else {
                // In active mode, the server connects to the client
                const socket = require('net').createConnection({
                    host: this.dataHost,
                    port: this.dataPort
                });

                socket.on('connect', () => {
                    this.dataSocket = socket;
                    resolve(socket);
                });

                socket.on('error', err => {
                    reject(err);
                });
            }
        });
    }

    closeDataConnection() {
        if (this.dataSocket) {
            this.dataSocket.end();
            this.dataSocket = null;
        }

        if (this.passiveServer && this.passive) {
            this.passiveServer.close();
            this.passiveServer = null;
            this.passive = false;
        }
    }

    handleList(args) {
        const targetDir = args ? path.resolve(this.currentDir, args) : this.currentDir;

        const fullPath = path.join(this.ftpWorker.userConfig.rootDir, targetDir);

        fs.access(fullPath, fs.constants.R_OK, err => {
            if (err) {
                this.sendMsg(Buffer.from('550 Directory not accessible'));
                return;
            }

            this.sendMsg(Buffer.from('150 Opening ASCII mode data connection for file list'));

            // Send directory listing event
            this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.DIRECTORY_LISTING, {
                directory: targetDir,
                clientInfo: this.getClientInfo()
            });

            this.createDataConnection()
                .then(socket => {
                    fs.readdir(fullPath, (err, files) => {
                        if (err) {
                            socket.end();
                            this.sendMsg(Buffer.from('550 Failed to list directory'));
                            return;
                        }

                        const fileList = [];

                        const getFileInfo = index => {
                            if (index >= files.length) {
                                // All files processed
                                socket.end(fileList.join('\r\n') + '\r\n');
                                this.sendMsg(Buffer.from('226 Transfer complete'));
                                this.closeDataConnection();
                                return;
                            }

                            const file = files[index];
                            const filePath = path.join(fullPath, file);

                            fs.stat(filePath, (err, stats) => {
                                if (err) {
                                    // Skip files with errors
                                    getFileInfo(index + 1);
                                    return;
                                }

                                // Format directory listing similar to 'ls -l' format
                                const isDir = stats.isDirectory();
                                const permissions = isDir ? 'drwxr-xr-x' : '-rw-r--r--';
                                const size = stats.size;
                                const date = stats.mtime.toDateString();

                                fileList.push(`${permissions} 1 owner group ${size} ${date} ${file}`);
                                getFileInfo(index + 1);
                            });
                        };

                        getFileInfo(0);
                    });
                })
                .catch(err => {
                    logger.error(`Data connection error: ${err.message}`);
                    this.sendMsg(Buffer.from('425 Cannot open data connection'));
                });
        });
    }

    handleCwd(dir) {
        // Change working directory
        let newDir = dir;
        if (dir.startsWith('/')) {
            newDir = dir;
        } else {
            // FTP always uses forward slashes regardless of platform
            // Don't use path.resolve as it uses platform-specific behavior
            newDir = this.currentDir === '/' ? '/' + dir : this.currentDir + '/' + dir;

            // Normalize the path to handle cases like "/a/../b" -> "/b"
            // Split by '/', filter out empty segments and '.', handle '..'
            const segments = newDir.split('/').filter(segment => segment && segment !== '.');
            const resultSegments = [];

            for (const segment of segments) {
                if (segment === '..') {
                    resultSegments.pop();
                } else {
                    resultSegments.push(segment);
                }
            }

            newDir = '/' + resultSegments.join('/');
        }

        logger.info(`Changing directory to ${newDir}`);

        // Ensure the path is within the root directory
        const fullPath = path.join(this.ftpWorker.userConfig.rootDir, newDir);
        logger.info(`Changing directory to ${fullPath}`);

        fs.access(fullPath, fs.constants.R_OK, err => {
            if (err) {
                this.sendMsg(Buffer.from('550 Directory not accessible'));
                return;
            }

            fs.stat(fullPath, (err, stats) => {
                if (err || !stats.isDirectory()) {
                    this.sendMsg(Buffer.from('550 Not a directory'));
                    return;
                }

                this.currentDir = newDir;
                this.sendMsg(Buffer.from('250 Directory changed to ' + newDir));
            });
        });
    }

    handleCdup() {
        this.handleCwd('..');
    }

    handleRetr(filePath) {
        // Download a file
        const fullPath = path.join(this.ftpWorker.userConfig.rootDir, this.currentDir, filePath);

        fs.access(fullPath, fs.constants.R_OK, err => {
            if (err) {
                this.sendMsg(Buffer.from('550 File not accessible'));
                return;
            }

            fs.stat(fullPath, (err, stats) => {
                if (err || !stats.isFile()) {
                    this.sendMsg(Buffer.from('550 Not a regular file'));
                    return;
                }

                this.sendMsg(
                    Buffer.from(
                        `150 Opening ${this.transferType} mode data connection for ${filePath} (${stats.size} bytes)`
                    )
                );

                // Send file transfer start event
                this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.FILE_TRANSFER_START, {
                    type: 'download',
                    filename: filePath,
                    size: stats.size,
                    clientInfo: this.getClientInfo()
                });

                this.createDataConnection()
                    .then(socket => {
                        const stream = fs.createReadStream(fullPath);

                        stream.on('error', err => {
                            logger.error(`File read error: ${err.message}`);
                            socket.end();
                            this.sendMsg(Buffer.from('550 Failed to read file'));

                            // Send file transfer error event
                            this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.FILE_TRANSFER_ERROR, {
                                type: 'download',
                                filename: filePath,
                                error: err.message,
                                clientInfo: this.getClientInfo()
                            });
                        });

                        stream.pipe(socket);

                        socket.on('close', () => {
                            this.sendMsg(Buffer.from('226 Transfer complete'));
                            this.closeDataConnection();

                            // Send file transfer complete event
                            this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.FILE_TRANSFER_COMPLETE, {
                                type: 'download',
                                filename: filePath,
                                size: stats.size,
                                clientInfo: this.getClientInfo()
                            });
                        });
                    })
                    .catch(err => {
                        logger.error(`Data connection error: ${err.message}`);
                        this.sendMsg(Buffer.from('425 Cannot open data connection'));

                        // Send file transfer error event
                        this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.FILE_TRANSFER_ERROR, {
                            type: 'download',
                            filename: filePath,
                            error: err.message,
                            clientInfo: this.getClientInfo()
                        });
                    });
            });
        });
    }

    handleStor(filePath) {
        // Upload a file
        const fullPath = path.join(this.ftpWorker.userConfig.rootDir, this.currentDir, filePath);
        const dirPath = path.dirname(fullPath);

        // Ensure directory exists
        fs.access(dirPath, fs.constants.W_OK, err => {
            if (err) {
                this.sendMsg(Buffer.from('550 Directory not writable'));
                return;
            }

            this.sendMsg(Buffer.from(`150 Opening ${this.transferType} mode data connection for ${filePath}`));

            this.createDataConnection()
                .then(socket => {
                    const stream = fs.createWriteStream(fullPath);

                    stream.on('error', err => {
                        logger.error(`File write error: ${err.message}`);
                        socket.end();
                        this.sendMsg(Buffer.from('550 Failed to write file'));
                    });

                    socket.pipe(stream);

                    socket.on('close', () => {
                        this.sendMsg(Buffer.from('226 Transfer complete'));
                        this.closeDataConnection();
                    });
                })
                .catch(err => {
                    logger.error(`Data connection error: ${err.message}`);
                    this.sendMsg(Buffer.from('425 Cannot open data connection'));
                });
        });
    }

    handleDele(filePath) {
        // Delete a file
        const fullPath = path.join(this.ftpWorker.userConfig.rootDir, this.currentDir, filePath);

        fs.access(fullPath, fs.constants.W_OK, err => {
            if (err) {
                this.sendMsg(Buffer.from('550 File not accessible'));
                return;
            }

            fs.unlink(fullPath, err => {
                if (err) {
                    this.sendMsg(Buffer.from('550 Failed to delete file'));
                    return;
                }

                this.sendMsg(Buffer.from('250 File deleted'));
            });
        });
    }

    handleRmd(dirPath) {
        // Remove a directory
        const fullPath = path.join(this.ftpWorker.userConfig.rootDir, this.currentDir, dirPath);

        fs.access(fullPath, fs.constants.W_OK, err => {
            if (err) {
                this.sendMsg(Buffer.from('550 Directory not accessible'));
                return;
            }

            fs.rmdir(fullPath, err => {
                if (err) {
                    this.sendMsg(Buffer.from('550 Failed to remove directory'));
                    return;
                }

                this.sendMsg(Buffer.from('250 Directory removed'));
            });
        });
    }

    handleMkd(dirPath) {
        // Create a directory
        const fullPath = path.join(this.ftpWorker.userConfig.rootDir, this.currentDir, dirPath);

        fs.mkdir(fullPath, err => {
            if (err) {
                this.sendMsg(Buffer.from('550 Failed to create directory'));
                return;
            }

            this.sendMsg(Buffer.from(`257 "${dirPath}" created`));
        });
    }

    handleFeat() {
        // List supported features
        this.sendMsg(Buffer.from('211-Features:'));
        this.sendMsg(Buffer.from(' UTF8'));
        this.sendMsg(Buffer.from(' SIZE'));
        this.sendMsg(Buffer.from(' PASV'));
        this.sendMsg(Buffer.from(' TYPE A;I'));
        this.sendMsg(Buffer.from('211 End'));
    }

    handleOpts(args) {
        const parts = args.split(' ');
        if (parts[0].toUpperCase() === 'UTF8') {
            this.sendMsg(Buffer.from('200 UTF8 set to ON'));
        } else {
            this.sendMsg(Buffer.from('501 Option not supported'));
        }
    }

    handleNoop() {
        this.sendMsg(Buffer.from('200 NOOP command successful'));
    }

    handleQuit() {
        this.sendMsg(Buffer.from('221 Goodbye'));
        this.closeSession();
    }

    recvMsg(buffer) {
        this.messageBuffer = Buffer.concat([this.messageBuffer, buffer]);
        const messages = this.messageBuffer.toString().split('\r\n');

        // Process complete messages, keeping any incomplete message in the buffer
        if (messages.length > 1) {
            this.messageBuffer = Buffer.from(messages[messages.length - 1]);

            for (let i = 0; i < messages.length - 1; i++) {
                if (messages[i].length > 0) {
                    this.processMessage(Buffer.from(messages[i]));
                }
            }
        }
    }

    sendMsg(buffer) {
        if (this.socket && this.socket.writable) {
            this.socket.write(buffer);
            this.socket.write('\r\n');
        }
    }

    closeSession() {
        this.closeDataConnection();

        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }

        // Update the client connection event
        this.messageHandler.sendEvent(FtpConst.FTP_EVT_TYPES.FTP_EVT, {
            type: FtpConst.FTP_SUB_EVT_TYPES.FTP_SUB_EVT_CONNCET,
            opType: 'remove',
            data: this.getClientInfo()
        });
    }

    getClientInfo() {
        const status = this.authenticated ? '已登录' : '已连接';
        const connectedTime = this.connectedTime
            ? this.connectedTime.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : '';

        return {
            localIp: this.localIp,
            localPort: this.localPort,
            remoteIp: this.remoteIp,
            remotePort: this.remotePort,
            username: this.username || '匿名',
            authenticated: this.authenticated,
            status: status,
            connectedTime: connectedTime
        };
    }
}

module.exports = FtpSession;
