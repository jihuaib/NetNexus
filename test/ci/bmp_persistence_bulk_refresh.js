const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
const Peer = require('../../electron/worker/bmp/bmpBgpSession');
const Instance = require('../../electron/worker/bmp/bmpBgpInstance');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const { resolveBmpRoutePartition } = require('../../electron/worker/bmp/bmpRoutePartitionManifest');
const {
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation,
    buildScopeMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-bulk-refresh-'));
const TIME = 1767225600000;
let serial = 0;

function context(kind, generation = 1) {
    const session = {
        remoteIp: '192.0.2.10',
        remotePort: 50000 + generation,
        localIp: '127.0.0.1',
        localPort: 11019,
        sysName: 'bulk-refresh',
        persistenceConnectionId: `bulk-refresh-${generation}`,
        persistenceConnectionGeneration: generation,
        persistenceOpenedAtMs: TIME + generation
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

function route(index, group = 0) {
    const value = new Route(null, null);
    const prefix = `10.${(index >>> 16) & 255}.${(index >>> 8) & 255}.${index & 255}`;
    Object.assign(value, { afi: 1, safi: 1, pathId: 0, ip: prefix, mask: 32, nlriDetail: { prefix, length: 32 } });
    value.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: `192.0.2.${group + 1}` });
    return value;
}

function announce(current, index, group = 0, options = {}) {
    return buildRouteUpsertMutation(current.session, current.owner, route(index, group), 1, 1, current.ribType, {
        kind: current.kind,
        state: 'ready',
        scopeState: 'ready',
        eventAtMs: TIME + 1000,
        sourceTimestampMs: TIME + 100,
        ...options
    });
}

function batch(label, mutations, includeDeltas) {
    return { batchId: label, createdAtMs: TIME, mutations, includeDeltas };
}

function cloneWorkerMessage(value) {
    const channel = new MessageChannel();
    try {
        channel.port1.postMessage(value);
        return receiveMessageOnPort(channel.port2).message;
    } finally {
        channel.port1.close();
        channel.port2.close();
    }
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
    ])
        result[table] = store.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
    result.routes = store.db
        .prepare('SELECT * FROM bmp_current_routes_all ORDER BY partition_id, scope_pk, route_pk')
        .all();
    result.gc = store.db.prepare('SELECT * FROM main.bmp_gc_candidates ORDER BY kind, pk').all();
    return result;
}

function monitor(store) {
    const calls = { point: 0, bulk: 0, rows: 0, lastStatement: null, lastParams: null };
    for (const statements of store.partitionStatements.values()) {
        const original = statements.refreshRouteMetadata;
        statements.refreshRouteMetadata = new Proxy(original, {
            get(target, key) {
                if (key === 'run')
                    return (...args) => {
                        calls.point += 1;
                        return Reflect.apply(target.run, target, args);
                    };
                return Reflect.get(target, key, target);
            }
        });
    }
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = sql => {
        const statement = prepare(sql);
        if (!sql.includes('WITH seen(route_pk, payload_id, attr_pk,')) return statement;
        return new Proxy(statement, {
            get(target, key) {
                if (key === 'run')
                    return (...args) => {
                        calls.bulk += 1;
                        calls.rows += (args.length - 4) / 6;
                        calls.lastStatement = target;
                        calls.lastParams = args;
                        return Reflect.apply(target.run, target, args);
                    };
                return Reflect.get(target, key, target);
            }
        });
    };
    return calls;
}

function assertPointLookupPlan(store, calls) {
    const details = store.db
        .prepare(`EXPLAIN QUERY PLAN ${calls.lastStatement.source}`)
        .all(...calls.lastParams)
        .map(row => row.detail);
    const seen = details.findIndex(detail => detail === 'SCAN seen');
    const target = details.findIndex(detail => /^SEARCH r USING INTEGER PRIMARY KEY \(rowid=\?\)$/.test(detail));
    assert.ok(seen >= 0 && target > seen, `seen must drive point lookups: ${details.join('; ')}`);
    assert.ok(
        details.some(detail =>
            /^SEARCH candidate USING INDEX sqlite_autoindex_.* \(scope_pk=\? AND route_pk=\?\)$/.test(detail)
        ),
        `candidate must use both columns of its unique index: ${details.join('; ')}`
    );
    assert.equal(
        details.some(detail => /^SCAN r(?:\s|$)|^SEARCH r USING INDEX /.test(detail)),
        false,
        'never scan a million-route target scope/epoch for each seen chunk'
    );
}

function compare(kind, includeDeltas, label, build, verify) {
    serial += 1;
    const current = context(kind);
    const input = build(current);
    const actual = new Store({ dbPath: path.join(directory, `${serial}-actual.sqlite3`) }).open();
    const reference = new Store({ dbPath: path.join(directory, `${serial}-reference.sqlite3`) }).open();
    reference.prepareDeferredMetadataRefresh = () => {};
    const calls = monitor(actual);
    try {
        if (input.seed?.length) {
            const seed = batch(`${label}-seed`, input.seed, includeDeltas);
            actual.applyBatch(seed);
            reference.applyBatch(seed);
        }
        input.before?.(actual, reference);
        calls.point = calls.bulk = calls.rows = 0;
        const request = batch(label, input.mutations, includeDeltas);
        const received = actual.applyBatch(request),
            expected = reference.applyBatch(request);
        assert.deepEqual(
            { ...received, deltas: received.deltas || [] },
            { ...expected, deltas: expected.deltas || [] },
            label
        );
        assert.deepEqual(
            snapshot(actual),
            snapshot(reference),
            `${kind}/${label} physical state, refs, times, counts, GC`
        );
        verify?.(received, actual, calls, input);
        const counts = [calls.point, calls.bulk, calls.rows];
        assert.equal(actual.applyBatch(request).duplicate, true);
        assert.deepEqual([calls.point, calls.bulk, calls.rows], counts);
    } finally {
        actual.close();
        reference.close();
    }
}

try {
    for (const kind of ['peer', 'loc-rib'])
        for (const includeDeltas of [false, true]) {
            compare(
                kind,
                includeDeltas,
                'timestamps-and-null',
                current => ({
                    seed: [announce(current, 0), announce(current, 1)],
                    mutations: [
                        announce(current, 0, 0, { eventAtMs: TIME - 100, sourceTimestampMs: null }),
                        announce(current, 1, 0, { eventAtMs: TIME + 3000, sourceTimestampMs: TIME + 2000 })
                    ]
                }),
                (result, store, calls) => {
                    assert.equal(calls.point, 0);
                    assert.equal(calls.bulk, 1);
                    assert.equal(calls.rows, 2);
                    const rows = snapshot(store).routes;
                    assert.equal(rows[0].last_seen_ms, TIME + 1000);
                    assert.equal(rows[0].source_timestamp_ms, null);
                    assert.equal(rows[1].last_seen_ms, TIME + 3000);
                    if (includeDeltas) assert.deepEqual(result.deltas, []);
                    assert.equal(result.requiresProjectionRebuild, undefined);
                    const operations = store.db
                        .prepare(`EXPLAIN ${calls.lastStatement.source}`)
                        .all(...calls.lastParams);
                    assert.equal(
                        operations.some(row => ['IdxDelete', 'IdxInsert', 'Program'].includes(row.opcode)),
                        false,
                        'set-based metadata refresh must not rewrite persistent indexes or run triggers'
                    );
                    assertPointLookupPlan(store, calls);
                }
            );

            compare(
                kind,
                includeDeltas,
                'new-attrs-existing-and-new-rows',
                current => ({
                    seed: [announce(current, 0), announce(current, 1), announce(current, 2)],
                    mutations: [
                        announce(current, 0),
                        announce(current, 1, 1),
                        announce(current, 2),
                        announce(current, 3)
                    ]
                }),
                (result, store, calls) => {
                    assert.equal(calls.point, 0);
                    assert.equal(calls.bulk, 1);
                    assert.equal(calls.rows, 2);
                    assert.equal(snapshot(store).routes.length, 4);
                    if (includeDeltas)
                        assert.deepEqual(
                            result.deltas.map(x => x.classification),
                            ['replace', 'announce']
                        );
                }
            );

            compare(
                kind,
                includeDeltas,
                'nullable-attribute-refresh',
                current => {
                    const clearAttributes = mutation => {
                        mutation.route.attrId = null;
                        mutation.route.attrJson = null;
                        return mutation;
                    };
                    return {
                        seed: [clearAttributes(announce(current, 0)), clearAttributes(announce(current, 1))],
                        mutations: [
                            clearAttributes(announce(current, 0, 0, { eventAtMs: TIME + 9000 })),
                            clearAttributes(announce(current, 1, 0, { eventAtMs: TIME + 9000 }))
                        ]
                    };
                },
                (result, store, calls) => {
                    assert.equal(calls.point, 0);
                    assert.equal(calls.bulk, 1);
                    assert.equal(calls.rows, 2);
                    for (const row of snapshot(store).routes) {
                        assert.equal(row.attr_pk, null);
                        assert.equal(row.last_seen_ms, TIME + 9000);
                    }
                    if (includeDeltas) assert.deepEqual(result.deltas, []);
                }
            );

            for (const transition of ['connection', 'epoch'])
                compare(
                    kind,
                    includeDeltas,
                    `new-${transition}-semantic`,
                    current => {
                        const seed = [announce(current, 0), announce(current, 1)];
                        let next = current;
                        if (transition === 'connection') next = context(kind, 2);
                        else if (kind === 'peer') current.owner.advanceRibEpoch(1, 1, current.ribType);
                        else current.owner.advanceRibEpoch();
                        return { seed, mutations: [announce(next, 0), announce(next, 1)] };
                    },
                    (result, store, calls, input) => {
                        assert.equal(calls.point, 0);
                        assert.equal(calls.bulk, 0);
                        assert.equal(calls.rows, 0);
                        for (const row of store.queryRoutes({ routeState: 'all', pageSize: 10 }).list) {
                            assert.equal(row.persistentConnectionId, input.mutations[0].connection.id);
                            assert.equal(row.ribEpoch, input.mutations[0].scope.epoch);
                            assert.equal(row.routeState, 'active');
                        }
                        if (includeDeltas)
                            assert.deepEqual(
                                result.deltas.map(x => x.classification),
                                ['refresh', 'refresh']
                            );
                    }
                );

            compare(
                kind,
                includeDeltas,
                'old-sequence',
                current => {
                    const seed = [announce(current, 0), announce(current, 1), announce(current, 2)];
                    const old = announce(current, 0),
                        newer = announce(current, 1);
                    return { seed, mutations: [newer, old, announce(current, 2)] };
                },
                (result, _store, calls) => {
                    assert.equal(result.applied, 2);
                    assert.equal(calls.rows, 2);
                    assert.equal(calls.point, 0);
                }
            );

            compare(
                kind,
                includeDeltas,
                'row-sequence-guard',
                current => ({
                    seed: [announce(current, 0), announce(current, 1)],
                    mutations: [announce(current, 0, 0, { eventAtMs: TIME + 9000 }), announce(current, 1)],
                    before: (actual, reference) => {
                        const partition = resolveBmpRoutePartition({ scopeKind: kind, afi: 1, safi: 1 });
                        for (const store of [actual, reference])
                            store.db
                                .prepare(
                                    `UPDATE ${partition.quotedTableName} SET last_sequence = 1000 WHERE route_pk = 1`
                                )
                                .run();
                    }
                }),
                (_result, store, calls) => {
                    assert.equal(calls.rows, 2);
                    assert.equal(calls.point, 0);
                    const first = snapshot(store).routes[0];
                    assert.equal(first.last_seen_ms, TIME + 1000);
                    assert.equal(first.last_sequence, 1000);
                }
            );

            for (const guard of ['epoch', 'owner'])
                compare(
                    kind,
                    includeDeltas,
                    `actual-scope-${guard}`,
                    current => ({
                        seed: [announce(current, 0), announce(current, 1)],
                        mutations: [
                            announce(current, 0, 0, { eventAtMs: TIME + 9000 }),
                            announce(current, 1, 0, { eventAtMs: TIME + 9000 })
                        ],
                        before: (actual, reference) => {
                            for (const store of [actual, reference]) {
                                if (guard === 'epoch')
                                    store.db
                                        .prepare('UPDATE bmp_rib_scopes SET current_epoch = current_epoch + 1')
                                        .run();
                                else {
                                    const conn = store.db.prepare('SELECT * FROM bmp_connections').get();
                                    store.db
                                        .prepare(
                                            `INSERT INTO bmp_connections(connection_id,source_pk,connection_generation,opened_at_ms,connection_state)
                            VALUES ('new-owner', ?, 2, ?, 'open')`
                                        )
                                        .run(conn.source_pk, TIME + 2);
                                    store.db
                                        .prepare(
                                            'UPDATE bmp_rib_scopes SET last_connection_pk = (SELECT connection_pk FROM bmp_connections WHERE connection_id = ?)'
                                        )
                                        .run('new-owner');
                                }
                            }
                        }
                    }),
                    (result, store, calls) => {
                        assert.equal(calls.rows, 2);
                        assert.equal(calls.point, 0);
                        for (const row of snapshot(store).routes) assert.equal(row.last_seen_ms, TIME + 1000);
                        assert.equal(
                            result.applied,
                            2,
                            'accepted connection sequences preserve original applied count even when SQL ownership rejects'
                        );
                    }
                );

            compare(
                kind,
                includeDeltas,
                'duplicate-key-fallback',
                current => ({
                    seed: [announce(current, 0), announce(current, 1)],
                    mutations: [
                        announce(current, 0),
                        announce(current, 0, 1),
                        announce(current, 0, 1),
                        announce(current, 1)
                    ]
                }),
                (_result, _store, calls) => {
                    assert.equal(calls.bulk, 0);
                    assert.equal(calls.point, 3);
                }
            );

            compare(
                kind,
                includeDeltas,
                'context-fallback-and-sticky',
                current => {
                    const seed = [announce(current, 0), announce(current, 1), announce(current, 2)];
                    const mutations = [announce(current, 0), announce(current, 1), announce(current, 2)];
                    mutations[1].source = { ...mutations[1].source, sysName: 'changed-label' };
                    mutations[1].connection = { ...mutations[1].connection, localPort: 12019 };
                    mutations[1].scope = { ...mutations[1].scope, vrfName: 'green' };
                    mutations[2].source = mutations[1].source;
                    mutations[2].connection = mutations[1].connection;
                    mutations[2].scope = mutations[1].scope;
                    return { seed, mutations };
                },
                (result, store, calls) => {
                    assert.equal(calls.bulk, 0);
                    assert.equal(calls.point, 3);
                    assert.equal(result.requiresProjectionRebuild, includeDeltas ? true : undefined);
                    assert.equal(
                        store.db.prepare('SELECT local_port, last_sequence FROM bmp_connections').get().local_port,
                        12019
                    );
                    const rows = store.queryRoutes({ routeState: 'all', pageSize: 10 }).list;
                    assert.equal(rows.length, 3);
                    for (const row of rows) {
                        assert.equal(row.source.sysName, 'changed-label');
                        assert.equal(row.peer.vrf, 'green');
                    }
                }
            );

            compare(
                kind,
                includeDeltas,
                'delimiter-safe-context-signatures',
                current => {
                    const seed = [announce(current, 0), announce(current, 1), announce(current, 2)];
                    const mutations = [announce(current, 0), announce(current, 1)];
                    mutations[0].source = { ...mutations[0].source, sysName: 'label|tail', sysDesc: 'detail' };
                    mutations[1].source = { ...mutations[1].source, sysName: 'label', sysDesc: 'tail|detail' };
                    mutations[0].scope = { ...mutations[0].scope, reason: 'why|green', vrfName: 'blue' };
                    mutations[1].scope = { ...mutations[1].scope, reason: 'why', vrfName: 'green|blue' };
                    return { seed, mutations };
                },
                (result, store, calls) => {
                    assert.equal(calls.bulk, 0);
                    assert.equal(result.requiresProjectionRebuild, includeDeltas ? true : undefined);
                    const source = store.db.prepare('SELECT sys_name,sys_desc FROM bmp_sources').get();
                    assert.equal(source.sys_name, 'label');
                    assert.equal(source.sys_desc, 'tail|detail');
                    for (const row of store.queryRoutes({ routeState: 'all', pageSize: 10 }).list)
                        assert.equal(
                            row.peer.vrf,
                            'green|blue',
                            'even unreported rows inherit the updated scope context'
                        );
                }
            );

            for (const event of ['scope_eor', 'withdraw'])
                compare(
                    kind,
                    includeDeltas,
                    `mixed-${event}`,
                    current => {
                        const seed = [announce(current, 0), announce(current, 1)];
                        const first = announce(current, 0);
                        const middle =
                            event === 'scope_eor'
                                ? buildScopeMutation(current.session, current.owner, 1, 1, current.ribType, event, {
                                      kind,
                                      state: 'ready',
                                      eventAtMs: TIME
                                  })
                                : buildRouteWithdrawMutation(
                                      current.session,
                                      current.owner,
                                      route(0),
                                      route(0),
                                      1,
                                      1,
                                      current.ribType,
                                      { kind, state: 'ready', eventAtMs: TIME }
                                  );
                        return { seed, mutations: [first, middle, announce(current, 1)] };
                    },
                    (_result, _store, calls) => {
                        assert.equal(calls.bulk, 0);
                        assert.equal(calls.point, 2);
                    }
                );

            compare(
                kind,
                includeDeltas,
                'toJSON-hidden-different-scopes',
                current => {
                    const second = context(kind);
                    second.session = current.session;
                    second.owner.bmpSession = current.session;
                    if (kind === 'peer') second.owner.sessionIp = '198.51.100.2';
                    else second.owner.instanceIp = '198.51.100.2';
                    const seed = [announce(current, 0), announce(second, 1)];
                    const mutations = [
                        announce(current, 0, 0, { eventAtMs: TIME + 9000 }),
                        announce(second, 1, 0, { eventAtMs: TIME + 9000 })
                    ];
                    for (const mutation of mutations)
                        mutation.scope = {
                            ...mutation.scope,
                            toJSON() {
                                return { hidden: true };
                            }
                        };
                    assert.notEqual(mutations[0].scope.id, mutations[1].scope.id);
                    return { seed, mutations };
                },
                (_result, store, calls) => {
                    assert.equal(calls.bulk, 0);
                    assert.equal(calls.point, 2);
                    assert.equal(snapshot(store).routes.length, 2);
                    for (const row of snapshot(store).routes) assert.equal(row.last_seen_ms, TIME + 9000);
                }
            );

            for (const transition of ['connection', 'epoch'])
                compare(
                    kind,
                    includeDeltas,
                    `toJSON-hidden-${transition}-takeover`,
                    current => {
                        const seed = [announce(current, 0), announce(current, 1)];
                        const first = announce(current, 0, 0, { eventAtMs: TIME + 9000 });
                        let next = current;
                        if (transition === 'connection') next = context(kind, 2);
                        else if (kind === 'peer') current.owner.advanceRibEpoch(1, 1, current.ribType);
                        else current.owner.advanceRibEpoch();
                        const second = announce(next, 1, 0, { eventAtMs: TIME + 9000 });
                        for (const mutation of [first, second]) {
                            mutation.connection = {
                                ...mutation.connection,
                                toJSON() {
                                    return { hidden: true };
                                }
                            };
                            mutation.scope = {
                                ...mutation.scope,
                                toJSON() {
                                    return { hidden: true };
                                }
                            };
                        }
                        return { seed, mutations: [first, second] };
                    },
                    (result, store, calls) => {
                        assert.equal(calls.bulk, 0);
                        assert.equal(calls.point, 1);
                        assert.equal(result.requiresProjectionRebuild, includeDeltas ? true : undefined);
                        for (const row of snapshot(store).routes)
                            assert.equal(
                                row.last_seen_ms,
                                TIME + 9000,
                                'metadata observed before takeover must not be deferred and rejected by the later owner/epoch'
                            );
                    }
                );

            compare(
                kind,
                includeDeltas,
                'toJSON-hidden-connection-context',
                current => {
                    const seed = [announce(current, 0), announce(current, 1)];
                    const mutations = [announce(current, 0), announce(current, 1)];
                    mutations[0].connection = {
                        ...mutations[0].connection,
                        toJSON() {
                            return { hidden: true };
                        }
                    };
                    mutations[1].connection = {
                        ...mutations[1].connection,
                        localPort: 12019,
                        toJSON() {
                            return { hidden: true };
                        }
                    };
                    return { seed, mutations };
                },
                (result, store, calls) => {
                    assert.equal(calls.bulk, 0);
                    assert.equal(calls.point, 2);
                    assert.equal(result.requiresProjectionRebuild, includeDeltas ? true : undefined);
                    assert.equal(store.db.prepare('SELECT local_port FROM bmp_connections').get().local_port, 12019);
                }
            );

            for (const extra of ['cycle', 'bigint'])
                compare(
                    kind,
                    includeDeltas,
                    `unknown-${extra}-fallback`,
                    current => {
                        const seed = [announce(current, 0), announce(current, 1)];
                        const mutations = [announce(current, 0), announce(current, 1)];
                        const connection = { ...mutations[0].connection },
                            scope = { ...mutations[0].scope };
                        if (extra === 'cycle') {
                            connection.extra = connection;
                            scope.extra = scope;
                        } else {
                            connection.extra = 10000000000000000000n;
                            scope.extra = 10000000000000000000n;
                        }
                        for (const mutation of mutations) {
                            mutation.connection = connection;
                            mutation.scope = scope;
                        }
                        return { seed, mutations: cloneWorkerMessage(mutations) };
                    },
                    (_result, _store, calls) => {
                        assert.equal(calls.bulk, 0);
                        assert.equal(calls.point, 2);
                    }
                );
        }

    for (const size of [250, 251, 5000])
        compare(
            'peer',
            false,
            `chunks-${size}`,
            current => ({
                seed: Array.from({ length: size }, (_, i) => announce(current, i, i % 100)),
                mutations: Array.from({ length: size }, (_, i) => announce(current, i, i % 100))
            }),
            (_result, store, calls) => {
                assert.equal(calls.point, 0);
                assert.equal(calls.bulk, Math.ceil(size / 250));
                assert.equal(calls.rows, size);
                assertPointLookupPlan(store, calls);
            }
        );

    const current = context('peer');
    const store = new Store({ dbPath: path.join(directory, 'rollback.sqlite3') }).open();
    try {
        store.applyBatch(batch('rollback-seed', [announce(current, 0), announce(current, 1)], true));
        const before = snapshot(store);
        const original = store.flushDeferredMetadataRefresh.bind(store);
        store.flushDeferredMetadataRefresh = cache => {
            original(cache);
            throw new Error('injected post-refresh failure');
        };
        const request = batch(
            'rollback-retry',
            [announce(current, 0, 0, { eventAtMs: TIME + 9000 }), announce(current, 1, 1)],
            true
        );
        assert.throws(() => store.applyBatch(request), /injected/);
        assert.deepEqual(
            snapshot(store),
            before,
            'deferred metadata, semantic refs, new dimensions, candidates, highwater, batch marker all rollback'
        );
        store.flushDeferredMetadataRefresh = original;
        assert.equal(store.applyBatch(request).applied, 2);

        // A changed endpoint must not reset in-memory connection progress or dirty.
        const first = announce(current, 0),
            last = announce(current, 1);
        last.connection = { ...last.connection, localPort: 13019 };
        const replay = { ...first, connection: { ...last.connection, localPort: 14019 }, sequence: first.sequence - 1 };
        const result = store.applyBatch(batch('endpoint-sequence-sticky', [first, last, replay], true));
        assert.equal(result.applied, 2);
        assert.equal(result.requiresProjectionRebuild, true);
        const conn = store.db.prepare('SELECT local_port,last_sequence FROM bmp_connections').get();
        assert.equal(conn.last_sequence, last.sequence);
        assert.equal(conn.local_port, 14019);
    } finally {
        store.close();
    }
    console.log('BMP guarded deferred metadata refresh tests passed (5000 scalar UPDATEs -> 20 bulk UPDATEs)');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
