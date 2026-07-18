const { parentPort } = require('worker_threads');

parentPort.on('message', message => {
    if (message.op === '__cancel__') return;
    if (message.op === 'emit') {
        parentPort.postMessage({ eventName: 'fixture:event', data: message.data });
        parentPort.postMessage({ messageId: message.messageId, status: 'success', data: true });
        return;
    }
    if (message.op === 'delay') {
        setTimeout(
            () => {
                parentPort.postMessage({ messageId: message.messageId, status: 'success', data: message.data });
            },
            Number(message.data?.delayMs) || 50
        );
        return;
    }
    if (message.op === 'fail') {
        parentPort.postMessage({ messageId: message.messageId, status: 'error', msg: 'fixture failure' });
        return;
    }
    parentPort.postMessage({ messageId: message.messageId, status: 'success', data: message.data });
});
