const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
const ClientStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const Peer = require('../../electron/worker/bmp/bmpBgpSession');
const Instance = require('../../electron/worker/bmp/bmpBgpInstance');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const { parseEvpnNlri } = require('../../electron/utils/bgpAddressFamily/evpn');
const { parseFlowSpecNlri } = require('../../electron/utils/bgpAddressFamily/flowSpec');
const {
    buildConnectionMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-stale-purge-'));
const TIME = 1767225600000;
let serial = 0;
const openedStores = [];
const commonAttr = { origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' };

function open(label, facade = false) {
    const Constructor = facade ? ClientStore : Store;
    const store = new Constructor({ dbPath: path.join(directory, `${label}.sqlite3`) }).open();
    openedStores.push(store);
    return store;
}

function context(name, kind = 'peer', generation = 1) {
    const session = {
        remoteIp: '192.0.2.10',
        remotePort: 50000 + generation,
        localIp: '127.0.0.1',
        localPort: 11019,
        sysName: name,
        persistenceConnectionId: `${name}-${generation}`,
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

function families() {
    const evpnBody = Buffer.concat([
        Buffer.from('0000fde800000001', 'hex'),
        Buffer.alloc(10),
        Buffer.from('00000064', 'hex'),
        Buffer.from('30aabbccddeeff20c000020a002710', 'hex')
    ]);
    return [
        { afi: 1, safi: 1, nlri: { prefix: '203.0.113.0', length: 24, rd: '0:0' } },
        {
            afi: 25,
            safi: 70,
            nlri: parseEvpnNlri(Buffer.concat([Buffer.from([2, evpnBody.length]), evpnBody]), 0).route
        },
        { afi: 1, safi: 133, nlri: parseFlowSpecNlri(Buffer.from([5, 1, 24, 192, 0, 2]), 0, 1).route }
    ];
}

function announce(current, index, family = families()[0], attr = commonAttr) {
    const nlri = { ...family.nlri, pathId: index, rd: family.nlri.rd || '0:0' };
    const route = new Route(current.owner, null);
    Object.assign(route, {
        afi: family.afi,
        safi: family.safi,
        ribType: current.ribType,
        pathId: index,
        rd: nlri.rd,
        rdRaw: nlri.rdRaw || null,
        ip: nlri.displayPrefix || nlri.prefix,
        mask: nlri.length,
        routeType: nlri.routeType ?? null,
        nlriDetail: nlri
    });
    if (attr) route.assignRouteAttr(attr);
    route.markActive(current.owner.getRibEpoch(family.afi, family.safi, current.ribType));
    const mutation = buildRouteUpsertMutation(
        current.session,
        current.owner,
        route,
        family.afi,
        family.safi,
        current.ribType,
        {
            kind: current.kind,
            scopeState: 'ready',
            eventAtMs: TIME + 1000 + index
        }
    );
    if (!attr) mutation.route = { ...mutation.route, attrId: null, attrJson: null };
    return mutation;
}

function apply(store, mutations) {
    return store.applyBatch({ batchId: `stale-${++serial}`, createdAtMs: TIME, mutations, includeDeltas: false });
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
    result.routes = store.db.prepare('SELECT * FROM bmp_current_route_refs ORDER BY scope_pk, route_pk').all();
    result.gc = store.db.prepare('SELECT * FROM temp.bmp_gc_candidates ORDER BY kind, pk').all();
    return result;
}

function assertCompact(result) {
    assert.deepEqual(Object.keys(result).sort(), ['affectedScopes', 'hasMore', 'nextCursor', 'purged']);
    assert.equal(result.nextCursor, null);
    assert.equal(
        result.affectedScopes.reduce((sum, scope) => sum + scope.deletedRoutes, 0),
        result.purged
    );
}

function assertCandidatesEmpty(store) {
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM temp.bmp_stale_purge_candidates').get().count, 0);
}

try {
    for (const kind of ['peer', 'loc-rib']) {
        const store = open(`families-${kind}`);
        const old = context(`families-${kind}`, kind, 1);
        const first = [buildConnectionMutation(old.session, 'connection_open')];
        for (const family of families()) first.push(announce(old, 1, family), announce(old, 2, family));
        apply(store, first);
        const latest = context(`families-${kind}`, kind, 2);
        const refreshed = [buildConnectionMutation(latest.session, 'connection_open')];
        for (const family of families()) refreshed.push(announce(latest, 1, family));
        apply(store, refreshed);
        const sourceId = first[0].source.id;
        assert.equal(store.queryScopeSummary({ sourceId }).active, 3);
        assert.equal(store.queryScopeSummary({ sourceId }).stale, 3);
        const before = snapshot(store);
        assertCompact(
            store.purgeStaleRoutes({
                sourceId: 'f'.repeat(64),
                ownerKey: first[1].scope.ownerKey,
                includeDetails: false
            })
        );
        assert.deepEqual(snapshot(store), before, 'a different source must not delete this client');
        const queries =
            kind === 'peer'
                ? [{ ownerKey: first[1].scope.ownerKey }]
                : [...new Set(first.filter(mutation => mutation.scope).map(mutation => mutation.scope.id))].map(
                      scopeId => ({ scopeId })
                  );
        const result = { purged: 0, hasMore: false, affectedScopes: [], nextCursor: null };
        for (const selector of queries) {
            const part = store.purgeStaleRoutes({ sourceId, ...selector, includeDetails: false, routeLimit: 20000 });
            assertCompact(part);
            result.purged += part.purged;
            result.hasMore ||= part.hasMore;
            result.affectedScopes.push(...part.affectedScopes);
        }
        assertCompact(result);
        assert.equal(result.purged, 3);
        assert.equal(result.hasMore, false);
        assert.equal(result.affectedScopes.length, 3);
        assert.deepEqual(
            result.affectedScopes.map(scope => [scope.afi, scope.safi]).sort(),
            [
                [1, 1],
                [1, 133],
                [25, 70]
            ].sort()
        );
        assert.equal(store.queryScopeSummary({ sourceId }).active, 3);
        assert.equal(store.queryScopeSummary({ sourceId }).stale, 0);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_identities').get().count, 3);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_attributes').get().count, 1);
        assertCandidatesEmpty(store);
        const empty = store.purgeStaleRoutes({ sourceId, ownerKey: first[1].scope.ownerKey, includeDetails: false });
        assertCompact(empty);
        assert.equal(empty.purged, 0);
        const legacy = store.purgeStaleRoutes({ sourceId, ownerKey: first[1].scope.ownerKey });
        assert.deepEqual(legacy, { purged: 0, hasMore: false, routes: [], deltas: [] });
    }

    const mixed = open('mixed-buckets');
    const current = context('mixed-buckets');
    const family = families()[0];
    const seed = [buildConnectionMutation(current.session, 'connection_open')];
    for (let index = 1; index <= 300; index++) seed.push(announce(current, index, family));
    apply(mixed, seed);
    const refresh = [];
    for (let index = 1; index <= 256; index++) {
        const mutation = announce(current, index, family);
        mutation.scope = { ...mutation.scope, epoch: 1 };
        refresh.push(mutation);
    }
    apply(mixed, refresh);
    const scopeId = seed[1].scope.id;
    const sourceId = seed[0].source.id;
    const plans = [];
    const prepare = mixed.db.prepare.bind(mixed.db);
    mixed.db.prepare = sql => {
        const statement = prepare(sql);
        if (
            !sql.includes('INSERT INTO temp.bmp_stale_purge_candidates') &&
            !sql.includes('DELETE FROM "bmp_current_routes_')
        )
            return statement;
        const run = statement.run.bind(statement);
        statement.run = params => {
            plans.push({ sql, params, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) });
            return run(params);
        };
        return statement;
    };
    for (const statements of mixed.partitionStatements.values())
        statements.deleteRoute.all = () => {
            throw new Error('point delete forbidden');
        };
    mixed.statements.addGcCandidate.run = () => {
        throw new Error('point GC registration forbidden');
    };
    mixed.mapRouteRow = () => {
        throw new Error('route projection forbidden');
    };
    let removed = 0;
    let batches = 0;
    let result;
    do {
        result = mixed.purgeStaleRoutes({ sourceId, scopeId, includeDetails: false, routeLimit: 7 });
        assertCompact(result);
        assert.ok(result.purged > 0 && result.purged <= 7);
        removed += result.purged;
        batches++;
        const summary = mixed.queryScopeSummary({ sourceId, scopeId });
        assert.equal(summary.active, 256);
        assert.equal(summary.stale, 44 - removed);
        assert.equal(summary.total, 300 - removed);
        assertCandidatesEmpty(mixed);
    } while (result.hasMore);
    assert.equal(removed, 44);
    assert.equal(batches, 7);
    const inserts = plans.filter(plan => plan.sql.includes('INSERT INTO'));
    assert.equal(inserts.length, 7);
    for (const query of inserts) {
        assert.equal(query.params.epoch, 0, 'active current-epoch buckets must not be scanned');
        assert.ok(
            query.plan.some(row =>
                /SEARCH r USING INDEX idx_.*_scope_epoch \(scope_pk=\? AND connection_pk=\? AND rib_epoch=\?\)/.test(
                    row.detail
                )
            )
        );
        assert.ok(!query.plan.some(row => /SCAN r\b|TEMP B-TREE.*ORDER BY/.test(row.detail)));
    }
    const deletes = plans.filter(plan => plan.sql.includes('DELETE FROM'));
    assert.equal(deletes.length, 7);
    for (const query of deletes) {
        assert.ok(query.plan.some(row => /SEARCH r USING INTEGER PRIMARY KEY/.test(row.detail)));
        assert.ok(!query.plan.some(row => /SCAN r\b/.test(row.detail)));
    }
    assert.equal(mixed.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_identities').get().count, 256);
    assert.equal(mixed.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_payloads').get().count, 1);
    assert.equal(mixed.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_attributes').get().count, 1);

    const rollback = open('rollback');
    const stale = context('rollback');
    const rollbackSeed = [
        buildConnectionMutation(stale.session, 'connection_open'),
        announce(stale, 1, family, null),
        announce(stale, 2, family, null)
    ];
    apply(rollback, rollbackSeed);
    rollback.db.prepare("UPDATE bmp_rib_scopes SET scope_state='down'").run();
    const rollbackQuery = {
        sourceId: rollbackSeed[0].source.id,
        scopeId: rollbackSeed[1].scope.id,
        includeDetails: false
    };
    const beforeRollback = snapshot(rollback);
    const collect = rollback.collectGarbage.bind(rollback);
    rollback.collectGarbage = () => {
        throw new Error('injected GC failure');
    };
    assert.throws(() => rollback.purgeStaleRoutes(rollbackQuery), /injected GC failure/);
    assert.deepEqual(snapshot(rollback), beforeRollback);
    assertCandidatesEmpty(rollback);
    rollback.collectGarbage = collect;
    assert.equal(rollback.purgeStaleRoutes(rollbackQuery).purged, 2);
    assert.equal(rollback.queryScopeSummary(rollbackQuery).total, 0);
    for (const table of ['bmp_route_identities', 'bmp_route_payloads', 'bmp_route_attributes'])
        assert.equal(rollback.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    assertCandidatesEmpty(rollback);
    assert.throws(() => rollback.purgeStaleRoutes({ includeDetails: false }), /requires scopeId or ownerKey/);
    assert.throws(
        () => rollback.purgeStaleRoutes({ ...rollbackQuery, cursor: 'foreign-cursor' }),
        /does not accept a cursor/
    );

    const stateGuard = open('actual-state-guard');
    const guardContext = context('actual-state-guard');
    const guardSeed = [buildConnectionMutation(guardContext.session, 'connection_open'), announce(guardContext, 1)];
    apply(stateGuard, guardSeed);
    stateGuard.db.prepare("UPDATE bmp_rib_scopes SET scope_state='stale'").run();
    const guardPrepare = stateGuard.db.prepare.bind(stateGuard.db);
    stateGuard.db.prepare = sql => {
        const statement = guardPrepare(sql);
        if (!sql.includes('INSERT INTO temp.bmp_stale_purge_candidates')) return statement;
        const run = statement.run.bind(statement);
        statement.run = params => {
            guardPrepare("UPDATE bmp_rib_scopes SET scope_state='ready'").run();
            return run(params);
        };
        return statement;
    };
    assert.equal(stateGuard.purgeStaleRoutes({ scopeId: guardSeed[1].scope.id, includeDetails: false }).purged, 0);
    assert.equal(stateGuard.queryScopeSummary({ scopeId: guardSeed[1].scope.id }).active, 1);
    assertCandidatesEmpty(stateGuard);

    const filtered = open('filters');
    const filterContext = context('filters');
    const filterSeed = [
        buildConnectionMutation(filterContext.session, 'connection_open'),
        announce(filterContext, 1),
        announce(filterContext, 2)
    ];
    apply(filtered, filterSeed);
    filtered.db.prepare("UPDATE bmp_rib_scopes SET current_epoch=1, scope_state='ready'").run();
    const filterQuery = {
        sourceId: filterSeed[0].source.id,
        scopeId: filterSeed[1].scope.id,
        includeDetails: false,
        routeLimit: 1
    };
    for (const extra of [
        { ribEpochBefore: 0 },
        { connectionId: 'not-current' },
        { prefixExact: '198.51.100.0' },
        { prefixLength: 32 },
        { afi: 2 },
        { safi: 70 },
        { ribType: '1' },
        { scopeKind: 'loc-rib' }
    ])
        assert.equal(filtered.purgeStaleRoutes({ ...filterQuery, ...extra }).purged, 0);
    const filteredResult = filtered.purgeStaleRoutes({
        ...filterQuery,
        ribEpochBefore: 1,
        prefixExact: '203.0.113.0',
        prefixLength: 24
    });
    assert.equal(filteredResult.purged, 1);
    assert.equal(filteredResult.hasMore, true);
    const detailed = filtered.purgeStaleRoutes({ ...filterQuery, includeDetails: true });
    assert.equal(detailed.purged, 1);
    assert.equal(detailed.routes.length, 1);
    assert.equal(detailed.deltas.length, 1);
    assert.equal(detailed.deltas[0].previous.persistentRouteId, detailed.routes[0].persistentRouteId);

    const shared = open('shared-identity');
    const sharedContext = context('shared-identity');
    const otherOwner = new Peer(sharedContext.session);
    Object.assign(otherOwner, { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.2', sessionAs: 65001 });
    const sharedSeed = [
        buildConnectionMutation(sharedContext.session, 'connection_open'),
        announce(sharedContext, 1),
        announce({ ...sharedContext, owner: otherOwner }, 1)
    ];
    apply(shared, sharedSeed);
    shared.db.prepare("UPDATE bmp_rib_scopes SET scope_state='stale' WHERE scope_id=?").run(sharedSeed[1].scope.id);
    assert.equal(shared.purgeStaleRoutes({ scopeId: sharedSeed[1].scope.id, includeDetails: false }).purged, 1);
    assert.equal(shared.queryScopeSummary({ scopeId: sharedSeed[2].scope.id }).active, 1);
    for (const table of ['bmp_route_identities', 'bmp_route_payloads', 'bmp_route_attributes'])
        assert.equal(
            shared.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
            1,
            'another scope referencing the same identity/payload/attribute must keep that object alive'
        );

    const partitionRollback = open('partition-rollback');
    const partitionContext = context('partition-rollback');
    const partitionSeed = [buildConnectionMutation(partitionContext.session, 'connection_open')];
    for (const value of families()) partitionSeed.push(announce(partitionContext, 1, value));
    apply(partitionRollback, partitionSeed);
    partitionRollback.db.prepare("UPDATE bmp_rib_scopes SET scope_state='down'").run();
    const partitionBefore = snapshot(partitionRollback);
    const partitionPrepare = partitionRollback.db.prepare.bind(partitionRollback.db);
    let deleteCount = 0;
    partitionRollback.db.prepare = sql => {
        const statement = partitionPrepare(sql);
        if (!sql.includes('DELETE FROM "bmp_current_routes_')) return statement;
        const run = statement.run.bind(statement);
        statement.run = params => {
            if (++deleteCount === 2) throw new Error('injected second partition delete failure');
            return run(params);
        };
        return statement;
    };
    const partitionQuery = { ownerKey: partitionSeed[1].scope.ownerKey, includeDetails: false };
    assert.throws(() => partitionRollback.purgeStaleRoutes(partitionQuery), /second partition delete failure/);
    assert.deepEqual(snapshot(partitionRollback), partitionBefore);
    assertCandidatesEmpty(partitionRollback);
    partitionRollback.db.prepare = partitionPrepare;
    assert.equal(partitionRollback.purgeStaleRoutes(partitionQuery).purged, 3);

    const readOnly = new Store({ dbPath: shared.dbPath, readOnly: true }).open();
    try {
        assert.throws(
            () => readOnly.purgeStaleRoutes({ scopeId: sharedSeed[2].scope.id, includeDetails: false }),
            /read-only/
        );
    } finally {
        readOnly.close();
    }

    const clients = open('clients', true);
    const clientA = context('client-a');
    const clientB = context('client-b');
    const seedA = [buildConnectionMutation(clientA.session, 'connection_open'), announce(clientA, 1)];
    const seedB = [buildConnectionMutation(clientB.session, 'connection_open'), announce(clientB, 1)];
    apply(clients, [...seedA, ...seedB]);
    for (const source of [seedA[0].source.id, seedB[0].source.id])
        clients.getStore(source).db.prepare("UPDATE bmp_rib_scopes SET scope_state='down'").run();
    const mismatch = clients.purgeStaleRoutes({
        sourceId: seedA[0].source.id,
        scopeId: seedB[1].scope.id,
        includeDetails: false
    });
    assertCompact(mismatch);
    assert.equal(mismatch.purged, 0);
    assert.equal(clients.queryScopeSummary({ sourceId: seedB[0].source.id }).stale, 1);
    const absent = clients.purgeStaleRoutes({ scopeId: 'f'.repeat(64), includeDetails: false });
    assertCompact(absent);
    assert.equal(absent.purged, 0);
    const ownerKey = seedA[1].scope.ownerKey;
    const firstClient = clients.purgeStaleRoutes({ ownerKey, includeDetails: false, routeLimit: 1 });
    assertCompact(firstClient);
    assert.equal(firstClient.purged, 1);
    assert.equal(firstClient.hasMore, true);
    const secondClient = clients.purgeStaleRoutes({ ownerKey, includeDetails: false, routeLimit: 1 });
    assertCompact(secondClient);
    assert.equal(secondClient.purged, 1);
    assert.equal(clients.queryScopeSummary({}).total, 0);
    assert.throws(() => clients.purgeStaleRoutes({ includeDetails: false }), /requires scopeId or ownerKey/);
    console.log(
        'BMP compact stale purge bucket isolation, set deletion, GC, counters, rollback and query plans passed'
    );
} finally {
    for (const store of openedStores.reverse()) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
}
