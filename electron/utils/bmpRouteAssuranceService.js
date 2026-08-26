const { performance } = require('node:perf_hooks');
const BmpConst = require('../const/bmpConst');
const {
    applyBmpRouteAssuranceBootstrapMutation,
    applyBmpRouteAssuranceMutation,
    buildBmpRouteAssuranceAnalysis,
    buildBmpRouteAssuranceAnalysisAsync,
    buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync,
    buildBmpRouteAssuranceAnalysisFromRowStreamAsync,
    refreshBmpRouteAssuranceStreamRun,
    makeStreamRunKey,
    countBmpRouteAssuranceSourcePaths,
    getRouteAssuranceStage,
    makeRouteAssuranceSourceKey,
    normalizeBmpRouteAssuranceCommittedDelta,
    paginateBmpRouteAssuranceAnalysis
} = require('./bmpRouteAssurance');

// A million-path snapshot may be large. Keep one analysis by default so a
// filter change releases the previous snapshot instead of retaining several
// full-network aggregates. Callers can opt into a larger LRU explicitly.
const DEFAULT_MAX_CACHE_ENTRIES = 1;
const PAGINATION_ONLY_OPTIONS = new Set(['category', 'page', 'pageSize']);
const PERSISTED_REBUILD_ACTIONS = new Set([
    'scope_open',
    'scope_stale',
    'scope_eor',
    'scope_timeout',
    'connection_close'
]);
const PERSISTED_NOOP_ACTIONS = new Set(['connection_open']);
// Streamed snapshots refresh one NLRI group per committed delta by re-reading
// that group from SQLite. Under a full-table dump the delta rate is far
// higher than that makes sense; beyond this many pending groups the service
// asks the caller to invalidate and rebuild once the writer goes quiet.
const DEFAULT_MAX_PENDING_GROUP_REFRESHES = 5000;
const DEFAULT_GROUP_REFRESH_DELAY_MS = 200;

// Bridges push-style chunk callbacks to the async iterable the builder
// consumes; each push resolves once the builder has processed the chunk so
// the producer's flow-control window reflects real consumption.
function makeChunkQueue() {
    const pending = [];
    let waiter = null;
    let closed = false;
    let failure = null;
    const wake = () => {
        if (waiter) {
            const resolve = waiter;
            waiter = null;
            resolve();
        }
    };
    return {
        push(chunk) {
            return new Promise(resolve => {
                pending.push({ chunk, resolve });
                wake();
            });
        },
        close() {
            closed = true;
            wake();
        },
        fail(error) {
            failure = error;
            closed = true;
            wake();
        },
        async *[Symbol.asyncIterator]() {
            for (;;) {
                if (pending.length > 0) {
                    const { chunk, resolve } = pending.shift();
                    try {
                        yield chunk;
                    } finally {
                        resolve();
                    }
                    continue;
                }
                if (failure) {
                    throw failure;
                }
                if (closed) {
                    return;
                }
                await new Promise(resolve => {
                    waiter = resolve;
                });
            }
        }
    };
}

function makeGroupLocator(route, delta) {
    if (!route || typeof route !== 'object') {
        return null;
    }
    const sourceId = route.persistentSourceId || delta?.sourceId || delta?.source?.id || null;
    const prefix = route.ip ?? route.prefix ?? route.nlriDetail?.prefix ?? null;
    if (!sourceId || prefix === null || prefix === undefined || prefix === '') {
        return null;
    }
    const afi = Number(route.afi);
    const safi = Number(route.safi);
    const prefixLength = route.mask ?? route.prefixLength ?? null;
    const locator = {
        sourceId: String(sourceId),
        afi: Number.isFinite(afi) ? afi : null,
        safi: Number.isFinite(safi) ? safi : null,
        rd: route.rd ?? route.nlriDetail?.rd ?? null,
        prefix: String(prefix),
        prefixLength: Number.isFinite(Number(prefixLength)) ? Number(prefixLength) : null
    };
    // Row-shaped view of the locator so it hashes to the same run key as rows.
    locator.row = {
        sourceId: locator.sourceId,
        afi: locator.afi ?? '',
        safi: locator.safi ?? '',
        rd: locator.rd ?? '',
        ip: locator.prefix,
        mask: locator.prefixLength ?? ''
    };
    return locator;
}

function normalizedRouteState(value) {
    const state = String(value || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE)
        .trim()
        .toLowerCase();
    return Object.values(BmpConst.BMP_ROUTE_STATE_FILTER).includes(state)
        ? state
        : BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
}

function canonicalValue(value, seen = new WeakSet()) {
    if (value === undefined) {
        return '[undefined]';
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'bigint') {
        return `bigint:${value}`;
    }
    if (typeof value === 'function') {
        return `function:${value.name || 'anonymous'}`;
    }
    if (seen.has(value)) {
        throw new TypeError('BMP Route Assurance 查询条件不能包含循环引用');
    }
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
        result = `[${value.map(item => canonicalValue(item, seen)).join(',')}]`;
    } else {
        result = `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`)
            .join(',')}}`;
    }
    seen.delete(value);
    return result;
}

function makeAnalysisOptions(options = {}) {
    const analysisOptions = {};
    Object.keys(options).forEach(key => {
        if (!PAGINATION_ONLY_OPTIONS.has(key)) {
            analysisOptions[key] = options[key];
        }
    });

    // Match the builder's normalization so semantically identical filters share a snapshot.
    analysisOptions.client = String(options.client || '').trim();
    analysisOptions.vrf = String(options.vrf || '').trim();
    analysisOptions.af = String(options.af || '').trim();
    analysisOptions.query = String(options.query || '').trim();
    analysisOptions.routeState = normalizedRouteState(options.routeState);
    return analysisOptions;
}

class BmpRouteAssuranceService {
    constructor(options = {}) {
        this.maxCacheEntries = Math.max(1, Math.floor(Number(options.maxCacheEntries)) || DEFAULT_MAX_CACHE_ENTRIES);
        this.cache = new Map();
        this.mapIds = new WeakMap();
        this.nextMapId = 1;
        this.revision = 0;
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.aggregationCount = 0;
        this.invalidationCount = 0;
        this.evictionCount = 0;
        this.lastInvalidationReason = '';
        this.lastAggregationDurationMs = 0;
        this.enabled = options.enabled !== false;
        this.state = this.enabled ? 'ready' : 'disabled';
        this.incrementalUpdateCount = 0;
        this.bootstrapGeneration = 0;
        this.bootstrapProgress = { scannedPathCount: 0 };
        this.pendingMutations = new Map();
        this.bootstrapPromise = null;
        this.bootstrapCacheKey = null;
        this.dataMode = 'memory';
        this.persistedSourceToken = Object.freeze({ kind: 'bmp-persisted-routes' });
        this.persistedAnalysisOptions = null;
        this.streamControl = null;
        this.groupRefreshLoader = null;
        this.pendingGroupRefreshes = new Map();
        this.groupRefreshTimer = null;
        this.groupRefreshRunning = false;
        this.maxPendingGroupRefreshes = Math.max(
            1,
            Math.floor(Number(options.maxPendingGroupRefreshes)) || DEFAULT_MAX_PENDING_GROUP_REFRESHES
        );
        this.groupRefreshDelayMs = Math.max(0, Number(options.groupRefreshDelayMs) || DEFAULT_GROUP_REFRESH_DELAY_MS);
        this.groupRefreshCount = 0;
        this.groupRefreshOverflow = false;
    }

    // Streamed bootstrap: `openStream(onChunk)` must start an ordered scan
    // (BmpPersistenceClient.streamRouteAssuranceRows) and resolve when it
    // completes; the returned promise may expose cancel(). Committed deltas
    // that arrive later are applied by re-reading the affected NLRI group via
    // `control.loadGroupRows(locator)`.
    async bootstrapFromRouteStream(openStream, options = {}, control = {}) {
        if (typeof openStream !== 'function') {
            throw new Error('BMP Route Assurance stream bootstrap requires an openStream function');
        }
        const rebuildingInvalidatedSnapshot = this.enabled && this.state === 'dirty';
        this.enabled = true;
        this.state = 'bootstrapping';
        this.dataMode = 'stream';
        this.bootstrapGeneration += 1;
        const generation = this.bootstrapGeneration;
        this.cache.clear();
        if (!rebuildingInvalidatedSnapshot) {
            this.revision += 1;
            this.invalidationCount += 1;
            this.lastInvalidationReason = 'stream-bootstrap';
        }
        this.pendingMutations.clear();
        this.pendingGroupRefreshes.clear();
        this.groupRefreshOverflow = false;
        this.bootstrapProgress = { scannedPathCount: 0 };
        const analysisOptions = makeAnalysisOptions(options);
        this.persistedAnalysisOptions = analysisOptions;
        this.streamControl = {
            resolveContext: control.resolveContext,
            maxRetainedIssuesPerCategory: control.maxRetainedIssuesPerCategory
        };
        this.groupRefreshLoader = typeof control.loadGroupRows === 'function' ? control.loadGroupRows : null;
        const cacheKey = this.makeCacheKey(this.persistedSourceToken, analysisOptions);
        this.bootstrapCacheKey = cacheKey;
        const startedAt = performance.now();

        const queue = makeChunkQueue();
        const shouldCancel = () => generation !== this.bootstrapGeneration || !this.enabled;
        const streamPromise = openStream(chunk => {
            if (shouldCancel()) {
                return Promise.reject(
                    Object.assign(new Error('路由矩阵分析初始化已取消'), { code: 'BMP_ROUTE_ASSURANCE_CANCELLED' })
                );
            }
            return queue.push(chunk);
        });
        const cancelStream = () => {
            if (typeof streamPromise?.cancel === 'function') {
                streamPromise.cancel();
            }
        };
        streamPromise.then(
            () => queue.close(),
            error => queue.fail(error)
        );
        const cancelWatcher = setInterval(() => {
            if (shouldCancel()) {
                cancelStream();
                queue.fail(
                    Object.assign(new Error('路由矩阵分析初始化已取消'), { code: 'BMP_ROUTE_ASSURANCE_CANCELLED' })
                );
            }
        }, 250);
        cancelWatcher.unref?.();

        this.bootstrapPromise = buildBmpRouteAssuranceAnalysisFromRowStreamAsync(queue, analysisOptions, {
            chunkSize: control.chunkSize,
            resolveContext: control.resolveContext,
            maxRetainedIssuesPerCategory: control.maxRetainedIssuesPerCategory,
            shouldCancel,
            onProgress: progress => {
                this.bootstrapProgress = { ...progress };
                control.onProgress?.(this.getStatus());
            }
        })
            .then(async analysis => {
                clearInterval(cancelWatcher);
                if (shouldCancel()) {
                    cancelStream();
                    return this.getStatus();
                }
                await streamPromise.catch(() => {});
                this.lastAggregationDurationMs = performance.now() - startedAt;
                this.aggregationCount += 1;
                const cacheEntry = {
                    analysis,
                    aggregationDurationMs: this.lastAggregationDurationMs,
                    revision: this.revision
                };
                this.cache.set(cacheKey, cacheEntry);
                this.state = 'ready';
                this.bootstrapPromise = null;
                this.bootstrapCacheKey = null;
                this.scheduleGroupRefresh();
                return this.getStatus();
            })
            .catch(error => {
                clearInterval(cancelWatcher);
                cancelStream();
                if (error?.code === 'BMP_ROUTE_ASSURANCE_CANCELLED') {
                    return this.getStatus();
                }
                if (generation === this.bootstrapGeneration) {
                    this.state = this.enabled ? 'dirty' : 'disabled';
                    this.cache.clear();
                    this.bootstrapPromise = null;
                    this.bootstrapCacheKey = null;
                    this.pendingGroupRefreshes.clear();
                }
                throw error;
            });
        return this.bootstrapPromise;
    }

    // Queues one NLRI group for re-evaluation. Returns false when the caller
    // should fall back to a full rebuild instead.
    queueGroupRefresh(delta) {
        const locator = makeGroupLocator(delta?.current, delta) || makeGroupLocator(delta?.previous, delta);
        if (!locator) {
            return false;
        }
        if (!this.groupRefreshLoader) {
            return false;
        }
        const runKey = makeStreamRunKey(locator.row);
        this.pendingGroupRefreshes.set(runKey, locator);
        this.revision += 1;
        if (this.pendingGroupRefreshes.size > this.maxPendingGroupRefreshes) {
            this.groupRefreshOverflow = true;
            this.pendingGroupRefreshes.clear();
            return false;
        }
        this.scheduleGroupRefresh();
        return true;
    }

    scheduleGroupRefresh() {
        if (this.groupRefreshTimer || this.groupRefreshRunning || this.pendingGroupRefreshes.size === 0) {
            return;
        }
        if (this.state !== 'ready') {
            return;
        }
        this.groupRefreshTimer = setTimeout(() => {
            this.groupRefreshTimer = null;
            this.flushGroupRefreshes().catch(error => {
                this.lastGroupRefreshError = error?.message || String(error);
                this.invalidate('group-refresh-error', { prepareBootstrap: true });
            });
        }, this.groupRefreshDelayMs);
        this.groupRefreshTimer.unref?.();
    }

    async flushGroupRefreshes() {
        if (this.groupRefreshRunning || !this.groupRefreshLoader) {
            return;
        }
        this.groupRefreshRunning = true;
        try {
            while (this.pendingGroupRefreshes.size > 0 && this.state === 'ready' && this.enabled) {
                const [runKey, locator] = this.pendingGroupRefreshes.entries().next().value;
                this.pendingGroupRefreshes.delete(runKey);
                const rows = await this.groupRefreshLoader(locator);
                if (this.state !== 'ready' || !this.enabled) {
                    return;
                }
                this.cache.forEach(cacheEntry => {
                    if (
                        refreshBmpRouteAssuranceStreamRun(
                            cacheEntry.analysis,
                            locator.row,
                            rows,
                            this.streamControl?.resolveContext
                        )
                    ) {
                        cacheEntry.revision = this.revision;
                    }
                });
                this.groupRefreshCount += 1;
                this.incrementalUpdateCount += 1;
            }
        } finally {
            this.groupRefreshRunning = false;
            if (this.pendingGroupRefreshes.size > 0) {
                this.scheduleGroupRefresh();
            }
        }
    }

    getMapId(bmpSessionMap) {
        if ((typeof bmpSessionMap !== 'object' && typeof bmpSessionMap !== 'function') || bmpSessionMap === null) {
            return `primitive:${String(bmpSessionMap)}`;
        }
        if (!this.mapIds.has(bmpSessionMap)) {
            this.mapIds.set(bmpSessionMap, this.nextMapId);
            this.nextMapId += 1;
        }
        return this.mapIds.get(bmpSessionMap);
    }

    makeCacheKey(bmpSessionMap, analysisOptions) {
        return `${this.getMapId(bmpSessionMap)}\u001f${canonicalValue(analysisOptions)}`;
    }

    query(bmpSessionMap, options = {}) {
        if (!this.enabled) {
            throw new Error('路由矩阵分析未开启');
        }
        if (this.state === 'bootstrapping') {
            throw new Error('路由矩阵正在初始化，请稍候');
        }
        if (this.state === 'dirty') {
            throw new Error('路由矩阵正在重新同步，请稍候');
        }
        const queryStartedAt = performance.now();
        const analysisOptions = makeAnalysisOptions(options);
        const cacheKey = this.makeCacheKey(bmpSessionMap, analysisOptions);
        let cacheHit = this.cache.has(cacheKey);
        let cacheEntry = this.cache.get(cacheKey);

        if (cacheHit) {
            this.cacheHits += 1;
            // Map insertion order is used as a small LRU to cap retained snapshots.
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, cacheEntry);
        } else {
            this.cacheMisses += 1;
            const aggregationStartedAt = performance.now();
            let analysis;
            try {
                analysis = buildBmpRouteAssuranceAnalysis(bmpSessionMap, analysisOptions);
            } finally {
                this.lastAggregationDurationMs = performance.now() - aggregationStartedAt;
                this.aggregationCount += 1;
            }
            cacheEntry = {
                analysis,
                aggregationDurationMs: this.lastAggregationDurationMs,
                revision: this.revision
            };
            this.cache.set(cacheKey, cacheEntry);
            while (this.cache.size > this.maxCacheEntries) {
                const oldestKey = this.cache.keys().next().value;
                this.cache.delete(oldestKey);
                this.evictionCount += 1;
            }
        }

        const result = paginateBmpRouteAssuranceAnalysis(cacheEntry.analysis, options);
        result.summary = {
            ...result.summary,
            cacheHit,
            dataRevision: cacheEntry.revision,
            aggregationDurationMs: cacheEntry.aggregationDurationMs,
            queryDurationMs: performance.now() - queryStartedAt
        };
        return result;
    }

    async queryAsync(bmpSessionMap, options = {}, control = {}) {
        if (!this.enabled) {
            throw new Error('路由矩阵分析未开启');
        }
        const queryStartedAt = performance.now();
        const analysisOptions = makeAnalysisOptions(options);
        const cacheKey = this.makeCacheKey(bmpSessionMap, analysisOptions);

        if (this.state === 'bootstrapping' && this.bootstrapPromise) {
            await this.bootstrapPromise;
        }
        if (!this.enabled) {
            throw new Error('路由矩阵分析未开启');
        }
        if (this.state === 'dirty') {
            throw new Error('路由矩阵正在重新同步，请稍候');
        }

        let cacheHit = this.cache.has(cacheKey);
        let cacheEntry = this.cache.get(cacheKey);
        if (cacheHit) {
            this.cacheHits += 1;
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, cacheEntry);
        } else {
            this.cacheMisses += 1;
            cacheEntry = await this.buildSnapshotAsync(bmpSessionMap, analysisOptions, cacheKey, control);
            cacheHit = false;
        }

        const result = paginateBmpRouteAssuranceAnalysis(cacheEntry.analysis, options);
        result.summary = {
            ...result.summary,
            cacheHit,
            dataRevision: cacheEntry.revision,
            aggregationDurationMs: cacheEntry.aggregationDurationMs,
            queryDurationMs: performance.now() - queryStartedAt
        };
        return result;
    }

    async buildSnapshotAsync(bmpSessionMap, analysisOptions, cacheKey, control = {}) {
        this.dataMode = 'memory';
        this.state = 'bootstrapping';
        this.bootstrapGeneration += 1;
        const generation = this.bootstrapGeneration;
        this.cache.clear();
        this.pendingMutations.clear();
        this.bootstrapProgress = { scannedPathCount: 0 };
        this.bootstrapCacheKey = cacheKey;
        const startedAt = performance.now();

        this.bootstrapPromise = buildBmpRouteAssuranceAnalysisAsync(bmpSessionMap, analysisOptions, {
            chunkSize: control.chunkSize,
            issueChunkSize: control.issueChunkSize,
            shouldCancel: () => generation !== this.bootstrapGeneration || !this.enabled,
            onProgress: progress => {
                this.bootstrapProgress = { ...progress };
                control.onProgress?.(this.getStatus());
            }
        })
            .then(analysis => {
                if (generation !== this.bootstrapGeneration || !this.enabled) {
                    const error = new Error('路由矩阵分析初始化已取消');
                    error.code = 'BMP_ROUTE_ASSURANCE_CANCELLED';
                    throw error;
                }
                this.lastAggregationDurationMs = performance.now() - startedAt;
                this.aggregationCount += 1;
                const cacheEntry = {
                    analysis,
                    aggregationDurationMs: this.lastAggregationDurationMs,
                    revision: this.revision
                };
                this.cache.set(cacheKey, cacheEntry);
                for (const mutation of this.pendingMutations.values()) {
                    applyBmpRouteAssuranceBootstrapMutation(analysis, mutation);
                }
                analysis.summary.scannedPathCount = countBmpRouteAssuranceSourcePaths(bmpSessionMap, analysisOptions);
                cacheEntry.revision = this.revision;
                this.incrementalUpdateCount += this.pendingMutations.size;
                this.pendingMutations.clear();
                this.state = 'ready';
                this.bootstrapPromise = null;
                this.bootstrapCacheKey = null;
                return cacheEntry;
            })
            .catch(error => {
                if (error?.code === 'BMP_ROUTE_ASSURANCE_CANCELLED') {
                    if (!this.enabled) {
                        throw new Error('路由矩阵分析未开启');
                    }
                    throw new Error('路由矩阵正在重新同步，请稍候');
                }
                if (generation === this.bootstrapGeneration) {
                    this.state = this.enabled ? 'ready' : 'disabled';
                    this.bootstrapPromise = null;
                    this.bootstrapCacheKey = null;
                    this.pendingMutations.clear();
                }
                throw error;
            });
        return this.bootstrapPromise;
    }

    invalidate(reason = 'data-change', options = {}) {
        this.pendingGroupRefreshes.clear();
        if (this.groupRefreshTimer) {
            clearTimeout(this.groupRefreshTimer);
            this.groupRefreshTimer = null;
        }
        if (this.state === 'bootstrapping') {
            this.bootstrapGeneration += 1;
            this.bootstrapPromise = null;
            this.bootstrapCacheKey = null;
            this.pendingMutations.clear();
            this.bootstrapProgress = { scannedPathCount: 0 };
        }
        this.cache.clear();
        this.revision += 1;
        this.invalidationCount += 1;
        this.lastInvalidationReason = String(reason || 'data-change');
        this.state = this.enabled && options.prepareBootstrap === true ? 'dirty' : this.enabled ? 'ready' : 'disabled';
        return this.revision;
    }

    setEnabled(enabled) {
        const nextEnabled = Boolean(enabled);
        if (this.enabled === nextEnabled) {
            return this.getStatus();
        }
        this.enabled = nextEnabled;
        this.state = nextEnabled ? 'ready' : 'disabled';
        this.bootstrapGeneration += 1;
        this.bootstrapPromise = null;
        this.bootstrapCacheKey = null;
        this.pendingMutations.clear();
        this.bootstrapProgress = { scannedPathCount: 0 };
        this.invalidate(nextEnabled ? 'analysis-enabled' : 'analysis-disabled');
        return this.getStatus();
    }

    async enableWithBootstrap(bmpSessionMap, options = {}, control = {}) {
        if (this.enabled && this.state === 'ready') {
            return this.getStatus();
        }
        if (this.enabled && this.state === 'bootstrapping' && this.bootstrapPromise) {
            return this.bootstrapPromise;
        }

        const rebuildingInvalidatedSnapshot = this.enabled && this.state === 'dirty';
        this.dataMode = 'memory';
        this.enabled = true;
        this.state = 'bootstrapping';
        this.bootstrapGeneration += 1;
        const generation = this.bootstrapGeneration;
        this.cache.clear();
        if (!rebuildingInvalidatedSnapshot) {
            this.revision += 1;
            this.invalidationCount += 1;
            this.lastInvalidationReason = 'analysis-enabled';
        }
        this.pendingMutations.clear();
        this.bootstrapProgress = { scannedPathCount: 0 };
        const analysisOptions = makeAnalysisOptions(options);
        const startedAt = performance.now();

        this.bootstrapPromise = buildBmpRouteAssuranceAnalysisAsync(bmpSessionMap, analysisOptions, {
            chunkSize: control.chunkSize,
            issueChunkSize: control.issueChunkSize,
            shouldCancel: () => generation !== this.bootstrapGeneration || !this.enabled,
            onProgress: progress => {
                this.bootstrapProgress = { ...progress };
                control.onProgress?.(this.getStatus());
            }
        })
            .then(analysis => {
                if (generation !== this.bootstrapGeneration || !this.enabled) {
                    return this.getStatus();
                }
                this.lastAggregationDurationMs = performance.now() - startedAt;
                this.aggregationCount += 1;
                const cacheEntry = {
                    analysis,
                    aggregationDurationMs: this.lastAggregationDurationMs,
                    revision: this.revision
                };
                const cacheKey = this.makeCacheKey(bmpSessionMap, analysisOptions);
                this.cache.set(cacheKey, cacheEntry);
                for (const mutation of this.pendingMutations.values()) {
                    applyBmpRouteAssuranceBootstrapMutation(analysis, mutation);
                }
                analysis.summary.scannedPathCount = countBmpRouteAssuranceSourcePaths(bmpSessionMap, analysisOptions);
                this.incrementalUpdateCount += this.pendingMutations.size;
                this.pendingMutations.clear();
                this.state = 'ready';
                this.bootstrapPromise = null;
                this.bootstrapCacheKey = null;
                return this.getStatus();
            })
            .catch(error => {
                if (error?.code === 'BMP_ROUTE_ASSURANCE_CANCELLED') {
                    return this.getStatus();
                }
                if (generation === this.bootstrapGeneration) {
                    this.enabled = false;
                    this.state = 'disabled';
                    this.cache.clear();
                    this.bootstrapPromise = null;
                    this.bootstrapCacheKey = null;
                }
                throw error;
            });
        return this.bootstrapPromise;
    }

    async bootstrapFromPersistedRoutes(routeRows, options = {}, control = {}) {
        const rebuildingInvalidatedSnapshot = this.enabled && this.state === 'dirty';
        this.enabled = true;
        this.state = 'bootstrapping';
        this.dataMode = 'persisted';
        this.bootstrapGeneration += 1;
        const generation = this.bootstrapGeneration;
        this.cache.clear();
        if (!rebuildingInvalidatedSnapshot) {
            this.revision += 1;
            this.invalidationCount += 1;
            this.lastInvalidationReason = 'persisted-routes-bootstrap';
        }
        this.pendingMutations.clear();
        this.bootstrapProgress = { scannedPathCount: 0 };
        const analysisOptions = makeAnalysisOptions(options);
        this.persistedAnalysisOptions = analysisOptions;
        const cacheKey = this.makeCacheKey(this.persistedSourceToken, analysisOptions);
        this.bootstrapCacheKey = cacheKey;
        const startedAt = performance.now();

        this.bootstrapPromise = buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync(routeRows, analysisOptions, {
            chunkSize: control.chunkSize,
            issueChunkSize: control.issueChunkSize,
            resolveContext: control.resolveContext,
            shouldCancel: () => generation !== this.bootstrapGeneration || !this.enabled,
            onProgress: progress => {
                this.bootstrapProgress = { ...progress };
                control.onProgress?.(this.getStatus());
            }
        })
            .then(analysis => {
                if (generation !== this.bootstrapGeneration || !this.enabled) {
                    return this.getStatus();
                }
                this.lastAggregationDurationMs = performance.now() - startedAt;
                this.aggregationCount += 1;
                const cacheEntry = {
                    analysis,
                    aggregationDurationMs: this.lastAggregationDurationMs,
                    revision: this.revision
                };
                this.cache.set(cacheKey, cacheEntry);
                for (const mutation of this.pendingMutations.values()) {
                    applyBmpRouteAssuranceBootstrapMutation(analysis, mutation);
                }
                cacheEntry.revision = this.revision;
                this.incrementalUpdateCount += this.pendingMutations.size;
                this.pendingMutations.clear();
                this.state = 'ready';
                this.bootstrapPromise = null;
                this.bootstrapCacheKey = null;
                return this.getStatus();
            })
            .catch(error => {
                if (error?.code === 'BMP_ROUTE_ASSURANCE_CANCELLED') {
                    return this.getStatus();
                }
                if (generation === this.bootstrapGeneration) {
                    this.state = this.enabled ? 'dirty' : 'disabled';
                    this.cache.clear();
                    this.bootstrapPromise = null;
                    this.bootstrapCacheKey = null;
                    this.pendingMutations.clear();
                }
                throw error;
            });
        return this.bootstrapPromise;
    }

    getPersistedCacheEntry(options = {}) {
        if (!this.enabled) {
            throw new Error('路由矩阵分析未开启');
        }
        if (this.state === 'bootstrapping') {
            throw new Error('路由矩阵正在初始化，请稍候');
        }
        if (this.state === 'dirty') {
            throw new Error('路由矩阵正在重新同步，请稍候');
        }
        const analysisOptions = makeAnalysisOptions(options);
        const cacheKey = this.makeCacheKey(this.persistedSourceToken, analysisOptions);
        const cacheEntry = this.cache.get(cacheKey);
        if (!cacheEntry) {
            const error = new Error('当前持久化路由矩阵不包含该筛选快照，请先重新 bootstrap');
            error.code = 'BMP_ROUTE_ASSURANCE_PERSISTED_SNAPSHOT_MISS';
            throw error;
        }
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cacheEntry);
        return cacheEntry;
    }

    queryPersisted(options = {}) {
        const queryStartedAt = performance.now();
        const cacheEntry = this.getPersistedCacheEntry(options);
        this.cacheHits += 1;
        const result = paginateBmpRouteAssuranceAnalysis(cacheEntry.analysis, options);
        result.summary = {
            ...result.summary,
            cacheHit: true,
            dataRevision: cacheEntry.revision,
            aggregationDurationMs: cacheEntry.aggregationDurationMs,
            queryDurationMs: performance.now() - queryStartedAt
        };
        return result;
    }

    async queryPersistedAsync(options = {}) {
        if (this.state === 'bootstrapping' && this.bootstrapPromise) {
            await this.bootstrapPromise;
        }
        return this.queryPersisted(options);
    }

    applyCommittedDelta(delta) {
        const action = String(delta?.action || '')
            .trim()
            .toLowerCase();
        // Scope/connection transitions can change the effective state of many
        // SQLite rows at once. A single route aggregate cannot represent that;
        // false tells the caller to invalidate and stream a fresh snapshot.
        if (PERSISTED_REBUILD_ACTIONS.has(action)) {
            return false;
        }
        if (PERSISTED_NOOP_ACTIONS.has(action)) {
            return true;
        }
        if (delta?.committed === true && delta.projectionChanged === false) {
            return true;
        }
        if (this.dataMode === 'stream') {
            return this.queueGroupRefresh(delta);
        }
        return this.applyMutation(normalizeBmpRouteAssuranceCommittedDelta(delta));
    }

    getStatus() {
        return {
            enabled: this.enabled,
            state: this.state,
            dataRevision: this.revision,
            cacheSize: this.cache.size,
            incrementalUpdateCount: this.incrementalUpdateCount,
            progress: { ...this.bootstrapProgress },
            dataMode: this.dataMode
        };
    }

    applyMutation(mutation) {
        if (!this.enabled) {
            return false;
        }
        this.revision += 1;
        if (this.state === 'bootstrapping') {
            const scope = mutation.scope === 'instance' ? 'instance' : 'session';
            const stage = mutation.stage || getRouteAssuranceStage(mutation.ribType, scope);
            const sourceKey =
                mutation.sourceKey ||
                makeRouteAssuranceSourceKey({
                    clientKey: mutation.clientKey,
                    scope,
                    ownerKey: mutation.ownerKey,
                    stage,
                    routeKey: mutation.routeKey
                });
            const previousPending = this.pendingMutations.get(sourceKey);
            if (mutation.sourceKey) {
                this.pendingMutations.set(sourceKey, {
                    ...mutation,
                    sourceKey,
                    bootstrapInitiallyNew: previousPending
                        ? previousPending.bootstrapInitiallyNew
                        : mutation.isNew === true
                });
                return true;
            }
            const bootstrapCandidateRoutes = previousPending?.bootstrapCandidateRoutes || new Set();
            [mutation.previous, mutation.route].forEach(route => {
                if ((typeof route === 'object' && route !== null) || typeof route === 'function') {
                    bootstrapCandidateRoutes.add(route);
                }
            });
            this.pendingMutations.set(sourceKey, {
                ...mutation,
                bootstrapCandidateRoutes,
                bootstrapInitiallyNew: previousPending ? previousPending.bootstrapInitiallyNew : mutation.isNew === true
            });
            return true;
        }
        let applied = false;
        this.cache.forEach(cacheEntry => {
            if (applyBmpRouteAssuranceMutation(cacheEntry.analysis, mutation)) {
                cacheEntry.revision = this.revision;
                applied = true;
            }
        });
        if (applied) {
            this.incrementalUpdateCount += 1;
        }
        return applied;
    }

    clear() {
        return this.invalidate('clear');
    }

    getStats() {
        return {
            revision: this.revision,
            dataRevision: this.revision,
            cacheSize: this.cache.size,
            maxCacheEntries: this.maxCacheEntries,
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses,
            aggregationCount: this.aggregationCount,
            invalidationCount: this.invalidationCount,
            evictionCount: this.evictionCount,
            lastInvalidationReason: this.lastInvalidationReason,
            lastAggregationDurationMs: this.lastAggregationDurationMs,
            enabled: this.enabled,
            state: this.state,
            dataMode: this.dataMode,
            bootstrapProgress: { ...this.bootstrapProgress },
            incrementalUpdateCount: this.incrementalUpdateCount,
            groupRefreshCount: this.groupRefreshCount,
            pendingGroupRefreshes: this.pendingGroupRefreshes.size
        };
    }
}

module.exports = BmpRouteAssuranceService;
module.exports.BmpRouteAssuranceService = BmpRouteAssuranceService;
module.exports.DEFAULT_MAX_CACHE_ENTRIES = DEFAULT_MAX_CACHE_ENTRIES;
