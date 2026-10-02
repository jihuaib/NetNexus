const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const BgpConst = require('../../electron/const/bgpConst');
const BgpRoute = require('../../electron/worker/bgp/bgpRoute');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');

const UNC = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
const LABEL = BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
const instanceKey = 'group-tests|1|1';

function entry(ip, options = {}) {
    const { mask = 24, rd = '65000:1', pathId = 0, nextHop = '192.0.2.1', ...extra } = options;
    return {
        routeKey: BgpRoute.makeUnicastKey(pathId, rd, ip, mask),
        route: { ip, mask, rd, pathId, ...extra },
        attr: { origin: 'IGP', asPath: '65000', nextHop }
    };
}

function replace(store, groupId, routes, options = {}) {
    return store.replaceRouteGroup(groupId, {
        groupName: `Name ${groupId}`,
        addressFamily: UNC,
        instanceKey,
        routes,
        ...options
    });
}

const store = new BgpRouteSqliteStore().open();
try {
    const initial = [entry('10.0.0.7', { rd: '065000:0001' }), entry('10.0.0.99', { pathId: 1 }), entry('10.0.1.0')];
    const first = replace(store, 'a', initial);
    assert.equal(first.inserted, 3);
    assert.equal(first.deleted, 0);
    assert.equal(store.getRouteCount(instanceKey), 3);
    assert.equal(store.getRouteGroupRoutes('a')[0].ip, '10.0.0.0');
    assert.equal(store.getRouteGroupRoutes('a')[0].rd, '65000:1');
    assert.equal(store.getRouteGroupRoutes('a')[0].routeKey, '65000:1|0|10.0.0.0|24');
    assert.equal(store.listRouteGroups()[0].routeCount, 3);
    assert.ok(store.listRouteGroups()[0].generatedAt > 0);

    assert.throws(() => replace(store, 'b', [entry('10.0.0.199', { pathId: 7 })]), /Name a.*\(a\)/);
    assert.equal(store.listRouteGroups().length, 1, 'a conflict cannot create a group');
    assert.throws(() => replace(store, 'duplicate', [entry('10.0.2.1'), entry('10.0.2.99')]), /duplicate route key/);
    assert.equal(store.getRouteCount(instanceKey), 3);
    replace(store, 'different-mask', [entry('10.0.0.0', { mask: 25 })]);
    replace(store, 'different-rd', [entry('10.0.0.0', { rd: '65000:2' })]);
    replace(store, 'different-instance', [entry('10.0.0.0')], { instanceKey: 'other|1|1' });

    store.upsertRoutes(instanceKey, [entry('10.0.3.199', { rd: '065000:0001' })]);
    assert.throws(() => replace(store, 'legacy-collision', [entry('10.0.3.0')]), /legacy route/);
    const beforeLegacyOverwrite = store.getRouteGroupRoutes('a');
    assert.throws(() => store.upsertRoutes(instanceKey, [entry('10.0.0.77', { pathId: 99 })]), /Name a/);
    assert.throws(() => store.applyBatch({ instanceKey, clear: true, upserts: [entry('10.0.0.77')] }), /Name a/);
    assert.throws(
        () => store.updateRouteAttr(instanceKey, '65000:1|0|10.0.0.0|24', { nextHop: '192.0.2.99' }),
        /Name a/
    );
    assert.deepEqual(store.getRouteGroupRoutes('a'), beforeLegacyOverwrite);

    const update = replace(
        store,
        'a',
        [entry('10.0.0.0', { nextHop: '192.0.2.2' }), entry('10.0.0.0', { pathId: 1 }), entry('10.0.2.0')],
        { includeOldRoutes: false }
    );
    assert.equal(update.inserted, 1);
    assert.equal(update.updated, 1);
    assert.equal(update.unchanged, 1);
    assert.equal(update.deleted, 1);
    assert.deepEqual(update.oldRoutes, []);
    assert.deepEqual(
        update.withdrawnRoutes.map(route => route.routeKey),
        ['65000:1|0|10.0.1.0|24']
    );
    assert.ok(update.withdrawnRoutes.every(route => !route.routeAttr));
    assert.ok(update.withdrawnRoutes.every(route => route.forceWithdraw === undefined));
    const changedEncoding = replace(store, 'a', [
        entry('10.0.0.0', { nextHop: '192.0.2.2', nlriEncoding: 'mpReach', mpNextHop: '2001:db8::1' }),
        entry('10.0.0.0', { pathId: 1 }),
        entry('10.0.2.0')
    ]);
    assert.equal(changedEncoding.updated, 1);
    assert.equal(changedEncoding.deleted, 0);
    assert.equal(changedEncoding.withdrawnRoutes.length, 1);
    assert.equal(changedEncoding.withdrawnRoutes[0].forceWithdraw, true);
    assert.ok(
        store.getRouteGroupRoutes('a').every(route => route.forceWithdraw === undefined),
        'force-withdraw is only a transient result marker'
    );

    const beforeFailure = {
        routes: store.getRouteGroupRoutes('a'),
        groups: store.listRouteGroups(),
        stats: store.getInstanceStats(instanceKey),
        status: store.getStatus()
    };
    const invalidLateCandidate = function* () {
        yield entry('10.10.0.0');
        yield entry('10.10.1.0', { mask: 99 });
    };
    assert.throws(() => replace(store, 'a', invalidLateCandidate()), /mask is invalid/);
    const failedGenerator = function* () {
        yield entry('10.10.0.0');
        throw new Error('generator failure');
    };
    assert.throws(() => replace(store, 'a', failedGenerator()), /generator failure/);
    const lateCollision = function* () {
        yield entry('10.10.0.0');
        yield entry('10.0.0.0', { rd: '65000:2' });
    };
    assert.throws(() => replace(store, 'a', lateCollision()), /Name different-rd/);
    assert.deepEqual(store.getRouteGroupRoutes('a'), beforeFailure.routes);
    assert.deepEqual(store.listRouteGroups(), beforeFailure.groups);
    assert.deepEqual(store.getInstanceStats(instanceKey), beforeFailure.stats);
    assert.equal(store.getStatus().attributes, beforeFailure.status.attributes);

    const table = BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS.find(family => family.addressFamily === UNC).tableName;
    store.db.exec(
        `CREATE TRIGGER fail_group_insert BEFORE INSERT ON ${table} WHEN NEW.prefix = '10.10.1.0' BEGIN SELECT RAISE(ABORT, 'injected insertion failure'); END`
    );
    assert.throws(() => replace(store, 'a', [entry('10.10.0.0'), entry('10.10.1.0')]), /injected insertion failure/);
    assert.deepEqual(
        store.getRouteGroupRoutes('a'),
        beforeFailure.routes,
        'late insertion failure rolls back deleted old routes'
    );
    assert.deepEqual(store.listRouteGroups(), beforeFailure.groups);
    assert.deepEqual(store.getInstanceStats(instanceKey), beforeFailure.stats);
    store.db.exec('DROP TRIGGER fail_group_insert');
    store.db.exec(
        `CREATE TRIGGER ignore_group_insert BEFORE INSERT ON ${table} WHEN NEW.prefix = '10.10.1.0' BEGIN SELECT RAISE(IGNORE); END`
    );
    assert.throws(() => replace(store, 'a', [entry('10.10.0.0'), entry('10.10.1.0')]), /insertion failed/);
    assert.deepEqual(store.getRouteGroupRoutes('a'), beforeFailure.routes);
    store.db.exec('DROP TRIGGER ignore_group_insert');

    const familyChange = replace(
        store,
        'a',
        [{ route: { ip: '198.51.100.17', mask: 24, label: 16 }, attr: { nextHop: '192.0.2.1' } }],
        { addressFamily: LABEL, instanceKey: 'group-tests|1|4', groupName: 'Label group' }
    );
    assert.equal(familyChange.deleted, 3);
    assert.equal(familyChange.inserted, 1);
    assert.equal(familyChange.withdrawnRoutes.length, 3);
    assert.equal(store.getRouteGroupRoutes('a')[0].routeKey, '198.51.100.0|24');
    assert.equal(store.listRouteGroups().find(group => group.groupId === 'a').addressFamily, LABEL);
    assert.equal(Array.from(store.iterateRouteGroupRoutes('a', { batchSize: 1 })).length, 1);
    const withdrawal = store.withdrawRouteGroup('a');
    assert.equal(withdrawal.deleted, 1);
    assert.equal(withdrawal.routes[0].instanceKey, 'group-tests|1|4');
    assert.equal(store.getRouteCount('group-tests|1|4'), 0);
    assert.equal(
        store.listRouteGroups().some(group => group.groupId === 'a'),
        false
    );
    assert.deepEqual(store.withdrawRouteGroup('missing'), { deleted: 0, routes: [] });

    replace(store, 'delete-members', [entry('172.16.0.1', { rd: '065000:0001' }), entry('172.16.1.0')]);
    assert.equal(store.deleteRoutes(instanceKey, ['65000:1|0|172.16.0.0|24']).deleted, 1);
    assert.equal(store.listRouteGroups().find(group => group.groupId === 'delete-members').routeCount, 1);
    assert.equal(store.deletePrefix(instanceKey, '172.16.1.0', { prefixLength: 24 }).deleted, 1);
    assert.equal(
        store.listRouteGroups().some(group => group.groupId === 'delete-members'),
        false
    );
    store.clearInstance(instanceKey);
    assert.deepEqual(
        store.listRouteGroups().map(group => group.groupId),
        ['different-instance']
    );
    const manyCandidates = function* (count) {
        for (let index = 0; index < count; index += 1) {
            yield entry(`198.18.${index >> 8}.${index & 255}`, { mask: 32 });
        }
    };
    replace(store, 'scale', manyCandidates(5001), { instanceKey: 'scale|1|1', includeOldRoutes: false });
    assert.equal(store.getRouteCount('scale|1|1'), 5001);
    let streamedCount = 0;
    for (const route of store.iterateRouteGroupRoutes('scale', { batchSize: 37 })) {
        assert.equal(route.instanceKey, 'scale|1|1');
        streamedCount += 1;
    }
    assert.equal(streamedCount, 5001);
    const orderedPairs = [2, 10, 11].flatMap(host => [
        entry(`192.0.2.${host}`, { mask: 32 }),
        entry(`192.0.2.${host}`, { mask: 32, pathId: 1 })
    ]);
    replace(store, 'ordered-pairs', orderedPairs, { instanceKey: 'ordered|1|1', includeOldRoutes: false });
    assert.deepEqual(
        store.getRouteGroupRoutes('ordered-pairs').map(route => route.routeKey),
        orderedPairs.map(route => route.routeKey),
        'input ordering keeps the paths of each prefix adjacent'
    );
    store.clearInstance('ordered|1|1');
    const reduced = replace(store, 'scale', manyCandidates(3001), {
        instanceKey: 'scale|1|1',
        includeOldRoutes: false
    });
    assert.equal(reduced.unchanged, 3001);
    assert.equal(reduced.deleted, 2000);
    assert.equal(reduced.withdrawnRoutes.length, 2000);
    store.clearInstance('scale|1|1');
    assert.equal(store.sweepOrphanAttributes(), 0);
} finally {
    store.close();
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-route-groups-'));
const dbPath = path.join(tempDir, 'groups.sqlite3');
let writer;
let reader;
try {
    writer = new BgpRouteSqliteStore({ dbPath }).open();
    replace(writer, 'persisted', [entry('203.0.113.0')]);
    writer.close();
    writer = null;
    reader = new BgpRouteSqliteStore({ dbPath, readOnly: true }).open();
    assert.equal(reader.listRouteGroups()[0].groupId, 'persisted');
    assert.equal(reader.getRouteGroupRoutes('persisted')[0].routeAttr.nextHop, '192.0.2.1');
    reader.close();
    reader = null;

    const legacyPath = path.join(tempDir, 'v5.sqlite3');
    const oldDb = new Database(legacyPath);
    oldDb.pragma('user_version = 5');
    oldDb.close();
    assert.throws(
        () => new BgpRouteSqliteStore({ dbPath: legacyPath }).open(),
        /schema 5 is incompatible with schema 6/
    );
} finally {
    writer?.close();
    reader?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('BGP route group SQLite store tests passed');
