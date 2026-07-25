const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const BmpConst = require('../../electron/const/bmpConst');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { getSessionStatisticsReportRibType } = require('../../electron/utils/bmpStatistics');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation,
    buildRoutePurgeMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-persistence-'));
const dbPath = path.join(tempDir, 'bmp.sqlite3');
const oldTimestamp = Date.now() - 120000;

function makeContext() {
    const bmpSession = {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 55000,
        sysName: 'ci-router',
        sysDesc: 'persistence test',
        bmpVersion: 4,
        getBmpV4TlvDraft: () => 20
    };
    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, {
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: '198.51.100.1',
        sessionAs: 65001,
        vrfTableNames: ['blue']
    });
    return { bmpSession, owner };
}

function makeRoute(owner, prefix, pathId, nextHop) {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        ribType: 2,
        pathId,
        rd: '0:0',
        ip: prefix,
        mask: 24,
        nlriDetail: { prefix, length: 24, pathId, rd: '0:0' }
    });
    route.assignRouteAttr({
        origin: 'IGP',
        asPath: '65001',
        med: 0,
        localPref: 100,
        communities: ['65001:100'],
        nextHop
    });
    route.markActive(owner.getRibEpoch(1, 1, 2));
    return route;
}

function batch(batchId, mutations) {
    return { batchId, createdAtMs: Date.now(), mutations };
}

function makeStatisticsMutation(bmpSession, report, eventAtMs) {
    const mutation = buildConnectionMutation(bmpSession, 'statistics', { eventAtMs });
    mutation.statistics = report;
    return mutation;
}

let store;
try {
    const { bmpSession, owner } = makeContext();
    const routeA = makeRoute(owner, '203.0.113.0', 1, '192.0.2.1');
    const routeB = makeRoute(owner, '203.0.114.0', 2, '192.0.2.1');

    store = new BmpPersistenceStore({ dbPath }).open();
    assert.equal(store.getStatus().journalMode, 'wal');
    assert.equal(store.getStatus().schemaVersion, BmpPersistenceStore.SCHEMA_VERSION);

    const connectionOpen = buildConnectionMutation(bmpSession, 'connection_open', { eventAtMs: oldTimestamp });
    const scopeOpen = buildScopeMutation(bmpSession, owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'syncing',
        eventAtMs: oldTimestamp
    });
    const announceA = buildRouteUpsertMutation(bmpSession, owner, routeA, 1, 1, 2, {
        kind: 'peer',
        state: 'syncing',
        scopeState: 'syncing',
        isNewRoute: true,
        eventAtMs: oldTimestamp
    });
    const announceB = buildRouteUpsertMutation(bmpSession, owner, routeB, 1, 1, 2, {
        kind: 'peer',
        state: 'syncing',
        scopeState: 'syncing',
        isNewRoute: true,
        eventAtMs: oldTimestamp
    });
    const firstResult = store.applyBatch(batch('batch-1', [connectionOpen, scopeOpen, announceA, announceB]));
    assert.deepEqual(firstResult, { duplicate: false, applied: 4 });
    assert.equal(firstResult.deltas.length, 2);
    assert.deepEqual(
        firstResult.deltas.map(delta => delta.classification),
        ['announce', 'announce']
    );
    assert.equal(firstResult.deltas[0].previous, null);
    assert.equal(firstResult.deltas[0].current.ip, '203.0.113.0');
    assert.equal(firstResult.deltas[0].mutation.scope.ownerKey, announceA.scope.ownerKey);
    assert.deepEqual(store.applyBatch(batch('batch-1', [connectionOpen])), { duplicate: true, applied: 0 });
    assert.equal(
        Object.prototype.hasOwnProperty.call(JSON.parse(announceA.route.routeJson), 'asPath'),
        false,
        'deduplicated attributes must not be repeated in route_json'
    );

    let routes = store.queryRoutes({ routeState: 'all', pageSize: 10 });
    assert.equal(routes.total, 2);
    assert.equal(
        store.db.prepare('SELECT COUNT(*) AS count FROM bmp_current_routes_peer_ipv4_unicast').get().count,
        2,
        'IPv4 unicast peer routes must be written to their fixed physical partition'
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bmp_current_routes_peer_other').get().count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bmp_current_routes_all').get().count, 2);
    assert.equal(
        store.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_payloads').get().count,
        1,
        'identity and current-state fields must not prevent ordinary routes from sharing one compact payload'
    );
    assert.equal(
        routes.list.every(route => route.routeState === 'active'),
        true
    );
    assert.equal(routes.list.find(route => route.ip === '203.0.113.0').asPath, '65001');
    assert.deepEqual(routes.list[0].source, {
        localIp: bmpSession.localIp,
        localPort: bmpSession.localPort,
        remoteIp: bmpSession.remoteIp,
        remotePort: bmpSession.remotePort,
        sysName: bmpSession.sysName,
        sysDesc: bmpSession.sysDesc
    });
    assert.equal(store.queryRoutes({ afi: 1, safi: 1, prefix: '203.0.113' }).total, 1);
    assert.equal(store.queryRoutes({ ownerKey: announceA.scope.ownerKey }).total, 2);
    assert.equal(store.queryRoutes({ connectionId: announceA.connection.id }).total, 2);
    assert.equal(store.queryRoutes({ prefixExact: '203.0.113.0' }).total, 1);
    assert.equal(store.queryRoutes({ prefixLength: 24 }).total, 2);
    assert.equal(store.queryRoutes({ prefixCidrs: ['203.0.114.0/24'] }).total, 1);
    assert.equal(store.queryRoutes({ searchText: '192.0.2.1' }).total, 2);
    assert.equal(store.queryRoutes({ routeIdentityText: 'ipv4 unicast' }).total, 2);
    assert.equal(
        store.queryRoutes({ routeIdentityText: '192.0.2.1' }).total,
        0,
        'Route Lens text matching must not select a route by path attributes'
    );
    assert.equal(store.queryRoutes({ prefixFilter: '203.0.113.0/24' }).total, 1);
    assert.equal(store.queryRoutes({ prefixFilter: '203.0.113.0' }).total, 1);
    assert.equal(store.queryRoutes({ prefixFilter: '203.0.11' }).total, 2);
    assert.equal(store.queryRoutes({ prefixFilter: '192.0.2.1' }).total, 0, 'next-hop must not match prefixFilter');
    assert.deepEqual(store.queryScopeSummary({ scopeId: announceA.scope.id }), {
        active: 2,
        stale: 0,
        total: 2,
        scopes: [
            {
                scopeId: announceA.scope.id,
                sourceId: announceA.source.id,
                connectionId: announceA.connection.id,
                ownerKey: announceA.scope.ownerKey,
                scopeKind: 'peer',
                afi: 1,
                safi: 1,
                ribType: '2',
                scopeState: 'syncing',
                currentEpoch: 0,
                eorEpoch: null,
                staleReason: null,
                active: 2,
                stale: 0,
                total: 2
            }
        ]
    });
    const routeScopeSnapshot = store.queryRouteScope({
        routeQuery: { scopeId: announceA.scope.id, routeState: 'all', pageSize: 1 },
        summaryQuery: { scopeId: announceA.scope.id }
    });
    assert.equal(routeScopeSnapshot.routes.list.length, 1);
    assert.equal(routeScopeSnapshot.routes.total, routeScopeSnapshot.summary.total);
    assert.equal(routes.list[0].persistentRouteId.length, 64);
    const firstRouteCursorPage = store.queryRoutes({ routeState: 'all', pageSize: 1, includeTotal: false });
    assert.equal(firstRouteCursorPage.total, null);
    assert.ok(firstRouteCursorPage.nextCursor);
    const secondRouteCursorPage = store.queryRoutes({
        routeState: 'all',
        pageSize: 1,
        includeTotal: false,
        cursor: firstRouteCursorPage.nextCursor
    });
    assert.notEqual(firstRouteCursorPage.list[0].persistentRouteId, secondRouteCursorPage.list[0].persistentRouteId);
    const firstSeenRoutePage = store.queryRoutes({
        routeState: 'all',
        orderBy: 'firstSeen',
        page: 1,
        pageSize: 1
    });
    const secondFirstSeenRoutePage = store.queryRoutes({
        routeState: 'all',
        orderBy: 'firstSeen',
        page: 2,
        pageSize: 1
    });
    assert.equal(firstSeenRoutePage.nextCursor, null);
    assert.notEqual(firstSeenRoutePage.list[0].persistentRouteId, secondFirstSeenRoutePage.list[0].persistentRouteId);
    assert.throws(
        () =>
            store.queryRoutes({
                orderBy: 'firstSeen',
                cursor: firstRouteCursorPage.nextCursor
            }),
        /cannot be combined/
    );

    const beforeAttrHash = announceA.route.attrId;
    routeA.assignRouteAttr({ ...routeA.getRouteAttr(), nextHop: '192.0.2.2' });
    const replaceA = buildRouteUpsertMutation(bmpSession, owner, routeA, 1, 1, 2, {
        kind: 'peer',
        state: 'syncing',
        scopeState: 'syncing',
        isNewRoute: false,
        previousAttrHash: beforeAttrHash
    });
    assert.equal(replaceA.eventType, 'replace');
    const replaceResult = store.applyBatch(batch('batch-2', [replaceA]));
    assert.equal(replaceResult.deltas[0].classification, 'replace');
    assert.equal(replaceResult.deltas[0].previous.nextHop, '192.0.2.1');
    assert.equal(replaceResult.deltas[0].current.nextHop, '192.0.2.2');

    owner.advanceRibEpoch(1, 1, 2);
    const nextScope = buildScopeMutation(bmpSession, owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'syncing'
    });
    routeA.markActive(owner.getRibEpoch(1, 1, 2));
    const refreshA = buildRouteUpsertMutation(bmpSession, owner, routeA, 1, 1, 2, {
        kind: 'peer',
        state: 'syncing',
        scopeState: 'syncing',
        isNewRoute: false,
        previousAttrHash: replaceA.route.attrId
    });
    const eor = buildScopeMutation(bmpSession, owner, 1, 1, 2, 'scope_eor', {
        kind: 'peer',
        state: 'ready'
    });
    const refreshResult = store.applyBatch(batch('batch-3', [nextScope, refreshA, eor]));
    assert.equal(refreshResult.deltas[0].classification, 'refresh');

    routes = store.queryRoutes({ routeState: 'all', pageSize: 10 });
    assert.equal(routes.total, 2);
    assert.equal(routes.list.find(route => route.ip === '203.0.113.0').routeState, 'active');
    const staleAfterEor = routes.list.find(route => route.ip === '203.0.114.0');
    assert.equal(staleAfterEor.routeState, 'stale');
    assert.equal(staleAfterEor.staleReason, 'refresh-pending');
    assert.equal(staleAfterEor.staleEpoch, 1);
    assert.ok(staleAfterEor.staleAt);

    // A BMP reconnect/application restart creates a new in-memory owner whose epoch starts at zero.
    // The persisted connection generation must reset the scope epoch without reviving unseen routes.
    const reconnect = makeContext();
    reconnect.bmpSession.persistenceOpenedAtMs = bmpSession.persistenceOpenedAtMs + 1000;
    const reconnectedRouteA = makeRoute(reconnect.owner, '203.0.113.0', 1, '192.0.2.3');
    const reconnectScope = buildScopeMutation(reconnect.bmpSession, reconnect.owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'syncing'
    });
    const reconnectAnnounce = buildRouteUpsertMutation(
        reconnect.bmpSession,
        reconnect.owner,
        reconnectedRouteA,
        1,
        1,
        2,
        {
            kind: 'peer',
            state: 'syncing',
            scopeState: 'syncing',
            isNewRoute: true
        }
    );
    const reconnectEor = buildScopeMutation(reconnect.bmpSession, reconnect.owner, 1, 1, 2, 'scope_eor', {
        kind: 'peer',
        state: 'ready'
    });
    store.applyBatch(batch('batch-reconnect', [reconnectScope, reconnectAnnounce, reconnectEor]));

    routes = store.queryRoutes({ routeState: 'all', pageSize: 10 });
    const activeAfterReconnect = routes.list.find(route => route.ip === '203.0.113.0');
    const unseenAfterReconnect = routes.list.find(route => route.ip === '203.0.114.0');
    assert.equal(activeAfterReconnect.routeState, 'active');
    assert.equal(activeAfterReconnect.currentEpoch, 0);
    assert.equal(activeAfterReconnect.eorEpoch, 0);
    assert.equal(unseenAfterReconnect.routeState, 'stale');

    // A delayed mutation from the superseded connection must not change the current projection.
    const lateOldWithdraw = buildRouteWithdrawMutation(
        bmpSession,
        owner,
        { prefix: '203.0.113.0', length: 24, pathId: 1, rd: '0:0' },
        routeA,
        1,
        1,
        2,
        { kind: 'peer' }
    );
    const lateWithdrawResult = store.applyBatch(batch('batch-late-old-connection', [lateOldWithdraw]));
    assert.equal(lateWithdrawResult.deltas[0].classification, 'withdraw-noop');
    assert.equal(lateWithdrawResult.deltas[0].projectionChanged, false);
    assert.equal(lateWithdrawResult.deltas[0].current.ip, '203.0.113.0');
    routes = store.queryRoutes({ routeState: 'all', pageSize: 10 });
    assert.equal(routes.list.find(route => route.ip === '203.0.113.0').routeState, 'active');

    const swept = store.sweep({
        staleBeforeMs: Date.now() - 60000,
        eventsBeforeMs: 0,
        routeLimit: 100,
        eventLimit: 100
    });
    assert.equal(swept.routes, 1);
    routes = store.queryRoutes({ routeState: 'all' });
    assert.equal(routes.total, 1);
    assert.equal(routes.list[0].ip, '203.0.113.0');

    const missing = { prefix: '203.0.113.0', length: 24, pathId: 1, rd: '0:0' };
    const withdrawA = buildRouteWithdrawMutation(
        reconnect.bmpSession,
        reconnect.owner,
        missing,
        reconnectedRouteA,
        1,
        1,
        2,
        { kind: 'peer' }
    );
    store.applyBatch(batch('batch-4', [withdrawA]));
    assert.equal(store.queryRoutes({ routeState: 'all' }).total, 0);

    const events = store.queryEvents({ pageSize: 100 });
    assert.equal(
        events.list.some(event => event.eventType === 'announce'),
        true
    );
    assert.equal(
        events.list.some(event => event.eventType === 'replace'),
        true
    );
    assert.equal(events.list[0].eventType, 'withdraw');
    assert.ok(store.queryEvents({ afi: 1, safi: 1, prefix: '203.0.113', fromMs: null }).total > 0);
    assert.equal(
        store.queryEvents({ afi: 1, safi: 1, pageSize: 100 }).list.some(event => event.eventType === 'scope_open'),
        true,
        'scope-only events must retain their address-family partition'
    );
    assert.equal(store.queryEvents({ afi: 2, safi: 1 }).total, 0);
    const firstEventCursorPage = store.queryEvents({ pageSize: 2, includeTotal: false });
    assert.equal(firstEventCursorPage.total, null);
    assert.ok(firstEventCursorPage.nextCursor);
    const secondEventCursorPage = store.queryEvents({
        pageSize: 2,
        includeTotal: false,
        cursor: firstEventCursorPage.nextCursor
    });
    assert.equal(secondEventCursorPage.list.length > 0, true);
    assert.equal(
        firstEventCursorPage.list.some(first =>
            secondEventCursorPage.list.some(second => second.eventId === first.eventId)
        ),
        false
    );

    const eventCountBeforeAtomicityCheck = store.getStatus({ includeCounts: true }).routeEvents;
    const validRetryMutation = buildConnectionMutation(bmpSession, 'source_update');
    assert.throws(
        () => store.applyBatch(batch('atomic-retry', [validRetryMutation, { eventType: 'invalid', sequence: 999999 }])),
        /requires source and connection identities/
    );
    assert.equal(store.getStatus({ includeCounts: true }).routeEvents, eventCountBeforeAtomicityCheck);
    const retryResult = store.applyBatch(batch('atomic-retry', [validRetryMutation]));
    assert.deepEqual(retryResult, { duplicate: false, applied: 1 });

    const invalidSqlMutation = buildConnectionMutation(bmpSession, 'source_update');
    invalidSqlMutation.eventType = null;
    assert.throws(
        () => store.applyBatch(batch('sql-constraint-retry', [invalidSqlMutation])),
        /NOT NULL constraint failed/
    );
    invalidSqlMutation.eventType = 'source_update';
    assert.deepEqual(store.applyBatch(batch('sql-constraint-retry', [invalidSqlMutation])), {
        duplicate: false,
        applied: 1
    });

    const statisticsBase = {
        client: {
            localIp: bmpSession.localIp,
            localPort: bmpSession.localPort,
            remoteIp: bmpSession.remoteIp,
            remotePort: bmpSession.remotePort
        },
        tlvs: []
    };
    const peerSession = {
        sessionType: 0,
        sessionRd: '0:0',
        sessionRdRaw: 'raw:0000000000000000',
        sessionIp: '198.51.100.1',
        sessionAs: 65001
    };
    const firstPreInSessionReport = {
        ...statisticsBase,
        session: peerSession,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_IN, value: 10 }],
        updatedAt: '2026-01-01T00:00:00.000Z'
    };
    const latestPreInSessionReport = {
        ...firstPreInSessionReport,
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_IN, value: 20 }],
        updatedAt: '2026-01-01T00:00:01.000Z'
    };
    const firstPostInSessionReport = {
        ...statisticsBase,
        session: peerSession,
        effectiveSessionFlags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY,
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN, value: 30 }],
        updatedAt: '2026-01-01T00:00:02.000Z'
    };
    const latestPostInSessionReport = {
        ...firstPostInSessionReport,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_IN, value: 31 }],
        updatedAt: '2026-01-01T00:00:03.000Z'
    };
    const firstPreOutSessionReport = {
        ...statisticsBase,
        session: peerSession,
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT, value: 40 }],
        updatedAt: '2026-01-01T00:00:04.000Z'
    };
    const latestPreOutSessionReport = {
        ...statisticsBase,
        session: peerSession,
        ribDirection: 'rib-out',
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_PREFIXES_REJECTED, value: 50 }],
        updatedAt: '2026-01-01T00:00:05.000Z'
    };
    const firstPostOutSessionReport = {
        ...statisticsBase,
        session: peerSession,
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT, value: 60 }],
        updatedAt: '2026-01-01T00:00:06.000Z'
    };
    const latestPostOutSessionReport = {
        ...firstPostOutSessionReport,
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_OUT, value: 70 }],
        updatedAt: '2026-01-01T00:00:07.000Z'
    };
    const otherSessionReport = {
        ...statisticsBase,
        session: { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.2', sessionAs: 65002 },
        statistics: [{ type: 0, value: 30 }],
        updatedAt: '2026-01-01T00:00:08.000Z'
    };
    const instanceReport = {
        ...statisticsBase,
        instance: {
            instanceType: 3,
            instanceRd: '65000:100',
            instanceRdRaw: 'raw:0000fde800000064',
            vrfTableNames: ['blue']
        },
        statistics: [{ type: 14, value: 40 }],
        updatedAt: '2026-01-01T00:00:09.000Z'
    };
    store.applyBatch(
        batch('statistics-latest', [
            makeStatisticsMutation(bmpSession, firstPreInSessionReport, oldTimestamp + 1000),
            makeStatisticsMutation(bmpSession, latestPreInSessionReport, oldTimestamp + 2000),
            makeStatisticsMutation(bmpSession, firstPostInSessionReport, oldTimestamp + 3000),
            makeStatisticsMutation(bmpSession, latestPostInSessionReport, oldTimestamp + 4000),
            makeStatisticsMutation(bmpSession, firstPreOutSessionReport, oldTimestamp + 5000),
            makeStatisticsMutation(bmpSession, latestPreOutSessionReport, oldTimestamp + 6000),
            makeStatisticsMutation(bmpSession, firstPostOutSessionReport, oldTimestamp + 7000),
            makeStatisticsMutation(bmpSession, latestPostOutSessionReport, oldTimestamp + 8000),
            makeStatisticsMutation(bmpSession, otherSessionReport, oldTimestamp + 9000),
            makeStatisticsMutation(bmpSession, instanceReport, oldTimestamp + 10000)
        ])
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bmp_statistics_samples').get().count, 10);
    assert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM bmp_statistics_latest WHERE report_kind = 'session'").get()
            .count,
        5,
        'the latest projection must contain one row per peer and exact RIB stage'
    );
    const sessionReports = store.queryStatisticsReports({ sourceId: connectionOpen.source.id, kind: 'session' });
    assert.equal(sessionReports.length, 5);
    const peerReportsByRibType = new Map(
        sessionReports
            .filter(report => report.session.sessionIp === '198.51.100.1')
            .map(report => [getSessionStatisticsReportRibType(report), report])
    );
    assert.equal(peerReportsByRibType.size, 4);
    assert.equal(peerReportsByRibType.get(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN).statistics[0].value, 20);
    assert.equal(peerReportsByRibType.get(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN).statistics[0].value, 31);
    assert.equal(peerReportsByRibType.get(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT).statistics[0].value, 50);
    assert.equal(peerReportsByRibType.get(BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT).statistics[0].value, 70);
    assert.equal(sessionReports.find(report => report.session.sessionIp === '198.51.100.2').statistics[0].value, 30);
    assert.deepEqual(store.queryStatisticsReports({ sourceId: connectionOpen.source.id, kind: 'instance' }), [
        instanceReport
    ]);
    assert.deepEqual(store.queryStatisticsReports({ sourceId: 'missing-source', kind: 'session' }), []);
    assert.throws(
        () => store.queryStatisticsReports({ sourceId: connectionOpen.source.id, kind: 'invalid' }),
        /kind must be session or instance/
    );

    const corruptSample = store.db
        .prepare(
            `INSERT INTO bmp_statistics_samples(
                source_id, connection_id, scope_id, report_kind, report_key,
                observed_at_ms, source_timestamp_ms, statistics_json
             ) VALUES (@sourceId, @connectionId, NULL, 'session', 'corrupt', @observedAtMs, NULL, '{')`
        )
        .run({
            sourceId: connectionOpen.source.id,
            connectionId: connectionOpen.connection.id,
            observedAtMs: oldTimestamp + 11000
        });
    store.db
        .prepare(
            `INSERT INTO bmp_statistics_latest(source_id, report_kind, report_key, sample_id, observed_at_ms)
             VALUES (@sourceId, 'session', 'corrupt', @sampleId, @observedAtMs)`
        )
        .run({
            sourceId: connectionOpen.source.id,
            sampleId: Number(corruptSample.lastInsertRowid),
            observedAtMs: oldTimestamp + 11000
        });
    assert.equal(
        store.queryStatisticsReports({ sourceId: connectionOpen.source.id, kind: 'session' }).length,
        5,
        'malformed historical JSON must be ignored without failing the whole query'
    );
    const expectedEventCountBeforeReopen = store.getStatus({ includeCounts: true }).routeEvents;

    store.close();
    store = null;
    const reopened = new BmpPersistenceStore({ dbPath, readOnly: true }).open();
    assert.equal(reopened.queryRoutes({ routeState: 'all' }).total, 0);
    assert.equal(reopened.queryEvents({ pageSize: 100 }).total, expectedEventCountBeforeReopen);
    assert.equal(
        reopened
            .queryStatisticsReports({ sourceId: connectionOpen.source.id, kind: 'session' })
            .find(
                report =>
                    report.session.sessionIp === '198.51.100.1' &&
                    getSessionStatisticsReportRibType(report) === BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
            ).statistics[0].value,
        20,
        'latest statistics reports must remain queryable after closing and reopening the database'
    );
    assert.deepEqual(reopened.queryStatisticsReports({ sourceId: connectionOpen.source.id, kind: 'instance' }), [
        instanceReport
    ]);
    reopened.close();

    const recoveryDbPath = path.join(tempDir, 'recovery.sqlite3');
    const recoveryContext = makeContext();
    const recoveryRoute = makeRoute(recoveryContext.owner, '198.18.0.0', 0, '192.0.2.9');
    let recoveryStore = new BmpPersistenceStore({ dbPath: recoveryDbPath }).open();
    recoveryStore.applyBatch(
        batch('recovery-open', [
            buildConnectionMutation(recoveryContext.bmpSession, 'connection_open'),
            buildRouteUpsertMutation(recoveryContext.bmpSession, recoveryContext.owner, recoveryRoute, 1, 1, 2, {
                kind: 'peer',
                state: 'syncing',
                scopeState: 'syncing',
                isNewRoute: true
            })
        ])
    );
    assert.equal(recoveryStore.queryRoutes({ routeState: 'active' }).total, 1);
    recoveryStore.close();
    recoveryStore = new BmpPersistenceStore({ dbPath: recoveryDbPath }).open();
    assert.equal(recoveryStore.queryRoutes({ routeState: 'active' }).total, 0);
    assert.equal(recoveryStore.queryRoutes({ routeState: 'stale' }).list[0].scopeState, 'down');
    recoveryStore.close();

    // Replaying an already committed source sequence under a new batch ID must be a complete no-op.
    // In particular, an old scope_stale event must not roll a recovered ready scope backwards.
    const replayDbPath = path.join(tempDir, 'replay.sqlite3');
    const replayContext = makeContext();
    const replayRoute = makeRoute(replayContext.owner, '198.19.0.0', 0, '192.0.2.10');
    const replayStore = new BmpPersistenceStore({ dbPath: replayDbPath }).open();
    replayStore.applyBatch(
        batch('replay-initial', [
            buildRouteUpsertMutation(replayContext.bmpSession, replayContext.owner, replayRoute, 1, 1, 2, {
                kind: 'peer',
                state: 'syncing',
                scopeState: 'syncing',
                isNewRoute: true
            }),
            buildScopeMutation(replayContext.bmpSession, replayContext.owner, 1, 1, 2, 'scope_eor', {
                kind: 'peer',
                state: 'ready'
            })
        ])
    );
    replayContext.owner.advanceRibEpoch(1, 1, 2);
    const staleMutation = buildScopeMutation(replayContext.bmpSession, replayContext.owner, 1, 1, 2, 'scope_stale', {
        kind: 'peer',
        state: 'stale',
        reason: 'peer-refresh'
    });
    replayStore.applyBatch(batch('replay-stale', [staleMutation]));
    replayRoute.markActive(replayContext.owner.getRibEpoch(1, 1, 2));
    replayStore.applyBatch(
        batch('replay-recovered', [
            buildRouteUpsertMutation(replayContext.bmpSession, replayContext.owner, replayRoute, 1, 1, 2, {
                kind: 'peer',
                state: 'syncing',
                scopeState: 'syncing',
                isNewRoute: undefined
            }),
            buildScopeMutation(replayContext.bmpSession, replayContext.owner, 1, 1, 2, 'scope_eor', {
                kind: 'peer',
                state: 'ready'
            })
        ])
    );
    let recoveredRoute = replayStore.queryRoutes({ routeState: 'all' }).list[0];
    assert.equal(recoveredRoute.routeState, 'active');
    assert.equal(recoveredRoute.scopeState, 'ready');
    assert.deepEqual(replayStore.applyBatch(batch('replay-stale-again', [staleMutation])), {
        duplicate: false,
        applied: 0
    });
    recoveredRoute = replayStore.queryRoutes({ routeState: 'all' }).list[0];
    assert.equal(recoveredRoute.routeState, 'active');
    assert.equal(recoveredRoute.scopeState, 'ready');
    replayStore.close();

    const refreshTimeoutDbPath = path.join(tempDir, 'refresh-timeout.sqlite3');
    const refreshContext = makeContext();
    const refreshKeptRoute = makeRoute(refreshContext.owner, '198.22.0.0', 1, '192.0.2.31');
    const refreshMissingRoute = makeRoute(refreshContext.owner, '198.22.1.0', 2, '192.0.2.31');
    const refreshMissingRoute2 = makeRoute(refreshContext.owner, '198.22.2.0', 3, '192.0.2.31');
    const refreshStore = new BmpPersistenceStore({ dbPath: refreshTimeoutDbPath }).open();
    const refreshStartedAtMs = Date.now() - 20 * 60 * 1000;
    refreshStore.applyBatch(
        batch('refresh-initial', [
            buildRouteUpsertMutation(refreshContext.bmpSession, refreshContext.owner, refreshKeptRoute, 1, 1, 2, {
                kind: 'peer',
                scopeState: 'syncing',
                isNewRoute: true,
                eventAtMs: oldTimestamp
            }),
            buildRouteUpsertMutation(refreshContext.bmpSession, refreshContext.owner, refreshMissingRoute, 1, 1, 2, {
                kind: 'peer',
                scopeState: 'syncing',
                isNewRoute: true,
                eventAtMs: oldTimestamp
            }),
            buildRouteUpsertMutation(refreshContext.bmpSession, refreshContext.owner, refreshMissingRoute2, 1, 1, 2, {
                kind: 'peer',
                scopeState: 'syncing',
                isNewRoute: true,
                eventAtMs: oldTimestamp
            })
        ])
    );
    refreshContext.owner.advanceRibEpoch(1, 1, 2);
    refreshKeptRoute.markActive(refreshContext.owner.getRibEpoch(1, 1, 2));
    refreshStore.applyBatch(
        batch('refresh-without-eor', [
            buildScopeMutation(refreshContext.bmpSession, refreshContext.owner, 1, 1, 2, 'scope_open', {
                kind: 'peer',
                state: 'syncing',
                eventAtMs: refreshStartedAtMs
            }),
            buildRouteUpsertMutation(refreshContext.bmpSession, refreshContext.owner, refreshKeptRoute, 1, 1, 2, {
                kind: 'peer',
                scopeState: 'syncing',
                isNewRoute: undefined
            })
        ])
    );
    assert.equal(
        refreshStore.sweep({
            staleBeforeMs: 0,
            refreshTimeoutBeforeMs: refreshStartedAtMs - 1,
            eventsBeforeMs: 0
        }).routes,
        0
    );
    const firstRefreshTimeoutSweep = refreshStore.sweep({
        staleBeforeMs: 0,
        refreshTimeoutBeforeMs: Date.now() - 10 * 60 * 1000,
        eventsBeforeMs: 0,
        routeLimit: 1
    });
    assert.equal(firstRefreshTimeoutSweep.routes, 1);
    assert.equal(firstRefreshTimeoutSweep.refreshTimeoutScopes, 0);
    assert.equal(refreshStore.db.prepare('SELECT scope_state FROM bmp_rib_scopes').get().scope_state, 'syncing');
    const secondRefreshTimeoutSweep = refreshStore.sweep({
        staleBeforeMs: 0,
        refreshTimeoutBeforeMs: Date.now() - 10 * 60 * 1000,
        eventsBeforeMs: 0,
        routeLimit: 1
    });
    assert.equal(secondRefreshTimeoutSweep.routes, 1);
    assert.equal(secondRefreshTimeoutSweep.refreshTimeoutScopes, 1);
    assert.deepEqual(refreshStore.db.prepare('SELECT scope_state, stale_reason FROM bmp_rib_scopes').get(), {
        scope_state: 'ready',
        stale_reason: 'refresh-timeout'
    });
    const routesAfterRefreshTimeout = refreshStore.queryRoutes({ routeState: 'all' });
    assert.equal(routesAfterRefreshTimeout.total, 1);
    assert.equal(routesAfterRefreshTimeout.list[0].ip, '198.22.0.0');
    refreshStore.close();

    // A route can be both from an old epoch and inside a stale/down scope. Sweep
    // must count each physical row once so duplicate predicates cannot consume
    // the bounded batch limit.
    const overlappingSweepContext = makeContext();
    const overlappingSweepStore = new BmpPersistenceStore({
        dbPath: path.join(tempDir, 'overlapping-sweep.sqlite3')
    }).open();
    const overlappingRoutes = [
        makeRoute(overlappingSweepContext.owner, '198.24.0.0', 1, '192.0.2.50'),
        makeRoute(overlappingSweepContext.owner, '198.24.1.0', 2, '192.0.2.50'),
        makeRoute(overlappingSweepContext.owner, '198.24.2.0', 3, '192.0.2.50')
    ];
    overlappingSweepStore.applyBatch(
        batch(
            'overlapping-sweep-routes',
            overlappingRoutes.map(route =>
                buildRouteUpsertMutation(
                    overlappingSweepContext.bmpSession,
                    overlappingSweepContext.owner,
                    route,
                    1,
                    1,
                    2,
                    { kind: 'peer', scopeState: 'syncing', isNewRoute: true, eventAtMs: oldTimestamp }
                )
            )
        )
    );
    overlappingSweepContext.owner.advanceRibEpoch(1, 1, 2);
    overlappingSweepStore.applyBatch(
        batch('overlapping-sweep-stale', [
            buildScopeMutation(
                overlappingSweepContext.bmpSession,
                overlappingSweepContext.owner,
                1,
                1,
                2,
                'scope_stale',
                { kind: 'peer', state: 'stale', eventAtMs: oldTimestamp }
            )
        ])
    );
    const overlappingFirstSweep = overlappingSweepStore.sweep({
        staleBeforeMs: Date.now(),
        refreshTimeoutBeforeMs: 0,
        eventsBeforeMs: 0,
        routeLimit: 2
    });
    assert.equal(overlappingFirstSweep.routes, 2);
    assert.equal(overlappingSweepStore.queryRoutes({ routeState: 'all' }).total, 1);
    const overlappingSecondSweep = overlappingSweepStore.sweep({
        staleBeforeMs: Date.now(),
        refreshTimeoutBeforeMs: 0,
        eventsBeforeMs: 0,
        routeLimit: 2
    });
    assert.equal(overlappingSecondSweep.routes, 1);
    assert.equal(overlappingSweepStore.queryRoutes({ routeState: 'all' }).total, 0);
    overlappingSweepStore.close();

    // Projection changes are epoch-owned. Old EOR/open/announce/withdraw mutations may remain
    // queryable as history, but must not roll a newer refresh backwards or touch its routes.
    const delayedDbPath = path.join(tempDir, 'delayed-epoch.sqlite3');
    const delayedContext = makeContext();
    const delayedKeptRoute = makeRoute(delayedContext.owner, '198.23.0.0', 1, '192.0.2.40');
    const delayedMissingRouteA = makeRoute(delayedContext.owner, '198.23.1.0', 2, '192.0.2.40');
    const delayedMissingRouteB = makeRoute(delayedContext.owner, '198.23.2.0', 3, '192.0.2.40');
    const delayedStore = new BmpPersistenceStore({ dbPath: delayedDbPath }).open();
    delayedStore.applyBatch(
        batch('delayed-initial', [
            buildRouteUpsertMutation(delayedContext.bmpSession, delayedContext.owner, delayedKeptRoute, 1, 1, 2, {
                kind: 'peer',
                scopeState: 'syncing',
                isNewRoute: true
            }),
            buildRouteUpsertMutation(delayedContext.bmpSession, delayedContext.owner, delayedMissingRouteA, 1, 1, 2, {
                kind: 'peer',
                scopeState: 'syncing',
                isNewRoute: true
            }),
            buildRouteUpsertMutation(delayedContext.bmpSession, delayedContext.owner, delayedMissingRouteB, 1, 1, 2, {
                kind: 'peer',
                scopeState: 'syncing',
                isNewRoute: true
            })
        ])
    );
    const delayedOldEor = buildScopeMutation(delayedContext.bmpSession, delayedContext.owner, 1, 1, 2, 'scope_eor', {
        kind: 'peer',
        state: 'ready'
    });
    const delayedOldOpen = buildScopeMutation(delayedContext.bmpSession, delayedContext.owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'syncing'
    });
    const veryLateOldOpen = buildScopeMutation(delayedContext.bmpSession, delayedContext.owner, 1, 1, 2, 'scope_open', {
        kind: 'peer',
        state: 'syncing'
    });
    const delayedOldAnnounce = buildRouteUpsertMutation(
        delayedContext.bmpSession,
        delayedContext.owner,
        delayedKeptRoute,
        1,
        1,
        2,
        { kind: 'peer', scopeState: 'syncing', isNewRoute: false, previousAttrHash: null }
    );
    const delayedOldWithdraw = buildRouteWithdrawMutation(
        delayedContext.bmpSession,
        delayedContext.owner,
        delayedKeptRoute,
        delayedKeptRoute,
        1,
        1,
        2,
        { kind: 'peer' }
    );

    delayedContext.owner.advanceRibEpoch(1, 1, 2);
    delayedKeptRoute.assignRouteAttr({ ...delayedKeptRoute.getRouteAttr(), nextHop: '192.0.2.41' });
    delayedKeptRoute.markActive(delayedContext.owner.getRibEpoch(1, 1, 2));
    delayedStore.applyBatch(
        batch('delayed-current-refresh', [
            buildScopeMutation(delayedContext.bmpSession, delayedContext.owner, 1, 1, 2, 'scope_open', {
                kind: 'peer',
                state: 'syncing'
            }),
            buildRouteUpsertMutation(delayedContext.bmpSession, delayedContext.owner, delayedKeptRoute, 1, 1, 2, {
                kind: 'peer',
                scopeState: 'syncing',
                isNewRoute: false,
                previousAttrHash: null
            })
        ])
    );
    delayedStore.applyBatch(
        batch('delayed-old-epoch', [delayedOldEor, delayedOldOpen, delayedOldAnnounce, delayedOldWithdraw])
    );
    let delayedRoutes = delayedStore.queryRoutes({ routeState: 'all' });
    assert.equal(delayedRoutes.total, 3);
    assert.equal(delayedRoutes.list.find(route => route.ip === '198.23.0.0').nextHop, '192.0.2.41');
    assert.equal(delayedRoutes.list.find(route => route.ip === '198.23.0.0').routeState, 'active');
    assert.equal(delayedRoutes.list.filter(route => route.routeState === 'stale').length, 2);
    let delayedScope = delayedStore.db
        .prepare(
            `SELECT current_epoch, eor_epoch, scope_state, cleanup_pending_epoch
               FROM bmp_rib_scopes`
        )
        .get();
    assert.deepEqual(delayedScope, {
        current_epoch: 1,
        eor_epoch: null,
        scope_state: 'syncing',
        cleanup_pending_epoch: null
    });

    delayedStore.applyBatch(
        batch('delayed-timeout', [
            buildScopeMutation(delayedContext.bmpSession, delayedContext.owner, 1, 1, 2, 'scope_timeout', {
                kind: 'peer',
                state: 'ready',
                reason: 'refresh-timeout'
            })
        ])
    );
    delayedScope = delayedStore.db
        .prepare('SELECT scope_state, stale_reason, cleanup_pending_epoch FROM bmp_rib_scopes')
        .get();
    assert.deepEqual(delayedScope, {
        scope_state: 'ready',
        stale_reason: 'refresh-timeout',
        cleanup_pending_epoch: 1
    });
    const firstPendingCleanup = delayedStore.sweep({
        staleBeforeMs: 0,
        refreshTimeoutBeforeMs: 0,
        eventsBeforeMs: 0,
        routeLimit: 1
    });
    assert.equal(firstPendingCleanup.routes, 1);
    assert.equal(firstPendingCleanup.finalizedCleanupScopes, 0);
    assert.equal(
        delayedStore.db.prepare('SELECT cleanup_pending_epoch FROM bmp_rib_scopes').get().cleanup_pending_epoch,
        1
    );
    const secondPendingCleanup = delayedStore.sweep({
        staleBeforeMs: 0,
        refreshTimeoutBeforeMs: 0,
        eventsBeforeMs: 0,
        routeLimit: 1
    });
    assert.equal(secondPendingCleanup.routes, 1);
    assert.equal(secondPendingCleanup.finalizedCleanupScopes, 1);
    delayedRoutes = delayedStore.queryRoutes({ routeState: 'all' });
    assert.equal(delayedRoutes.total, 1);
    assert.equal(delayedRoutes.list[0].nextHop, '192.0.2.41');

    const timeoutBeforeEor = buildScopeMutation(
        delayedContext.bmpSession,
        delayedContext.owner,
        1,
        1,
        2,
        'scope_timeout',
        { kind: 'peer', state: 'ready', reason: 'refresh-timeout' }
    );
    delayedStore.applyBatch(
        batch('delayed-current-eor', [
            buildScopeMutation(delayedContext.bmpSession, delayedContext.owner, 1, 1, 2, 'scope_eor', {
                kind: 'peer',
                state: 'ready'
            })
        ])
    );
    delayedStore.applyBatch(batch('delayed-timeout-after-eor', [timeoutBeforeEor, veryLateOldOpen]));
    delayedScope = delayedStore.db
        .prepare(
            'SELECT current_epoch, eor_epoch, scope_state, stale_reason, cleanup_pending_epoch FROM bmp_rib_scopes'
        )
        .get();
    assert.deepEqual(delayedScope, {
        current_epoch: 1,
        eor_epoch: 1,
        scope_state: 'ready',
        stale_reason: null,
        cleanup_pending_epoch: 1
    });
    delayedStore.sweep({ staleBeforeMs: 0, refreshTimeoutBeforeMs: 0, eventsBeforeMs: 0 });
    assert.equal(
        delayedStore.db.prepare('SELECT cleanup_pending_epoch FROM bmp_rib_scopes').get().cleanup_pending_epoch,
        null
    );
    delayedStore.applyBatch(
        batch('delayed-duplicate-eor', [
            buildScopeMutation(delayedContext.bmpSession, delayedContext.owner, 1, 1, 2, 'scope_eor', {
                kind: 'peer',
                state: 'ready'
            })
        ])
    );
    assert.equal(
        delayedStore.db.prepare('SELECT cleanup_pending_epoch FROM bmp_rib_scopes').get().cleanup_pending_epoch,
        null,
        'a duplicate EOR must not requeue an already completed full-scope cleanup'
    );
    delayedStore.close();

    // Connection ownership is ordered by a monotonic generation, not a millisecond timestamp.
    // A delayed event from connection A must never reclaim a scope after connection B took it over.
    const takeoverDbPath = path.join(tempDir, 'equal-timestamp-takeover.sqlite3');
    const takeoverA = makeContext();
    const takeoverB = makeContext();
    const equalOpenedAtMs = Date.now();
    takeoverA.bmpSession.persistenceOpenedAtMs = equalOpenedAtMs;
    takeoverB.bmpSession.persistenceOpenedAtMs = equalOpenedAtMs;
    const takeoverRouteA = makeRoute(takeoverA.owner, '198.21.0.0', 3, '192.0.2.21');
    const takeoverRouteB = makeRoute(takeoverB.owner, '198.21.0.0', 3, '192.0.2.22');
    const takeoverAnnounceA = buildRouteUpsertMutation(takeoverA.bmpSession, takeoverA.owner, takeoverRouteA, 1, 1, 2, {
        kind: 'peer',
        state: 'syncing',
        scopeState: 'syncing',
        isNewRoute: true
    });
    const takeoverAnnounceB = buildRouteUpsertMutation(takeoverB.bmpSession, takeoverB.owner, takeoverRouteB, 1, 1, 2, {
        kind: 'peer',
        state: 'syncing',
        scopeState: 'syncing',
        isNewRoute: true
    });
    assert.ok(takeoverAnnounceB.connection.generation > takeoverAnnounceA.connection.generation);
    const takeoverStore = new BmpPersistenceStore({ dbPath: takeoverDbPath }).open();
    takeoverStore.applyBatch(batch('takeover-a', [takeoverAnnounceA]));
    takeoverStore.applyBatch(batch('takeover-b', [takeoverAnnounceB]));
    const lateTakeoverA = buildRouteWithdrawMutation(
        takeoverA.bmpSession,
        takeoverA.owner,
        takeoverRouteA,
        takeoverRouteA,
        1,
        1,
        2,
        { kind: 'peer' }
    );
    takeoverStore.applyBatch(batch('takeover-late-a', [lateTakeoverA]));
    assert.equal(takeoverStore.queryRoutes({ routeState: 'all' }).total, 1);
    assert.equal(
        takeoverStore.db
            .prepare('SELECT last_connection_id FROM bmp_rib_scopes WHERE scope_id = ?')
            .get(takeoverAnnounceB.scope.id).last_connection_id,
        takeoverAnnounceB.connection.id
    );

    takeoverStore.applyBatch(
        batch('takeover-b-close', [
            buildConnectionMutation(takeoverB.bmpSession, 'connection_close', { reason: 'test-close' })
        ])
    );
    takeoverRouteA.assignRouteAttr({ ...takeoverRouteA.getRouteAttr(), nextHop: '192.0.2.23' });
    const failbackAnnounceA = buildRouteUpsertMutation(takeoverA.bmpSession, takeoverA.owner, takeoverRouteA, 1, 1, 2, {
        kind: 'peer',
        state: 'syncing',
        scopeState: 'syncing',
        isNewRoute: false,
        previousAttrHash: null
    });
    takeoverStore.applyBatch(batch('takeover-failback-a', [failbackAnnounceA]));
    assert.equal(
        takeoverStore.db
            .prepare('SELECT last_connection_id FROM bmp_rib_scopes WHERE scope_id = ?')
            .get(takeoverAnnounceA.scope.id).last_connection_id,
        takeoverAnnounceA.connection.id
    );
    assert.equal(takeoverStore.queryRoutes({ routeState: 'active' }).total, 1);
    takeoverStore.close();

    const purgeDbPath = path.join(tempDir, 'purge.sqlite3');
    const purgeContext = makeContext();
    const purgeRoute = makeRoute(purgeContext.owner, '198.20.0.0', 7, '192.0.2.11');
    const purgeStore = new BmpPersistenceStore({ dbPath: purgeDbPath }).open();
    purgeStore.applyBatch(
        batch('purge-announce', [
            buildRouteUpsertMutation(purgeContext.bmpSession, purgeContext.owner, purgeRoute, 1, 1, 2, {
                kind: 'peer',
                state: 'stale',
                scopeState: 'stale',
                isNewRoute: true
            })
        ])
    );
    assert.equal(purgeStore.queryRoutes({ routeState: 'all' }).total, 1);
    purgeStore.applyBatch(
        batch('purge-remove', [
            buildRoutePurgeMutation(purgeContext.bmpSession, purgeContext.owner, purgeRoute, 1, 1, 2, {
                kind: 'peer'
            })
        ])
    );
    assert.equal(purgeStore.queryRoutes({ routeState: 'all' }).total, 0);
    const purgeEvent = purgeStore.queryEvents({ eventType: 'purge' }).list[0];
    assert.equal(purgeEvent.eventType, 'purge');
    assert.equal(purgeEvent.reason, 'manual-stale-purge');
    purgeStore.close();

    const directPurgeDbPath = path.join(tempDir, 'direct-purge.sqlite3');
    const directPurgeContext = makeContext();
    const directPurgeRoute = makeRoute(directPurgeContext.owner, '198.21.0.0', 8, '192.0.2.12');
    const directPurgeStore = new BmpPersistenceStore({ dbPath: directPurgeDbPath }).open();
    const genericUpsert = buildRouteUpsertMutation(
        directPurgeContext.bmpSession,
        directPurgeContext.owner,
        directPurgeRoute,
        1,
        1,
        2,
        { kind: 'peer', state: 'stale', scopeState: 'stale' }
    );
    assert.equal(genericUpsert.eventType, 'upsert');
    const genericUpsertResult = directPurgeStore.applyBatch(batch('direct-purge-announce', [genericUpsert]));
    assert.equal(genericUpsertResult.deltas[0].classification, 'announce');
    assert.equal(directPurgeStore.queryEvents({ eventType: 'announce' }).total, 1);
    assert.deepEqual(directPurgeStore.queryScopeSummary({ ownerKey: genericUpsert.scope.ownerKey }), {
        active: 0,
        stale: 1,
        total: 1,
        scopes: [
            {
                scopeId: genericUpsert.scope.id,
                sourceId: genericUpsert.source.id,
                connectionId: genericUpsert.connection.id,
                ownerKey: genericUpsert.scope.ownerKey,
                scopeKind: 'peer',
                afi: 1,
                safi: 1,
                ribType: '2',
                scopeState: 'stale',
                currentEpoch: 0,
                eorEpoch: null,
                staleReason: null,
                active: 0,
                stale: 1,
                total: 1
            }
        ]
    });
    const directPurge = directPurgeStore.purgeStaleRoutes({
        scopeId: genericUpsert.scope.id,
        reason: 'ci-direct-purge'
    });
    assert.equal(directPurge.purged, 1);
    assert.equal(directPurge.hasMore, false);
    assert.equal(directPurge.routes[0].ip, '198.21.0.0');
    assert.equal(directPurge.deltas[0].classification, 'purge');
    assert.equal(directPurge.deltas[0].reason, 'ci-direct-purge');
    assert.ok(directPurge.deltas[0].eventId > 0);
    assert.equal(directPurgeStore.queryRoutes({ routeState: 'all' }).total, 0);
    const directPurgeEvents = directPurgeStore.queryEvents({ eventType: 'purge' });
    assert.equal(directPurgeEvents.total, 1);
    assert.equal(directPurgeEvents.list[0].reason, 'ci-direct-purge');
    directPurgeStore.close();

    const epochCutoffDbPath = path.join(tempDir, 'notification-purge-epoch-cutoff.sqlite3');
    const epochCutoffContext = makeContext();
    const epochCutoffStore = new BmpPersistenceStore({ dbPath: epochCutoffDbPath }).open();
    const preNotificationRoute = makeRoute(epochCutoffContext.owner, '198.22.0.0', 1, '192.0.2.13');
    const preNotificationUpsert = buildRouteUpsertMutation(
        epochCutoffContext.bmpSession,
        epochCutoffContext.owner,
        preNotificationRoute,
        1,
        1,
        2,
        { kind: 'peer', state: 'ready', scopeState: 'ready' }
    );
    epochCutoffStore.applyBatch(batch('notification-cutoff-old', [preNotificationUpsert]));
    const notificationEpoch = epochCutoffContext.owner.advanceRibEpoch(1, 1, 2);
    const postNotificationRoute = makeRoute(epochCutoffContext.owner, '198.23.0.0', 2, '192.0.2.14');
    const postNotificationUpsert = buildRouteUpsertMutation(
        epochCutoffContext.bmpSession,
        epochCutoffContext.owner,
        postNotificationRoute,
        1,
        1,
        2,
        { kind: 'peer', state: 'stale', scopeState: 'stale' }
    );
    epochCutoffStore.applyBatch(batch('notification-cutoff-new', [postNotificationUpsert]));
    assert.equal(epochCutoffStore.queryRoutes({ routeState: 'stale' }).total, 2);
    const cutoffPurge = epochCutoffStore.purgeStaleRoutes({
        scopeId: preNotificationUpsert.scope.id,
        ribEpochBefore: notificationEpoch,
        reason: 'peer-down-notification:1'
    });
    assert.equal(cutoffPurge.purged, 1);
    assert.equal(cutoffPurge.routes[0].ip, '198.22.0.0');
    const routesAfterCutoffPurge = epochCutoffStore.queryRoutes({ routeState: 'all' });
    assert.equal(routesAfterCutoffPurge.total, 1);
    assert.equal(routesAfterCutoffPurge.list[0].ip, '198.23.0.0');
    assert.equal(routesAfterCutoffPurge.list[0].ribEpoch, notificationEpoch);
    epochCutoffStore.close();

    const legacyDbPath = path.join(tempDir, 'legacy-v8.sqlite3');
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
        CREATE TABLE bmp_current_routes (
            scope_id TEXT NOT NULL,
            route_id TEXT NOT NULL,
            route_json TEXT NOT NULL,
            PRIMARY KEY (scope_id, route_id)
        ) WITHOUT ROWID;
        INSERT INTO bmp_current_routes(scope_id, route_id, route_json)
        VALUES ('legacy-scope', 'legacy-route', '{"ip":"198.24.0.0"}');
        PRAGMA user_version = 8;
    `);
    legacyDb.close();

    for (const readOnly of [true, false]) {
        assert.throws(
            () => new BmpPersistenceStore({ dbPath: legacyDbPath, readOnly }).open(),
            error => error.code === 'BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE',
            `schema v8 must be rejected in ${readOnly ? 'read-only' : 'writable'} mode`
        );
    }
    const unchangedLegacyDb = new Database(legacyDbPath, { readonly: true });
    assert.equal(unchangedLegacyDb.pragma('user_version', { simple: true }), 8);
    assert.deepEqual(unchangedLegacyDb.prepare('SELECT * FROM bmp_current_routes').get(), {
        scope_id: 'legacy-scope',
        route_id: 'legacy-route',
        route_json: '{"ip":"198.24.0.0"}'
    });
    unchangedLegacyDb.close();

    const nonEmptyV0DbPath = path.join(tempDir, 'non-empty-v0.sqlite3');
    const nonEmptyV0Db = new Database(nonEmptyV0DbPath);
    nonEmptyV0Db.exec(`
        CREATE TABLE sentinel (value TEXT NOT NULL);
        INSERT INTO sentinel(value) VALUES ('preserve-me');
    `);
    nonEmptyV0Db.close();
    assert.throws(
        () => new BmpPersistenceStore({ dbPath: nonEmptyV0DbPath }).open(),
        error => error.code === 'BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE'
    );
    const unchangedV0Db = new Database(nonEmptyV0DbPath, { readonly: true });
    assert.equal(unchangedV0Db.pragma('user_version', { simple: true }), 0);
    assert.equal(unchangedV0Db.prepare('SELECT value FROM sentinel').get().value, 'preserve-me');
    unchangedV0Db.close();

    const futureDbPath = path.join(tempDir, 'future-v10.sqlite3');
    const futureDb = new Database(futureDbPath);
    futureDb.exec(`
        CREATE TABLE sentinel (value TEXT NOT NULL);
        INSERT INTO sentinel(value) VALUES ('future-data');
        PRAGMA user_version = 10;
    `);
    futureDb.close();
    for (const readOnly of [true, false]) {
        assert.throws(
            () => new BmpPersistenceStore({ dbPath: futureDbPath, readOnly }).open(),
            error => error.code === 'BMP_PERSISTENCE_SCHEMA_TOO_NEW'
        );
    }

    const invalidSchemaDbPath = path.join(tempDir, 'invalid-schema.sqlite3');
    const invalidSchemaStore = new BmpPersistenceStore({ dbPath: invalidSchemaDbPath }).open();
    invalidSchemaStore.db.exec('DROP TABLE bmp_statistics_latest');
    invalidSchemaStore.close();
    assert.throws(
        () => new BmpPersistenceStore({ dbPath: invalidSchemaDbPath, readOnly: true }).open(),
        /missing required table bmp_statistics_latest/
    );

    console.log('BMP SQLite persistence tests passed');
} finally {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
