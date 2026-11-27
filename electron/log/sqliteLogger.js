const path = require('path');
const { isMainThread, threadId } = require('worker_threads');
const logger = require('./logger');

let sqliteLogger = null;

function getSqliteLogger() {
    if (sqliteLogger) return sqliteLogger;

    const runtimeLogger = logger.raw();
    const runtimeLogPath = runtimeLogger.transports.file.getFile().path;
    const source = path.parse(runtimeLogPath).name;
    const thread = isMainThread ? 'main' : `worker-${threadId}`;
    const logPath = path.join(path.dirname(runtimeLogPath), 'sqlite', `${source}-${thread}.log`);
    const dedicatedLogger = runtimeLogger.create({ logId: 'sqlite', errorHandler: null, eventLogger: null });

    // SQL traces belong only in their own file, including in development mode
    // where electron-log can forward messages to renderer consoles over IPC.
    Object.values(dedicatedLogger.transports).forEach(transport => {
        if (transport) transport.level = false;
    });
    Object.assign(dedicatedLogger.transports.file, {
        level: 'debug',
        maxSize: 5 * 1024 * 1024,
        format: runtimeLogger.transports.file.format,
        resolvePathFn: () => logPath
    });
    sqliteLogger = dedicatedLogger;
    return sqliteLogger;
}

function logSqlTrace(message) {
    if (!logger.shouldLog('debug')) return;
    getSqliteLogger().debug(logger.getThreadTag(), message);
}

module.exports = { logSqlTrace };
