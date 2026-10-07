const fs = require('fs');
const path = require('path');
const BmpPersistenceStore = require('./bmpPersistenceStore');
const { prepareBmpDatabaseVersions } = require('./bmpDatabaseVersionCheck');
const {
    normalizeClientSourceId,
    getClientDatabaseDirectory,
    getClientWorkerIndex,
    assertClientDatabaseDirectory,
    assertClientDatabaseArtifacts,
    listClientDatabases
} = require('./bmpClientPersistencePaths');

const CURSOR_KIND = 'client-routes';
const ROUTE_CURSOR = Symbol('bmpClientRouteCursor');
const NUMERIC_STATUS_FIELDS = ['fileSize', 'walSize', 'totalSize', 'reclaimableBytes', 'logicalSize'];
const COUNT_FIELDS = ['sources', 'connections', 'scopes', 'currentRoutes'];

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function decodeMutations(batch) {
    const mutations = Array.isArray(batch.mutations) ? batch.mutations : [];
    const normalizedSources = new WeakMap();
    const sourceIds = new WeakMap();
    const decoded = mutations.map(mutation => {
        let result = mutation;
        if (batch.refs) {
            const { sourceRef, connectionRef, scopeRef } = mutation;
            if (sourceRef !== undefined || connectionRef !== undefined || scopeRef !== undefined) {
                result = { ...mutation };
            }
            if (sourceRef !== undefined) {
                result.source = batch.refs.sources?.[sourceRef];
                delete result.sourceRef;
            }
            if (connectionRef !== undefined) {
                result.connection = batch.refs.connections?.[connectionRef];
                delete result.connectionRef;
            }
            if (scopeRef !== undefined) {
                result.scope = batch.refs.scopes?.[scopeRef];
                delete result.scopeRef;
            }
        }
        const source = result?.source;
        let normalized = source && normalizedSources.get(source);
        if (!normalized) {
            const id = normalizeClientSourceId(source?.id);
            normalized = source.id === id ? source : { ...source, id };
            normalizedSources.set(source, normalized);
            sourceIds.set(normalized, id);
        }
        if (result.source !== normalized) {
            if (result === mutation) result = { ...mutation };
            result.source = normalized;
        }
        return result;
    });
    return { mutations: decoded, sourceIds };
}

function encodeCursor(sourceId, innerCursor, offset = 0) {
    return Buffer.from(JSON.stringify({ version: 1, kind: CURSOR_KIND, sourceId, innerCursor, offset })).toString(
        'base64url'
    );
}

function decodeCursor(value) {
    if (!value) return null;
    try {
        const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
        if (cursor.version !== 1 || cursor.kind !== CURSOR_KIND) throw new Error('cursor type mismatch');
        cursor.sourceId = normalizeClientSourceId(cursor.sourceId);
        if (cursor.innerCursor !== null && typeof cursor.innerCursor !== 'string')
            throw new Error('invalid inner cursor');
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('invalid cursor offset');
        return cursor;
    } catch (error) {
        throw new Error(`Invalid BMP persistence client routes cursor: ${error.message}`);
    }
}

function emptyRoutes(query = {}) {
    return {
        list: [],
        total: query.includeTotal === false ? null : 0,
        page: positiveInteger(query.page, 1),
        pageSize: positiveInteger(query.pageSize, 100, 5000),
        nextCursor: null
    };
}

function emptySummary() {
    return { active: 0, stale: 0, total: 0, scopes: [] };
}

// An evicted writer connection must not reinterpret live connections as a
// collector restart when it is reopened in the same writer worker.
class SingleClientStore extends BmpPersistenceStore {
    constructor(options, recoveredSources, sourceId) {
        super(options);
        this.recoveredSources = recoveredSources;
        this.clientSourceId = sourceId;
    }

    recoverInterruptedConnections(...args) {
        // Verify before restart recovery mutates connection/scope state. A
        // misplaced client file must be rejected without modifying its data.
        const sources = this.db.prepare('SELECT source_id FROM bmp_sources LIMIT 2').all();
        if (sources.some(source => source.source_id !== this.clientSourceId)) {
            throw new Error(`BMP client database contains data belonging to another source: ${this.clientSourceId}`);
        }
        if (this.recoveredSources.has(this.clientSourceId)) return 0;
        const result = super.recoverInterruptedConnections(...args);
        this.recoveredSources.add(this.clientSourceId);
        return result;
    }

    mapRouteRow(row, ...args) {
        const route = super.mapRouteRow(row, ...args);
        // Keep the exact SQLite keyset position locally. Symbol/non-enumerable
        // metadata is neither JSON-serialized nor sent to the UI by postMessage.
        Object.defineProperty(route, ROUTE_CURSOR, {
            value: Buffer.from(
                JSON.stringify({
                    version: 1,
                    kind: 'routes-by-id',
                    scopePk: row.scope_pk,
                    routePk: row.route_pk
                })
            ).toString('base64url')
        });
        return route;
    }
}

// Each stable BMP client owns a complete, independent SQLite schema. Writer
// workers own disjoint clients; aggregate reads discover the same directory.
class BmpClientPersistenceStore {
    constructor(options = {}) {
        if (!options.dbPath) throw new Error('BMP persistence dbPath is required');
        this.dbPath = path.resolve(options.dbPath);
        this.storageDirectory = getClientDatabaseDirectory(this.dbPath);
        this.readOnly = options.readOnly === true;
        this.sourceId = options.sourceId ? normalizeClientSourceId(options.sourceId) : null;
        this.workerCount = positiveInteger(options.workerCount, 1);
        this.workerIndex = Number(options.workerIndex ?? 0);
        if (!Number.isInteger(this.workerIndex) || this.workerIndex < 0 || this.workerIndex >= this.workerCount) {
            throw new Error('BMP persistence workerIndex is outside workerCount');
        }
        this.maxOpenDatabases = positiveInteger(options.maxOpenDatabases, 32, 256);
        this.logLevel = options.logLevel || 'off';
        this.sqlTraceLog = options.sqlTraceLog;
        this.stores = new Map();
        this.recoveredSources = new Set();
        this.connectionSources = new Map();
        this.scopeSources = new Map();
        this.maintenanceSources = null;
        this.maintenanceSelection = null;
        this.opened = false;
    }

    owns(sourceId) {
        return !this.readOnly && getClientWorkerIndex(sourceId, this.workerCount) === this.workerIndex;
    }

    open() {
        if (this.opened) return this;
        assertClientDatabaseDirectory(this.dbPath, { create: !this.readOnly });
        if (!this.readOnly) {
            prepareBmpDatabaseVersions(this.dbPath, {
                expectedVersion: BmpPersistenceStore.SCHEMA_VERSION,
                workerIndex: this.workerIndex,
                workerCount: this.workerCount
            });
        }
        this.opened = true;
        try {
            // Recover every existing owned client even if no new packet arrives
            // for that client after a collector restart.
            if (!this.readOnly) {
                for (const sourceId of this.discoverSourceIds()) {
                    if (this.owns(sourceId)) this.getStore(sourceId);
                }
            }
        } catch (error) {
            this.close();
            throw error;
        }
        return this;
    }

    discoverSourceIds() {
        const ids = listClientDatabases(this.dbPath).map(item => item.sourceId);
        return this.sourceId ? ids.filter(id => id === this.sourceId) : ids;
    }

    getStore(sourceId, create = false) {
        const id = normalizeClientSourceId(sourceId);
        if (this.sourceId && id !== this.sourceId) throw new Error('BMP client database source mismatch');
        if (create && !this.owns(id)) throw new Error('BMP client database belongs to another writer worker');
        const databasePath = assertClientDatabaseArtifacts(this.dbPath, id);
        if (!fs.existsSync(databasePath) && !create) {
            const old = this.stores.get(id);
            if (old) {
                old.close();
                this.stores.delete(id);
            }
            return null;
        }
        if (!fs.existsSync(databasePath) && create) {
            this.initializeClientDatabase(databasePath);
            assertClientDatabaseArtifacts(this.dbPath, id);
        }
        let store = this.stores.get(id);
        if (store) {
            this.stores.delete(id);
            this.stores.set(id, store);
            return store;
        }
        const options = {
            dbPath: databasePath,
            readOnly: !this.owns(id),
            logLevel: this.logLevel,
            sqlTraceLog: this.sqlTraceLog
        };
        store = new SingleClientStore(options, this.recoveredSources, id).open();
        try {
            const sources = store.db.prepare('SELECT source_id FROM bmp_sources LIMIT 2').all();
            if (sources.some(source => source.source_id !== id)) {
                throw new Error(`BMP client database contains data belonging to another source: ${id}`);
            }
        } catch (error) {
            store.close();
            throw error;
        }
        this.stores.set(id, store);
        while (this.stores.size > this.maxOpenDatabases) {
            const [oldestId, oldestStore] = this.stores.entries().next().value;
            oldestStore.close();
            this.stores.delete(oldestId);
        }
        return store;
    }

    initializeClientDatabase(databasePath) {
        // Readers discover only the final .sqlite3 filename. Build and flush the
        // schema under a private, non-discoverable name, then publish the fully
        // readable file atomically without overwriting an existing client DB.
        const directory = fs.mkdtempSync(path.join(this.storageDirectory, '.initializing-'));
        const temporaryPath = path.join(directory, 'database.sqlite3');
        let initializingStore = null;
        let initializationError = null;
        let cleanupError = null;
        try {
            initializingStore = new BmpPersistenceStore({
                dbPath: temporaryPath,
                logLevel: this.logLevel,
                sqlTraceLog: this.sqlTraceLog
            }).open();
            initializingStore.checkpoint('TRUNCATE');
            initializingStore.close();
            initializingStore = null;
            try {
                fs.linkSync(temporaryPath, databasePath);
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            }
        } catch (error) {
            initializationError = error;
        } finally {
            if (initializingStore) {
                try {
                    initializingStore.close();
                } catch (error) {
                    cleanupError = error;
                }
            }
            // Only these exact files in our newly-created private directory
            // belong to this initialization; never recursively remove storage.
            for (const suffix of ['', '-wal', '-shm', '-journal']) {
                try {
                    fs.unlinkSync(`${temporaryPath}${suffix}`);
                } catch (error) {
                    if (error.code !== 'ENOENT' && !cleanupError) cleanupError = error;
                }
            }
            try {
                fs.rmdirSync(directory);
            } catch (error) {
                if (!cleanupError) cleanupError = error;
            }
        }
        if (initializationError) throw initializationError;
        if (cleanupError) throw cleanupError;
    }

    sourceIdsForQuery(query = {}, ownedOnly = false) {
        let sourceIds;
        if (query.sourceId) {
            const id = normalizeClientSourceId(query.sourceId);
            sourceIds = this.sourceId && this.sourceId !== id ? [] : [id];
        } else if (Array.isArray(query.sourceIds)) {
            sourceIds = Array.from(new Set(query.sourceIds.map(normalizeClientSourceId))).sort();
        } else if (query.scopeId) {
            const id = this.findIdentitySource('scope', String(query.scopeId));
            sourceIds = id ? [id] : [];
        } else {
            sourceIds = this.discoverSourceIds();
        }
        if (this.sourceId) sourceIds = sourceIds.filter(id => id === this.sourceId);
        if (ownedOnly) sourceIds = sourceIds.filter(id => this.owns(id));
        return sourceIds;
    }

    findIdentitySource(kind, identity) {
        const cache = kind === 'connection' ? this.connectionSources : this.scopeSources;
        if (cache.has(identity)) return cache.get(identity);
        const table = kind === 'connection' ? 'bmp_connections' : 'bmp_rib_scopes';
        const column = kind === 'connection' ? 'connection_id' : 'scope_id';
        for (const id of this.discoverSourceIds()) {
            const store = this.getStore(id);
            if (store.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(identity)) {
                cache.set(identity, id);
                return id;
            }
        }
        return null;
    }

    validateMutations(mutations, sourceIds = new WeakMap()) {
        const connections = new Map();
        const scopes = new Map();
        const validatedSources = new Set();
        const validatedConnections = new WeakMap();
        const validatedScopes = new WeakMap();
        for (const mutation of mutations) {
            let sourceId = sourceIds.get(mutation?.source);
            if (!sourceId) {
                sourceId = normalizeClientSourceId(mutation?.source?.id);
                sourceIds.set(mutation.source, sourceId);
            }
            if (!validatedSources.has(sourceId)) {
                if (this.sourceId && sourceId !== this.sourceId) throw new Error('BMP client database source mismatch');
                if (!this.owns(sourceId)) throw new Error('BMP mutation belongs to another writer worker');
                validatedSources.add(sourceId);
            }
            const connection = mutation.connection;
            if (!connection?.id) throw new Error('BMP persistence mutation requires a connection identity');
            const validatedConnectionSource = validatedConnections.get(connection);
            if (validatedConnectionSource) {
                if (validatedConnectionSource !== sourceId)
                    throw new Error('BMP connection source does not match client database');
            } else {
                const declaredConnectionSource = connection.sourceId
                    ? normalizeClientSourceId(connection.sourceId)
                    : null;
                const connectionSource =
                    connections.get(connection.id) ||
                    this.connectionSources.get(connection.id) ||
                    declaredConnectionSource ||
                    this.findIdentitySource('connection', connection.id);
                if (connectionSource && connectionSource !== sourceId)
                    throw new Error('BMP connection source does not match client database');
                if (declaredConnectionSource && declaredConnectionSource !== sourceId)
                    throw new Error('BMP connection source does not match client database');
                connections.set(connection.id, sourceId);
                validatedConnections.set(connection, sourceId);
            }
            const scope = mutation.scope;
            if (scope) {
                if (!scope.id) throw new Error('BMP persistence mutation requires a scope identity');
                const validatedScopeSource = validatedScopes.get(scope);
                if (validatedScopeSource) {
                    if (validatedScopeSource !== sourceId)
                        throw new Error('BMP scope source does not match client database');
                    continue;
                }
                let identitySource = null;
                if (scope.identityJson) {
                    try {
                        identitySource = JSON.parse(scope.identityJson).sourceKeyHex || null;
                    } catch (_error) {
                        throw new Error('Invalid BMP scope identity JSON');
                    }
                }
                const explicitScopeSource = scope.sourceId ? normalizeClientSourceId(scope.sourceId) : null;
                const normalizedIdentitySource = identitySource ? normalizeClientSourceId(identitySource) : null;
                const declaredScopeSource = explicitScopeSource || normalizedIdentitySource;
                const scopeSource =
                    scopes.get(scope.id) ||
                    this.scopeSources.get(scope.id) ||
                    declaredScopeSource ||
                    this.findIdentitySource('scope', scope.id);
                if (
                    (scopeSource && scopeSource !== sourceId) ||
                    (explicitScopeSource && explicitScopeSource !== sourceId) ||
                    (normalizedIdentitySource && normalizedIdentitySource !== sourceId)
                ) {
                    throw new Error('BMP scope source does not match client database');
                }
                scopes.set(scope.id, sourceId);
                validatedScopes.set(scope, sourceId);
            }
        }
        return { connections, scopes };
    }

    applyBatch(batch = {}) {
        if (this.readOnly) throw new Error('Cannot apply a BMP persistence batch to a read-only store');
        if (!batch.batchId) throw new Error('BMP persistence batchId is required');
        if (!this.opened) this.open();
        const { mutations, sourceIds } = decodeMutations(batch);
        // Validate every source and descriptor before committing any client.
        const bindings = this.validateMutations(mutations, sourceIds);
        const groups = new Map();
        for (const mutation of mutations) {
            const id = sourceIds.get(mutation.source);
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(mutation);
        }
        let duplicate = groups.size > 0;
        let applied = 0;
        let requiresProjectionRebuild = false;
        const deltas = [];
        for (const [id, clientMutations] of groups) {
            const result = this.getStore(id, true).applyBatch({
                ...batch,
                refs: undefined,
                mutations: clientMutations
            });
            duplicate = duplicate && result.duplicate;
            requiresProjectionRebuild ||=
                result.requiresProjectionRebuild || (result.duplicate && batch.includeDeltas !== false);
            applied += result.applied;
            if (result.deltas) deltas.push(...result.deltas);
        }
        for (const [identity, id] of bindings.connections) this.connectionSources.set(identity, id);
        for (const [identity, id] of bindings.scopes) this.scopeSources.set(identity, id);
        const result = { duplicate, applied };
        if (requiresProjectionRebuild) result.requiresProjectionRebuild = true;
        if (batch.includeDeltas !== false)
            Object.defineProperty(result, 'deltas', { value: deltas, enumerable: false });
        return result;
    }

    *iterateRoutes(sourceId, query, options = {}) {
        let page = 1;
        let cursor = options.innerCursor || null;
        let skip = options.offset || 0;
        const firstSeen = query.orderBy === 'firstSeen';
        for (;;) {
            // A firstSeen merge can yield while another client evicts this DB.
            // Reacquire every chunk instead of reopening an untracked handle.
            const store = this.getStore(sourceId);
            if (!store) return;
            const result = store.queryRoutes({ ...query, sourceId, page, pageSize: 256, includeTotal: false, cursor });
            for (let index = 0; index < result.list.length; index += 1) {
                if (skip > 0) {
                    skip -= 1;
                    continue;
                }
                yield { route: result.list[index], sourceId, innerCursor: cursor, offset: index + 1 };
            }
            if (firstSeen) {
                if (result.list.length < 256) return;
                page += 1;
            } else {
                if (!result.nextCursor) return;
                cursor = result.nextCursor;
            }
        }
    }

    queryRoutes(query = {}) {
        const orderBy = query.orderBy || 'routeId';
        if (!['routeId', 'firstSeen'].includes(orderBy))
            throw new Error(`Unsupported BMP persistence route order: ${orderBy}`);
        const cursor = decodeCursor(query.cursor);
        if (cursor && orderBy === 'firstSeen')
            throw new Error('BMP persistence routes cursor cannot be combined with orderBy firstSeen');
        const result = emptyRoutes(query);
        const sourceIds = this.sourceIdsForQuery(query);
        if (sourceIds.length === 1 && (!cursor || (cursor.sourceId === sourceIds[0] && cursor.offset === 0))) {
            const sourceId = sourceIds[0];
            const store = this.getStore(sourceId);
            if (!store) return result;
            const direct = store.queryRoutes({ ...query, sourceId, cursor: cursor?.innerCursor });
            direct.nextCursor = direct.nextCursor ? encodeCursor(sourceId, direct.nextCursor) : null;
            return direct;
        }
        const innerQuery = { ...query, cursor: undefined };
        if (query.includeTotal !== false) {
            result.total = sourceIds.reduce((total, id) => {
                const store = this.getStore(id);
                return (
                    total + (store ? store.queryRoutes({ ...innerQuery, sourceId: id, page: 1, pageSize: 1 }).total : 0)
                );
            }, 0);
        }
        let skip = cursor ? 0 : (result.page - 1) * result.pageSize;
        let last = null;
        let hasMore = false;
        const consume = entry => {
            if (skip > 0) {
                skip -= 1;
                return true;
            }
            if (result.list.length >= result.pageSize) {
                hasMore = true;
                return false;
            }
            result.list.push(entry.route);
            last = entry;
            return true;
        };
        if (orderBy === 'firstSeen') {
            // At most one bounded chunk per client is resident during the merge.
            const pending = sourceIds
                .map(id => {
                    const iterator = this.iterateRoutes(id, innerQuery);
                    return { iterator, entry: iterator.next() };
                })
                .filter(item => !item.entry.done);
            while (pending.length > 0) {
                pending.sort(
                    (left, right) =>
                        String(left.entry.value.route.firstSeenAt).localeCompare(
                            String(right.entry.value.route.firstSeenAt)
                        ) || left.entry.value.sourceId.localeCompare(right.entry.value.sourceId)
                );
                const next = pending[0];
                if (!consume(next.entry.value)) break;
                next.entry = next.iterator.next();
                if (next.entry.done) pending.shift();
            }
        } else {
            for (const id of sourceIds) {
                if (cursor && id < cursor.sourceId) continue;
                const position = cursor && id === cursor.sourceId ? cursor : {};
                let finished = false;
                for (const entry of this.iterateRoutes(id, innerQuery, position)) {
                    if (!consume(entry)) {
                        finished = true;
                        break;
                    }
                }
                if (finished) break;
            }
        }
        result.nextCursor =
            orderBy === 'routeId' && hasMore && last ? encodeCursor(last.sourceId, last.route[ROUTE_CURSOR], 0) : null;
        return result;
    }

    queryRouteScope(query = {}) {
        const routeQuery = query.routeQuery || {};
        const summaryQuery = query.summaryQuery || {};
        const declaredSources = [query.sourceId, routeQuery.sourceId, summaryQuery.sourceId]
            .filter(value => value !== undefined && value !== null && value !== '')
            .map(normalizeClientSourceId);
        if (new Set(declaredSources).size > 1)
            throw new Error('BMP route scope query has conflicting client sourceIds');
        const explicitSourceId = declaredSources[0] || null;
        const selector = { ...summaryQuery, ...routeQuery, sourceId: explicitSourceId };
        if (selector.scopeId && !selector.sourceId)
            selector.sourceId = this.findIdentitySource('scope', selector.scopeId);
        if (selector.sourceId) {
            if (this.sourceId && selector.sourceId !== this.sourceId) {
                return { routes: emptyRoutes(routeQuery), summary: emptySummary() };
            }
            const store = this.getStore(selector.sourceId);
            if (store) {
                store.refreshQueryStatistics();
                // Preserve the route page and counter summary's single-client
                // transaction rather than taking two independent snapshots.
                return store.db.transaction(() => ({
                    routes: this.queryRoutes({ ...routeQuery, sourceId: selector.sourceId }),
                    summary: store.queryScopeSummary({ ...summaryQuery, sourceId: selector.sourceId })
                }))();
            }
            return { routes: emptyRoutes(routeQuery), summary: emptySummary() };
        }
        return { routes: this.queryRoutes(routeQuery), summary: this.queryScopeSummary(summaryQuery) };
    }

    queryScopeSummary(query = {}) {
        const result = emptySummary();
        for (const id of this.sourceIdsForQuery(query)) {
            const store = this.getStore(id);
            if (!store) continue;
            const summary = store.queryScopeSummary({ ...query, sourceId: id });
            result.active += summary.active;
            result.stale += summary.stale;
            result.total += summary.total;
            result.scopes.push(...summary.scopes);
            for (const scope of summary.scopes) this.scopeSources.set(scope.scopeId, id);
        }
        result.scopes.sort((left, right) => left.scopeId.localeCompare(right.scopeId));
        return result;
    }

    queryTopology(query = {}) {
        const result = {
            clients: [],
            scopes: [],
            routeSummary: { active: 0, stale: 0, total: 0 },
            sourceCount: 0,
            sessionCount: 0,
            instanceCount: 0,
            scopeCount: 0
        };
        for (const id of this.sourceIdsForQuery(query)) {
            const store = this.getStore(id);
            if (!store) continue;
            const topology = store.queryTopology({ ...query, sourceId: id });
            result.clients.push(...topology.clients);
            result.scopes.push(...topology.scopes);
            for (const field of ['active', 'stale', 'total'])
                result.routeSummary[field] += topology.routeSummary[field];
            for (const field of ['sourceCount', 'sessionCount', 'instanceCount', 'scopeCount'])
                result[field] += topology[field];
            for (const scope of topology.scopes) this.scopeSources.set(scope.scopeId, id);
        }
        return result;
    }

    queryStatisticsReports(query = {}) {
        if (!query.sourceId) throw new Error('BMP statistics report query requires sourceId');
        const store = this.getStore(query.sourceId);
        return store ? store.queryStatisticsReports(query) : [];
    }

    streamRouteAssuranceRows(query = {}, emit) {
        if (typeof emit !== 'function') throw new Error('BMP route assurance stream requires an emit callback');
        const result = { rows: 0, cancelled: false };
        for (const id of this.sourceIdsForQuery(query)) {
            const store = this.getStore(id);
            if (!store) continue;
            const streamed = store.streamRouteAssuranceRows({ ...query, sourceId: id }, emit);
            result.rows += streamed.rows;
            if (streamed.cancelled) {
                result.cancelled = true;
                break;
            }
        }
        return result;
    }

    getStatus(options = {}) {
        const clientDatabases = [];
        for (const id of this.sourceIdsForQuery(options, !this.readOnly && options.ownedOnly === true)) {
            const store = this.getStore(id);
            if (store) clientDatabases.push({ sourceId: id, ...store.getStatus(options) });
        }
        const result = {
            ready: !this.readOnly || clientDatabases.length > 0,
            dbPath: this.dbPath,
            storageMode: 'client-databases',
            storageDirectory: this.storageDirectory,
            storagePath: this.storageDirectory,
            storageLayout: 'client-databases',
            schemaVersion: BmpPersistenceStore.SCHEMA_VERSION,
            journalMode: 'wal',
            clientDatabaseCount: clientDatabases.length,
            clientDatabases,
            availableDiskBytes: null,
            countsExact: options.includeCounts === true
        };
        for (const field of NUMERIC_STATUS_FIELDS)
            result[field] = clientDatabases.reduce((sum, client) => sum + Number(client[field] || 0), 0);
        for (const field of COUNT_FIELDS)
            result[field] =
                options.includeCounts === true
                    ? clientDatabases.reduce((sum, client) => sum + Number(client[field] || 0), 0)
                    : null;
        const available = clientDatabases
            .map(client => client.availableDiskBytes)
            .filter(value => Number.isFinite(value));
        if (available.length) result.availableDiskBytes = Math.min(...available);
        return result;
    }

    purgeSource(query = {}) {
        if (this.readOnly) throw new Error('Cannot purge a source from a read-only BMP persistence store');
        const id = normalizeClientSourceId(query.sourceId);
        if (!this.owns(id)) throw new Error('BMP client database belongs to another writer worker');
        const store = this.getStore(id);
        const result = store
            ? store.db.transaction(() => {
                  const purged = store.purgeSource({ ...query, sourceId: id });
                  // The underlying shared Store garbage-collects only recent route
                  // references. In a client-exclusive DB, deletion also owns all
                  // historical orphan attributes, payloads and route identities.
                  for (const [field, table] of [
                      ['routeAttributes', 'bmp_route_attributes'],
                      ['routePayloads', 'bmp_route_payloads'],
                      ['routeIdentities', 'bmp_route_identities'],
                      ['ingestBatches', 'bmp_ingest_batches']
                  ])
                      purged.counts[field] += store.db.prepare(`DELETE FROM ${table}`).run().changes;
                  store.db.prepare('DELETE FROM main.bmp_gc_candidates').run();
                  return purged;
              })()
            : {
                  sourceId: id,
                  deleted: false,
                  counts: {
                      sources: 0,
                      connections: 0,
                      scopes: 0,
                      currentRoutes: 0,
                      statisticsSamples: 0,
                      statisticsLatest: 0,
                      routeAttributes: 0,
                      ingestBatches: 0,
                      routeIdentities: 0,
                      routePayloads: 0
                  }
              };
        for (const [identity, sourceId] of this.connectionSources)
            if (sourceId === id) this.connectionSources.delete(identity);
        for (const [identity, sourceId] of this.scopeSources) if (sourceId === id) this.scopeSources.delete(identity);
        // Keep the empty file so already-open readers keep the same inode and
        // see the committed deletion. Whole-storage deletion closes all workers.
        return result;
    }

    purgeStaleRoutes(query = {}) {
        if (this.readOnly) throw new Error('Cannot purge stale routes from a read-only BMP persistence store');
        if (!query.scopeId && !query.ownerKey) throw new Error('BMP stale route purge requires scopeId or ownerKey');
        const compact = query.includeDetails === false;
        const routeLimit = positiveInteger(query.routeLimit, 2000, 20000);
        const result = compact
            ? { purged: 0, hasMore: false, affectedScopes: [], nextCursor: null }
            : { purged: 0, hasMore: false, routes: [], deltas: [] };
        const sourceIds = this.sourceIdsForQuery(query, true);
        for (const [index, id] of sourceIds.entries()) {
            const store = this.getStore(id);
            if (!store) continue;
            const purged = store.purgeStaleRoutes({
                ...query,
                sourceId: id,
                ...(compact ? { routeLimit: routeLimit - result.purged } : {})
            });
            result.purged += purged.purged;
            result.hasMore ||= purged.hasMore;
            if (compact) {
                result.affectedScopes.push(...purged.affectedScopes);
                if (result.purged >= routeLimit) {
                    result.hasMore ||= index < sourceIds.length - 1;
                    break;
                }
            } else {
                result.routes.push(...purged.routes);
                result.deltas.push(...purged.deltas);
            }
        }
        return result;
    }

    sweep(options = {}) {
        if (this.readOnly) throw new Error('Cannot sweep a read-only BMP persistence store');
        const numericFields = [
            'routes',
            'statistics',
            'batches',
            'attributes',
            'payloads',
            'identities',
            'finalizedCleanupScopes',
            'refreshTimeoutScopes',
            'reconnectTimeoutScopes'
        ];
        const result = {
            affectedScopes: [],
            nextRefreshStartedMs: null,
            nextRefreshSourceId: null,
            effectiveLimits: {},
            hasMore: false
        };
        for (const field of numericFields) result[field] = 0;
        let sourceIds = this.sourceIdsForQuery(options, true);
        const boundedMaintenance = options.mode !== 'lifecycle' && !options.sourceId;
        if (boundedMaintenance) {
            const selection = JSON.stringify({
                sourceIds: Array.isArray(options.sourceIds)
                    ? [...new Set(options.sourceIds.map(normalizeClientSourceId))].sort()
                    : null,
                scopeId: options.scopeId || null
            });
            if (!this.maintenanceSources || this.maintenanceSelection !== selection) {
                this.maintenanceSources = [...sourceIds];
                this.maintenanceSelection = selection;
            }
            sourceIds = this.maintenanceSources.slice(0, 1);
        }
        for (const id of sourceIds) {
            const store = this.getStore(id);
            if (!store) {
                if (boundedMaintenance) this.maintenanceSources.shift();
                continue;
            }
            const swept = store.sweep({ ...options, sourceId: id });
            for (const field of numericFields) result[field] += Number(swept[field] || 0);
            result.affectedScopes.push(...swept.affectedScopes);
            result.hasMore ||= swept.hasMore;
            result.effectiveLimits = swept.effectiveLimits;
            if (boundedMaintenance && !swept.hasMore) this.maintenanceSources.shift();
        }
        if (boundedMaintenance) {
            result.hasMore ||= this.maintenanceSources.length > 0;
            if (!this.maintenanceSources.length) this.maintenanceSources = null;
        }
        if (options.includeGlobalDeadline !== false) {
            const deadline = this.queryRefreshDeadline();
            result.nextRefreshStartedMs = deadline?.started_at_ms ?? null;
            result.nextRefreshSourceId = deadline?.source_id ?? null;
        }
        return result;
    }

    queryRefreshDeadline() {
        let deadline = null;
        for (const id of this.discoverSourceIds()) {
            const store = this.getStore(id);
            if (!store) continue;
            const candidate = store.queryRefreshDeadline();
            if (
                candidate &&
                (!deadline ||
                    candidate.started_at_ms < deadline.started_at_ms ||
                    (candidate.started_at_ms === deadline.started_at_ms && candidate.source_id < deadline.source_id))
            )
                deadline = candidate;
        }
        return deadline;
    }

    checkpoint(mode = 'PASSIVE') {
        if (this.readOnly) return null;
        const result = [];
        for (const id of this.sourceIdsForQuery({}, true)) {
            const store = this.getStore(id);
            if (store) result.push({ sourceId: id, result: store.checkpoint(mode) });
        }
        return result;
    }

    setLogLevel(level) {
        this.logLevel = level;
        for (const store of this.stores.values()) store.setLogLevel(level);
        return this.logLevel;
    }

    isSqlTraceEnabled() {
        return this.logLevel === 'debug';
    }

    close() {
        let failure = null;
        for (const store of this.stores.values()) {
            try {
                store.close();
            } catch (error) {
                failure ||= error;
            }
        }
        this.stores.clear();
        this.recoveredSources.clear();
        this.connectionSources.clear();
        this.scopeSources.clear();
        this.maintenanceSources = null;
        this.maintenanceSelection = null;
        this.opened = false;
        if (failure) throw failure;
    }
}

BmpClientPersistenceStore.SCHEMA_VERSION = BmpPersistenceStore.SCHEMA_VERSION;
module.exports = BmpClientPersistenceStore;
