const { performance } = require('node:perf_hooks');
const BmpConst = require('../const/bmpConst');
const {
    applyBmpRouteAssuranceBootstrapMutation,
    applyBmpRouteAssuranceMutation,
    buildBmpRouteAssuranceAnalysis,
    buildBmpRouteAssuranceAnalysisAsync,
    countBmpRouteAssuranceSourcePaths,
    getRouteAssuranceStage,
    makeRouteAssuranceSourceKey,
    paginateBmpRouteAssuranceAnalysis
} = require('./bmpRouteAssurance');

// A million-path snapshot may be large. Keep one analysis by default so a
// filter change releases the previous snapshot instead of retaining several
// full-network aggregates. Callers can opt into a larger LRU explicitly.
const DEFAULT_MAX_CACHE_ENTRIES = 1;
const PAGINATION_ONLY_OPTIONS = new Set(['category', 'page', 'pageSize']);

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
                analysis.summary.scannedPathCount = countBmpRouteAssuranceSourcePaths(
                    bmpSessionMap,
                    analysisOptions
                );
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
        this.state =
            this.enabled && options.prepareBootstrap === true ? 'dirty' : this.enabled ? 'ready' : 'disabled';
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
                analysis.summary.scannedPathCount = countBmpRouteAssuranceSourcePaths(
                    bmpSessionMap,
                    analysisOptions
                );
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

    getStatus() {
        return {
            enabled: this.enabled,
            state: this.state,
            dataRevision: this.revision,
            cacheSize: this.cache.size,
            incrementalUpdateCount: this.incrementalUpdateCount,
            progress: { ...this.bootstrapProgress }
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
            const sourceKey = makeRouteAssuranceSourceKey({
                clientKey: mutation.clientKey,
                scope,
                ownerKey: mutation.ownerKey,
                stage,
                routeKey: mutation.routeKey
            });
            const previousPending = this.pendingMutations.get(sourceKey);
            const bootstrapCandidateRoutes = previousPending?.bootstrapCandidateRoutes || new Set();
            [mutation.previous, mutation.route].forEach(route => {
                if ((typeof route === 'object' && route !== null) || typeof route === 'function') {
                    bootstrapCandidateRoutes.add(route);
                }
            });
            this.pendingMutations.set(sourceKey, {
                ...mutation,
                bootstrapCandidateRoutes,
                bootstrapInitiallyNew: previousPending
                    ? previousPending.bootstrapInitiallyNew
                    : mutation.isNew === true
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
            bootstrapProgress: { ...this.bootstrapProgress },
            incrementalUpdateCount: this.incrementalUpdateCount
        };
    }
}

module.exports = BmpRouteAssuranceService;
module.exports.BmpRouteAssuranceService = BmpRouteAssuranceService;
module.exports.DEFAULT_MAX_CACHE_ENTRIES = DEFAULT_MAX_CACHE_ENTRIES;
