const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
    TCP_AO_FORWARD_CAPABILITY_BYTES,
    TCP_AO_FORWARD_HEADER_BYTES,
    TCP_AO_FORWARD_VERSION,
    TCP_AO_UNIX_PATH_MAX_BYTES
} = require('./tcpAoForwardProtocol');

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const MAX_STATUS_OUTPUT_BYTES = 64 * 1024;
const TCP_AO_HELPER_EXIT_CODES = Object.freeze({
    KEYS_EXPIRED: 20,
    CLOCK_ROLLBACK: 21,
    CLOCK_UNAVAILABLE: 22,
    ROTATION_FAILED: 23
});

const TCP_AO_RUNTIME_FAILURES = Object.freeze({
    [TCP_AO_HELPER_EXIT_CODES.KEYS_EXPIRED]: Object.freeze({
        code: 'TCP_AO_KEYS_EXPIRED',
        reason: 'TCP-AO发送密钥已过期且没有可用的后继密钥，{service}服务已安全停止'
    }),
    [TCP_AO_HELPER_EXIT_CODES.CLOCK_ROLLBACK]: Object.freeze({
        code: 'TCP_AO_CLOCK_ROLLBACK',
        reason: '检测到系统时间回拨，为避免重新启用过期密钥，TCP-AO/{service}服务已安全停止'
    }),
    [TCP_AO_HELPER_EXIT_CODES.CLOCK_UNAVAILABLE]: Object.freeze({
        code: 'TCP_AO_CLOCK_UNAVAILABLE',
        reason: '无法读取系统时间，TCP-AO/{service}服务已安全停止'
    }),
    [TCP_AO_HELPER_EXIT_CODES.ROTATION_FAILED]: Object.freeze({
        code: 'TCP_AO_ROTATION_FAILED',
        reason: 'TCP-AO密钥轮换失败，{service}服务已安全停止'
    })
});

function normalizeServiceName(value) {
    const serviceName = String(value || 'RPKI')
        .trim()
        .toUpperCase();
    return /^[A-Z0-9_-]{1,32}$/.test(serviceName) ? serviceName : 'RPKI';
}

function runtimeFailureForHelperExit(exitCode, serviceName = 'RPKI') {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const failure = TCP_AO_RUNTIME_FAILURES[Number(exitCode)];
    if (failure) return { ...failure, reason: failure.reason.replace('{service}', normalizedServiceName) };
    return {
        code: 'TCP_AO_HELPER_EXIT',
        reason: `TCP-AO认证进程异常退出，${normalizedServiceName}服务已安全停止`
    };
}

function normalizePort(value, field) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${field}必须是1-65535之间的整数`);
    }
    return port;
}

function runtimeTimestamp(value) {
    if (value === null || value === undefined || value === '') return 0;
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
        throw new Error('TCP-AO密钥有效期格式无效');
    }
    return seconds;
}

function normalizeForwardSocket(value) {
    const socketPath = typeof value === 'string' ? value : '';
    if (!socketPath || !path.isAbsolute(socketPath) || socketPath.includes('\0')) {
        throw new Error('TCP-AO内部Unix socket路径无效');
    }
    if (Buffer.byteLength(socketPath, 'utf8') > TCP_AO_UNIX_PATH_MAX_BYTES) {
        throw new Error(`TCP-AO内部Unix socket路径不能超过${TCP_AO_UNIX_PATH_MAX_BYTES}字节`);
    }
    return socketPath;
}

function normalizeForwardCapability(value) {
    if (!Buffer.isBuffer(value) || value.length !== TCP_AO_FORWARD_CAPABILITY_BYTES) {
        throw new Error(`TCP-AO内部通道能力令牌必须为${TCP_AO_FORWARD_CAPABILITY_BYTES}字节`);
    }
    return value.toString('hex');
}

function serializeProfile(profile) {
    return {
        peer: profile.peer,
        keys: profile.keys.map(key => ({
            algorithm: key.algorithm,
            sndId: key.sndId,
            rcvId: key.rcvId,
            key: key.key,
            macLength: key.macLength,
            acceptStart: runtimeTimestamp(key.acceptStart),
            sendStart: runtimeTimestamp(key.sendStart),
            sendEnd: runtimeTimestamp(key.sendEnd),
            acceptEnd: runtimeTimestamp(key.acceptEnd)
        }))
    };
}

function clearSerializedConfig(config) {
    if (!config || typeof config !== 'object') return;
    config.forwardCapability = null;
    for (const profile of Array.isArray(config.profiles) ? config.profiles : []) {
        for (const key of Array.isArray(profile?.keys) ? profile.keys : []) key.key = null;
        if (profile && typeof profile === 'object') profile.keys = [];
    }
    config.profiles = [];
}

class TcpAoProxy extends EventEmitter {
    constructor(options = {}) {
        super();
        this.spawn = options.spawn || spawn;
        this.fs = options.fs || fs;
        this.platform = options.platform || process.platform;
        this.arch = options.arch || process.arch;
        this.resourcesPath = options.resourcesPath || process.resourcesPath;
        this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..', '..');
        this.helperPath = options.helperPath || null;
        this.serviceName = normalizeServiceName(options.serviceName);
        this.readyTimeoutMs = Math.max(250, Number(options.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS);
        this.stopTimeoutMs = Math.max(250, Number(options.stopTimeoutMs) || DEFAULT_STOP_TIMEOUT_MS);
        this.child = null;
        this.ready = false;
        this.stopping = false;
        this.exitPromise = null;
        this.resolveExit = null;
        this.lastStatus = null;
    }

    resolveHelperPath() {
        if (this.platform !== 'linux') {
            throw new Error('TCP-AO认证仅支持Linux');
        }
        const runtimeDirectory = `linux-${this.arch}`;
        const candidates = [
            this.helperPath,
            this.resourcesPath && path.join(this.resourcesPath, 'tcp-ao', runtimeDirectory, 'tcp-ao-helper'),
            path.join(this.projectRoot, 'resources', 'tcp-ao', runtimeDirectory, 'tcp-ao-helper')
        ].filter(Boolean);

        for (const candidate of candidates) {
            try {
                const stats = this.fs.lstatSync(candidate);
                if (!stats.isFile() || stats.isSymbolicLink()) continue;
                if ((stats.mode & 0o111) === 0) {
                    throw new Error(`TCP-AO helper没有执行权限: ${candidate}`);
                }
                if ((stats.mode & 0o022) !== 0) {
                    throw new Error(`TCP-AO helper不能被组用户或其他用户写入: ${candidate}`);
                }
                return candidate;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        throw new Error(`未找到${runtimeDirectory} TCP-AO helper，请先运行 npm run tcp-ao:build`);
    }

    buildConfig(profiles, forwardCapability) {
        if (!Array.isArray(profiles) || profiles.length === 0) {
            throw new Error('TCP-AO helper至少需要一个profile');
        }
        return {
            schemaVersion: 2,
            forwardCapability: normalizeForwardCapability(forwardCapability),
            profiles: profiles.map(serializeProfile)
        };
    }

    start(options = {}) {
        if (this.child) return Promise.reject(new Error('TCP-AO helper已经启动'));
        const listenPort = normalizePort(options.listenPort, 'TCP-AO监听端口');
        const forwardSocket = normalizeForwardSocket(options.forwardSocket);
        const helperPath = this.resolveHelperPath();
        const expectedProfileCount = Array.isArray(options.profiles) ? options.profiles.length : 0;
        const expectedKeyCount = Array.isArray(options.profiles)
            ? options.profiles.reduce(
                  (total, profile) => total + (Array.isArray(profile?.keys) ? profile.keys.length : 0),
                  0
              )
            : 0;
        const expectedFamilies = Array.from(
            new Set(
                (Array.isArray(options.profiles) ? options.profiles : []).map(profile =>
                    Number(profile?.family) === 6 || String(profile?.peer || '').includes(':') ? 'ipv6' : 'ipv4'
                )
            )
        ).sort();
        const config = this.buildConfig(options.profiles, options.forwardCapability);
        let secretPayload;
        try {
            secretPayload = Buffer.from(`${JSON.stringify(config)}\n`, 'utf8');
        } finally {
            // The stdin Buffer is the sole remaining proxy-owned copy. It is
            // wiped by every completion/failure path below.
            clearSerializedConfig(config);
        }

        this.stopping = false;
        this.ready = false;
        let child;
        try {
            child = this.spawn(
                helperPath,
                [
                    '--parent-pid',
                    String(process.pid),
                    '--listen-port',
                    String(listenPort),
                    '--forward-socket',
                    forwardSocket,
                    '--max-clients',
                    String(options.maxClients || 256),
                    '--backlog',
                    String(options.backlog || 128)
                ],
                {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                    shell: false
                }
            );
        } catch (error) {
            secretPayload.fill(0);
            return Promise.reject(new Error(`无法启动TCP-AO helper: ${error.message}`));
        }
        this.child = child;
        this.exitPromise = new Promise(resolve => {
            this.resolveExit = resolve;
        });

        return new Promise((resolve, reject) => {
            let settled = false;
            let exitFinalized = false;
            let output = '';
            let diagnostic = '';
            let payloadWiped = false;
            const wipePayload = () => {
                if (payloadWiped) return;
                payloadWiped = true;
                secretPayload?.fill(0);
            };
            const readyTimer = setTimeout(() => {
                fail(new Error(`TCP-AO helper在${this.readyTimeoutMs}ms内没有就绪`));
            }, this.readyTimeoutMs);
            readyTimer.unref?.();

            const cleanupStartup = () => {
                clearTimeout(readyTimer);
                wipePayload();
            };
            const fail = error => {
                wipePayload();
                if (settled) return;
                settled = true;
                cleanupStartup();
                this.stopping = true;
                if (Number.isInteger(child.pid)) {
                    try {
                        child.kill('SIGTERM');
                    } catch (_error) {
                        // The original startup error is more useful.
                    }
                }
                const detail = diagnostic.trim();
                if (detail && !error.message.includes(detail)) error.message = `${error.message}: ${detail}`;
                reject(error);
            };
            const finalizeExit = (code, signal) => {
                wipePayload();
                if (exitFinalized) return;
                exitFinalized = true;
                this.child = null;
                this.ready = false;
                this.resolveExit?.({ code, signal });
                this.resolveExit = null;
                if (!settled) {
                    fail(new Error(`TCP-AO helper启动前退出（code=${code ?? '-'}, signal=${signal || '-'}）`));
                    return;
                }
                if (!this.stopping) {
                    const detail = diagnostic.trim();
                    const suffix = detail ? `: ${detail}` : '';
                    const error = new Error(
                        `TCP-AO helper异常退出（code=${code ?? '-'}, signal=${signal || '-'}）${suffix}`
                    );
                    error.code = 'TCP_AO_HELPER_EXIT';
                    error.runtimeFailure = runtimeFailureForHelperExit(code, this.serviceName);
                    this.emit('unexpectedExit', error);
                }
            };
            const handleStatusLine = line => {
                let status;
                try {
                    status = JSON.parse(line);
                } catch (_error) {
                    fail(new Error('TCP-AO helper返回了无效的启动状态'));
                    return;
                }
                if (status?.status === 'error') {
                    const error = new Error(status.message || 'TCP-AO helper启动失败');
                    error.code = status.code || 'TCP_AO_HELPER_ERROR';
                    fail(error);
                    return;
                }
                if (
                    status?.status !== 'ready' ||
                    status.aoRequired !== true ||
                    status.listenPort !== listenPort ||
                    status.forwardTransport !== 'unix' ||
                    status.peerHeaderVersion !== TCP_AO_FORWARD_VERSION ||
                    status.peerHeaderBytes !== TCP_AO_FORWARD_HEADER_BYTES ||
                    status.profileCount !== expectedProfileCount ||
                    status.keyCount !== expectedKeyCount ||
                    !Array.isArray(status.families) ||
                    JSON.stringify([...status.families].sort()) !== JSON.stringify(expectedFamilies)
                ) {
                    fail(new Error('TCP-AO helper未确认AO强制认证状态'));
                    return;
                }
                if (settled) return;
                settled = true;
                cleanupStartup();
                this.ready = true;
                this.lastStatus = status;
                resolve(status);
            };

            child.once('error', error => {
                fail(new Error(`无法启动TCP-AO helper: ${error.message}`));
                // A failed spawn emits error + close, but no exit. Finalize immediately so
                // the worker cleanup path cannot wait forever for an exit event that will not occur.
                if (!Number.isInteger(child.pid)) finalizeExit(null, null);
            });
            child.stdout.on('data', chunk => {
                if (settled) return;
                output += chunk.toString('utf8');
                if (Buffer.byteLength(output, 'utf8') > MAX_STATUS_OUTPUT_BYTES) {
                    fail(new Error('TCP-AO helper启动状态输出过大'));
                    return;
                }
                const newline = output.indexOf('\n');
                if (newline !== -1) handleStatusLine(output.slice(0, newline).trim());
            });
            child.stderr.on('data', chunk => {
                if (diagnostic.length < MAX_STATUS_OUTPUT_BYTES) diagnostic += chunk.toString('utf8');
            });
            child.once('exit', finalizeExit);
            // `close` is the only terminal event guaranteed after a spawn failure.
            child.once('close', finalizeExit);

            child.stdin.once('error', error => {
                wipePayload();
                fail(new Error(`写入TCP-AO helper配置失败: ${error.message}`));
            });
            try {
                child.stdin.end(secretPayload, wipePayload);
            } catch (error) {
                wipePayload();
                fail(new Error(`写入TCP-AO helper配置失败: ${error.message}`));
            }
        });
    }

    async stop() {
        const child = this.child;
        if (!child) return;
        this.stopping = true;
        try {
            child.kill('SIGTERM');
        } catch (error) {
            if (error.code !== 'ESRCH') throw error;
        }

        let timeout;
        try {
            await Promise.race([
                this.exitPromise,
                new Promise(resolve => {
                    timeout = setTimeout(resolve, this.stopTimeoutMs);
                    timeout.unref?.();
                })
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
        if (this.child === child) {
            try {
                child.kill('SIGKILL');
            } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
            await this.exitPromise;
        }
    }
}

module.exports = TcpAoProxy;
module.exports.serializeProfile = serializeProfile;
module.exports.TCP_AO_HELPER_EXIT_CODES = TCP_AO_HELPER_EXIT_CODES;
module.exports.runtimeFailureForHelperExit = runtimeFailureForHelperExit;
