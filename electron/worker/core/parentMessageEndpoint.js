const { parentPort: workerThreadParentPort } = require('node:worker_threads');
const {
    PROTOCOL_PROCESS_IPC_CODEC,
    PROTOCOL_PROCESS_IPC_CODEC_ENV,
    encodeProtocolProcessMessage,
    decodeProtocolProcessMessage
} = require('./protocolProcessSerialization');

function createWorkerThreadEndpoint() {
    if (!workerThreadParentPort) {
        return null;
    }

    return {
        kind: 'worker-thread',
        on(eventName, listener) {
            workerThreadParentPort.on(eventName, listener);
            return this;
        },
        postMessage(message) {
            workerThreadParentPort.postMessage(message);
        }
    };
}

function createUtilityProcessEndpoint() {
    const utilityParentPort = process.parentPort;
    if (!utilityParentPort || typeof utilityParentPort.on !== 'function') {
        return null;
    }

    return {
        kind: 'utility-process',
        on(eventName, listener) {
            if (eventName !== 'message') {
                utilityParentPort.on(eventName, listener);
                return this;
            }

            // Electron utility-process messages arrive as MessageEvent objects.
            utilityParentPort.on('message', event => listener(event.data));
            return this;
        },
        postMessage(message) {
            utilityParentPort.postMessage(message);
        }
    };
}

function createChildProcessEndpoint() {
    if (typeof process.send !== 'function') {
        return null;
    }

    const jsonIpc = process.env[PROTOCOL_PROCESS_IPC_CODEC_ENV] === PROTOCOL_PROCESS_IPC_CODEC;

    return {
        kind: 'child-process',
        on(eventName, listener) {
            if (eventName === 'message' && jsonIpc) {
                process.on(eventName, message => listener(decodeProtocolProcessMessage(message)));
            } else {
                process.on(eventName, listener);
            }
            return this;
        },
        postMessage(message) {
            if (!process.connected) {
                throw new Error('Parent process IPC channel is closed');
            }
            process.send(jsonIpc ? encodeProtocolProcessMessage(message) : message);
        }
    };
}

function getParentMessageEndpoint() {
    return createWorkerThreadEndpoint() || createUtilityProcessEndpoint() || createChildProcessEndpoint();
}

module.exports = {
    getParentMessageEndpoint
};
