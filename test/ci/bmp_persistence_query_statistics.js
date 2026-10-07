const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ClientStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const Instance = require('../../electron/worker/bmp/bmpBgpInstance');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const { buildRouteUpsertMutation } = require('../../electron/worker/bmp/bmpPersistenceMutation');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-query-statistics-'));
const TIME = 1767225600000;
const SHARED_ROUTES = 10;
let serial = 0;

function mutation(context, index, asPath = '65001', eventAtMs = TIME + index) {
    const prefix = `10.${(index >>> 16) & 255}.${(index >>> 8) & 255}.${index & 255}`;
    const route = new Route(null, null);
    Object.assign(route, { afi: 1, safi: 1, pathId: 0, ip: prefix, mask: 32, nlriDetail: { prefix, length: 32 } });
    route.assignRouteAttr({ origin: 'IGP', asPath, nextHop: '192.0.2.1' });
    return buildRouteUpsertMutation(context.session, context.owner, route, 1, 1, 'loc-rib', {
        kind: 'loc-rib',
        state: 'ready',
        scopeState: 'ready',
        eventAtMs
    });
}

function apply(writer, mutations, batchId = `query-statistics-${++serial}`) {
    return writer.applyBatch({
        batchId,
        createdAtMs: TIME,
        includeDeltas: false,
        mutations
    });
}

function attributeEstimate(db) {
    const row = db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'bmp_route_attributes'").get();
    return Number(row?.stat.split(' ')[0] || 0);
}

function fixture(name) {
    const session = {
        remoteIp: '192.0.2.10',
        remotePort: 50001,
        localIp: '127.0.0.1',
        localPort: 11019,
        sysName: 'query-statistics',
        persistenceConnectionId: 'query-statistics-connection',
        persistenceConnectionGeneration: 1,
        persistenceOpenedAtMs: TIME
    };
    const owner = new Instance(session);
    Object.assign(owner, { instanceType: 3, instanceRd: '0:0', instanceIp: '198.51.100.1', instanceAs: 65001 });
    const context = { session, owner };
    const dbPath = path.join(directory, `${name}.sqlite3`);
    const clientWriter = new ClientStore({ dbPath }).open();
    const initial = Array.from({ length: SHARED_ROUTES }, (_, index) => mutation(context, index));
    apply(clientWriter, initial);
    const writer = clientWriter.getStore(initial[0].source.id);
    // These statistics are accurate when all ten initial routes share one attribute.
    writer.db.exec('ANALYZE');
    assert.equal(attributeEstimate(writer.db), 1);
    const clientReader = new ClientStore({ dbPath, readOnly: true }).open();
    const reader = clientReader.getStore(initial[0].source.id);
    const routeQuery = {
        sourceId: initial[0].source.id,
        scopeId: initial[0].scope.id,
        page: 1,
        pageSize: 25,
        routeState: 'all',
        prefixFilter: '',
        orderBy: 'firstSeen'
    };
    const request = {
        routeQuery,
        summaryQuery: { sourceId: routeQuery.sourceId, scopeId: routeQuery.scopeId }
    };
    let routeSql;
    const buildRows = reader.buildRouteRowsSql.bind(reader);
    reader.buildRouteRowsSql = options => {
        routeSql = buildRows(options);
        return routeSql;
    };
    assert.equal(clientReader.queryRouteScope(request).routes.total, SHARED_ROUTES);
    const plan = () =>
        reader.db
            .prepare(`EXPLAIN QUERY PLAN ${routeSql}`)
            .all({ sourceId: routeQuery.sourceId, scopeId: routeQuery.scopeId, limit: 26, offset: 0 })
            .map(row => row.detail);
    return { context, writer, reader, clientWriter, clientReader, request, plan };
}

function assertIndexedAttributePlan(plan) {
    const text = plan.join('\n');
    assert.match(text, /SEARCH route_attr USING INTEGER PRIMARY KEY/, text);
    assert.doesNotMatch(text, /SCAN route_attr/, text);
}

function assertPage(current, total) {
    const result = current.clientReader.queryRouteScope(current.request);
    assert.equal(result.routes.total, total);
    assert.equal(result.routes.list.length, 25);
    assert.deepEqual(
        result.routes.list.map(route => route.ip),
        Array.from({ length: 25 }, (_, index) => `10.0.0.${index}`),
        'refresh preserves the requested first-seen order'
    );
    assertIndexedAttributePlan(current.plan());
}

function verifyMaintenanceRefreshesMissedStatistics() {
    const current = fixture('maintenance');
    try {
        // Reproduce statistics left by the previous writer, whose ordinary
        // optimize never selected the attributes table after unique-key lookups.
        const optimize = current.writer.optimizeQueryStatistics;
        current.writer.optimizeQueryStatistics = () => current.writer.db.pragma('optimize');
        apply(
            current.clientWriter,
            Array.from({ length: 10000 }, (_, index) =>
                mutation(current.context, SHARED_ROUTES + index, String(70000 + index))
            )
        );
        current.writer.optimizeQueryStatistics = optimize;
        assert.equal(
            attributeEstimate(current.writer.db),
            1,
            'ordinary optimize leaves the original accurate snapshot stale after attribute growth'
        );
        assert.match(current.plan().join('\n'), /SCAN route_attr/, 'the fixture exercises the stale attribute plan');
        const options = { staleBeforeMs: 0, eventsBeforeMs: 0, refreshTimeoutBeforeMs: 0 };
        current.writer.sweep({ ...options, mode: 'lifecycle', sourceId: current.request.routeQuery.sourceId });
        assert.equal(attributeEstimate(current.writer.db), 1, 'a source lifecycle sweep does not analyze the database');
        current.writer.sweep({ ...options, mode: 'maintenance' });
        assert.ok(
            attributeEstimate(current.writer.db) > 1,
            'maintenance discovers growth despite unique attr_id lookups'
        );
        assert.match(
            current.plan().join('\n'),
            /SCAN route_attr/,
            'the already-open reader still caches old statistics'
        );
        assert.equal(current.reader.refreshQueryStatistics(), true, 'the existing reader reloads changed statistics');
        assert.equal(current.reader.refreshQueryStatistics(), false, 'unchanged statistics are not reloaded again');
        assertPage(current, SHARED_ROUTES + 10000);
    } finally {
        current.clientReader.close();
        current.clientWriter.close();
    }
}

function verifyLargeIngestRefreshesBeforeTheNextPage() {
    const current = fixture('ingest');
    try {
        apply(
            current.clientWriter,
            Array.from({ length: 10000 }, (_, index) =>
                mutation(current.context, SHARED_ROUTES + index, String(70000 + index))
            )
        );
        assert.equal(
            current.writer.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_attributes').get().count,
            10001
        );
        assert.ok(
            attributeEstimate(current.writer.db) > 1,
            'large ingest updates statistics without waiting for a sweep'
        );
        assert.match(current.plan().join('\n'), /SCAN route_attr/, 'the old reader has not yet refreshed its planner');
        assertPage(current, SHARED_ROUTES + 10000);
        assert.equal(current.reader.refreshQueryStatistics(), false, 'public paging has already refreshed the reader');

        const version = current.reader.db.pragma('data_version', { simple: true });
        apply(current.clientWriter, [mutation(current.context, 0, '65001', TIME + 20000)]);
        assert.notEqual(current.reader.db.pragma('data_version', { simple: true }), version);
        assert.equal(
            current.reader.refreshQueryStatistics(),
            false,
            'ordinary route updates do not reload unchanged stats'
        );
        assertPage(current, SHARED_ROUTES + 10000);
    } finally {
        current.clientReader.close();
        current.clientWriter.close();
    }
}

function verifyCommittedNewAttributesAccumulateAcrossBatches() {
    const current = fixture('cumulative');
    const group = (offset, size = 100) =>
        Array.from({ length: size }, (_, index) =>
            mutation(current.context, SHARED_ROUTES + offset + index, String(70000 + offset + index))
        );
    try {
        const first = group(0);
        apply(current.clientWriter, first, 'cumulative-first');
        assert.equal(
            attributeEstimate(current.writer.db),
            1,
            'a small committed batch remains below the refresh budget'
        );
        apply(current.clientWriter, first, 'cumulative-first');
        apply(current.clientWriter, group(0));
        assert.equal(
            attributeEstimate(current.writer.db),
            1,
            'duplicate batches and existing attributes do not add growth'
        );

        const failed = group(1000, 200);
        failed[0].scope = { ...failed[0].scope, identityJson: null };
        assert.throws(() => apply(current.clientWriter, failed), /NOT NULL constraint failed/);
        assert.equal(
            current.writer.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_attributes').get().count,
            101,
            'failed inserts roll back their new attribute rows'
        );
        apply(current.clientWriter, group(100));
        assert.equal(
            attributeEstimate(current.writer.db),
            1,
            'failed batches do not consume the committed growth budget'
        );
        apply(current.clientWriter, group(200));
        assert.ok(attributeEstimate(current.writer.db) > 1, 'several small commits eventually refresh the statistics');
        assertPage(current, SHARED_ROUTES + 300);
    } finally {
        current.clientReader.close();
        current.clientWriter.close();
    }
}

function verifyReaderOpeningSnapshotDoesNotMissConcurrentAnalysis() {
    const current = fixture('opening-snapshot');
    const validate = current.reader.validateReadableSchema.bind(current.reader);
    let pending = true;
    current.reader.validateReadableSchema = () => {
        validate();
        if (pending) {
            pending = false;
            // Commit after schema reads have initialized the reader's planner,
            // but before open records its statistics fingerprint/data_version.
            apply(
                current.clientWriter,
                Array.from({ length: 10000 }, (_, index) =>
                    mutation(current.context, SHARED_ROUTES + index, String(82000 + index))
                )
            );
            current.writer.db.exec('ANALYZE');
        }
    };
    try {
        current.reader.close();
        current.reader.open();
        assert.ok(
            attributeEstimate(current.reader.db) > 1,
            'the writer committed updated statistics during reader open'
        );
        assert.match(current.plan().join('\n'), /SCAN route_attr/, 'the opening snapshot initialized the old planner');
        assert.equal(
            current.reader.refreshQueryStatistics(),
            true,
            'initialization does not record a newer fingerprint over an older planner snapshot'
        );
        assert.equal(current.reader.refreshQueryStatistics(), false);
        assertPage(current, SHARED_ROUTES + 10000);
    } finally {
        current.clientReader.close();
        current.clientWriter.close();
    }
}

try {
    verifyMaintenanceRefreshesMissedStatistics();
    verifyLargeIngestRefreshesBeforeTheNextPage();
    verifyCommittedNewAttributesAccumulateAcrossBatches();
    verifyReaderOpeningSnapshotDoesNotMissConcurrentAnalysis();
    console.log('BMP attribute growth / maintenance statistics / existing reader planner refresh tests passed');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
