const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
const Peer = require('../../electron/worker/bmp/bmpBgpSession');
const Instance = require('../../electron/worker/bmp/bmpBgpInstance');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const { resolveBmpRoutePartition } = require('../../electron/worker/bmp/bmpRoutePartitionManifest');
const { parseFlowSpecNlri } = require('../../electron/utils/bgp/addressFamily/flowSpec');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-detailed-stale-purge-'));
const TIME = 1767225600000;
const stores = [];
const explicitlyStale = new WeakSet();
const attributes = { origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1', communities: ['65001:100'] };
const ipv4 = { afi: 1, safi: 1, nlri: { prefix: '203.0.113.0', length: 24, rd: '0:0' } };
const ipv6 = { afi: 2, safi: 1, nlri: { prefix: '2001:db8:1::', length: 64, rd: '0:0' } };
const flowSpec = { afi: 1, safi: 133, nlri: parseFlowSpecNlri(Buffer.from([5, 1, 24, 192, 0, 2]), 0, 1).route };
let serial = 0;

function open(name) {
    const store = new Store({ dbPath: path.join(directory, `${name}.sqlite3`) }).open();
    stores.push(store);
    return store;
}

function context(name, kind = 'peer', generation = 1, remoteIp = '192.0.2.10', ownerIp = '198.51.100.1') {
    const session = {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp,
        remotePort: 50000 + generation,
        sysName: name,
        sysDesc: 'Detailed stale purge regression',
        persistenceConnectionId: `${name}-${generation}`,
        persistenceConnectionGeneration: generation,
        persistenceOpenedAtMs: TIME + generation
    };
    const owner = kind === 'peer' ? new Peer(session) : new Instance(session);
    Object.assign(
        owner,
        kind === 'peer'
            ? { sessionType: 0, sessionRd: '0:0', sessionIp: ownerIp, sessionAs: 65001 }
            : { instanceType: 3, instanceRd: '0:0', instanceIp: ownerIp, instanceAs: 65001 }
    );
    owner.vrfTableNames = ['blue'];
    return { session, owner, kind, ribType: kind === 'peer' ? 2 : 'loc-rib' };
}

function announce(current, family, pathId, options = {}) {
    const nlri = { ...family.nlri, ...options.nlri, pathId, rd: family.nlri.rd || '0:0' };
    const route = new Route(
        current.kind === 'peer' ? current.owner : null,
        current.kind === 'loc-rib' ? current.owner : null
    );
    Object.assign(route, {
        afi: family.afi,
        safi: family.safi,
        ribType: current.ribType,
        pathId,
        rd: nlri.rd,
        ip: nlri.displayPrefix || nlri.prefix,
        mask: nlri.length,
        nlriDetail: nlri
    });
    if (options.attr !== null) route.assignRouteAttr(attributes);
    route.markActive(current.owner.getRibEpoch(family.afi, family.safi, current.ribType));
    route.lastSeenAt = new Date(TIME + pathId).toISOString();
    if (options.stale) {
        route.markStale('ci-explicit-stale', route.ribEpoch);
        route.staleAt = new Date(TIME + 500).toISOString();
    }
    const mutation = buildRouteUpsertMutation(
        current.session,
        current.owner,
        route,
        family.afi,
        family.safi,
        current.ribType,
        { kind: current.kind, scopeState: 'ready', eventAtMs: TIME + 1000 + pathId, sourceTimestampMs: TIME + pathId }
    );
    if (options.attr === null) mutation.route = { ...mutation.route, attrId: null, attrJson: null };
    if (options.stale) explicitlyStale.add(mutation);
    return mutation;
}

function apply(store, mutations) {
    const result = store.applyBatch({
        batchId: `detailed-purge-${++serial}`,
        createdAtMs: TIME,
        includeDeltas: false,
        mutations
    });
    // Announcements always activate a persisted path. Seed explicit stale
    // buckets separately so their selection and counter triggers are exercised.
    for (const mutation of mutations.filter(value => explicitlyStale.has(value))) {
        const partition = resolveBmpRoutePartition({
            scopeKind: mutation.scope.kind,
            afi: mutation.route.afi,
            safi: mutation.route.safi
        });
        store.db
            .prepare(
                `UPDATE ${partition.quotedTableName} SET explicit_state = 'stale'
                       WHERE scope_pk = (SELECT scope_pk FROM bmp_rib_scopes WHERE scope_id = ?)
                         AND route_pk = (SELECT route_pk FROM bmp_route_identities WHERE route_id = ?)`
            )
            .run(mutation.scope.id, mutation.route.id);
    }
    return result;
}

function analyze(store) {
    store.db.exec('ANALYZE');
    assert.ok(store.db.prepare('SELECT COUNT(*) AS count FROM sqlite_stat1').get().count > 0);
    assert.equal(store.db.pragma('automatic_index', { simple: true }), 1);
}

function routeKey(route) {
    return `${route.persistentScopeId}|${route.persistentRouteId}`;
}

function orderedRoutes(store, query = {}) {
    const routes = store.queryRoutes({ ...query, routeState: 'stale', pageSize: 5000 }).list;
    const byKey = new Map(routes.map(route => [routeKey(route), route]));
    const physicalOrder = store.db
        .prepare(
            `SELECT s.scope_id, identity.route_id
                    FROM bmp_current_route_refs ref
                    JOIN bmp_rib_scopes s ON s.scope_pk = ref.scope_pk
                    JOIN bmp_route_identities identity ON identity.route_pk = ref.route_pk
                   ORDER BY ref.scope_pk, ref.route_pk`
        )
        .all();
    return physicalOrder.map(row => byKey.get(`${row.scope_id}|${row.route_id}`)).filter(Boolean);
}

function snapshot(store) {
    const result = {};
    for (const table of [
        'bmp_current_route_refs',
        'bmp_rib_scopes',
        'bmp_scope_route_counts',
        'bmp_route_identities',
        'bmp_route_payloads',
        'bmp_route_attributes',
        'main.bmp_gc_candidates'
    ]) {
        result[table] = store.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
    }
    return result;
}

// Observe work performed, rather than prescribing a SELECT's spelling or index
// name. The physical candidate boundary must survive ANALYZE and stay narrow.
function observedPurge(store, query, options = {}) {
    const originalPrepare = store.db.prepare;
    const candidates = [];
    const details = [];
    store.db.prepare = function (sql) {
        const statement = originalPrepare.call(this, sql);
        const columns = statement.reader ? statement.columns().map(column => column.name) : [];
        const candidateInsert = /INSERT\s+INTO\s+temp\.bmp_detailed_purge_candidates\b/i.test(sql);
        const detailRead = statement.readonly && columns.includes('route_id') && columns.includes('effective_state');
        if (!candidateInsert && !detailRead) return statement;
        const method = candidateInsert ? 'run' : 'all';
        const original = statement[method];
        statement[method] = function (...args) {
            assert.equal(store.db.inTransaction, true, 'candidate and detail reads share the deletion transaction');
            const plan = originalPrepare.call(store.db, `EXPLAIN QUERY PLAN ${sql}`).all(...args);
            const result = original.apply(this, args);
            const count = candidateInsert ? result.changes : result.length;
            (candidateInsert ? candidates : details).push({ count, columns, plan, args });
            return result;
        };
        return statement;
    };
    let result;
    try {
        result = store.purgeStaleRoutes(query);
    } finally {
        store.db.prepare = originalPrepare;
    }
    assert.ok(candidates.length > 0, 'purge must bound narrow physical candidates before loading route details');
    assert.ok(candidates.reduce((total, read) => total + read.count, 0) <= query.routeLimit + 1);
    assert.equal(
        details.reduce((total, read) => total + read.count, 0),
        result.purged,
        'lookahead never loads full details'
    );
    let candidateBudget = query.routeLimit + 1;
    for (const read of candidates) {
        const plan = read.plan.map(row => row.detail).join('\n');
        assert.ok(/SEARCH .*scope_pk=\?/i.test(plan), `scope candidates must use an indexed lookup:\n${plan}`);
        if (query.prefixExact) {
            assert.match(
                plan,
                /SEARCH identity .*prefix=\?/i,
                `exact prefixes start at the identity prefix index:\n${plan}`
            );
            assert.match(
                plan,
                /SEARCH r .*scope_pk=\? AND route_pk=\?/i,
                `prefix identities probe individual current paths:\n${plan}`
            );
        }
        // The prefix index groups different lengths before route_pk. Sorting
        // those narrow identity matches is valid when no length is supplied.
        if (!query.prefixExact || query.prefixLength !== undefined) {
            assert.doesNotMatch(plan, /TEMP B-TREE FOR (?:RIGHT PART OF )?ORDER BY/i);
        }
        if (options.epochBuckets) {
            assert.match(
                plan,
                /SEARCH r .*scope_pk=\? AND connection_pk=\? AND rib_epoch=\?/i,
                `small epoch buckets avoid newer paths:\n${plan}`
            );
        }
        assert.ok(read.args[0].limit <= candidateBudget, 'each scope only receives the remaining lookahead budget');
        candidateBudget -= read.count;
    }
    for (const read of details) {
        const plan = read.plan.map(row => row.detail).join('\n');
        assert.match(
            plan,
            /SEARCH candidate USING PRIMARY KEY \(scope_pk=\?\)/i,
            `details start at bounded scope keys:\n${plan}`
        );
        assert.match(
            plan,
            /SEARCH current USING INTEGER PRIMARY KEY \(rowid=\?\)/i,
            `details use physical path point lookups:\n${plan}`
        );
        // The validated candidate keys already provide output order. Detail
        // joins must preserve that order rather than introduce another sort.
        assert.doesNotMatch(plan, /SCAN (?:current|r)\b|TEMP B-TREE FOR (?:RIGHT PART OF )?ORDER BY/i);
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM temp.bmp_detailed_purge_candidates').get().count, 0);
    assert.ok(store.db.prepare('SELECT COUNT(*) AS count FROM sqlite_stat1').get().count > 0);
    return result;
}

function assertDetails(store, result, expected, query) {
    assert.equal(result.purged, expected.length);
    assert.deepEqual(
        result.routes,
        expected,
        'purge returns the complete pre-delete stored projections in physical order'
    );
    const lastConnections = new Map(
        store.db
            .prepare(
                `SELECT s.scope_id, connection.connection_id
                        FROM bmp_rib_scopes s
                        JOIN bmp_connections connection ON connection.connection_pk = s.last_connection_pk`
            )
            .all()
            .map(row => [row.scope_id, row.connection_id])
    );
    assert.deepEqual(
        result.deltas,
        expected.map(route => ({
            action: 'delete',
            classification: 'purge',
            eventType: 'purge',
            sequence: null,
            committed: true,
            projectionChanged: true,
            sourceId: route.persistentSourceId,
            connectionId: lastConnections.get(route.persistentScopeId),
            scopeId: route.persistentScopeId,
            ownerKey: route.ownerKey,
            source: { id: route.persistentSourceId },
            connection: { id: lastConnections.get(route.persistentScopeId) },
            scope: {
                id: route.persistentScopeId,
                ownerKey: route.ownerKey,
                kind: route.scopeKind,
                afi: route.afi,
                safi: route.safi,
                ribType: route.ribType,
                epoch: route.currentEpoch,
                state: route.scopeState
            },
            scopeKind: route.scopeKind,
            afi: route.afi,
            safi: route.safi,
            ribType: route.ribType,
            routeId: route.persistentRouteId,
            legacyRouteKey: route.routeKey,
            routeKey: route.routeKey,
            reason: query.reason || 'manual-stale-purge',
            previous: route,
            current: null,
            context: query.context ?? null,
            mutation: null
        }))
    );
}

function assertNoOrphans(store) {
    for (const [table, key] of [
        ['bmp_route_identities', 'route_pk'],
        ['bmp_route_payloads', 'payload_id'],
        ['bmp_route_attributes', 'attr_pk']
    ]) {
        assert.equal(
            store.db
                .prepare(
                    `SELECT COUNT(*) AS count FROM ${table} object
                            WHERE NOT EXISTS (SELECT 1 FROM bmp_current_route_refs ref WHERE ref.${key} = object.${key})`
                )
                .get().count,
            0,
            `${table} must reclaim unreferenced objects while preserving shared objects`
        );
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM main.bmp_gc_candidates').get().count, 0);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
}

function sparseEpochFixture(name) {
    const store = open(name);
    const old = context(name);
    const oldOtherRib = { ...old, ribType: 1 };
    const oldMutations = [
        announce(old, ipv4, 1),
        announce(old, ipv4, 2, { stale: true, nlri: { length: 25 } }),
        announce(oldOtherRib, ipv4, 11)
    ];
    apply(store, oldMutations);
    const latest = context(name, 'peer', 2);
    const latestOpen = buildConnectionMutation(latest.session, 'connection_open', { eventAtMs: TIME + 2000 });
    const latestOtherRib = { ...latest, ribType: 1 };
    for (const current of [latest, latestOtherRib]) current.owner.advanceRibEpoch(1, 1, current.ribType);
    const mutations = [
        latestOpen,
        announce(latest, ipv4, 3),
        announce(latest, ipv4, 4, { stale: true, nlri: { length: 25 } }),
        announce(latestOtherRib, ipv4, 12, { stale: true })
    ];
    for (const current of [latest, latestOtherRib]) {
        current.owner.advanceRibEpoch(1, 1, current.ribType);
        for (let index = 0; index < 24; index += 1) {
            mutations.push(announce(current, ipv4, 100 + index, { nlri: { prefix: `10.1.${index}.0` } }));
        }
        mutations.push(announce(current, ipv4, 200, { stale: true }));
    }
    apply(store, mutations);
    analyze(store);
    assert.equal(store.queryRoutes({ routeState: 'active' }).total, 48);
    assert.equal(store.queryRoutes({ routeState: 'stale' }).total, 8);
    return { store, ownerKey: oldMutations[0].scope.ownerKey, firstScopeId: oldMutations[0].scope.id };
}

try {
    const store = open('owner-order-after-analyze');
    const current = context('ordered');
    const warmer = context('identity-warmer', 'peer', 1, '192.0.2.20', '198.51.100.9');
    // Create route identities in a different order from physical paths, and
    // scopes in a different order from the partition manifest.
    const families = [flowSpec, ipv6, ipv4];
    apply(
        store,
        families.flatMap(family => [6, 2, 5, 1, 4, 3].map(id => announce(warmer, family, id)))
    );
    const initial = families.flatMap(family => [1, 2, 3, 4, 5, 6].map(id => announce(current, family, id)));
    apply(store, initial);
    const refreshes = [];
    for (const family of families) {
        current.owner.advanceRibEpoch(family.afi, family.safi, current.ribType);
        refreshes.push(
            announce(current, family, 2),
            announce(current, family, 4),
            announce(current, family, 7, { stale: true })
        );
    }
    // The analyzed distribution includes many active paths and one shared
    // attribute, the conditions that formerly changed the detailed join plan.
    for (let index = 0; index < 96; index += 1) {
        refreshes.push(announce(current, ipv4, 100 + index, { nlri: { prefix: `10.0.${index}.0` } }));
    }
    apply(store, refreshes);
    const outside = context('other-source', 'peer', 1, '192.0.2.30');
    const outsideMutation = announce(outside, ipv4, 1, { stale: true });
    apply(store, [outsideMutation]);
    const selector = { sourceId: initial[0].source.id, ownerKey: initial[0].scope.ownerKey };
    const untouched = store.queryRoutes({ sourceId: outsideMutation.source.id, routeState: 'all' }).list;
    const shared = store.queryRoutes({ sourceId: initial[0].source.id, routeState: 'active', pageSize: 5000 }).list;
    assert.equal(shared.length, 102);
    assert.equal(orderedRoutes(store, selector).length, 15);
    analyze(store);

    const scopedQuery = { ...selector, scopeId: initial[0].scope.id, routeLimit: 2, gcLimit: 50000 };
    const first = orderedRoutes(store, scopedQuery);
    assert.notDeepEqual(
        first.map(route => route.pathId),
        [...first.map(route => route.pathId)].sort((a, b) => a - b)
    );
    const scopedResult = observedPurge(store, scopedQuery);
    assertDetails(store, scopedResult, first.slice(0, 2), scopedQuery);
    assert.equal(scopedResult.hasMore, true);

    let remaining = orderedRoutes(store, selector);
    while (remaining.length) {
        const query = {
            ...selector,
            routeLimit: 4,
            gcLimit: 50000,
            reason: 'ci-owner-purge',
            context: { requestId: 'owner' }
        };
        const result = observedPurge(store, query);
        assertDetails(store, result, remaining.slice(0, 4), query);
        assert.equal(result.hasMore, remaining.length > 4);
        remaining = orderedRoutes(store, selector);
    }
    assert.deepEqual(store.queryRoutes({ ...selector, routeState: 'active', pageSize: 5000 }).list, shared);
    assert.deepEqual(store.queryRoutes({ sourceId: outsideMutation.source.id, routeState: 'all' }).list, untouched);
    assert.equal(store.queryRoutes({ sourceId: initial[0].source.id, routeState: 'all' }).total, 102);
    assertNoOrphans(store);

    const filtered = open('filters-last-connection');
    const old = context('filters');
    const oldRoutes = [
        announce(old, ipv4, 1),
        announce(old, ipv4, 2, { nlri: { length: 25 } }),
        announce(old, ipv4, 3, { nlri: { prefix: '198.51.100.0' } }),
        announce(old, ipv4, 6, { attr: null })
    ];
    apply(filtered, oldRoutes);
    old.owner.advanceRibEpoch(1, 1, 2);
    apply(filtered, [announce(old, ipv4, 4, { stale: true })]);
    const latest = context('filters', 'peer', 2);
    latest.owner.advanceRibEpoch(1, 1, 2);
    const latestOpen = buildConnectionMutation(latest.session, 'connection_open', { eventAtMs: TIME + 2000 });
    const latestActive = announce(latest, ipv4, 5);
    apply(filtered, [latestOpen, latestActive]);
    const otherRib = { ...latest, ribType: 1 };
    const otherRibMutation = announce(otherRib, ipv4, 20, { stale: true });
    const otherOwner = { ...latest, owner: context('filters', 'peer', 2, '192.0.2.10', '198.51.100.99').owner };
    const otherOwnerMutation = announce(otherOwner, ipv4, 30, { stale: true });
    const otherSource = context('filters-other', 'peer', 1, '192.0.2.40');
    const otherSourceMutation = announce(otherSource, ipv4, 1, { stale: true });
    apply(filtered, [otherRibMutation, otherOwnerMutation, otherSourceMutation]);
    analyze(filtered);
    const baseQuery = {
        sourceId: oldRoutes[0].source.id,
        scopeId: oldRoutes[0].scope.id,
        connectionId: latestActive.connection.id,
        routeLimit: 1,
        gcLimit: 50000
    };
    const beforeFilters = snapshot(filtered);
    for (const mismatch of [
        { sourceId: otherSourceMutation.source.id },
        { ownerKey: otherOwnerMutation.scope.ownerKey },
        { connectionId: oldRoutes[0].connection.id },
        { scopeKind: 'loc-rib' },
        { afi: 2 },
        { safi: 133 },
        { ribType: '1' },
        { ribEpochBefore: 0 },
        { prefixExact: '203.0.114.0' },
        { prefixLength: 32 }
    ]) {
        const result = filtered.purgeStaleRoutes({ ...baseQuery, ...mismatch });
        assert.deepEqual(result, { purged: 0, hasMore: false, routes: [], deltas: [] });
        assert.deepEqual(snapshot(filtered), beforeFilters, 'a mismatched selector cannot alter routes or GC');
    }
    const prefixQuery = { ...baseQuery, ribEpochBefore: 1, prefixExact: '203.0.113.0', prefixLength: 24 };
    const prefixExpected = orderedRoutes(filtered, { sourceId: baseQuery.sourceId, scopeId: baseQuery.scopeId }).filter(
        route => route.ip === '203.0.113.0' && route.mask === 24 && route.ribEpoch < 1
    );
    assert.equal(prefixExpected.length, 2);
    assert.ok(prefixExpected.every(route => route.persistentConnectionId === oldRoutes[0].connection.id));
    for (let index = 0; index < prefixExpected.length; index += 1) {
        const result = observedPurge(filtered, prefixQuery);
        assertDetails(filtered, result, [prefixExpected[index]], prefixQuery);
        assert.equal(result.hasMore, index === 0);
        assert.equal(
            result.deltas[0].connectionId,
            latestActive.connection.id,
            'purge ownership uses the scope last connection'
        );
        assert.equal(
            result.routes[0].persistentConnectionId,
            oldRoutes[0].connection.id,
            'details retain the route original connection'
        );
    }
    assert.equal(prefixExpected[1].attrId, '', 'a route without attributes still has a complete stored projection');
    const survivors = filtered.queryRoutes({ scopeId: baseQuery.scopeId, routeState: 'all' }).list;
    assert.deepEqual(
        survivors.map(route => route.pathId).sort((a, b) => a - b),
        [2, 3, 4, 5]
    );
    assert.equal(
        survivors.find(route => route.pathId === 4).ribEpoch,
        1,
        'epoch cutoff preserves newer explicit stale paths'
    );
    assert.equal(survivors.find(route => route.pathId === 5).routeState, 'active');
    const lengthQuery = { ...baseQuery, prefixExact: '203.0.113.0', prefixLength: 25 };
    const lengthExpected = orderedRoutes(filtered, { scopeId: baseQuery.scopeId }).filter(route => route.mask === 25);
    const lengthResult = observedPurge(filtered, lengthQuery);
    assertDetails(filtered, lengthResult, lengthExpected, lengthQuery);
    assert.equal(lengthResult.hasMore, false, 'an exact full batch has no lookahead');
    assert.equal(filtered.queryRoutes({ scopeId: otherRibMutation.scope.id, routeState: 'all' }).total, 1);
    assert.equal(filtered.queryRoutes({ scopeId: otherOwnerMutation.scope.id, routeState: 'all' }).total, 1);
    assert.equal(filtered.queryRoutes({ sourceId: otherSourceMutation.source.id, routeState: 'all' }).total, 1);
    assertNoOrphans(filtered);

    const sparse = sparseEpochFixture('sparse-epoch-no-prefix');
    const sparseQuery = { scopeId: sparse.firstScopeId, ribEpochBefore: 2, routeLimit: 4, gcLimit: 50000 };
    const sparseExpected = orderedRoutes(sparse.store, { scopeId: sparse.firstScopeId }).filter(
        route => route.ribEpoch < 2
    );
    assert.equal(sparseExpected.length, 4);
    assert.equal(new Set(sparseExpected.map(route => route.persistentConnectionId)).size, 2);
    assert.equal(new Set(sparseExpected.map(route => route.ribEpoch)).size, 2);
    const sparseActive = sparse.store.queryRoutes({ routeState: 'active', pageSize: 5000 }).list;
    const sparseResult = observedPurge(sparse.store, sparseQuery, { epochBuckets: true });
    assertDetails(sparse.store, sparseResult, sparseExpected, sparseQuery);
    assert.equal(
        sparseResult.hasMore,
        false,
        'all old buckets fitting exactly the limit do not include the newer stale bucket'
    );
    assert.deepEqual(sparse.store.queryRoutes({ routeState: 'active', pageSize: 5000 }).list, sparseActive);
    assert.equal(sparse.store.queryRoutes({ scopeId: sparse.firstScopeId, routeState: 'stale' }).total, 1);
    assertNoOrphans(sparse.store);

    const sparseLength = sparseEpochFixture('sparse-epoch-prefix-length');
    const sparseLengthQuery = {
        ownerKey: sparseLength.ownerKey,
        ribEpochBefore: 2,
        prefixLength: 24,
        routeLimit: 3,
        gcLimit: 50000
    };
    let sparseLengthExpected = orderedRoutes(sparseLength.store, { ownerKey: sparseLength.ownerKey }).filter(
        route => route.ribEpoch < 2 && route.mask === 24
    );
    assert.equal(sparseLengthExpected.length, 4);
    assert.equal(new Set(sparseLengthExpected.slice(0, 3).map(route => route.persistentScopeId)).size, 2);
    const sparseLengthResult = observedPurge(sparseLength.store, sparseLengthQuery, { epochBuckets: true });
    assertDetails(sparseLength.store, sparseLengthResult, sparseLengthExpected.slice(0, 3), sparseLengthQuery);
    assert.equal(
        sparseLengthResult.hasMore,
        true,
        'length filtering leaves enough budget for another scope and its lookahead'
    );
    sparseLengthExpected = orderedRoutes(sparseLength.store, { ownerKey: sparseLength.ownerKey }).filter(
        route => route.ribEpoch < 2 && route.mask === 24
    );
    const sparseLengthFinal = observedPurge(sparseLength.store, sparseLengthQuery, { epochBuckets: true });
    assertDetails(sparseLength.store, sparseLengthFinal, sparseLengthExpected, sparseLengthQuery);
    assert.equal(sparseLengthFinal.hasMore, false);
    assert.deepEqual(
        orderedRoutes(sparseLength.store, { ownerKey: sparseLength.ownerKey })
            .filter(route => route.ribEpoch < 2)
            .map(route => route.mask),
        [25, 25],
        'nonmatching lengths remain even when their eligible epoch buckets were inspected'
    );
    assert.equal(sparseLength.store.queryRoutes({ routeState: 'active' }).total, 48);
    assertNoOrphans(sparseLength.store);

    const prefixOnlyStore = open('exact-prefix-across-lengths');
    const prefixOnlyOwner = context('prefix-across-lengths');
    apply(prefixOnlyStore, [
        announce(prefixOnlyOwner, ipv4, 1, { stale: true, nlri: { length: 25 } }),
        announce(prefixOnlyOwner, ipv4, 2, { stale: true }),
        announce(prefixOnlyOwner, ipv4, 3, { stale: true, nlri: { length: 25 } }),
        announce(prefixOnlyOwner, ipv4, 4, { stale: true }),
        announce(prefixOnlyOwner, ipv4, 5, { stale: true, nlri: { prefix: '198.51.100.0' } })
    ]);
    analyze(prefixOnlyStore);
    const prefixOnlyQuery = {
        ownerKey: '0|0:0|198.51.100.1|65001',
        prefixExact: '203.0.113.0',
        routeLimit: 2,
        gcLimit: 50000
    };
    let prefixOnlyExpected = orderedRoutes(prefixOnlyStore, { ownerKey: prefixOnlyQuery.ownerKey }).filter(
        route => route.ip === '203.0.113.0'
    );
    assert.deepEqual(
        prefixOnlyExpected.map(route => route.mask),
        [25, 24, 25, 24]
    );
    while (prefixOnlyExpected.length) {
        const result = observedPurge(prefixOnlyStore, prefixOnlyQuery);
        assertDetails(prefixOnlyStore, result, prefixOnlyExpected.slice(0, 2), prefixOnlyQuery);
        assert.equal(result.hasMore, prefixOnlyExpected.length > 2);
        prefixOnlyExpected = orderedRoutes(prefixOnlyStore, { ownerKey: prefixOnlyQuery.ownerKey }).filter(
            route => route.ip === '203.0.113.0'
        );
    }
    assert.deepEqual(
        orderedRoutes(prefixOnlyStore).map(route => route.ip),
        ['198.51.100.0']
    );
    assertNoOrphans(prefixOnlyStore);

    const sharedStore = open('shared-identities-scope-boundary');
    const sharedOwner = context('shared-scope-boundary');
    const firstScopeMutations = [1, 2].map(id => announce(sharedOwner, ipv4, id, { stale: true }));
    const secondScopeOwner = { ...sharedOwner, ribType: 1 };
    const secondScopeMutations = [1, 2, 3].map(id => announce(secondScopeOwner, ipv4, id, { stale: true }));
    apply(sharedStore, [...firstScopeMutations, ...secondScopeMutations]);
    assert.equal(firstScopeMutations[0].route.id, secondScopeMutations[0].route.id);
    assert.equal(firstScopeMutations[1].route.id, secondScopeMutations[1].route.id);
    analyze(sharedStore);
    const boundaryQuery = { ownerKey: firstScopeMutations[0].scope.ownerKey, routeLimit: 2, gcLimit: 50000 };
    let sharedRemaining = orderedRoutes(sharedStore, { ownerKey: boundaryQuery.ownerKey });
    assert.equal(sharedRemaining.length, 5);
    assert.equal(new Set(sharedRemaining.map(route => route.persistentRouteId)).size, 3);
    const boundaryResult = observedPurge(sharedStore, boundaryQuery);
    assertDetails(sharedStore, boundaryResult, sharedRemaining.slice(0, 2), boundaryQuery);
    assert.ok(boundaryResult.routes.every(route => route.persistentScopeId === firstScopeMutations[0].scope.id));
    assert.equal(boundaryResult.hasMore, true, 'a full first scope still needs lookahead into the next scope');
    assert.equal(sharedStore.queryRoutes({ scopeId: secondScopeMutations[0].scope.id, routeState: 'stale' }).total, 3);
    assert.equal(sharedStore.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_identities').get().count, 3);
    assertNoOrphans(sharedStore);
    sharedRemaining = orderedRoutes(sharedStore, { ownerKey: boundaryQuery.ownerKey });
    while (sharedRemaining.length) {
        const result = observedPurge(sharedStore, boundaryQuery);
        assertDetails(sharedStore, result, sharedRemaining.slice(0, 2), boundaryQuery);
        assert.equal(result.hasMore, sharedRemaining.length > 2);
        sharedRemaining = orderedRoutes(sharedStore, { ownerKey: boundaryQuery.ownerKey });
    }
    assert.equal(sharedStore.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_identities').get().count, 0);
    assertNoOrphans(sharedStore);

    const fallbackStore = open('unknown-family-partition');
    const fallbackOwner = context('fallback');
    const unknownFamily = {
        afi: 65000,
        safi: 200,
        nlri: { prefix: null, length: null, rawNlri: Buffer.from('0103aabb01', 'hex') }
    };
    const otherUnknownFamily = { ...unknownFamily, afi: 65001 };
    const fallbackMutations = [1, 2].map(id => announce(fallbackOwner, unknownFamily, id, { stale: true }));
    const otherFallbackMutation = announce(fallbackOwner, otherUnknownFamily, 1, { stale: true });
    apply(fallbackStore, [...fallbackMutations, otherFallbackMutation]);
    assert.equal(resolveBmpRoutePartition({ scopeKind: 'peer', afi: 65000, safi: 200 }).fallback, true);
    analyze(fallbackStore);
    const fallbackQuery = {
        ownerKey: fallbackMutations[0].scope.ownerKey,
        afi: 65000,
        safi: 200,
        routeLimit: 2,
        gcLimit: 50000
    };
    const fallbackExpected = orderedRoutes(fallbackStore, { ownerKey: fallbackQuery.ownerKey, afi: 65000, safi: 200 });
    assert.equal(fallbackExpected.length, 2);
    const fallbackResult = observedPurge(fallbackStore, fallbackQuery);
    assertDetails(fallbackStore, fallbackResult, fallbackExpected, fallbackQuery);
    assert.equal(fallbackResult.hasMore, false, 'another AFI in the same fallback partition is not matching lookahead');
    assert.equal(fallbackStore.queryRoutes({ scopeId: otherFallbackMutation.scope.id, routeState: 'stale' }).total, 1);
    const otherFallbackQuery = { ownerKey: fallbackQuery.ownerKey, routeLimit: 1, gcLimit: 50000 };
    const otherFallbackExpected = orderedRoutes(fallbackStore, { ownerKey: fallbackQuery.ownerKey });
    const otherFallbackResult = observedPurge(fallbackStore, otherFallbackQuery);
    assertDetails(fallbackStore, otherFallbackResult, otherFallbackExpected, otherFallbackQuery);
    assert.equal(otherFallbackResult.hasMore, false);
    assertNoOrphans(fallbackStore);

    const instanceStore = open('instance-rollback-and-full-gc');
    const instance = context('instance', 'loc-rib');
    const instanceRoutes = [1, 2, 3].map(id => announce(instance, ipv6, id));
    apply(instanceStore, instanceRoutes);
    apply(instanceStore, [
        buildScopeMutation(instance.session, instance.owner, 2, 1, instance.ribType, 'scope_close', {
            kind: 'loc-rib',
            state: 'down',
            reason: 'ci-instance-down',
            eventAtMs: TIME + 2000
        })
    ]);
    analyze(instanceStore);
    const instanceQuery = { scopeId: instanceRoutes[0].scope.id, routeLimit: 3, gcLimit: 50000, includeDetails: true };
    const instanceExpected = orderedRoutes(instanceStore, { scopeId: instanceQuery.scopeId });
    assert.equal(instanceExpected.length, 3);
    const beforeRollback = snapshot(instanceStore);
    const originalCollectGarbage = instanceStore.collectGarbage;
    instanceStore.collectGarbage = () => {
        throw new Error('ci-detailed-purge-gc-failure');
    };
    try {
        assert.throws(() => instanceStore.purgeStaleRoutes(instanceQuery), /ci-detailed-purge-gc-failure/);
    } finally {
        instanceStore.collectGarbage = originalCollectGarbage;
    }
    assert.deepEqual(
        snapshot(instanceStore),
        beforeRollback,
        'a GC failure rolls back detailed selection and deletions'
    );
    assert.equal(
        instanceStore.db.prepare('SELECT COUNT(*) AS count FROM temp.bmp_detailed_purge_candidates').get().count,
        0
    );
    const instanceResult = observedPurge(instanceStore, instanceQuery);
    assertDetails(instanceStore, instanceResult, instanceExpected, instanceQuery);
    assert.equal(instanceResult.hasMore, false);
    assert.equal(instanceStore.queryRoutes({ routeState: 'all' }).total, 0);
    for (const table of [
        'bmp_route_identities',
        'bmp_route_payloads',
        'bmp_route_attributes',
        'main.bmp_gc_candidates'
    ]) {
        assert.equal(instanceStore.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    assertNoOrphans(instanceStore);
    console.log('BMP detailed stale purge regression passed');
} finally {
    stores.forEach(store => store.close());
    fs.rmSync(directory, { recursive: true, force: true });
}
