const BmpPersistenceClient = require('./bmpPersistenceClient');
const { BMP_PERSISTENCE_OP } = require('./bmpPersistenceConst');
const { getClientWorkerIndex, normalizeClientSourceId } = require('./bmpClientPersistencePaths');

const DEFAULT_WRITER_WORKERS = 4;
const MAX_WRITER_WORKERS = 16;

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function mergeMaintenanceResults(results) {
    const combined = {};
    for (const result of results) {
        for (const [key, value] of Object.entries(result || {})) {
            if (key === 'nextRefreshStartedMs' || key === 'nextRefreshSourceId') continue;
            if (typeof value === 'number') {
                combined[key] = (Number(combined[key]) || 0) + value;
            } else if (Array.isArray(value)) {
                combined[key] = [...(combined[key] || []), ...value];
            } else if (value && typeof value === 'object') {
                combined[key] = mergeMaintenanceResults([combined[key], value]);
            } else if (typeof value === 'boolean') {
                combined[key] = Boolean(combined[key]) || value;
            } else if (combined[key] === undefined) {
                combined[key] = value;
            }
        }
    }
    if (results.some(result => result && Object.hasOwn(result, 'nextRefreshStartedMs'))) {
        const next = results
            .filter(result => result?.nextRefreshStartedMs !== null && Number.isFinite(result?.nextRefreshStartedMs))
            .sort((left, right) => left.nextRefreshStartedMs - right.nextRefreshStartedMs)[0];
        combined.nextRefreshStartedMs = next?.nextRefreshStartedMs ?? null;
        combined.nextRefreshSourceId = next?.nextRefreshSourceId ?? null;
    }
    return combined;
}

function mutationSourceId(mutation, refs) {
    const source = mutation?.source || refs?.sources?.[mutation?.sourceRef];
    const sourceId = normalizeClientSourceId(source?.id);
    const connection = mutation?.connection || refs?.connections?.[mutation?.connectionRef];
    const scope = mutation?.scope || refs?.scopes?.[mutation?.scopeRef];
    for (const descriptor of [connection, scope]) {
        if (descriptor?.sourceId !== undefined && normalizeClientSourceId(descriptor.sourceId) !== sourceId) {
            const error = new Error('BMP client database mutation contains a descriptor belonging to another source');
            error.code = 'BMP_PERSISTENCE_SOURCE_MISMATCH';
            throw error;
        }
    }
    return sourceId;
}

// A bounded set of FIFO writers owns disjoint sets of client databases. A
// client never changes lanes during the process lifetime, so its lifecycle
// events and routes retain the existing ordered-batch/fence semantics.
class BmpClientPersistenceClient {
    constructor(options = {}) {
        this.dbPath = options.dbPath;
        this.readOnly = options.readOnly === true;
        this.partitionByClient = true;
        this.logLevel = typeof options.logLevel === 'string' ? options.logLevel : 'off';
        const configured = Number(options.writerWorkerCount);
        this.workerCount = this.readOnly
            ? 1
            : Math.min(
                  MAX_WRITER_WORKERS,
                  Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_WRITER_WORKERS
              );
        this.highWatermarkBytes = positiveInteger(options.highWatermarkBytes, 64 * 1024 * 1024);
        this.lowWatermarkBytes = Math.min(
            positiveInteger(options.lowWatermarkBytes, 32 * 1024 * 1024),
            this.highWatermarkBytes
        );
        this.options = options;
        this.clients = [];
        this.paused = false;
        this.failure = null;
        this.closing = false;
        this.closePromise = null;
        this.openPromise = null;
    }

    get worker() {
        return this.clients[0]?.worker || null;
    }

    get workerAlive() {
        return this.clients.length > 0 && this.clients.every(client => client.workerAlive);
    }

    open() {
        if (this.openPromise) return this.openPromise;
        this.openPromise = this.openInternal();
        return this.openPromise;
    }

    async openInternal() {
        if (!this.dbPath) throw new Error('BMP persistence dbPath is required');
        this.clients = Array.from(
            { length: this.workerCount },
            (_, workerIndex) =>
                new BmpPersistenceClient({
                    ...this.options,
                    clientDatabaseWorker: true,
                    partitionByClient: true,
                    workerIndex,
                    workerCount: this.workerCount,
                    onPause: () => this.updateBackpressure(),
                    onResume: () => this.updateBackpressure(),
                    onError: error => this.handleFailure(error),
                    onCommittedBatch: (result, batch) => {
                        this.updateBackpressure();
                        return this.options.onCommittedBatch?.(result, batch);
                    }
                })
        );
        const opened = await Promise.allSettled(this.clients.map(client => client.open()));
        const failed = opened.find(result => result.status === 'rejected');
        if (failed) {
            this.handleFailure(failed.reason);
            await Promise.allSettled(this.clients.map(client => client.close({ suppressErrors: true })));
            throw failed.reason;
        }
        return this.getStatus();
    }

    handleFailure(error) {
        if (this.failure) return;
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.(this.failure);
    }

    requireOpen() {
        if (this.failure) throw this.failure;
        if (!this.clients.length || !this.workerAlive || this.closing) {
            throw new Error('BMP client database pool is not accepting requests');
        }
    }

    getClient(sourceId) {
        this.requireOpen();
        const index = this.readOnly || !sourceId ? 0 : getClientWorkerIndex(sourceId, this.workerCount);
        return this.clients[index];
    }

    enqueue(mutation) {
        if (this.readOnly) throw new Error('Cannot enqueue writes on a read-only BMP persistence client');
        const sourceId = mutationSourceId(mutation);
        this.getClient(sourceId).enqueue(mutation);
        this.updateBackpressure();
    }

    getWatermark() {
        const result = {
            queueLength: 0,
            queueBytes: 0,
            inFlightBytes: 0,
            bufferedBytes: 0,
            paused: this.paused,
            failed: Boolean(this.failure)
        };
        for (const client of this.clients) {
            const watermark = client.getWatermark();
            for (const key of ['queueLength', 'queueBytes', 'inFlightBytes', 'bufferedBytes'])
                result[key] += watermark[key];
            result.failed ||= watermark.failed;
        }
        return result;
    }

    updateBackpressure() {
        const { bufferedBytes } = this.getWatermark();
        if (!this.paused && bufferedBytes >= this.highWatermarkBytes) {
            this.paused = true;
            this.options.onPause?.(bufferedBytes);
        } else if (this.paused && !this.failure && bufferedBytes <= this.lowWatermarkBytes) {
            this.paused = false;
            this.options.onResume?.(bufferedBytes);
        }
    }

    drain() {
        if (this.failure) return Promise.reject(this.failure);
        return Promise.all(this.clients.map(client => client.drain())).then(() => undefined);
    }

    fence(sourceId) {
        if (this.failure) return Promise.reject(this.failure);
        if (sourceId) {
            return this.getClient(normalizeClientSourceId(sourceId)).fence();
        }
        // Each lane captures its target synchronously, before any await.
        return Promise.all(this.clients.map(client => client.fence())).then(() => undefined);
    }

    queryRoutes(query = {}) {
        return this.getClient(query.sourceId).queryRoutes(query);
    }

    queryRouteScope(query = {}) {
        return this.getClient(query.sourceId || query.routeQuery?.sourceId).queryRouteScope(query);
    }

    queryScopeSummary(query = {}) {
        return this.getClient(query.sourceId).queryScopeSummary(query);
    }

    queryTopology(query = {}) {
        return this.getClient(query.sourceId).queryTopology(query);
    }

    queryStatisticsReports(query = {}) {
        return this.getClient(query.sourceId).queryStatisticsReports(query);
    }

    streamRouteAssuranceRows(query = {}, options = {}) {
        return this.getClient(query.sourceId).streamRouteAssuranceRows(query, options);
    }

    async getStatus(options = {}) {
        const status = await this.getClient(options.sourceId).getStatus(options);
        return { ...status, writerWorkerCount: this.readOnly ? 0 : this.workerCount };
    }

    async purgeSource(query = {}) {
        if (this.readOnly) throw new Error('Cannot purge a source through a read-only BMP persistence client');
        const client = this.getClient(normalizeClientSourceId(query.sourceId));
        return client.purgeSource(query);
    }

    async purgeStaleRoutes(query = {}, options = {}) {
        if (this.readOnly) throw new Error('Cannot purge stale routes through a read-only BMP persistence client');
        if (query.sourceId) return this.getClient(query.sourceId).purgeStaleRoutes(query, options);
        this.requireOpen();
        return mergeMaintenanceResults(
            await Promise.all(this.clients.map(client => client.purgeStaleRoutes(query, options)))
        );
    }

    async sweep(options = {}) {
        if (this.readOnly) throw new Error('Cannot sweep a read-only BMP persistence client');
        this.requireOpen();
        const result = options.sourceId
            ? await this.getClient(options.sourceId).sweep({ ...options, includeGlobalDeadline: false })
            : mergeMaintenanceResults(
                  await Promise.all(
                      this.clients.map(client =>
                          client.sweep({
                              ...options,
                              includeGlobalDeadline: false,
                              routeLimit: Math.max(
                                  1,
                                  Math.floor(positiveInteger(options.routeLimit, 2000) / this.workerCount)
                              ),
                              eventLimit: Math.max(
                                  1,
                                  Math.floor(positiveInteger(options.eventLimit, 5000) / this.workerCount)
                              ),
                              auxiliaryLimit: Math.max(
                                  1,
                                  Math.floor(
                                      positiveInteger(
                                          options.auxiliaryLimit,
                                          positiveInteger(options.eventLimit, 5000)
                                      ) / this.workerCount
                                  )
                              )
                          })
                      )
                  )
              );
        // A source-specific sweep must still expose the next deadline of ALL
        // clients, without performing cleanup in unrelated client databases.
        const next = await this.getClient().sendRequest(BMP_PERSISTENCE_OP.QUERY_REFRESH_DEADLINE);
        result.nextRefreshStartedMs = next?.started_at_ms ?? null;
        result.nextRefreshSourceId = next?.source_id ?? null;
        return result;
    }

    async checkpoint(mode = 'PASSIVE') {
        this.requireOpen();
        return (await Promise.all(this.clients.map(client => client.checkpoint(mode)))).flat();
    }

    async setLogLevel(level) {
        this.requireOpen();
        this.logLevel = typeof level === 'string' ? level : 'off';
        const results = await Promise.all(this.clients.map(client => client.setLogLevel(this.logLevel)));
        return { ...results[0], logLevel: this.logLevel };
    }

    async sendRequest(op, data = {}, options = {}) {
        if (op === BMP_PERSISTENCE_OP.APPLY_BATCH) {
            if (this.readOnly) throw new Error('Cannot apply a BMP persistence batch to a read-only client');
            this.requireOpen();
            await this.fence();
            const groups = new Map();
            for (const mutation of data.mutations || []) {
                const sourceId = mutationSourceId(mutation, data.refs);
                const index = getClientWorkerIndex(sourceId, this.workerCount);
                if (!groups.has(index)) groups.set(index, []);
                groups.get(index).push(mutation);
            }
            const results = await Promise.all(
                Array.from(groups, ([index, mutations]) =>
                    this.clients[index].sendRequest(op, { ...data, mutations }, options)
                )
            );
            return {
                duplicate: results.length > 0 && results.every(result => result.duplicate),
                applied: results.reduce((sum, result) => sum + (Number(result.applied) || 0), 0),
                ...(results.some(result => result.requiresProjectionRebuild)
                    ? { requiresProjectionRebuild: true }
                    : {}),
                ...(data.includeDeltas === false ? {} : { deltas: results.flatMap(result => result.deltas || []) })
            };
        }
        if (op === BMP_PERSISTENCE_OP.SWEEP) return this.sweep(data);
        if (op === BMP_PERSISTENCE_OP.CHECKPOINT) return this.checkpoint(data.mode);
        if (op === BMP_PERSISTENCE_OP.SET_LOG_LEVEL) return this.setLogLevel(data.logLevel);
        if (op === BMP_PERSISTENCE_OP.PURGE_SOURCE) return this.purgeSource(data);
        if (op === BMP_PERSISTENCE_OP.PURGE_STALE_ROUTES) return this.purgeStaleRoutes(data);
        return this.getClient(data?.sourceId || data?.routeQuery?.sourceId).sendRequest(op, data, options);
    }

    close(options = {}) {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = Promise.allSettled(this.clients.map(client => client.close(options))).then(results => {
            const failed = results.find(result => result.status === 'rejected');
            if (failed && options.suppressErrors !== true) throw failed.reason;
        });
        return this.closePromise;
    }
}

module.exports = BmpClientPersistenceClient;
