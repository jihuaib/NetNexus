const { isMainThread, threadId } = require('node:worker_threads');
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

messageHandler.registerHandler('exit', (_messageId, data) => {
    process.exit(Number(data?.code) || 23);
});
