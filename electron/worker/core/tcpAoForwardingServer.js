const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const ipaddr = require('ipaddr.js');
const logger = require('../../log/logger');
const TcpAoProxy = require('../rpki/tcpAoProxy');
const {
    TCP_AO_FORWARD_CAPABILITY_BYTES,
    TCP_AO_FORWARD_HEADER_BYTES,
    TCP_AO_FORWARD_HEADER_TIMEOUT_MS,
    TCP_AO_UNIX_PATH_MAX_BYTES,
    decodeTcpAoForwardHeader
} = require('../rpki/tcpAoForwardProtocol');

const DEFAULT_MAX_PENDING_HEADERS = 256;

function closeServer(server) {
    if (!server || typeof server.close !== 'function') return Promise.resolve();
    return new Promise((resolve, reject) => {
        try {
            server.close(error => {
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                else resolve();
            });
        } catch (error) {
            if (error.code === 'ERR_SERVER_NOT_RUNNING') resolve();
            else reject(error);
        }
    });
}

function listenUnixServer(server, socketPath) {
    return new Promise((resolve, reject) => {
        const onError = error => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(socketPath);
    });
}

class TcpAoForwardingServer {
    constructor(options = {}) {
        this.fs = options.fs || fs;
        this.net = options.net || net;
        this.os = options.os || os;
        this.crypto = options.crypto || crypto;
        this.createProxy = options.createProxy || (() => new TcpAoProxy({ serviceName: options.serviceName }));
        this.serviceName = String(options.serviceName || 'TCP').toUpperCase();
        this.directoryPrefix = String(options.directoryPrefix || `nn-${this.serviceName.toLowerCase()}-ao-`);
        this.socketFileName = String(options.socketFileName || 'f.sock');
        this.maxPendingHeaders = Math.max(
            1,
            Math.min(4096, Number(options.maxPendingHeaders) || DEFAULT_MAX_PENDING_HEADERS)
        );
        this.headerTimeoutMs = Math.max(
            1,
            Math.min(
                TCP_AO_FORWARD_HEADER_TIMEOUT_MS,
                Number(options.headerTimeoutMs) || TCP_AO_FORWARD_HEADER_TIMEOUT_MS
            )
        );

        this.server = null;
        this.proxy = null;
        this.socketDirectory = null;
        this.directoryIdentity = null;
        this.socketPath = null;
        this.socketIdentity = null;
        this.forwardCapability = null;
        this.exitCleanup = null;
        this.pendingSockets = new Set();
        this.profiles = [];
        this.listenPort = 0;
        this.acceptConnection = null;
        this.stopping = false;
    }

    isOwnedDirectory(directoryPath, expectedIdentity = null) {
        try {
            const stats = this.fs.lstatSync(directoryPath);
            const uid = typeof process.getuid === 'function' ? process.getuid() : null;
            return (
                stats.isDirectory() &&
                !stats.isSymbolicLink() &&
                (stats.mode & 0o777) === 0o700 &&
                (uid === null || stats.uid === uid) &&
                (!expectedIdentity || (stats.dev === expectedIdentity.dev && stats.ino === expectedIdentity.ino))
            );
        } catch (_error) {
            return false;
        }
    }

    createForwardEndpoint() {
        this.cleanupForwardEndpoint();
        const directory = this.fs.mkdtempSync(path.join(this.os.tmpdir(), this.directoryPrefix));
        this.socketDirectory = directory;
        const exitCleanup = () => this.cleanupForwardEndpoint();
        this.exitCleanup = exitCleanup;
        process.once('exit', exitCleanup);
        try {
            this.fs.chmodSync(directory, 0o700);
            const stats = this.fs.lstatSync(directory);
            const uid = typeof process.getuid === 'function' ? process.getuid() : null;
            if (
                !stats.isDirectory() ||
                stats.isSymbolicLink() ||
                (stats.mode & 0o777) !== 0o700 ||
                (uid !== null && stats.uid !== uid)
            ) {
                throw new Error('TCP-AO内部Unix socket目录权限无效');
            }
            this.directoryIdentity = { dev: stats.dev, ino: stats.ino };
            const socketPath = path.join(directory, this.socketFileName);
            if (Buffer.byteLength(socketPath, 'utf8') > TCP_AO_UNIX_PATH_MAX_BYTES) {
                throw new Error(`TCP-AO内部Unix socket路径超过${TCP_AO_UNIX_PATH_MAX_BYTES}字节`);
            }
            this.socketPath = socketPath;
            this.forwardCapability = this.crypto.randomBytes(TCP_AO_FORWARD_CAPABILITY_BYTES);
            return { socketPath, capability: this.forwardCapability };
        } catch (error) {
            this.cleanupForwardEndpoint();
            throw error;
        }
    }

    secureSocketFile() {
        const socketPath = this.socketPath;
        if (!socketPath || !this.isOwnedDirectory(this.socketDirectory, this.directoryIdentity)) {
            throw new Error('TCP-AO内部Unix socket目录无效');
        }
        const initialStats = this.fs.lstatSync(socketPath);
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (!initialStats.isSocket() || initialStats.isSymbolicLink() || (uid !== null && initialStats.uid !== uid)) {
            throw new Error('TCP-AO内部Unix socket文件无效');
        }
        this.socketIdentity = { dev: initialStats.dev, ino: initialStats.ino };
        this.fs.chmodSync(socketPath, 0o600);
        const stats = this.fs.lstatSync(socketPath);
        if (
            !stats.isSocket() ||
            stats.isSymbolicLink() ||
            (stats.mode & 0o777) !== 0o600 ||
            (uid !== null && stats.uid !== uid) ||
            stats.dev !== this.socketIdentity.dev ||
            stats.ino !== this.socketIdentity.ino
        ) {
            throw new Error('TCP-AO内部Unix socket文件权限无效');
        }
    }

    cleanupForwardEndpoint() {
        this.destroyPendingSockets();
        const exitCleanup = this.exitCleanup;
        this.exitCleanup = null;
        if (typeof exitCleanup === 'function') process.removeListener('exit', exitCleanup);
        if (Buffer.isBuffer(this.forwardCapability)) this.forwardCapability.fill(0);
        this.forwardCapability = null;

        const directory = this.socketDirectory;
        const directoryIdentity = this.directoryIdentity;
        const socketPath = this.socketPath;
        const socketIdentity = this.socketIdentity;
        this.socketDirectory = null;
        this.directoryIdentity = null;
        this.socketPath = null;
        this.socketIdentity = null;
        if (!directory || !this.isOwnedDirectory(directory, directoryIdentity)) return;

        if (socketPath) {
            try {
                const stats = this.fs.lstatSync(socketPath);
                const sameSocket =
                    stats.isSocket() &&
                    !stats.isSymbolicLink() &&
                    (!socketIdentity || (stats.dev === socketIdentity.dev && stats.ino === socketIdentity.ino));
                if (sameSocket) this.fs.unlinkSync(socketPath);
            } catch (error) {
                if (error.code !== 'ENOENT') logger.debug(`清理TCP-AO Unix socket失败: ${error.message}`);
            }
        }
        try {
            this.fs.rmdirSync(directory);
        } catch (error) {
            if (error.code !== 'ENOENT') logger.debug(`清理TCP-AO Unix socket目录失败: ${error.message}`);
        }
    }

    destroyPendingSockets() {
        for (const socket of this.pendingSockets) socket.destroy?.();
        this.pendingSockets.clear();
    }

    validatePeerMetadata(metadata) {
        if (metadata.localPort !== this.listenPort) {
            throw new Error('TCP-AO转发头本地端口与服务配置不匹配');
        }
        let remote;
        try {
            remote = ipaddr.parse(metadata.remoteAddress);
        } catch (_error) {
            throw new Error('TCP-AO转发头远端地址无效');
        }
        const matchedProfile = this.profiles.find(profile => {
            try {
                const [network, prefixLength] = ipaddr.parseCIDR(profile.peer);
                return network.kind() === remote.kind() && remote.match(network, prefixLength);
            } catch (_error) {
                return false;
            }
        });
        if (!matchedProfile) throw new Error('TCP-AO转发头远端地址不属于已认证Profile');
        return {
            ...metadata,
            tcpAoProfileId: matchedProfile.id || null,
            tcpAoProfileName: matchedProfile.name || null,
            tcpAoPeer: matchedProfile.peer
        };
    }

    acceptInternalSocket(socket) {
        const capability = this.forwardCapability;
        if (
            this.stopping ||
            !Buffer.isBuffer(capability) ||
            capability.length !== TCP_AO_FORWARD_CAPABILITY_BYTES ||
            this.pendingSockets.size >= this.maxPendingHeaders
        ) {
            socket.destroy();
            return;
        }

        const header = Buffer.alloc(TCP_AO_FORWARD_HEADER_BYTES);
        let received = 0;
        let finished = false;
        this.pendingSockets.add(socket);
        const timer = setTimeout(() => rejectHeader(), this.headerTimeoutMs);
        timer.unref?.();

        const cleanup = () => {
            clearTimeout(timer);
            this.pendingSockets.delete(socket);
            socket.removeListener('data', onData);
            socket.removeListener('end', onEnd);
            socket.removeListener('close', onClose);
            socket.removeListener('error', onError);
            header.fill(0);
        };
        const rejectHeader = () => {
            if (finished) return;
            finished = true;
            cleanup();
            socket.destroy();
        };
        const onEnd = () => rejectHeader();
        const onClose = () => rejectHeader();
        const onError = () => rejectHeader();
        const onData = chunk => {
            if (finished || !Buffer.isBuffer(chunk)) return;
            const copyLength = Math.min(TCP_AO_FORWARD_HEADER_BYTES - received, chunk.length);
            chunk.copy(header, received, 0, copyLength);
            received += copyLength;
            if (received < TCP_AO_FORWARD_HEADER_BYTES) return;

            socket.pause();
            let metadata;
            try {
                metadata = this.validatePeerMetadata(decodeTcpAoForwardHeader(header, this.forwardCapability));
                if (this.stopping) throw new Error(`${this.serviceName}正在停止`);
            } catch (_error) {
                rejectHeader();
                return;
            }
            const initialData = chunk.subarray(copyLength);
            finished = true;
            cleanup();
            try {
                const accepted = this.acceptConnection?.(socket, metadata, initialData);
                if (accepted === false || accepted === null) {
                    socket.destroy();
                    return;
                }
                if (!accepted || accepted.resume !== false) socket.resume();
            } catch (error) {
                logger.warn(`TCP-AO内部连接初始化失败: ${error.message}`);
                socket.destroy();
            }
        };
        socket.on('data', onData);
        socket.once('end', onEnd);
        socket.once('close', onClose);
        socket.once('error', onError);
        socket.resume();
    }

    async start(options = {}) {
        if (this.server || this.proxy) throw new Error('TCP-AO转发服务已经启动');
        const listenPort = Number(options.listenPort);
        if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
            throw new Error('TCP-AO监听端口必须是1-65535之间的整数');
        }
        if (!Array.isArray(options.profiles) || options.profiles.length === 0) {
            throw new Error('TCP-AO转发服务至少需要一个Profile');
        }
        if (typeof options.onConnection !== 'function') {
            throw new Error('TCP-AO转发服务缺少连接处理器');
        }

        let runtimeProfiles = options.profiles;
        const acceptConnection = options.onConnection;
        const onUnexpectedExit = options.onUnexpectedExit;
        const onProfilesConsumed = options.onProfilesConsumed;
        const maxClients = options.maxClients;
        const backlog = options.backlog;
        let profilesConsumed = false;
        const notifyProfilesConsumed = () => {
            if (profilesConsumed) return;
            profilesConsumed = true;
            onProfilesConsumed?.();
        };
        // Do not retain the caller's options object (which contains plaintext
        // keys) across either asynchronous startup wait below.
        options = null;

        this.listenPort = listenPort;
        this.profiles = runtimeProfiles.map(profile => ({
            id: profile.id || null,
            name: profile.name || null,
            peer: profile.peer
        }));
        this.acceptConnection = acceptConnection;
        this.stopping = false;
        try {
            const { socketPath, capability } = this.createForwardEndpoint();
            const server = this.net.createServer({ pauseOnConnect: true }, socket => this.acceptInternalSocket(socket));
            server.maxConnections = this.maxPendingHeaders;
            this.server = server;
            await listenUnixServer(server, socketPath);
            this.secureSocketFile();

            const proxy = this.createProxy();
            this.proxy = proxy;
            proxy.once('unexpectedExit', error => onUnexpectedExit?.(error));
            // TcpAoProxy serializes the helper configuration synchronously.
            // Notify the protocol worker immediately afterwards so it can wipe
            // its own plaintext references while helper readiness is pending.
            const startup = proxy.start({
                listenPort,
                forwardSocket: socketPath,
                forwardCapability: capability,
                profiles: runtimeProfiles,
                maxClients,
                backlog
            });
            runtimeProfiles = null;
            notifyProfilesConsumed();
            const status = await startup;
            return status;
        } catch (error) {
            runtimeProfiles = null;
            notifyProfilesConsumed();
            await this.stop().catch(cleanupError => {
                logger.warn(`清理TCP-AO启动失败资源时出错: ${cleanupError.message}`);
            });
            throw error;
        }
    }

    async stop() {
        this.stopping = true;
        const proxy = this.proxy;
        const server = this.server;
        this.proxy = null;
        this.server = null;
        this.destroyPendingSockets();
        const results = await Promise.allSettled([proxy?.stop?.() || Promise.resolve(), closeServer(server)]);
        this.cleanupForwardEndpoint();
        this.profiles = [];
        this.listenPort = 0;
        this.acceptConnection = null;
        this.stopping = false;
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
    }
}

module.exports = TcpAoForwardingServer;
module.exports.closeServer = closeServer;
module.exports.listenUnixServer = listenUnixServer;
