const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const WorkerWithPromise = require('./workerWithPromise');

class RequestWorkerClient extends EventEmitter {
    constructor(workerPath, options = {}) {
        super();
        this.workerPath = workerPath;
        this.workerData = options.workerData;
        this.defaultTimeoutMs = Math.max(0, Number(options.defaultTimeoutMs) || 30000);
        this.worker = null;
        this.pending = new Map();
        this.closed = false;
    }

    start() {
        if (this.worker) return this;
        this.closed = false;
        this.worker = new Worker(this.workerPath, { workerData: this.workerData });
        this.worker.on('message', message => this.handleMessage(message));
        this.worker.on('error', error => this.failAll(error));
        this.worker.on('exit', code => {
            const error = new Error(`Worker stopped with exit code ${code}`);
            error.code = 'WORKER_EXIT';
            this.worker = null;
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
            const error = new Error(message.msg || 'Worker execution failed');
            error.code = message.code || 'WORKER_REQUEST_FAILED';
            error.data = message.data;
            entry.reject(error);
        }
    }

    sendRequest(op, data = null, options = {}) {
        if (!this.worker) this.start();
        if (this.closed) return Promise.reject(new Error('Worker client is closed'));

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
                this.worker?.postMessage({ op: '__cancel__', data: { messageId: request.messageId } });
            };

            if (timeoutMs > 0) {
                timeout = setTimeout(() => {
                    const error = new Error(`Worker request timed out after ${timeoutMs}ms: ${op}`);
                    error.code = 'WORKER_TIMEOUT';
                    rejectAndCancel(error);
                }, timeoutMs);
            }
            if (options.signal) {
                abortHandler = () => {
                    const error = new Error(`Worker request cancelled: ${op}`);
                    error.code = 'WORKER_CANCELLED';
                    rejectAndCancel(error);
                };
                if (options.signal.aborted) {
                    const error = new Error(`Worker request cancelled: ${op}`);
                    error.code = 'WORKER_CANCELLED';
                    cleanup();
                    reject(error);
                    return;
                }
                options.signal.addEventListener('abort', abortHandler, { once: true });
            }

            this.pending.set(request.messageId, { resolve, reject, cleanup });
            this.worker.postMessage(request);
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
        this.closed = true;
        const error = new Error('Worker client terminated');
        error.code = 'WORKER_TERMINATED';
        this.failAll(error);
        const worker = this.worker;
        this.worker = null;
        if (worker) await worker.terminate();
    }
}

module.exports = RequestWorkerClient;
