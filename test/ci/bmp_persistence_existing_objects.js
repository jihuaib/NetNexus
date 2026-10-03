const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
const Peer = require('../../electron/worker/bmp/bmpBgpSession');
const Instance = require('../../electron/worker/bmp/bmpBgpInstance');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const { buildRouteUpsertMutation } = require('../../electron/worker/bmp/bmpPersistenceMutation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-existing-objects-'));
const TIME = 1767225600000;
let serial = 0;

function context(kind) {
    const session = {
        remoteIp: '192.0.2.10',
        remotePort: 50001,
        localIp: '127.0.0.1',
        localPort: 11019,
        sysName: 'existing-objects',
        persistenceConnectionId: 'existing-objects-connection',
        persistenceConnectionGeneration: 1,
        persistenceOpenedAtMs: TIME
    };
    const owner = kind === 'peer' ? new Peer(session) : new Instance(session);
    Object.assign(
        owner,
        kind === 'peer'
            ? { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65001 }
            : { instanceType: 3, instanceRd: '0:0', instanceIp: '198.51.100.1', instanceAs: 65001 }
    );
    owner.vrfTableNames = ['blue'];
    return { session, owner, kind, ribType: kind === 'peer' ? 2 : 'loc-rib' };
}

function announce(current, index, group = 0, eventAtMs = TIME) {
    const route = new Route(null, null);
    const prefix = `10.${(index >>> 16) & 255}.${(index >>> 8) & 255}.${index & 255}`;
    Object.assign(route, { afi: 1, safi: 1, pathId: 0, ip: prefix, mask: 32, nlriDetail: { prefix, length: 32 } });
    route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: `192.0.2.${group + 1}` });
    const mutation = buildRouteUpsertMutation(current.session, current.owner, route, 1, 1, current.ribType, {
        kind: current.kind,
        state: 'ready',
        scopeState: 'ready',
        eventAtMs
    });
    mutation.route.routeJson = JSON.stringify({ parseStatus: group + 1 });
    return mutation;
}

function request(mutations, includeDeltas = false, batchId = `objects-${++serial}`) {
    return { batchId, createdAtMs: TIME, mutations, includeDeltas };
}

function snapshot(store) {
    const result = {};
    for (const table of [
        'bmp_sources',
        'bmp_connections',
        'bmp_rib_scopes',
        'bmp_scope_route_counts',
        'bmp_route_identities',
        'bmp_route_payloads',
        'bmp_route_attributes',
        'bmp_ingest_batches'
    ]) {
        result[table] = store.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
    }
    result.routes = store.db
        .prepare('SELECT * FROM bmp_current_routes_all ORDER BY partition_id, scope_pk, route_pk')
        .all();
    result.gc = store.db.prepare('SELECT * FROM main.bmp_gc_candidates ORDER BY kind, pk').all();
    return result;
}

// Frozen reference for the previous INSERT-every-object / SELECT algorithm.
function legacyPrefill(mutations, cache) {
    const identities = new Map(),
        payloads = new Map(),
        attributes = new Map();
    for (const mutation of mutations) {
        const route = mutation.route;
        if (!route) continue;
        const time = mutation.eventAtMs ?? Date.now();
        if (route.id && !identities.has(route.id)) identities.set(route.id, { route, time });
        if (typeof route.routeJson === 'string' && !cache.routePayloadHashes.has(route.routeJson)) {
            const hash = crypto.createHash('sha256').update(route.routeJson).digest();
            const hex = hash.toString('hex');
            cache.routePayloadHashes.set(route.routeJson, hex);
            if (!payloads.has(hex)) payloads.set(hex, { hash, json: route.routeJson, time });
        }
        if (route.attrId && route.attrJson && !attributes.has(route.attrId))
            attributes.set(route.attrId, { json: route.attrJson, time });
    }
    const chunks = (map, handler) => {
        const entries = [...map];
        for (let i = 0; i < entries.length; i += 250) handler(entries.slice(i, i + 250));
    };
    chunks(identities, chunk => {
        const params = [];
        for (const [id, { route: r, time }] of chunk)
            params.push(
                id,
                Number(r.keyVersion),
                r.legacyRouteKey || null,
                Number(r.afi),
                Number(r.safi),
                Number(r.pathId || 0),
                r.rd || null,
                r.prefix || null,
                r.prefixLength ?? null,
                r.nlriKind || null,
                r.nlriJson ?? null,
                Number(r.nlriFlags) || 0,
                time,
                time
            );
        this.getBulkStatement('insertIdentities', chunk.length).run(...params);
        for (const row of this.getBulkStatement('selectIdentities', chunk.length).all(...chunk.map(([id]) => id)))
            cache.routeIdentities.set(row.route_id, Number(row.route_pk));
    });
    chunks(payloads, chunk => {
        this.getBulkStatement('insertPayloads', chunk.length).run(
            ...chunk.flatMap(([, x]) => [x.hash, x.json, x.time, x.time])
        );
        for (const row of this.getBulkStatement('selectPayloads', chunk.length).all(...chunk.map(([, x]) => x.hash))) {
            const hex = row.payload_hash.toString('hex');
            if (row.route_json !== payloads.get(hex).json) throw new Error('BMP route payload hash collision');
            cache.routePayloads.set(hex, Number(row.payload_id));
        }
    });
    chunks(attributes, chunk => {
        this.getBulkStatement('insertAttributes', chunk.length).run(
            ...chunk.flatMap(([id, x]) => [id, x.json, x.time, x.time])
        );
        for (const row of this.getBulkStatement('selectAttributes', chunk.length).all(...chunk.map(([id]) => id)))
            cache.attributes.set(row.attr_id, Number(row.attr_pk));
    });
}

function monitor(store) {
    const calls = {};
    const original = store.getBulkStatement.bind(store);
    store.getBulkStatement = (kind, size) => {
        const statement = original(kind, size);
        return new Proxy(statement, {
            get(target, key) {
                if (key === 'run' || key === 'all')
                    return (...args) => {
                        calls[kind] = (calls[kind] || 0) + 1;
                        return Reflect.apply(target[key], target, args);
                    };
                return Reflect.get(target, key, target);
            }
        });
    };
    return calls;
}

function compare(kind, size) {
    const current = context(kind);
    const actual = new Store({ dbPath: path.join(directory, `${kind}-${size}-actual.sqlite3`) }).open();
    const reference = new Store({ dbPath: path.join(directory, `${kind}-${size}-reference.sqlite3`) }).open();
    reference.prefillRouteObjectCaches = legacyPrefill;
    reference.prepareDeferredMetadataRefresh = () => {};
    const calls = monitor(actual);
    try {
        const first = request(
            Array.from({ length: size }, (_, i) => announce(current, i, i % 3)),
            true
        );
        assert.deepEqual(actual.applyBatch(first), reference.applyBatch(first));
        assert.deepEqual(snapshot(actual), snapshot(reference));
        assert.equal(calls.selectIdentities, Math.ceil(size / 250));
        assert.equal(calls.insertIdentitiesReturning, Math.ceil(size / 250));
        for (const key of Object.keys(calls)) delete calls[key];
        const dimensions = snapshot(actual);
        const repeat = request(
            Array.from({ length: size }, (_, i) => announce(current, i, i % 3, TIME + 1000)),
            true
        );
        assert.deepEqual(actual.applyBatch(repeat), reference.applyBatch(repeat));
        assert.deepEqual(snapshot(actual), snapshot(reference));
        assert.deepEqual(calls, { selectIdentities: Math.ceil(size / 250), selectPayloads: 1, selectAttributes: 1 });
        for (const table of ['bmp_route_identities', 'bmp_route_payloads', 'bmp_route_attributes'])
            assert.deepEqual(snapshot(actual)[table], dimensions[table], `${table} first/lastSeen and PK unchanged`);
        const beforeDuplicate = { ...calls };
        assert.equal(actual.applyBatch(repeat).duplicate, true);
        assert.deepEqual(calls, beforeDuplicate);
        const mixed = request(
            [
                announce(current, 0, 0, TIME + 2000),
                announce(current, size, 4, TIME + 2000),
                announce(current, size + 1, 4, TIME + 3000),
                announce(current, size, 4, TIME + 4000)
            ],
            true
        );
        assert.deepEqual(actual.applyBatch(mixed), reference.applyBatch(mixed));
        assert.deepEqual(snapshot(actual), snapshot(reference));
        const newIdentity = actual.db
            .prepare('SELECT first_seen_ms FROM bmp_route_identities WHERE route_id = ?')
            .get(mixed.mutations[1].route.id);
        assert.equal(newIdentity.first_seen_ms, TIME + 2000, 'new shared objects retain first mutation timestamp');
    } finally {
        actual.close();
        reference.close();
    }
}

try {
    for (const kind of ['peer', 'loc-rib']) for (const size of [2, 250, 251, 5000]) compare(kind, size);
    const current = context('peer');
    const store = new Store({ dbPath: path.join(directory, 'collision-and-memo.sqlite3') }).open();
    try {
        store.applyBatch(request([announce(current, 0)]));
        store.db.prepare('UPDATE bmp_route_payloads SET route_json = ?').run('{"corrupted":true}');
        const before = snapshot(store);
        const bad = request([announce(current, 1), announce(current, 0)]);
        assert.throws(() => store.applyBatch(bad), /payload hash collision/);
        assert.deepEqual(snapshot(store), before, 'existing payload collision rolls back new identities and batch id');
        store.db.prepare('UPDATE bmp_route_payloads SET route_json = ?').run(bad.mutations[1].route.routeJson);
        assert.equal(store.applyBatch(bad).applied, 2, 'failed batch id remains retryable');

        let jsonCalls = 0;
        const metadata = {
            toJSON() {
                jsonCalls += 1;
                return { transport: 'tcp' };
            }
        };
        const shared = [announce(current, 0), announce(current, 1)].map(mutation => ({
            ...mutation,
            source: { ...mutation.source, metadata }
        }));
        store.applyBatch(request(shared));
        assert.equal(jsonCalls, 1, 'shared metadata is serialized once despite distinct source DTOs');
        store.applyBatch(
            request(
                [announce(current, 0), announce(current, 1)].map(mutation => ({
                    ...mutation,
                    source: { ...mutation.source, metadata }
                }))
            )
        );
        assert.equal(jsonCalls, 2, 'memo is transaction-local, not a persistent identity cache');
        const changed = [announce(current, 0), announce(current, 1)];
        changed[0].source = { ...changed[0].source, sysName: 'new-label', metadata: { transport: 'tls' } };
        changed[1].source = { ...changed[1].source, sysName: 'new-label', metadata: { transport: 'quic' } };
        const result = store.applyBatch(request(changed, true));
        assert.equal(result.requiresProjectionRebuild, true);
        assert.equal(
            JSON.parse(store.db.prepare('SELECT metadata_json FROM bmp_sources').get().metadata_json).transport,
            'quic'
        );
    } finally {
        store.close();
    }
    console.log('BMP existing-object reads / missing-only inserts / batch-local source memo tests passed');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
