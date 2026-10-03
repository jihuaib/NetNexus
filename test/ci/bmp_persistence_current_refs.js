const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
const Peer = require('../../electron/worker/bmp/bmpBgpSession');
const Instance = require('../../electron/worker/bmp/bmpBgpInstance');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const {
    buildScopeMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-current-refs-'));
const BASE_TIME = 1767225600000;
let caseNumber = 0;

function context(kind, generation = 1) {
    const session = {
        sysName: 'current-refs-router',
        remoteIp: '192.0.2.10',
        remotePort: 50000 + generation,
        localIp: '127.0.0.1',
        localPort: 11019,
        persistenceConnectionId: `current-refs-${generation}`,
        persistenceConnectionGeneration: generation,
        persistenceOpenedAtMs: BASE_TIME + generation
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

function route(index = 0, nextHop = '192.0.2.1') {
    const value = new Route(null, null);
    const prefix = `10.${(index >>> 16) & 255}.${(index >>> 8) & 255}.${index & 255}`;
    Object.assign(value, { afi: 1, safi: 1, pathId: 0, ip: prefix, mask: 32, nlriDetail: { prefix, length: 32 } });
    value.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop });
    return value;
}

function announce(current, value, options = {}) {
    return buildRouteUpsertMutation(current.session, current.owner, value, 1, 1, current.ribType, {
        kind: current.kind,
        state: 'ready',
        scopeState: 'ready',
        eventAtMs: BASE_TIME + current.session.persistenceSequence,
        ...options
    });
}

function advanceEpoch(current) {
    if (current.kind === 'peer') current.owner.advanceRibEpoch(1, 1, current.ribType);
    else current.owner.advanceRibEpoch();
}

function batch(id, mutations, includeDeltas) {
    return { batchId: id, createdAtMs: BASE_TIME, mutations, includeDeltas };
}

function resultSnapshot(result) {
    return { ...result, deltas: result.deltas || [] };
}

function databaseSnapshot(store) {
    const snapshot = {};
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
        snapshot[table] = store.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
    }
    snapshot.routes = store.db
        .prepare('SELECT * FROM bmp_current_routes_all ORDER BY partition_id, scope_pk, route_pk')
        .all();
    snapshot.gc = store.db.prepare('SELECT * FROM main.bmp_gc_candidates ORDER BY kind, pk').all();
    return snapshot;
}

function monitor(store) {
    const calls = { point: 0, bulk: 0 };
    for (const statements of store.partitionStatements.values()) {
        const statement = statements.findCurrentRouteRefs;
        const get = statement.get.bind(statement);
        statements.findCurrentRouteRefs = new Proxy(statement, {
            get(target, key) {
                if (key === 'get')
                    return (...args) => {
                        calls.point += 1;
                        return get(...args);
                    };
                return Reflect.get(target, key, target);
            }
        });
    }
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = sql => {
        const statement = prepare(sql);
        if (!/SELECT route_pk, payload_id, attr_pk, connection_pk,/.test(sql)) return statement;
        const all = statement.all.bind(statement);
        return new Proxy(statement, {
            get(target, key) {
                if (key === 'all')
                    return (...args) => {
                        calls.bulk += 1;
                        return all(...args);
                    };
                return Reflect.get(target, key, target);
            }
        });
    };
    return calls;
}

function compare(kind, includeDeltas, label, build, expectedCalls = null) {
    caseNumber += 1;
    const current = context(kind);
    const inputs = build(current);
    const reference = new Store({ dbPath: path.join(directory, `${caseNumber}-reference.sqlite3`) }).open();
    const actual = new Store({ dbPath: path.join(directory, `${caseNumber}-bulk.sqlite3`) }).open();
    reference.prefillCurrentRouteRefs = () => {};
    try {
        const pointCalls = monitor(reference);
        const bulkCalls = monitor(actual);
        if (inputs.seed?.length) {
            const seed = batch(`${label}-seed`, inputs.seed, includeDeltas);
            reference.applyBatch(seed);
            actual.applyBatch(seed);
        }
        pointCalls.point = 0;
        pointCalls.bulk = 0;
        bulkCalls.point = 0;
        bulkCalls.bulk = 0;
        const request = batch(label, inputs.mutations, includeDeltas);
        const expected = reference.applyBatch(request);
        const received = actual.applyBatch(request);
        assert.deepEqual(
            resultSnapshot(received),
            resultSnapshot(expected),
            `${kind}/${label} committed deltas and flags`
        );
        assert.deepEqual(
            databaseSnapshot(actual),
            databaseSnapshot(reference),
            `${kind}/${label} physical state and GC`
        );
        if (expectedCalls) {
            assert.deepEqual(bulkCalls, expectedCalls, `${kind}/${label} query counts`);
            assert.equal(
                pointCalls.point,
                inputs.mutations.filter(
                    mutation =>
                        ['upsert', 'announce', 'replace', 'refresh'].includes(mutation.eventType) ||
                        (!includeDeltas && mutation.eventType === 'withdraw')
                ).length
            );
        }
        inputs.verify?.(received, actual, bulkCalls);
        // Duplicate batch ids must return before both dimension and refs prefetch.
        const callsBefore = { ...bulkCalls };
        assert.equal(actual.applyBatch(request).duplicate, true);
        assert.deepEqual(bulkCalls, callsBefore);
    } finally {
        actual.close();
        reference.close();
    }
}

try {
    for (const kind of ['peer', 'loc-rib']) {
        for (const includeDeltas of [false, true]) {
            compare(
                kind,
                includeDeltas,
                'insert-refresh-replace-refresh',
                current => ({
                    mutations: [
                        announce(current, route()),
                        announce(current, route()),
                        announce(current, route(0, '192.0.2.2')),
                        announce(current, route(0, '192.0.2.2'))
                    ],
                    verify: result => {
                        if (includeDeltas)
                            assert.deepEqual(
                                result.deltas.map(delta => delta.classification),
                                ['announce', 'replace']
                            );
                    }
                }),
                { point: 0, bulk: 1 }
            );

            compare(
                kind,
                includeDeltas,
                'existing-back-and-forth',
                current => {
                    const seed = [announce(current, route())];
                    return {
                        seed,
                        mutations: [
                            announce(current, route(0, '192.0.2.2')),
                            announce(current, route(0, '192.0.2.2')),
                            announce(current, route()),
                            announce(current, route())
                        ]
                    };
                },
                { point: 0, bulk: 1 }
            );

            compare(
                kind,
                includeDeltas,
                'epoch-forward-old-forward',
                current => {
                    const seed = [announce(current, route())];
                    const oldEpoch = current.owner.getRibEpoch(1, 1, current.ribType);
                    advanceEpoch(current);
                    const forward = announce(current, route());
                    const old = announce(current, route());
                    old.scope = { ...old.scope, epoch: oldEpoch };
                    return {
                        seed,
                        mutations: [forward, old, announce(current, route())],
                        verify: result => {
                            if (includeDeltas) {
                                assert.deepEqual(
                                    result.deltas.map(delta => delta.classification),
                                    ['refresh', 'upsert-noop']
                                );
                                assert.equal(result.deltas[1].previous.ribEpoch, forward.scope.epoch);
                            }
                        }
                    };
                },
                { point: 0, bulk: 1 }
            );

            compare(
                kind,
                includeDeltas,
                'new-old-new-connection',
                current => {
                    const seed = [announce(current, route())];
                    const next = context(kind, 2);
                    return {
                        seed,
                        mutations: [announce(next, route()), announce(current, route()), announce(next, route())],
                        verify: result => {
                            if (includeDeltas)
                                assert.deepEqual(
                                    result.deltas.map(delta => delta.classification),
                                    ['refresh', 'upsert-noop']
                                );
                        }
                    };
                },
                { point: 0, bulk: 1 }
            );

            compare(kind, includeDeltas, 'late-sequence', current => {
                const seed = [announce(current, route())];
                const oldest = announce(current, route());
                const newest = announce(current, route(0, '192.0.2.2'));
                return {
                    seed,
                    mutations: [newest, oldest, announce(current, route(0, '192.0.2.2'))],
                    verify: result => assert.equal(result.applied, 2)
                };
            });

            compare(
                kind,
                includeDeltas,
                'mixed-withdraw',
                current => {
                    const value = route();
                    const first = announce(current, value);
                    return {
                        mutations: [
                            first,
                            buildRouteWithdrawMutation(
                                current.session,
                                current.owner,
                                value,
                                value,
                                1,
                                1,
                                current.ribType,
                                { kind, state: 'ready', eventAtMs: BASE_TIME }
                            ),
                            announce(current, value)
                        ]
                    };
                },
                { point: includeDeltas ? 2 : 3, bulk: 0 }
            );

            compare(
                kind,
                includeDeltas,
                'mixed-eor',
                current => ({
                    mutations: [
                        announce(current, route()),
                        buildScopeMutation(current.session, current.owner, 1, 1, current.ribType, 'scope_eor', {
                            kind,
                            state: 'ready',
                            eventAtMs: BASE_TIME
                        }),
                        announce(current, route())
                    ]
                }),
                { point: 2, bulk: 0 }
            );

            compare(
                kind,
                includeDeltas,
                'single-route-fallback',
                current => ({ mutations: [announce(current, route())] }),
                { point: 1, bulk: 0 }
            );
        }
    }

    for (const size of [250, 251, 5000]) {
        for (const existing of [false, true]) {
            compare(
                'peer',
                false,
                `chunks-${size}-${existing}`,
                current => {
                    const seed = existing
                        ? Array.from({ length: size }, (_, index) => announce(current, route(index)))
                        : [];
                    return {
                        seed,
                        mutations: Array.from({ length: size }, (_, index) => announce(current, route(index)))
                    };
                },
                { point: 0, bulk: Math.ceil(size / 250) }
            );
        }
    }

    // Identical route_pk values must remain isolated by scope and partition.
    compare(
        'peer',
        true,
        'cross-scope-and-partition',
        current => {
            const second = context('peer');
            second.session = current.session;
            second.owner.bmpSession = current.session;
            second.owner.sessionIp = '198.51.100.2';
            const local = context('loc-rib');
            local.session = current.session;
            local.owner.bmpSession = current.session;
            const mutations = [
                announce(current, route()),
                announce(second, route(0, '192.0.2.2')),
                announce(local, route(0, '192.0.2.3')),
                announce(current, route()),
                announce(second, route(0, '192.0.2.2')),
                announce(local, route(0, '192.0.2.3'))
            ];
            return { mutations, verify: result => assert.equal(result.deltas.length, 3) };
        },
        { point: 0, bulk: 3 }
    );

    // All prefetch state is transaction-local and must be discarded on rollback.
    const current = context('peer');
    const store = new Store({ dbPath: path.join(directory, 'rollback.sqlite3') }).open();
    try {
        const first = announce(current, route());
        const invalid = announce(current, route(1));
        invalid.scope = { ...invalid.scope, id: `${invalid.scope.id}-invalid` };
        const identity = invalid.scope.identityJson;
        invalid.scope.identityJson = null;
        const request = batch('rollback-retry', [first, invalid], true);
        assert.throws(() => store.applyBatch(request), /NOT NULL constraint failed/);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bmp_current_routes_all').get().count, 0);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_identities').get().count, 0);
        invalid.scope.identityJson = identity;
        const retried = store.applyBatch(request);
        assert.equal(retried.applied, 2);
        assert.deepEqual(
            retried.deltas.map(delta => delta.classification),
            ['announce', 'announce']
        );
    } finally {
        store.close();
    }

    console.log('BMP batch current refs prefetch tests passed (5000 scalar probes -> 20 bulk queries)');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
