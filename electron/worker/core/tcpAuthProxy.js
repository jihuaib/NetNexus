const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
    TCP_AUTH_FORWARD_CAPABILITY_BYTES,
    TCP_AUTH_FORWARD_HEADER_BYTES,
    TCP_AUTH_FORWARD_VERSION,
    TCP_AUTH_FORWARD_UNIX_PATH_MAX_BYTES
} = require('./tcpAuthForwardProtocol');

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const DEFAULT_RELOAD_TIMEOUT_MS = 10_000;
const MAX_STATUS_OUTPUT_BYTES = 64 * 1024;
const MAX_TCP_MD5_KEY_BYTES = 80;
const TCP_AUTH_HELPER_LABEL = 'TCP 认证 helper';
const TCP_AUTH_TYPES = Object.freeze({
    TCP_AO: 'tcp-ao',
    TCP_MD5: 'tcp-md5'
});
const TCP_AO_HELPER_EXIT_CODES = Object.freeze({
    KEYS_EXPIRED: 20,
    CLOCK_ROLLBACK: 21,
    CLOCK_UNAVAILABLE: 22,
    ROTATION_FAILED: 23,
    RELOAD_FAILED: 24
});
const RECOVERABLE_RELOAD_ERROR_CODES = Object.freeze([
    'RELOAD_REQUEST_INVALID',
    'RELOAD_CONFIG_INVALID',
    'RELOAD_RESTART_REQUIRED',
    'RELOAD_CLOCK_ROLLBACK',
    'RELOAD_PREFLIGHT_FAILED',
    'RELOAD_APPLY_FAILED'
]);

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
    }),
    [TCP_AO_HELPER_EXIT_CODES.RELOAD_FAILED]: Object.freeze({
        code: 'TCP_AO_RELOAD_FAILED',
        reason: 'TCP-AO运行时密钥热更新失败且无法回滚，{service}服务已安全停止'
    })
});

function normalizeServiceName(value) {
    const serviceName = String(value || 'RPKI')
        .trim()
        .toUpperCase();
    return /^[A-Z0-9_-]{1,32}$/.test(serviceName) ? serviceName : 'RPKI';
}

function normalizeAuthType(value) {
    const authType = String(value || TCP_AUTH_TYPES.TCP_AO)
        .trim()
        .toLowerCase();
    if (!Object.values(TCP_AUTH_TYPES).includes(authType)) {
        throw new Error('不支持的TCP认证类型');
    }
    return authType;
}

function authLabel(authType) {
    return authType === TCP_AUTH_TYPES.TCP_MD5 ? 'TCP-MD5' : 'TCP-AO';
}

function runtimeFailureForHelperExit(exitCode, serviceName = 'RPKI', authType = TCP_AUTH_TYPES.TCP_AO) {
    const normalizedServiceName = normalizeServiceName(serviceName);
    const normalizedAuthType = normalizeAuthType(authType);
    if (normalizedAuthType === TCP_AUTH_TYPES.TCP_MD5) {
        return {
            code: 'TCP_MD5_HELPER_EXIT',
            reason: `TCP-MD5认证进程异常退出，${normalizedServiceName}服务已安全停止`
        };
    }
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

function normalizeForwardSocket(value, label = 'TCP认证') {
    const socketPath = typeof value === 'string' ? value : '';
    if (!socketPath || !path.isAbsolute(socketPath) || socketPath.includes('\0')) {
        throw new Error(`${label}内部Unix socket路径无效`);
    }
    if (Buffer.byteLength(socketPath, 'utf8') > TCP_AUTH_FORWARD_UNIX_PATH_MAX_BYTES) {
        throw new Error(`${label}内部Unix socket路径不能超过${TCP_AUTH_FORWARD_UNIX_PATH_MAX_BYTES}字节`);
    }
    return socketPath;
}

function normalizeForwardCapability(value, label = 'TCP认证') {
    if (!Buffer.isBuffer(value) || value.length !== TCP_AUTH_FORWARD_CAPABILITY_BYTES) {
        throw new Error(`${label}内部通道能力令牌必须为${TCP_AUTH_FORWARD_CAPABILITY_BYTES}字节`);
    }
    return value.toString('hex');
}

function serializeProfile(profile, authType = TCP_AUTH_TYPES.TCP_AO) {
    if (normalizeAuthType(authType) === TCP_AUTH_TYPES.TCP_MD5) {
        const key = typeof profile?.key === 'string' ? profile.key : '';
        const keyLength = Buffer.byteLength(key, 'utf8');
        if (keyLength < 1 || keyLength > MAX_TCP_MD5_KEY_BYTES) {
            throw new Error(`TCP-MD5密钥必须为1-${MAX_TCP_MD5_KEY_BYTES}字节`);
        }
        if (key.includes('\0')) throw new Error('TCP-MD5密钥不能包含NUL字符');
        return {
            peer: profile?.peer,
            key
        };
    }
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
        if (profile && typeof profile === 'object') profile.key = null;
        for (const key of Array.isArray(profile?.keys) ? profile.keys : []) key.key = null;
        if (profile && typeof profile === 'object') profile.keys = [];
    }
    config.profiles = [];
}

class TcpAuthProxy extends EventEmitter {
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
        this.authType = normalizeAuthType(options.authType);
        this.authLabel = authLabel(this.authType);
        this.readyTimeoutMs = Math.max(250, Number(options.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS);
        this.stopTimeoutMs = Math.max(250, Number(options.stopTimeoutMs) || DEFAULT_STOP_TIMEOUT_MS);
        this.reloadTimeoutMs = Math.max(250, Number(options.reloadTimeoutMs) || DEFAULT_RELOAD_TIMEOUT_MS);
        this.child = null;
        this.ready = false;
        this.stopping = false;
        this.exitPromise = null;
        this.resolveExit = null;
        this.lastStatus = null;
        this.forwardCapability = null;
        this.reloadRequestId = 0;
        this.reloadQueue = Promise.resolve();
        this.pendingReload = null;
    }

    clearForwardCapability() {
        if (Buffer.isBuffer(this.forwardCapability)) this.forwardCapability.fill(0);
        this.forwardCapability = null;
    }

    rejectPendingReload(error) {
        const pending = this.pendingReload;
        if (!pending) return false;
        this.pendingReload = null;
        clearTimeout(pending.timeout);
        pending.reject(error);
        return true;
    }

    failClosedReload(error) {
        this.ready = false;
        this.rejectPendingReload(error);
        const child = this.child;
        if (child && Number.isInteger(child.pid)) {
            try {
                child.kill('SIGTERM');
            } catch (_error) {
                // The explicit reload error remains the caller-facing cause;
                // the child exit path will publish the runtime failure.
            }
        }
    }

    handleReloadStatus(status) {
        const requestId = Number(status?.requestId);
        const pending = this.pendingReload;
        if (!Number.isSafeInteger(requestId) || requestId < 1) {
            const error = new Error(`${TCP_AUTH_HELPER_LABEL}热更新响应缺少有效requestId`);
            error.code = 'TCP_AO_RELOAD_PROTOCOL_ERROR';
            this.failClosedReload(error);
            return;
        }
        if (!pending || requestId !== pending.requestId) {
            const error = new Error(`${TCP_AUTH_HELPER_LABEL}热更新响应requestId不匹配`);
            error.code = 'TCP_AO_RELOAD_PROTOCOL_ERROR';
            this.failClosedReload(error);
            return;
        }

        if (status?.status === 'reloaded') {
            if (
                status.profileCount !== pending.expectedProfileCount ||
                status.keyCount !== pending.expectedKeyCount ||
                !Number.isSafeInteger(status.installedKeyCount) ||
                status.installedKeyCount < status.profileCount ||
                status.installedKeyCount > status.keyCount ||
                !Number.isSafeInteger(status.disconnectedConnections) ||
                status.disconnectedConnections < 0 ||
                status.activeSocketUpdate !== 'update-or-safe-reconnect'
            ) {
                const error = new Error(`${TCP_AUTH_HELPER_LABEL}热更新确认与请求计划不一致`);
                error.code = 'TCP_AO_RELOAD_PROTOCOL_ERROR';
                this.failClosedReload(error);
                return;
            }
            this.pendingReload = null;
            clearTimeout(pending.timeout);
            pending.resolve({
                requestId,
                profileCount: status.profileCount,
                keyCount: status.keyCount,
                installedKeyCount: status.installedKeyCount,
                disconnectedConnections: status.disconnectedConnections,
                activeSocketUpdate: status.activeSocketUpdate
            });
            return;
        }

        if (status?.status !== 'error') {
            const error = new Error(`${TCP_AUTH_HELPER_LABEL}返回了未知的热更新状态`);
            error.code = 'TCP_AO_RELOAD_PROTOCOL_ERROR';
            this.failClosedReload(error);
            return;
        }

        const errorCode = String(status.code || 'TCP_AO_RELOAD_FAILED');
        const error = new Error(
            errorCode === 'RELOAD_RESTART_REQUIRED'
                ? `${this.serviceName}运行中不能修改TCP-AO对端CIDR或Profile顺序，请先停止服务后再修改`
                : status?.message || `${this.authLabel}运行时密钥热更新失败`
        );
        error.code = errorCode;
        if (!RECOVERABLE_RELOAD_ERROR_CODES.includes(errorCode)) {
            // Keep the pending request installed so failClosedReload rejects
            // that exact caller with the helper's explicit error before the
            // helper is terminated.
            this.failClosedReload(error);
            return;
        }
        this.pendingReload = null;
        clearTimeout(pending.timeout);
        pending.reject(error);
    }

    executeReload(request) {
        if (!this.child || !this.ready || this.stopping || this.child.stdin?.destroyed) {
            const error = new Error(`${TCP_AUTH_HELPER_LABEL}未运行，无法热更新密钥`);
            error.code = 'TCP_AO_RELOAD_NOT_RUNNING';
            return Promise.reject(error);
        }
        if (this.pendingReload) {
            const error = new Error(`${TCP_AUTH_HELPER_LABEL}已有热更新请求正在处理`);
            error.code = 'TCP_AO_RELOAD_BUSY';
            return Promise.reject(error);
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingReload?.requestId !== request.requestId) return;
                const error = new Error(`${this.authLabel}运行时密钥热更新在${request.timeoutMs}ms内没有响应`);
                error.code = 'TCP_AO_RELOAD_TIMEOUT';
                this.failClosedReload(error);
            }, request.timeoutMs);
            timeout.unref?.();
            this.pendingReload = { ...request, resolve, reject, timeout };
            try {
                this.child.stdin.write(request.payload, error => {
                    if (!error || this.pendingReload?.requestId !== request.requestId) return;
                    const writeError = new Error(`${this.authLabel}运行时密钥热更新写入失败: ${error.message}`);
                    writeError.code = 'TCP_AO_RELOAD_TRANSPORT_ERROR';
                    this.failClosedReload(writeError);
                });
            } catch (error) {
                const writeError = new Error(`${this.authLabel}运行时密钥热更新写入失败: ${error.message}`);
                writeError.code = 'TCP_AO_RELOAD_TRANSPORT_ERROR';
                this.failClosedReload(writeError);
            }
        });
    }

    reload(options = {}) {
        if (this.authType !== TCP_AUTH_TYPES.TCP_AO) {
            const error = new Error('只有TCP-AO运行时支持密钥热更新');
            error.code = 'TCP_AO_RELOAD_UNSUPPORTED_AUTH';
            return Promise.reject(error);
        }
        if (!this.child || !this.ready || this.stopping || !Buffer.isBuffer(this.forwardCapability)) {
            const error = new Error(`${TCP_AUTH_HELPER_LABEL}未运行，无法热更新TCP-AO密钥`);
            error.code = 'TCP_AO_RELOAD_NOT_RUNNING';
            return Promise.reject(error);
        }

        if (this.reloadRequestId >= Number.MAX_SAFE_INTEGER) this.reloadRequestId = 0;
        const requestId = ++this.reloadRequestId;
        const profiles = Array.isArray(options.profiles) ? options.profiles : [];
        const expectedProfileCount = profiles.length;
        const expectedKeyCount = profiles.reduce(
            (total, profile) => total + (Array.isArray(profile?.keys) ? profile.keys.length : 0),
            0
        );
        const config = this.buildConfig(profiles, this.forwardCapability);
        let payload;
        try {
            payload = Buffer.from(
                `${JSON.stringify({ schemaVersion: 1, command: 'reload', requestId, config })}\n`,
                'utf8'
            );
        } finally {
            clearSerializedConfig(config);
        }
        const timeoutMs = Math.max(250, Number(options.timeoutMs) || this.reloadTimeoutMs);
        const request = {
            requestId,
            payload,
            timeoutMs,
            expectedProfileCount,
            expectedKeyCount
        };
        const operation = this.reloadQueue.then(() => this.executeReload(request));
        this.reloadQueue = operation.catch(() => {});
        return operation.finally(() => payload.fill(0));
    }

    resolveHelperPath() {
        if (this.platform !== 'linux') {
            throw new Error(`${this.authLabel}认证仅支持Linux`);
        }
        const runtimeDirectory = `linux-${this.arch}`;
        const candidates = [
            this.helperPath,
            this.resourcesPath && path.join(this.resourcesPath, 'tcp-auth', runtimeDirectory, 'tcp-auth-helper'),
            path.join(this.projectRoot, 'resources', 'tcp-auth', runtimeDirectory, 'tcp-auth-helper')
        ].filter(Boolean);

        for (const candidate of candidates) {
            try {
                const stats = this.fs.lstatSync(candidate);
                if (!stats.isFile() || stats.isSymbolicLink()) continue;
                if ((stats.mode & 0o111) === 0) {
                    throw new Error(`${TCP_AUTH_HELPER_LABEL}没有执行权限: ${candidate}`);
                }
                if ((stats.mode & 0o022) !== 0) {
                    throw new Error(`${TCP_AUTH_HELPER_LABEL}不能被组用户或其他用户写入: ${candidate}`);
                }
                return candidate;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        throw new Error(`未找到${runtimeDirectory} ${TCP_AUTH_HELPER_LABEL}，请先运行 npm run tcp-auth:build`);
    }

    buildConfig(profiles, forwardCapability) {
        if (!Array.isArray(profiles) || profiles.length === 0) {
            throw new Error(`${TCP_AUTH_HELPER_LABEL}至少需要一个profile`);
        }
        if (this.authType === TCP_AUTH_TYPES.TCP_MD5) {
            return {
                schemaVersion: 3,
                authType: TCP_AUTH_TYPES.TCP_MD5,
                forwardCapability: normalizeForwardCapability(forwardCapability, this.authLabel),
                profiles: profiles.map(profile => serializeProfile(profile, this.authType))
            };
        }
        return {
            schemaVersion: 2,
            forwardCapability: normalizeForwardCapability(forwardCapability, this.authLabel),
            profiles: profiles.map(profile => serializeProfile(profile, this.authType))
        };
    }

    start(options = {}) {
        if (this.child) return Promise.reject(new Error(`${TCP_AUTH_HELPER_LABEL}已经启动`));
        const listenPort = normalizePort(options.listenPort, `${this.authLabel}监听端口`);
        const forwardSocket = normalizeForwardSocket(options.forwardSocket, this.authLabel);
        const helperPath = this.resolveHelperPath();
        const expectedProfileCount = Array.isArray(options.profiles) ? options.profiles.length : 0;
        const expectedKeyCount =
            this.authType === TCP_AUTH_TYPES.TCP_MD5
                ? expectedProfileCount
                : Array.isArray(options.profiles)
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
            // JSON.stringify also creates a temporary immutable plaintext
            // string that JavaScript cannot explicitly wipe. Clear the
            // serialized object now; the mutable stdin Buffer is wiped by
            // every completion/failure path below.
            clearSerializedConfig(config);
        }
        this.clearForwardCapability();
        this.forwardCapability = Buffer.from(options.forwardCapability);

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
            this.clearForwardCapability();
            return Promise.reject(new Error(`无法启动${TCP_AUTH_HELPER_LABEL}: ${error.message}`));
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
                fail(new Error(`${TCP_AUTH_HELPER_LABEL}在${this.readyTimeoutMs}ms内没有就绪`));
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
                this.clearForwardCapability();
                const reloadExitError = new Error(`${TCP_AUTH_HELPER_LABEL}在运行时密钥热更新期间退出`);
                reloadExitError.code = 'TCP_AO_RELOAD_HELPER_EXIT';
                this.rejectPendingReload(reloadExitError);
                this.resolveExit?.({ code, signal });
                this.resolveExit = null;
                if (!settled) {
                    fail(
                        new Error(`${TCP_AUTH_HELPER_LABEL}启动前退出（code=${code ?? '-'}, signal=${signal || '-'}）`)
                    );
                    return;
                }
                if (!this.stopping) {
                    const detail = diagnostic.trim();
                    const suffix = detail ? `: ${detail}` : '';
                    const error = new Error(
                        `${TCP_AUTH_HELPER_LABEL}异常退出（code=${code ?? '-'}, signal=${signal || '-'}）${suffix}`
                    );
                    error.code =
                        this.authType === TCP_AUTH_TYPES.TCP_MD5 ? 'TCP_MD5_HELPER_EXIT' : 'TCP_AO_HELPER_EXIT';
                    error.runtimeFailure = runtimeFailureForHelperExit(code, this.serviceName, this.authType);
                    this.emit('unexpectedExit', error);
                }
            };
            const handleStatusLine = line => {
                let status;
                try {
                    status = JSON.parse(line);
                } catch (_error) {
                    if (!settled) {
                        fail(new Error(`${TCP_AUTH_HELPER_LABEL}返回了无效的启动状态`));
                    } else {
                        const error = new Error(`${TCP_AUTH_HELPER_LABEL}返回了无效的热更新状态`);
                        error.code = 'TCP_AO_RELOAD_PROTOCOL_ERROR';
                        this.failClosedReload(error);
                    }
                    return;
                }
                if (settled) {
                    this.handleReloadStatus(status);
                    return;
                }
                if (status?.status === 'error') {
                    const error = new Error(status.message || `${TCP_AUTH_HELPER_LABEL}启动失败`);
                    error.code =
                        status.code ||
                        (this.authType === TCP_AUTH_TYPES.TCP_MD5 ? 'TCP_MD5_HELPER_ERROR' : 'TCP_AO_HELPER_ERROR');
                    fail(error);
                    return;
                }
                const authenticationConfirmed =
                    this.authType === TCP_AUTH_TYPES.TCP_MD5
                        ? status?.authentication === TCP_AUTH_TYPES.TCP_MD5 && status.md5Configured === true
                        : status?.aoRequired === true;
                if (
                    status?.status !== 'ready' ||
                    !authenticationConfirmed ||
                    status.listenPort !== listenPort ||
                    status.forwardTransport !== 'unix' ||
                    status.peerHeaderVersion !== TCP_AUTH_FORWARD_VERSION ||
                    status.peerHeaderBytes !== TCP_AUTH_FORWARD_HEADER_BYTES ||
                    status.profileCount !== expectedProfileCount ||
                    status.keyCount !== expectedKeyCount ||
                    (this.authType === TCP_AUTH_TYPES.TCP_MD5 && status.installedKeyCount !== expectedKeyCount) ||
                    !Array.isArray(status.families) ||
                    JSON.stringify([...status.families].sort()) !== JSON.stringify(expectedFamilies)
                ) {
                    fail(
                        new Error(
                            this.authType === TCP_AUTH_TYPES.TCP_MD5
                                ? `${TCP_AUTH_HELPER_LABEL}未确认TCP MD5认证状态`
                                : `${TCP_AUTH_HELPER_LABEL}未确认TCP-AO强制认证状态`
                        )
                    );
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
                fail(new Error(`无法启动${TCP_AUTH_HELPER_LABEL}: ${error.message}`));
                if (settled) {
                    const reloadError = new Error(`${TCP_AUTH_HELPER_LABEL}通信失败: ${error.message}`);
                    reloadError.code = 'TCP_AO_RELOAD_TRANSPORT_ERROR';
                    this.failClosedReload(reloadError);
                }
                // A failed spawn emits error + close, but no exit. Finalize immediately so
                // the worker cleanup path cannot wait forever for an exit event that will not occur.
                if (!Number.isInteger(child.pid)) finalizeExit(null, null);
            });
            child.stdout.on('data', chunk => {
                output += chunk.toString('utf8');
                if (Buffer.byteLength(output, 'utf8') > MAX_STATUS_OUTPUT_BYTES) {
                    if (!settled) {
                        fail(new Error(`${TCP_AUTH_HELPER_LABEL}启动状态输出过大`));
                    } else {
                        output = '';
                        const error = new Error(`${TCP_AUTH_HELPER_LABEL}热更新状态输出过大`);
                        error.code = 'TCP_AO_RELOAD_PROTOCOL_ERROR';
                        this.failClosedReload(error);
                    }
                    return;
                }
                let newline = output.indexOf('\n');
                while (newline !== -1) {
                    const line = output.slice(0, newline).trim();
                    output = output.slice(newline + 1);
                    if (line) handleStatusLine(line);
                    newline = output.indexOf('\n');
                }
            });
            child.stderr.on('data', chunk => {
                if (diagnostic.length < MAX_STATUS_OUTPUT_BYTES) diagnostic += chunk.toString('utf8');
            });
            child.once('exit', finalizeExit);
            // `close` is the only terminal event guaranteed after a spawn failure.
            child.once('close', finalizeExit);

            child.stdin.once('error', error => {
                wipePayload();
                if (!settled) {
                    fail(new Error(`写入${TCP_AUTH_HELPER_LABEL}配置失败: ${error.message}`));
                } else {
                    const reloadError = new Error(`${TCP_AUTH_HELPER_LABEL}通信失败: ${error.message}`);
                    reloadError.code = 'TCP_AO_RELOAD_TRANSPORT_ERROR';
                    this.failClosedReload(reloadError);
                }
            });
            try {
                child.stdin.write(secretPayload, error => {
                    wipePayload();
                    if (!error) return;
                    fail(new Error(`写入${TCP_AUTH_HELPER_LABEL}配置失败: ${error.message}`));
                });
            } catch (error) {
                wipePayload();
                fail(new Error(`写入${TCP_AUTH_HELPER_LABEL}配置失败: ${error.message}`));
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
        this.clearForwardCapability();
    }
}

module.exports = TcpAuthProxy;
module.exports.serializeProfile = serializeProfile;
module.exports.TCP_AO_HELPER_EXIT_CODES = TCP_AO_HELPER_EXIT_CODES;
module.exports.TCP_AUTH_TYPES = TCP_AUTH_TYPES;
module.exports.MAX_TCP_MD5_KEY_BYTES = MAX_TCP_MD5_KEY_BYTES;
module.exports.runtimeFailureForHelperExit = runtimeFailureForHelperExit;
