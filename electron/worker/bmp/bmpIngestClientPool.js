const path = require('path');
const { Worker } = require('worker_threads');
const { normalizeBmpThreadCount } = require('../../utils/bmpThreadConfig');
const { normalizeClientSourceId } = require('./bmpClientPersistencePaths');

const RAW_HIGH_WATERMARK_BYTES = 1024 * 1024;
const RAW_LOW_WATERMARK_BYTES = 512 * 1024;
const START_TIMEOUT_MS = 15000;

// One live connection owns one parser slot until its final FIFO close has been
// acknowledged. Socket handles stay here; only owned byte buffers cross the
// thread boundary. The database retains its independently ordered writer lanes.
class BmpIngestClientPool {
    constructor(options = {}) {
        this.threadCount = normalizeBmpThreadCount(options.threadCount);
        this.config = {
            bmpV4TlvDraft: options.config?.bmpV4TlvDraft,
            pathMarkingTlvType: options.config?.pathMarkingTlvType,
            logLevel: options.config?.logLevel || 'off'
        };
        this.onResult = options.onResult;
        this.onClosed = options.onClosed;
        this.onError = options.onError;
        this.slots = [];
        this.callbacks = new Map();
        this.sequence = 0;
        this.failure = null;
        this.closing = false;
        this.closePromise = null;
        this.openPromise = null;
    }

    open() {
        if (this.openPromise) return this.openPromise;
        this.openPromise = this.openInternal();
        return this.openPromise;
    }

    async openInternal() {
        try {
            const ready = [];
            for (let index = 0; index < this.threadCount; index += 1) {
                const worker = new Worker(path.join(__dirname, 'bmpIngestWorker.js'), {
                    workerData: { index, threadCount: this.threadCount, config: this.config }
                });
                const slot = { index, worker, threadId: worker.threadId, alive: true, record: null };
                this.slots.push(slot);
                ready.push(
                    new Promise((resolve, reject) => {
                        slot.readyResolve = resolve;
                        slot.readyReject = reject;
                        slot.readyTimer = setTimeout(() => {
                            this.handleFailure(new Error(`BMP ingest worker ${index} startup timed out`));
                        }, START_TIMEOUT_MS);
                    })
                );
                worker.on('message', message => this.handleMessage(slot, message));
                worker.on('error', error => this.handleFailure(error));
                worker.on('exit', code => {
                    slot.alive = false;
                    const hasPendingRequests = Array.from(this.callbacks.values()).some(
                        callback => callback.slot === slot
                    );
                    if (!slot.expectedExit || hasPendingRequests) {
                        this.handleFailure(new Error(`BMP ingest worker ${index} exited with code ${code}`));
                    }
                });
            }
            await Promise.all(ready);
            return this.getStatus();
        } catch (error) {
            await this.terminateWorkers();
            throw error;
        }
    }

    handleFailure(error) {
        if (this.failure) return;
        this.failure = error instanceof Error ? error : new Error(String(error));
        for (const slot of this.slots) {
            clearTimeout(slot.readyTimer);
            slot.readyReject?.(this.failure);
            slot.record?.session?.socket?.pause?.();
        }
        for (const callback of this.callbacks.values()) callback.reject(this.failure);
        this.callbacks.clear();
        this.onError?.(this.failure);
    }

    hasCapacity() {
        return !this.closing && !this.failure && this.slots.some(slot => slot.alive && !slot.record);
    }

    attach(session, options = {}) {
        if (!this.hasCapacity()) return null;
        const slot = this.slots.find(item => item.alive && !item.record);
        const record = {
            index: slot.index,
            threadId: slot.threadId,
            token: `bmp-client-${++this.sequence}`,
            session,
            pendingBytes: 0,
            paused: false,
            closing: false,
            closed: false,
            closePromise: null
        };
        slot.record = record;
        this.request(slot, {
            op: 'attach',
            token: record.token,
            sessionKey: options.sessionKey,
            metadata: options.metadata,
            connectionGeneration: session.persistenceConnectionGeneration,
            connectionId: session.persistenceConnectionId,
            openedAtMs: session.persistenceOpenedAtMs
        }).catch(error => this.handleFailure(error));
        return record;
    }

    request(slot, message, transferList = [], bytes = 0) {
        if (this.failure) return Promise.reject(this.failure);
        if (!slot?.alive) return Promise.reject(new Error('BMP ingest worker is not running'));
        const requestId = `bmp-ingest-${++this.sequence}`;
        return new Promise((resolve, reject) => {
            this.callbacks.set(requestId, { slot, token: message.token, op: message.op, bytes, resolve, reject });
            try {
                slot.worker.postMessage({ ...message, requestId }, transferList);
            } catch (error) {
                this.callbacks.delete(requestId);
                reject(error);
            }
        });
    }

    send(record, buffer) {
        if (!record || record.closing || record.closed || this.closing || this.failure) return false;
        const slot = this.slots[record.index];
        if (slot?.record !== record) return false;
        const data = Uint8Array.from(buffer);
        const bytes = data.byteLength;
        record.pendingBytes += bytes;
        if (record.pendingBytes >= RAW_HIGH_WATERMARK_BYTES) {
            record.paused = true;
            record.session.socket?.pause?.();
        }
        this.request(slot, { op: 'data', token: record.token, data }, [data.buffer], bytes).catch(error => {
            this.handleFailure(error);
        });
        return true;
    }

    handleMessage(slot, message) {
        if (message?.op === 'ready') {
            clearTimeout(slot.readyTimer);
            slot.threadId = message.threadId;
            slot.readyResolve?.();
            return;
        }
        if (message?.op !== 'result') return;
        const callback = this.callbacks.get(message.requestId);
        if (!callback || callback.slot !== slot || callback.token !== message.token) return;
        this.callbacks.delete(message.requestId);
        const record = slot.record;
        try {
            if (message.error) {
                const error = new Error(message.error.message || 'BMP ingest worker failed');
                error.code = message.error.code;
                throw error;
            }
            if (record && record.token === message.token) {
                // Mutations enter the database FIFO before this request or any
                // subsequent barrier is acknowledged to readers/shutdown.
                this.onResult?.(record, message);
                record.pendingBytes = Math.max(0, record.pendingBytes - callback.bytes);
                if (record.paused && record.pendingBytes <= RAW_LOW_WATERMARK_BYTES) {
                    record.paused = false;
                    this.resume(record);
                }
                if (callback.op === 'close') {
                    record.closed = true;
                    slot.record = null;
                    this.onClosed?.(record);
                } else if (message.closed && !record.closing) {
                    this.closeSession(record).catch(error => this.handleFailure(error));
                }
            }
            callback.resolve(message);
        } catch (error) {
            callback.reject(error);
            this.handleFailure(error);
        }
    }

    resume(record) {
        const session = record.session;
        if (
            !record.closing &&
            !record.paused &&
            !this.failure &&
            !this.closing &&
            !session.socket?.destroyed &&
            !session.bmpWorker?.bmpSocketsPaused &&
            !session.bmpWorker?.persistence?.paused
        ) {
            session.socket?.resume?.();
        }
    }

    closeSession(record) {
        if (!record || record.closed) return Promise.resolve();
        if (record.closePromise) return record.closePromise;
        record.closing = true;
        record.closePromise = this.request(this.slots[record.index], { op: 'close', token: record.token });
        record.session.socket?.destroy?.();
        return record.closePromise;
    }

    fence(sourceId) {
        const targetSourceId = sourceId ? normalizeClientSourceId(sourceId) : null;
        return Promise.all(
            this.slots.flatMap(slot => {
                const record = slot.record;
                if (!record) return [];
                const recordSourceId = targetSourceId ? record.session.getPersistentSourceId?.() : null;
                // Initiation may still be in the parser FIFO, before its result
                // has established this record's identity in the coordinator.
                // Fence unknown records too: one may be the target reconnect.
                if (targetSourceId && recordSourceId && recordSourceId !== targetSourceId) return [];
                // A destroyed socket can precede its 'close' callback. Readers
                // and especially DELETE_SOURCE must also fence its final close,
                // otherwise the delayed close mutation could recreate the source.
                return [
                    record.closing || record.session.socket?.destroyed
                        ? this.closeSession(record)
                        : this.request(slot, { op: 'barrier', token: record.token })
                ];
            })
        );
    }

    async setLogLevel(level) {
        this.config.logLevel = level;
        await Promise.all(this.slots.map(slot => this.request(slot, { op: 'log-level', level })));
    }

    getStatus() {
        const records = this.slots.flatMap(slot => (slot.record ? [slot.record] : []));
        return {
            ingestWorkerCount: this.slots.filter(slot => slot.alive).length,
            activeClientCount: records.length,
            clientLimit: this.threadCount,
            ingestThreadIds: this.slots.filter(slot => slot.alive).map(slot => slot.threadId),
            clientThreads: records.map(record => ({
                slot: record.index,
                threadId: record.threadId,
                pendingBytes: record.pendingBytes,
                closing: record.closing,
                persistentConnectionId: record.session.persistenceConnectionId,
                persistentSourceId: record.session.getPersistentSourceId?.() || null,
                remoteIp: record.session.remoteIp,
                remotePort: record.session.remotePort
            })),
            acceptingClients: this.hasCapacity()
        };
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = (async () => {
            try {
                await Promise.all(this.slots.map(slot => this.closeSession(slot.record)));
                for (const slot of this.slots) slot.expectedExit = true;
                await Promise.all(this.slots.map(slot => this.request(slot, { op: 'shutdown' })));
            } finally {
                await this.terminateWorkers();
            }
        })();
        return this.closePromise;
    }

    async terminateWorkers() {
        for (const slot of this.slots) {
            slot.expectedExit = true;
            clearTimeout(slot.readyTimer);
        }
        await Promise.allSettled(this.slots.map(slot => slot.worker.terminate()));
        this.slots = [];
    }
}

module.exports = BmpIngestClientPool;
