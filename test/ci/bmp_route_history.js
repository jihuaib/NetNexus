const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const {
    buildRouteUpsertMutation,
    buildRoutePurgeMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-route-history-'));
const dbPath = path.join(tempDir, 'bmp.sqlite3');
const baseTime = Date.now() - 10000;

function makeSource() {
    return {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 55000,
        sysName: 'history-router',
        sysDesc: 'route history test',
        bmpVersion: 4,
        getBmpV4TlvDraft: () => 20
    };
}

function makeOwner(source, peerIp) {
    const owner = new BmpBgpSession(source);
    Object.assign(owner, {
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: peerIp,
        sessionAs: 65001,
        vrfTableNames: ['blue']
    });
    return owner;
}

function makeRoute(owner, { afi = 1, safi = 1, prefix, length, pathId = 1 }) {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi,
        safi,
        ribType: 2,
        pathId,
        rd: '0:0',
        ip: prefix,
        mask: length,
        nlriDetail: { prefix, length, pathId, rd: '0:0' }
    });
    route.assignRouteAttr({
        origin: 'IGP',
        asPath: '65001',
        med: 0,
        localPref: 100,
        nextHop: afi === 1 ? '192.0.2.1' : '2001:db8::1'
    });
    route.markActive(owner.getRibEpoch(afi, safi, 2));
    return route;
}

function announce(source, owner, route, eventAtMs) {
    return buildRouteUpsertMutation(source, owner, route, route.afi, route.safi, 2, {
        kind: 'peer',
        state: 'syncing',
        scopeState: 'syncing',
        isNewRoute: true,
        eventAtMs
    });
}

function apply(store, batchId, mutations) {
    return store.applyBatch({ batchId, createdAtMs: Date.now(), mutations });
}

let store;
try {
    const source = makeSource();
    const ownerA = makeOwner(source, '198.51.100.1');
    const ownerB = makeOwner(source, '198.51.100.2');
    const routeA = makeRoute(ownerA, { prefix: '203.0.113.0', length: 24 });
    const routeB = makeRoute(ownerB, { prefix: '203.0.113.0', length: 24 });
    const announceA = announce(source, ownerA, routeA, baseTime + 100);
    const announceB = announce(source, ownerB, routeB, baseTime + 200);

    store = new BmpPersistenceStore({ dbPath }).open();
    apply(store, 'history-a', [announceA]);
    apply(store, 'history-b', [announceB]);

    assert.throws(
        () => store.queryEvents({ groupByRoute: true }),
        /requires prefixExact, prefix, routeId, routeKey, or scopeId/,
        'an unbounded grouped history query must be rejected'
    );
    assert.throws(
        () => store.queryEvents({ groupByRoute: true, prefixExact: '   ' }),
        /requires prefixExact, prefix, routeId, routeKey, or scopeId/,
        'a whitespace-only selector must not bypass the grouped history guard'
    );
    assert.throws(
        () => store.queryEvents({ groupByRoute: true, prefixExact: '203.0.113.0/24', eventType: 'withdraw' }),
        /does not support eventType/,
        'eventType must not silently redefine latestEvent'
    );
    assert.throws(
        () => store.queryEvents({ groupByRoute: true, prefixExact: '203.0.113.0/24', page: 2 }),
        /uses cursor pagination/,
        'grouped history page numbers must not be silently ignored'
    );

    const firstPage = store.queryEvents({
        groupByRoute: true,
        prefixExact: '203.0.113.9/24',
        pageSize: 1
    });
    assert.equal(firstPage.kind, 'route-histories');
    assert.equal(firstPage.total, 2, 'total must count scope-isolated route histories, not events');
    assert.equal(firstPage.list.length, 1);
    assert.ok(firstPage.nextCursor);
    assert.ok(firstPage.asOfEventId > 0);
    assert.equal(firstPage.list[0].routeId, announceA.route.id);
    assert.equal(announceA.route.id, announceB.route.id, 'the same NLRI must share a route identity');
    assert.notEqual(announceA.scope.id, announceB.scope.id, 'peer scopes must remain separate histories');

    const ownerC = makeOwner(source, '198.51.100.3');
    const routeC = makeRoute(ownerC, { prefix: '203.0.113.0', length: 24 });
    const announceC = announce(source, ownerC, routeC, baseTime + 300);
    apply(store, 'history-c-after-page-one', [announceC]);

    const secondPage = store.queryEvents({
        groupByRoute: true,
        prefixExact: '203.0.113.0/24',
        pageSize: 1,
        includeTotal: false,
        cursor: firstPage.nextCursor
    });
    assert.equal(secondPage.asOfEventId, firstPage.asOfEventId);
    assert.equal(secondPage.list.length, 1);
    assert.equal(secondPage.nextCursor, null);
    assert.notEqual(secondPage.list[0].scopeId, firstPage.list[0].scopeId);
    assert.notEqual(
        secondPage.list[0].scopeId,
        announceC.scope.id,
        'a history inserted after page one must not drift into the as-of cursor snapshot'
    );

    const freshPage = store.queryEvents({
        groupByRoute: true,
        prefixExact: '203.0.113.0',
        prefixLength: 24,
        pageSize: 10
    });
    assert.equal(freshPage.total, 3);
    assert.equal(freshPage.list[0].scopeId, announceC.scope.id);

    const purgeA = buildRoutePurgeMutation(source, ownerA, routeA, 1, 1, 2, {
        kind: 'peer',
        eventAtMs: baseTime + 400,
        reason: 'history-test-purge'
    });
    apply(store, 'history-purge-a', [purgeA]);
    assert.equal(store.queryRoutes({ scopeId: announceA.scope.id, routeState: 'all' }).total, 0);

    const afterPurge = store.queryEvents({
        groupByRoute: true,
        prefixExact: '203.0.113.0/24',
        pageSize: 10
    });
    assert.equal(afterPurge.total, 3, 'purged routes must remain discoverable through retained events');
    const purgedHistory = afterPurge.list.find(item => item.scopeId === announceA.scope.id);
    assert.equal(purgedHistory.latestEvent.eventType, 'purge');
    assert.equal(purgedHistory.latestEvent.reason, 'history-test-purge');
    assert.equal(purgedHistory.eventCount, 2);
    const boundedTimeline = store.queryEvents({
        scopeId: announceA.scope.id,
        routeId: announceA.route.id,
        toEventId: firstPage.asOfEventId
    });
    assert.equal(boundedTimeline.total, 1, 'timeline Event upper bounds must exclude later re-announces/purges');
    assert.equal(boundedTimeline.list[0].eventType, 'announce');

    const ipv6Owner = makeOwner(source, '2001:db8::2');
    const ipv6Route = makeRoute(ipv6Owner, { afi: 2, prefix: '2001:db8::', length: 32 });
    apply(store, 'history-ipv6', [announce(source, ipv6Owner, ipv6Route, baseTime + 500)]);
    const ipv6History = store.queryEvents({
        groupByRoute: true,
        prefixExact: '2001:0DB8:0000:0000::/32'
    });
    assert.equal(ipv6History.total, 1, 'IPv6 CIDR input must be canonicalized before exact matching');
    assert.equal(ipv6History.list[0].route.ip, '2001:db8::');

    const legacyIpv6Owner = makeOwner(source, '2001:db8::3');
    const legacyIpv6Route = makeRoute(legacyIpv6Owner, {
        afi: 2,
        prefix: '2001::1:0:0:0:1',
        length: 128
    });
    const legacyIpv6Announce = announce(source, legacyIpv6Owner, legacyIpv6Route, baseTime + 600);
    assert.equal(
        legacyIpv6Announce.route.prefix,
        '2001:0:0:1::1',
        'newly persisted IPv6 identities must use one canonical text representation'
    );
    apply(store, 'history-ipv6-legacy-text', [legacyIpv6Announce]);
    store.db
        .prepare('UPDATE bmp_route_identities SET prefix = @prefix WHERE route_id = @routeId')
        .run({ prefix: '2001::1:0:0:0:1', routeId: legacyIpv6Announce.route.id });
    const legacyIpv6History = store.queryEvents({
        groupByRoute: true,
        prefixExact: '2001:0000:0000:0001:0000:0000:0000:0001/128'
    });
    assert.equal(
        legacyIpv6History.total,
        1,
        'canonical queries must still find IPv6 text produced by existing schema-v9 databases'
    );

    console.log('BMP grouped route history tests passed');
} finally {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
