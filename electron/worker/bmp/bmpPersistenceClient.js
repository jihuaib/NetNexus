const path = require('path');
const { Worker } = require('worker_threads');
const { BMP_PERSISTENCE_OP } = require('./bmpPersistenceConst');

const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_BATCH_BYTES = 2 * 1024 * 1024;
const DEFAULT_FLUSH_MS = 20;
const DEFAULT_HIGH_WATERMARK_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOW_WATERMARK_BYTES = 32 * 1024 * 1024;
const DEFAULT_BATCH_RETRY_LIMIT = 3;
const DEFAULT_BATCH_RETRY_DELAY_MS = 25;

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

class BmpPersistenceClient {
    constructor(options = {}) {
        this.dbPath = options.dbPath;
        this.readOnly = options.readOnly === true;
        this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
        this.batchBytes = positiveInteger(options.batchBytes, DEFAULT_BATCH_BYTES);
        this.flushMs = positiveInteger(options.flushMs, DEFAULT_FLUSH_MS);
        this.highWatermarkBytes = positiveInteger(options.highWatermarkBytes, DEFAULT_HIGH_WATERMARK_BYTES);
        this.lowWatermarkBytes = Math.min(
            positiveInteger(options.lowWatermarkBytes, DEFAULT_LOW_WATERMARK_BYTES),
            this.highWatermarkBytes
        );
        this.batchRetryLimit = positiveInteger(options.batchRetryLimit, DEFAULT_BATCH_RETRY_LIMIT);
        this.batchRetryDelayMs = positiveInteger(options.batchRetryDelayMs, DEFAULT_BATCH_RETRY_DELAY_MS);
        this.onPause = typeof options.onPause === 'function' ? options.onPause : null;
        this.onResume = typeof options.onResume === 'function' ? options.onResume : null;
        this.onError = typeof options.onError === 'function' ? options.onError : null;

        this.worker = null;
        this.workerAlive = false;
        this.callbacks = new Map();
        this.queue = [];
        this.queueHead = 0;
        this.queueBytes = 0;
        this.inFlightBytes = 0;
        this.inFlight = null;
        this.flushTimer = null;
        this.retryTimer = null;
        this.batchSequence = 0;
        this.mutationSequence = 0;
        this.committedMutationSequence = 0;
        this.requestSequence = 0;
        this.paused = false;
        this.closing = false;
        this.failure = null;
        this.closePromise = null;
        this.idleWaiters = [];
        this.fenceWaiters = [];
    }

    async open() {
        if (this.worker) {
            return this.getStatus();
        }
        if (!this.dbPath) {
            throw new Error('BMP persistence dbPath is required');
        }

        const workerPath = path.join(__dirname, 'bmpPersistenceWorker.js');
        this.worker = new Worker(workerPath);
        this.workerAlive = true;
        this.worker.on('message', message => this.handleMessage(message));
        this.worker.on('error', error => {
            this.workerAlive = false;
            this.handleWorkerFailure(error);
        });
        this.worker.on('exit', code => {
            this.workerAlive = false;
            if (!this.closing) {
                this.handleWorkerFailure(new Error(`BMP persistence worker exited with code ${code}`));
            } else {
                const error = this.failure || new Error(`BMP persistence worker exited during close with code ${code}`);
                this.rejectCallbacks(error);
                this.rejectIdleWaiters(error);
                this.rejectFenceWaiters(error);
            }
        });

        return this.sendRequest(BMP_PERSISTENCE_OP.OPEN, {
            dbPath: this.dbPath,
            readOnly: this.readOnly
        });
    }

    makeRequestId() {
        this.requestSequence += 1;
        return `bmp-store-${process.pid}-${Date.now()}-${this.requestSequence}`;
    }

    sendRequest(op, data = null, options = {}) {
        if (!this.worker) {
            return Promise.reject(new Error('BMP persistence worker is not running'));
        }
        if (!this.workerAlive) {
            return Promise.reject(this.failure || new Error('BMP persistence worker is not alive'));
        }
        if (this.closing && options.allowDuringClosing !== true) {
            return Promise.reject(new Error('BMP persistence client is closing'));
        }
        if (this.failure && options.allowAfterFailure !== true) {
            return Promise.reject(this.failure);
        }
        const messageId = this.makeRequestId();
        return new Promise((resolve, reject) => {
            this.callbacks.set(messageId, { resolve, reject });
            try {
                this.worker.postMessage({ messageId, op, data });
            } catch (error) {
                this.callbacks.delete(messageId);
                reject(error);
            }
        });
    }

    handleMessage(message) {
        const callback = this.callbacks.get(message?.messageId);
        if (!callback) {
            return;
        }
        this.callbacks.delete(message.messageId);
        if (message.status === 'success') {
            callback.resolve(message.data);
        } else {
            const error = new Error(message.msg || 'BMP persistence worker request failed');
            error.code = message.data?.code;
            callback.reject(error);
        }
    }

    handleWorkerFailure(error) {
        if (this.failure) {
            return;
        }
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.callbacks.forEach(callback => callback.reject(this.failure));
        this.callbacks.clear();
        this.rejectIdleWaiters(this.failure);
        this.rejectFenceWaiters(this.failure);
        if (this.onError) {
            this.onError(this.failure);
        }
    }

    rejectCallbacks(error) {
        this.callbacks.forEach(callback => callback.reject(error));
        this.callbacks.clear();
    }

    estimateMutationBytes(mutation) {
        return Buffer.byteLength(JSON.stringify(mutation), 'utf8');
    }

    enqueue(mutation) {
        if (this.readOnly) {
            throw new Error('Cannot enqueue writes on a read-only BMP persistence client');
        }
        if (!this.worker || this.closing) {
            throw new Error('BMP persistence client is not accepting writes');
        }
        if (this.failure) {
            throw this.failure;
        }

        const bytes = this.estimateMutationBytes(mutation);
        this.mutationSequence += 1;
        this.queue.push({ mutation, bytes, sequence: this.mutationSequence });
        this.queueBytes += bytes;
        this.updateBackpressure();

        if (this.getQueueLength() >= this.batchSize || this.queueBytes >= this.batchBytes) {
            this.scheduleFlush(0);
        } else {
            this.scheduleFlush(this.flushMs);
        }
    }

    scheduleFlush(delay) {
        if (this.flushTimer || this.inFlight || this.failure) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushNextBatch();
        }, delay);
    }

    takeBatch() {
        const entries = [];
        let bytes = 0;
        while (this.getQueueLength() > 0 && entries.length < this.batchSize) {
            const next = this.queue[this.queueHead];
            if (entries.length > 0 && bytes + next.bytes > this.batchBytes) {
                break;
            }
            this.queueHead += 1;
            this.queueBytes -= next.bytes;
            entries.push(next);
            bytes += next.bytes;
        }
        if (this.queueHead > 10000 && this.queueHead * 2 >= this.queue.length) {
            this.queue = this.queue.slice(this.queueHead);
            this.queueHead = 0;
        }
        return { entries, bytes };
    }

    getQueueLength() {
        return this.queue.length - this.queueHead;
    }

    makeBatch(entries) {
        this.batchSequence += 1;
        return {
            batchId: `bmp-${process.pid}-${Date.now()}-${this.batchSequence}`,
            createdAtMs: Date.now(),
            mutations: entries.map(entry => entry.mutation)
        };
    }

    flushNextBatch() {
        if (this.inFlight || this.getQueueLength() === 0 || this.failure) {
            this.resolveIdleWaitersIfReady();
            return;
        }

        const { entries, bytes } = this.takeBatch();
        const batch = this.makeBatch(entries);
        this.inFlightBytes = bytes;
        this.inFlight = { entries, bytes, batch };
        this.updateBackpressure();

        this.sendInFlightBatch();
    }

    sendInFlightBatch() {
        const pending = this.inFlight;
        if (!pending || this.failure) {
            return;
        }
        pending.attempts = (pending.attempts || 0) + 1;

        this.sendRequest(BMP_PERSISTENCE_OP.APPLY_BATCH, pending.batch, { allowDuringClosing: true })
            .then(() => {
                if (this.inFlight !== pending) {
                    return;
                }
                const lastEntry = pending.entries[pending.entries.length - 1];
                if (lastEntry) {
                    this.committedMutationSequence = Math.max(this.committedMutationSequence, lastEntry.sequence);
                }
                this.inFlight = null;
                this.inFlightBytes = 0;
                this.updateBackpressure();
                if (this.getQueueLength() > 0) {
                    this.scheduleFlush(0);
                }
                this.resolveIdleWaitersIfReady();
                this.resolveFenceWaiters();
            })
            .catch(error => {
                if (this.inFlight !== pending) {
                    return;
                }
                if (pending.attempts <= this.batchRetryLimit && this.worker && !this.failure) {
                    const retryDelay = this.batchRetryDelayMs * 2 ** (pending.attempts - 1);
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = null;
                        this.sendInFlightBatch();
                    }, retryDelay);
                    return;
                }
                const failedBatch = pending;
                this.inFlight = null;
                this.inFlightBytes = 0;
                if (failedBatch) {
                    this.queue = [...failedBatch.entries, ...this.queue.slice(this.queueHead)];
                    this.queueHead = 0;
                    this.queueBytes += failedBatch.bytes;
                }
                this.handleWorkerFailure(error);
                this.updateBackpressure();
            });
    }

    updateBackpressure() {
        const bufferedBytes = this.queueBytes + this.inFlightBytes;
        if (!this.paused && bufferedBytes >= this.highWatermarkBytes) {
            this.paused = true;
            if (this.onPause) {
                this.onPause(bufferedBytes);
            }
            return;
        }
        if (this.paused && !this.failure && bufferedBytes <= this.lowWatermarkBytes) {
            this.paused = false;
            if (this.onResume) {
                this.onResume(bufferedBytes);
            }
        }
    }

    getWatermark() {
        return {
            queueLength: this.getQueueLength(),
            queueBytes: this.queueBytes,
            inFlightBytes: this.inFlightBytes,
            bufferedBytes: this.queueBytes + this.inFlightBytes,
            paused: this.paused,
            failed: Boolean(this.failure)
        };
    }

    drain() {
        if (this.failure) {
            return Promise.reject(this.failure);
        }
        if (!this.inFlight && this.getQueueLength() === 0) {
            return Promise.resolve();
        }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.flushNextBatch();
        return new Promise((resolve, reject) => {
            this.idleWaiters.push({ resolve, reject });
        });
    }

    resolveIdleWaitersIfReady() {
        if (this.inFlight || this.getQueueLength() > 0) {
            return;
        }
        const waiters = this.idleWaiters.splice(0);
        waiters.forEach(waiter => waiter.resolve());
    }

    rejectIdleWaiters(error) {
        const waiters = this.idleWaiters.splice(0);
        waiters.forEach(waiter => waiter.reject(error));
    }

    fence() {
        if (this.readOnly) {
            return Promise.resolve();
        }
        if (this.failure) {
            return Promise.reject(this.failure);
        }
        const target = this.mutationSequence;
        if (this.committedMutationSequence >= target) {
            return Promise.resolve();
        }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.flushNextBatch();
        return new Promise((resolve, reject) => {
            this.fenceWaiters.push({ target, resolve, reject });
        });
    }

    resolveFenceWaiters() {
        const pending = [];
        this.fenceWaiters.forEach(waiter => {
            if (this.committedMutationSequence >= waiter.target) {
                waiter.resolve();
            } else {
                pending.push(waiter);
            }
        });
        this.fenceWaiters = pending;
    }

    rejectFenceWaiters(error) {
        const waiters = this.fenceWaiters.splice(0);
        waiters.forEach(waiter => waiter.reject(error));
    }

    queryRoutes(query = {}) {
        return this.sendRequest(BMP_PERSISTENCE_OP.QUERY_ROUTES, query);
    }

    queryEvents(query = {}) {
        return this.sendRequest(BMP_PERSISTENCE_OP.QUERY_EVENTS, query);
    }

    getStatus(options = {}) {
        return this.sendRequest(BMP_PERSISTENCE_OP.GET_STATUS, options);
    }

    sweep(options = {}) {
        return this.sendRequest(BMP_PERSISTENCE_OP.SWEEP, options);
    }

    checkpoint(mode = 'PASSIVE') {
        return this.sendRequest(BMP_PERSISTENCE_OP.CHECKPOINT, { mode });
    }

    close(options = {}) {
        if (this.closePromise) {
            return this.closePromise;
        }
        this.closePromise = this.closeInternal(options);
        return this.closePromise;
    }

    async closeInternal(options = {}) {
        if (!this.worker) {
            return;
        }
        const worker = this.worker;
        this.closing = true;
        let closeError = null;
        try {
            if (this.failure || !this.workerAlive) {
                closeError = this.failure || new Error('BMP persistence worker exited before close');
            } else if (!this.readOnly) {
                await this.drain();
                await this.sendRequest(
                    BMP_PERSISTENCE_OP.CHECKPOINT,
                    { mode: 'PASSIVE' },
                    {
                        allowDuringClosing: true
                    }
                );
            }
            if (!closeError) {
                await this.sendRequest(BMP_PERSISTENCE_OP.CLOSE, null, {
                    allowDuringClosing: true
                });
            }
        } catch (error) {
            closeError = error;
        } finally {
            if (this.flushTimer) {
                clearTimeout(this.flushTimer);
                this.flushTimer = null;
            }
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = null;
            }
            this.worker = null;
            this.workerAlive = false;
            const pendingError = closeError || new Error('BMP persistence client closed');
            this.rejectCallbacks(pendingError);
            this.rejectIdleWaiters(pendingError);
            this.rejectFenceWaiters(pendingError);
            await worker.terminate().catch(() => {});
        }
        if (closeError && options.suppressErrors !== true) {
            throw closeError;
        }
    }
}

module.exports = BmpPersistenceClient;
