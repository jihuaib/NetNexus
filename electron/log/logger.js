const log = require('electron-log');
const path = require('path');

let isMainThread = true;
let threadId = 0;

// 尝试引入 worker_threads（如在主线程没关系）
try {
    const { isMainThread: imt, threadId: tid } = require('worker_threads');
    isMainThread = imt;
    threadId = tid;
} catch (err) {
    // 忽略错误，说明不在 worker 环境中
}

// 配置 electron-log
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.maxFiles = 3; // 最多保留3个日志文件
const protocolServiceName = process.env.NETNEXUS_PROTOCOL_SERVICE;
if (protocolServiceName) {
    const logSuffix = protocolServiceName
        .replace(/^netnexus\.protocol\./, '')
        .replace(/[^a-z0-9_-]+/gi, '-')
        .toLowerCase();
    log.transports.file.fileName = `protocol-${logSuffix || process.pid}.log`;
}
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
log.transports.file.level = false;
if (log.transports.console) {
    log.transports.console.level = false;
}

const LOG_LEVEL_OFF = 'off';
const LOG_LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};

class Logger {
    constructor() {
        this.logger = log;
        this.logLevel = LOG_LEVEL_OFF;
    }

    normalizeLevel(level) {
        return Object.prototype.hasOwnProperty.call(LOG_LEVELS, level) ? level : LOG_LEVEL_OFF;
    }

    setLevel(level) {
        this.logLevel = this.normalizeLevel(level);
        const transportLevel = this.logLevel === LOG_LEVEL_OFF ? false : this.logLevel;
        if (this.logger.transports.file) {
            this.logger.transports.file.level = transportLevel;
        }
        if (this.logger.transports.console) {
            this.logger.transports.console.level = transportLevel;
        }
    }

    shouldLog(level) {
        if (this.logLevel === LOG_LEVEL_OFF) {
            return false;
        }
        return LOG_LEVELS[level] >= LOG_LEVELS[this.logLevel];
    }

    // 获取调用函数、文件、行号
    getCallerInfo(depth = 3) {
        const stack = new Error().stack.split('\n');
        const line = stack[depth] || stack[3]; // 默认跳过3层
        const fileMatch = line.match(/\(?(.+):(\d+):(\d+)\)?$/);
        const funcMatch = line.match(/at (.+?) \(/);

        return {
            file: fileMatch ? path.basename(fileMatch[1]) : 'unknown',
            line: fileMatch ? fileMatch[2] : '0',
            func: funcMatch ? funcMatch[1] : 'anonymous'
        };
    }

    // 获取线程标识
    getThreadTag() {
        if (process.parentPort || typeof process.send === 'function') {
            const serviceName = process.env.NETNEXUS_PROTOCOL_SERVICE;
            return serviceName ? `[Process-${process.pid}:${serviceName}]` : `[Process-${process.pid}]`;
        }
        return isMainThread ? '[Main]' : `[Worker-${threadId}]`;
    }

    // 构造日志前缀
    buildPrefix() {
        const { file, line, func } = this.getCallerInfo(4);
        return `${this.getThreadTag()} ${func} (${file}:${line})`;
    }

    // 日志接口
    info(...args) {
        if (!this.shouldLog('info')) return;
        this.logger.info(this.buildPrefix(), ...args);
    }

    warn(...args) {
        if (!this.shouldLog('warn')) return;
        this.logger.warn(this.buildPrefix(), ...args);
    }

    error(...args) {
        if (!this.shouldLog('error')) return;
        this.logger.error(this.buildPrefix(), ...args);
    }

    debug(...args) {
        if (!this.shouldLog('debug')) return;
        this.logger.debug(this.buildPrefix(), ...args);
    }

    // 暴露原始 electron-log
    raw() {
        return this.logger;
    }
}

// Create logger instance
const loggerInstance = new Logger();

module.exports = loggerInstance;
