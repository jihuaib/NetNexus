const path = require('path');
const logger = require('./logger');

const outputLoggers = new Map();

function writeProtocolOutput(serviceName, level, message) {
    if (!logger.shouldLog(level)) return;

    const suffix = String(serviceName || 'unknown')
        .replace(/^netnexus\.protocol\./, '')
        .replace(/[^a-z0-9_-]+/gi, '-')
        .toLowerCase();
    let outputLogger = outputLoggers.get(suffix);
    if (!outputLogger) {
        const runtimeLogger = logger.raw();
        const runtimeLogPath = runtimeLogger.transports.file.getFile().path;
        const logPath = path.join(path.dirname(runtimeLogPath), `protocol-${suffix}-output.log`);
        outputLogger = runtimeLogger.create({
            logId: `protocol-output-${suffix}`,
            errorHandler: null,
            eventLogger: null
        });
        Object.values(outputLogger.transports).forEach(transport => {
            if (transport) transport.level = false;
        });
        Object.assign(outputLogger.transports.file, {
            level: 'debug',
            maxSize: 5 * 1024 * 1024,
            format: runtimeLogger.transports.file.format,
            resolvePathFn: () => logPath
        });
        outputLoggers.set(suffix, outputLogger);
    }

    outputLogger[level](`[${serviceName}]`, message);
}

module.exports = { writeProtocolOutput };
