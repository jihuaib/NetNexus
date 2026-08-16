const { parentPort: workerThreadParentPort } = require('node:worker_threads');

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

    return {
        kind: 'child-process',
        on(eventName, listener) {
            process.on(eventName, listener);
            return this;
        },
        postMessage(message) {
            if (!process.connected) {
                throw new Error('Parent process IPC channel is closed');
            }
            process.send(message);
        }
    };
}

function getParentMessageEndpoint() {
    return createWorkerThreadEndpoint() || createUtilityProcessEndpoint() || createChildProcessEndpoint();
}

module.exports = {
    getParentMessageEndpoint
};
