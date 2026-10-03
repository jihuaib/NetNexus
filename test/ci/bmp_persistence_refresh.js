const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpClientPersistenceStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { resolveBmpRoutePartition } = require('../../electron/worker/bmp/bmpRoutePartitionManifest');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-refresh-'));
const BASE_TIME = 1767225600000;
let batchSequence = 0;

function context(kind, generation = 1) {
    const session = {
        sysName: 'refresh-router',
        remoteIp: '192.0.2.10',
        remotePort: 50000 + generation,
        localIp: '127.0.0.1',
        localPort: 11019,
        persistenceConnectionGeneration: generation,
        persistenceOpenedAtMs: BASE_TIME + generation
    };
    const owner = kind === 'peer' ? new BmpBgpSession(session) : new BmpBgpInstance(session);
    Object.assign(
        owner,
        kind === 'peer'
            ? { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65001 }
            : { instanceType: 3, instanceRd: '0:0', instanceIp: '198.51.100.1', instanceAs: 65001 }
    );
    owner.vrfTableNames = ['blue'];
    return { session, owner, kind, ribType: kind === 'peer' ? 2 : 'loc-rib' };
}

function route() {
    const value = new BmpBgpRoute(null, null);
    Object.assign(value, {
        afi: 1,
        safi: 1,
        pathId: 0,
        ip: '203.0.113.0',
        mask: 24,
        nlriDetail: { prefix: '203.0.113.0', length: 24 }
    });
    value.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' });
    return value;
}

function announce(current, value, options = {}) {
    return buildRouteUpsertMutation(current.session, current.owner, value, 1, 1, current.ribType, {
        kind: current.kind,
        state: 'ready',
        scopeState: 'ready',
        eventAtMs: BASE_TIME,
        ...options
    });
}

function scopeEvent(current, eventType, state, options = {}) {
    return buildScopeMutation(current.session, current.owner, 1, 1, current.ribType, eventType, {
        kind: current.kind,
        state,
        eventAtMs: BASE_TIME,
        ...options
    });
}

function apply(store, mutations, includeDeltas = true) {
    batchSequence += 1;
    return store.applyBatch({ batchId: `refresh-${batchSequence}`, createdAtMs: BASE_TIME, mutations, includeDeltas });
}

function partitionFor(current) {
    return resolveBmpRoutePartition({ scopeKind: current.kind, afi: 1, safi: 1 });
}

function rawRoute(store, current) {
    return store.db.prepare(`SELECT * FROM ${partitionFor(current).quotedTableName}`).get();
}

function candidates(store) {
    return store.db.prepare('SELECT kind, pk FROM main.bmp_gc_candidates ORDER BY kind, pk').all();
}

function monitor(statement, name, calls) {
    return new Proxy(statement, {
        get(target, key) {
            if (['run', 'get', 'all'].includes(key)) {
                return (...args) => {
                    calls[name] = (calls[name] || 0) + 1;
                    return Reflect.apply(target[key], target, args);
                };
            }
            return Reflect.get(target, key, target);
        }
    });
}

function monitorStore(store, current) {
    const calls = {};
    const statements = store.getPartitionStatements(partitionFor(current));
    for (const name of ['findCurrentRoute', 'findCurrentRouteRefs', 'refreshRouteMetadata', 'upsertRoute']) {
        statements[name] = monitor(statements[name], name, calls);
    }
    for (const name of ['addGcCandidate', 'findSourceContext', 'findConnectionContext']) {
        store.statements[name] = monitor(store.statements[name], name, calls);
    }
    return calls;
}

function clearCalls(calls) {
    Object.keys(calls).forEach(key => delete calls[key]);
}

function assertNoRebuild(result) {
    assert.equal(result.requiresProjectionRebuild, undefined, 'unchanged context must not request an analysis rebuild');
}

function metadataRefresh(kind, includeDeltas) {
    const current = context(kind);
    const value = route();
    const store = new BmpPersistenceStore({ dbPath: path.join(directory, `${kind}-${includeDeltas}.sqlite3`) }).open();
    try {
        const initial = announce(current, value, { sourceTimestampMs: BASE_TIME - 20 });
        apply(store, [initial], includeDeltas);
        const original = rawRoute(store, current);
        const counts = store.db.prepare('SELECT * FROM bmp_scope_route_counts').all();
        const calls = monitorStore(store, current);
        const refreshed = announce(current, value, {
            eventAtMs: BASE_TIME + 1000,
            sourceTimestampMs: BASE_TIME + 500
        });
        const result = apply(store, [refreshed], includeDeltas);
        assert.equal(result.applied, 1);
        assertNoRebuild(result);
        if (includeDeltas) assert.deepEqual(result.deltas, []);
        assert.equal(calls.findCurrentRouteRefs, 1);
        assert.equal(calls.refreshRouteMetadata, 1);
        assert.equal(calls.upsertRoute, undefined);
        assert.equal(calls.findCurrentRoute, undefined, 'metadata refresh must not read expanded previous JSON');
        assert.equal(calls.addGcCandidate, undefined);
        assert.equal(calls.findSourceContext || 0, includeDeltas ? 1 : 0);
        assert.equal(calls.findConnectionContext || 0, includeDeltas ? 1 : 0);
        assert.deepEqual(candidates(store), []);
        assert.deepEqual(store.db.prepare('SELECT * FROM bmp_scope_route_counts').all(), counts);
        const refreshedRow = rawRoute(store, current);
        assert.equal(refreshedRow.first_seen_ms, original.first_seen_ms);
        assert.equal(refreshedRow.last_seen_ms, BASE_TIME + 1000);
        assert.equal(refreshedRow.source_timestamp_ms, BASE_TIME + 500);
        assert.equal(refreshedRow.last_sequence, refreshed.sequence);
        for (const field of ['path_pk', 'payload_id', 'attr_pk', 'connection_pk', 'rib_epoch', 'explicit_state']) {
            assert.equal(refreshedRow[field], original[field], field);
        }
        const page = store.queryRoutes({ scopeId: initial.scope.id, routeState: 'all' }).list[0];
        assert.equal(page.lastSeenAt, new Date(BASE_TIME + 1000).toISOString());
        assert.equal(page.sourceTimestampMs, BASE_TIME + 500);

        clearCalls(calls);
        const olderTime = announce(current, value, { eventAtMs: BASE_TIME - 1000, sourceTimestampMs: null });
        assertNoRebuild(apply(store, [olderTime], includeDeltas));
        assert.equal(rawRoute(store, current).last_seen_ms, BASE_TIME + 1000, 'lastSeen must remain monotonic');
        assert.equal(
            rawRoute(store, current).source_timestamp_ms,
            null,
            'null source timestamps retain existing overwrite semantics'
        );
        assert.equal(rawRoute(store, current).last_sequence, olderTime.sequence);
        assert.equal(
            apply(store, [refreshed], includeDeltas).applied,
            0,
            'old sequence must not roll observation metadata back'
        );
        assert.equal(rawRoute(store, current).last_sequence, olderTime.sequence);

        const sql = store.getPartitionStatements(partitionFor(current)).refreshRouteMetadata.source;
        const operations = store.db.prepare(`EXPLAIN ${sql}`).all({
            scopePk: original.scope_pk,
            routePk: original.route_pk,
            payloadId: original.payload_id,
            attrPk: original.attr_pk,
            connectionPk: original.connection_pk,
            epoch: original.rib_epoch,
            partitionId: partitionFor(current).partitionId,
            sequence: olderTime.sequence + 1,
            eventAtMs: BASE_TIME + 2000,
            sourceTimestampMs: null
        });
        assert.equal(
            operations.some(operation => ['IdxDelete', 'IdxInsert', 'Program'].includes(operation.opcode)),
            false,
            'metadata UPDATE must neither rewrite indexed keys nor execute route triggers'
        );

        // Row-level ordering and current scope ownership remain guarded even if a
        // caller supplies a sequence newer than its connection but older than the row.
        const beforeGuard = rawRoute(store, current);
        store.db
            .prepare(`UPDATE ${partitionFor(current).quotedTableName} SET last_sequence = ?`)
            .run(olderTime.sequence + 100);
        const guarded = announce(current, value, { eventAtMs: BASE_TIME + 9000 });
        apply(store, [guarded], includeDeltas);
        assert.equal(rawRoute(store, current).last_seen_ms, beforeGuard.last_seen_ms);
        assert.equal(rawRoute(store, current).last_sequence, olderTime.sequence + 100);
        store.db.prepare(`UPDATE ${partitionFor(current).quotedTableName} SET last_sequence = ?`).run(guarded.sequence);

        // The narrow classification may match an old row while its scope has
        // already advanced. The UPDATE must not revive that previous epoch.
        const beforeScopeGuard = rawRoute(store, current);
        store.db.prepare('UPDATE bmp_rib_scopes SET current_epoch = current_epoch + 1, scope_state = ?').run('syncing');
        clearCalls(calls);
        const oldEpoch = apply(store, [announce(current, value, { eventAtMs: BASE_TIME + 10000 })], includeDeltas);
        assert.equal(calls.refreshRouteMetadata, 1, 'old row contents still select the narrow path');
        assert.equal(calls.upsertRoute, undefined);
        assertNoRebuild(oldEpoch);
        if (includeDeltas) assert.deepEqual(oldEpoch.deltas, []);
        assert.deepEqual(
            rawRoute(store, current),
            beforeScopeGuard,
            'scope epoch guard must preserve old row metadata'
        );
        store.db.prepare('UPDATE bmp_rib_scopes SET current_epoch = current_epoch - 1, scope_state = ?').run('ready');

        // Explicit stale state is semantic, even with identical attrs and payload.
        store.db.prepare(`UPDATE ${partitionFor(current).quotedTableName} SET explicit_state = 'stale'`).run();
        clearCalls(calls);
        const activated = apply(store, [announce(current, value)], includeDeltas);
        assert.equal(rawRoute(store, current).explicit_state, 'active');
        assert.equal(calls.upsertRoute, 1);
        assert.equal(calls.refreshRouteMetadata, undefined);
        assert.deepEqual(candidates(store), [], 'state-only changes cannot orphan unchanged payload/attrs');
        if (includeDeltas) {
            assert.equal(activated.deltas[0].projectionChanged, true);
            assert.equal(activated.deltas[0].classification, 'refresh');
        }
    } finally {
        store.close();
    }
}

function semanticChanges(kind) {
    const current = context(kind);
    const value = route();
    const store = new BmpPersistenceStore({ dbPath: path.join(directory, `${kind}-semantic.sqlite3`) }).open();
    try {
        apply(store, [announce(current, value)]);
        let previous = rawRoute(store, current);
        value.assignRouteAttr({ ...value.getRouteAttr(), nextHop: '192.0.2.2' });
        const replacement = apply(store, [announce(current, value)]);
        assert.equal(replacement.deltas[0].classification, 'replace');
        assert.deepEqual(
            candidates(store),
            [{ kind: 3, pk: previous.attr_pk }],
            'attrs-only replacement must not GC the still-shared payload'
        );
        store.db.exec('DELETE FROM main.bmp_gc_candidates');
        previous = rawRoute(store, current);
        value.labels = '100';
        const payloadChange = apply(store, [announce(current, value)]);
        assert.equal(payloadChange.deltas[0].projectionChanged, true);
        assert.deepEqual(
            candidates(store),
            [{ kind: 2, pk: previous.payload_id }],
            'payload-only replacement must not GC unchanged attrs'
        );
        store.db.exec('DELETE FROM main.bmp_gc_candidates');

        if (kind === 'peer') current.owner.advanceRibEpoch(1, 1, current.ribType);
        else current.owner.advanceRibEpoch();
        const epoch = apply(store, [announce(current, value, { scopeState: 'syncing' })]);
        assert.equal(epoch.deltas[0].classification, 'refresh');
        assert.equal(epoch.deltas[0].projectionChanged, true);
        assert.equal(epoch.requiresProjectionRebuild, true);
        assert.deepEqual(candidates(store), [], 'epoch-only refresh must not GC unchanged refs');
        apply(store, [scopeEvent(current, 'scope_eor', 'ready')]);
        assert.equal(store.queryRoutes({ routeState: 'active' }).total, 1);

        const reconnect = context(kind, 2);
        const reopened = apply(store, [
            buildConnectionMutation(reconnect.session, 'connection_open'),
            announce(reconnect, value)
        ]);
        assert.equal(reopened.deltas[0].projectionChanged, true);
        assert.equal(reopened.deltas[0].classification, 'refresh');
        assert.deepEqual(candidates(store), []);
        const active = rawRoute(store, current);
        const lateOld = apply(store, [announce(current, value, { eventAtMs: BASE_TIME + 50000 })]);
        assert.equal(lateOld.deltas[0].projectionChanged, false);
        assert.equal(
            lateOld.requiresProjectionRebuild,
            undefined,
            'rejected old scope ownership must not claim a context change'
        );
        assert.deepEqual(rawRoute(store, current), active);
        assert.equal(store.queryRoutes({ routeState: 'active' }).total, 1);
    } finally {
        store.close();
    }
}

function contextChanges(kind, aggregate = false) {
    const current = context(kind);
    const value = route();
    const dbPath = path.join(directory, `${kind}-context-${aggregate}.sqlite3`);
    const store = new (aggregate ? BmpClientPersistenceStore : BmpPersistenceStore)({ dbPath }).open();
    try {
        const initial = announce(current, value);
        const unreported = route();
        unreported.ip = '203.0.114.0';
        unreported.nlriDetail = { prefix: '203.0.114.0', length: 24 };
        apply(store, [initial, announce(current, unreported)]);
        const rows = () => store.queryRoutes({ sourceId: initial.source.id, routeState: 'all', pageSize: 10 }).list;
        const originalName = current.session.sysName;
        current.session.sysName = 'renamed-router';
        const renamed = apply(store, [announce(current, value)]);
        assert.equal(renamed.requiresProjectionRebuild, true, 'source labels affect unreported routes too');
        assert.deepEqual(renamed.deltas, [], 'context rebuild does not need an expanded per-route delta');
        assert.equal(rows().length, 2);
        assert.equal(
            rows().every(row => row.source.sysName === 'renamed-router'),
            true,
            'source changes affect the existing prefix that was not re-announced'
        );
        assertNoRebuild(apply(store, [announce(current, value)]));
        current.session.sysName = '';
        assertNoRebuild(
            apply(store, [announce(current, value)]),
            'empty source labels are not actual SQL context changes'
        );
        current.session.sysName = 'renamed-router';
        current.session.localPort += 1;
        const endpoint = apply(store, [announce(current, value)]);
        assert.equal(endpoint.requiresProjectionRebuild, true);
        assert.deepEqual(endpoint.deltas, []);
        assert.equal(
            rows().every(row => row.source.localPort === current.session.localPort),
            true
        );
        assertNoRebuild(apply(store, [announce(current, value)]));
        current.owner.vrfTableNames = ['green'];
        const vrf = apply(store, [announce(current, value)]);
        assert.equal(vrf.requiresProjectionRebuild, true, 'VRF changes must rebuild groups not present in this batch');
        assert.deepEqual(vrf.deltas, []);
        assert.equal(
            rows().every(row => row.peer.vrf === 'green'),
            true,
            'scope VRF changes affect both prefixes although only one was re-announced'
        );
        assertNoRebuild(apply(store, [announce(current, value)]));
        current.owner.vrfTableNames = [];
        assertNoRebuild(
            apply(store, [announce(current, value)]),
            'COALESCE-preserved VRF must not be treated as a real change'
        );

        // Source and scope can change twice within a batch. The rebuild request
        // must remain sticky after later mutations restore the original context.
        const first = announce(current, value);
        first.source = { ...first.source, sysName: originalName };
        first.scope = { ...first.scope, vrfName: 'blue' };
        const second = announce(current, value);
        second.source = { ...second.source, sysName: 'renamed-router' };
        second.scope = { ...second.scope, vrfName: 'green' };
        const transient = apply(store, [first, second]);
        assert.equal(transient.requiresProjectionRebuild, true);
        assert.deepEqual(transient.deltas, []);
        assertNoRebuild(apply(store, [announce(current, value)]));

        current.session.sysName = 'metadata-only-source-update';
        const sourceOnly = apply(store, [buildConnectionMutation(current.session, 'source_update')]);
        assert.equal(
            sourceOnly.requiresProjectionRebuild,
            true,
            'a source context update without route mutations still rebuilds analysis'
        );
        assert.deepEqual(sourceOnly.deltas, []);
        assertNoRebuild(apply(store, [buildConnectionMutation(current.session, 'source_update')]));

        const scopeState = apply(store, [announce(current, value, { scopeState: 'syncing' })]);
        assert.equal(
            scopeState.requiresProjectionRebuild,
            true,
            'same-row scope state transitions remain visible to analysis'
        );
        assert.deepEqual(scopeState.deltas, []);
        assertNoRebuild(apply(store, [announce(current, value, { scopeState: 'syncing' })]));

        current.session.sysName = 'analysis-off-name';
        current.owner.vrfTableNames = ['red'];
        const disabled = apply(store, [announce(current, value)], false);
        assertNoRebuild(disabled);
        assert.equal(Object.hasOwn(disabled, 'deltas'), false);
    } finally {
        store.close();
    }
}

try {
    for (const kind of ['peer', 'loc-rib']) {
        for (const includeDeltas of [false, true]) metadataRefresh(kind, includeDeltas);
        semanticChanges(kind);
        contextChanges(kind);
        contextChanges(kind, true);
    }
    console.log('BMP metadata refresh and context rebuild tests passed');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
