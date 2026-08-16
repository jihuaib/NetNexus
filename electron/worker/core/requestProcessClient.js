const { EventEmitter } = require('node:events');
const ProtocolProcessHost = require('./protocolProcessHost');
const WorkerWithPromise = require('./workerWithPromise');

class RequestProcessClient extends EventEmitter {
    constructor(processPath, options = {}) {
        super();
        this.processPath = processPath;
        this.options = options;
        this.defaultTimeoutMs = Math.max(0, Number(options.defaultTimeoutMs) || 30000);
        this.process = null;
        this.pending = new Map();
        this.closed = false;
        this.exited = false;
        this.terminationPromise = null;
    }

    createTerminatedError() {
        const error = new Error('Protocol process client is closed');
        error.code = 'WORKER_TERMINATED';
        return error;
    }

    createExitedError() {
        const error = new Error('Protocol process client has exited');
        error.code = 'WORKER_EXIT';
        return error;
    }

    start() {
        if (this.process) return this;
        if (this.closed) throw this.createTerminatedError();
        if (this.exited) throw this.createExitedError();
        const processHost = new ProtocolProcessHost(this.processPath, this.options);
        this.process = processHost;
        processHost.on('message', message => this.handleMessage(message));
        processHost.on('error', error => this.failAll(error));
        processHost.on('exit', code => {
            const error = new Error(`Protocol process stopped with exit code ${code}`);
            error.code = 'WORKER_EXIT';
            this.exited = true;
            if (this.process === processHost) this.process = null;
            if (!this.closed || code !== 0) this.failAll(error);
            this.emit('exit', code);
        });
        return this;
    }

    handleMessage(message = {}) {
        if (message.eventName) {
            this.emit('event', message.eventName, message.data);
            this.emit(message.eventName, message.data);
            return;
        }
        const entry = this.pending.get(message.messageId);
        if (!entry) return;
        this.pending.delete(message.messageId);
        entry.cleanup();
        if (message.status === 'success') entry.resolve(message);
        else {
            const error = new Error(message.msg || 'Protocol process execution failed');
            error.code = message.code || 'WORKER_REQUEST_FAILED';
            error.data = message.data;
            entry.reject(error);
        }
    }

    sendRequest(op, data = null, options = {}) {
        if (this.closed) return Promise.reject(this.createTerminatedError());
        if (this.exited) return Promise.reject(this.createExitedError());
        if (options.signal?.aborted) {
            const error = new Error(`Protocol process request cancelled: ${op}`);
            error.code = 'WORKER_CANCELLED';
            return Promise.reject(error);
        }
        if (!this.process) this.start();

        const request = WorkerWithPromise.createRequest(op, data);
        const timeoutMs =
            options.timeoutMs === undefined ? this.defaultTimeoutMs : Math.max(0, Number(options.timeoutMs));
        return new Promise((resolve, reject) => {
            let timeout = null;
            let abortHandler = null;
            const cleanup = () => {
                if (timeout) clearTimeout(timeout);
                if (abortHandler && options.signal) options.signal.removeEventListener('abort', abortHandler);
            };
            const rejectAndCancel = error => {
                if (!this.pending.delete(request.messageId)) return;
                cleanup();
                reject(error);
                try {
                    this.process?.postMessage({ op: '__cancel__', data: { messageId: request.messageId } });
                } catch (_error) {
                    // The process may have exited while the request was being cancelled.
                }
            };

            if (timeoutMs > 0) {
                timeout = setTimeout(() => {
                    const error = new Error(`Protocol process request timed out after ${timeoutMs}ms: ${op}`);
                    error.code = 'WORKER_TIMEOUT';
                    rejectAndCancel(error);
                }, timeoutMs);
            }
            if (options.signal) {
                abortHandler = () => {
                    const error = new Error(`Protocol process request cancelled: ${op}`);
                    error.code = 'WORKER_CANCELLED';
                    rejectAndCancel(error);
                };
                options.signal.addEventListener('abort', abortHandler, { once: true });
            }

            this.pending.set(request.messageId, { resolve, reject, cleanup });
            try {
                this.process.postMessage(request);
            } catch (error) {
                this.pending.delete(request.messageId);
                cleanup();
                reject(error);
            }
        });
    }

    failAll(error) {
        for (const entry of this.pending.values()) {
            entry.cleanup();
            entry.reject(error);
        }
        this.pending.clear();
    }

    async terminate() {
        if (this.terminationPromise) return this.terminationPromise;
        this.closed = true;
        const error = new Error('Protocol process client terminated');
        error.code = 'WORKER_TERMINATED';
        this.failAll(error);
        const processHost = this.process;
        this.terminationPromise = Promise.resolve(processHost?.terminate())
            .then(() => {
                if (this.process === processHost) this.process = null;
            })
            .catch(terminateError => {
                this.terminationPromise = null;
                throw terminateError;
            });
        return this.terminationPromise;
    }
}

module.exports = RequestProcessClient;
