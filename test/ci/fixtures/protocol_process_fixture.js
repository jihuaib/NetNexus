const { isMainThread, threadId } = require('node:worker_threads');
const logger = require('../../../electron/log/logger');
const WorkerMessageHandler = require('../../../electron/worker/core/workerMessageHandler');

const messageHandler = new WorkerMessageHandler();
messageHandler.init();

messageHandler.registerHandler('echo', (messageId, data) => {
    messageHandler.sendSuccessResponse(messageId, data);
});

messageHandler.registerHandler('runtime', messageId => {
    messageHandler.sendSuccessResponse(messageId, {
        pid: process.pid,
        isMainThread,
        threadId,
        serviceName: process.env.NETNEXUS_PROTOCOL_SERVICE || ''
    });
});

messageHandler.registerHandler('emit', (messageId, data) => {
    messageHandler.sendEvent('fixture:event', data);
    messageHandler.sendSuccessResponse(messageId, true);
});

messageHandler.registerHandler('delay', (messageId, data) => {
    setTimeout(() => messageHandler.sendSuccessResponse(messageId, data), Number(data?.delayMs) || 50);
});

messageHandler.registerHandler('fail', messageId => {
    messageHandler.sendErrorResponse(messageId, 'fixture failure', { reason: 'expected' });
});

messageHandler.registerHandler('log-output', async (messageId, data) => {
    logger.raw().transports.file.resolvePathFn = () => data.runtimePath;
    logger.setLevel(data.level);
    for (const level of ['debug', 'info', 'warn', 'error']) {
        logger[level](`${data.marker}-ordinary-${level}`);
    }
    await Promise.all([
        new Promise(resolve => process.stdout.write(`${data.marker}-stdout\n  ${data.marker}-indented\n`, resolve)),
        new Promise(resolve => process.stderr.write(`${data.marker}-stderr\n`, resolve))
    ]);
    messageHandler.sendSuccessResponse(messageId, {
        consoleLevel: logger.raw().transports.console?.level,
        ipcLevel: logger.raw().transports.ipc?.level
    });
});

messageHandler.registerHandler('exit', (_messageId, data) => {
    process.exit(Number(data?.code) || 23);
});
