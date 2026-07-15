const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const BgpConst = require('../../electron/const/bgpConst');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');

function route(routeKey, ip, pathId = 0, nextHop = '192.0.2.1') {
    return {
        routeKey,
        route: { ip, mask: 24, pathId, rd: '0:0' },
        attr: {
            origin: 'IGP',
            asPath: '65000 65001',
            nextHop,
            localPref: 100
        }
    };
}

function routeTable(afi, safi) {
    const definition = BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS.find(
        candidate => candidate.afi === afi && candidate.safi === safi
    );
    assert.ok(definition, `missing route table for AFI ${afi} SAFI ${safi}`);
    return definition.tableName;
}

const store = new BgpRouteSqliteStore().open();
try {
    assert.equal(store.getStatus().journalMode, 'memory');
    assert.equal(
        BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS.length,
        Object.keys(BgpConst.BGP_ADDR_FAMILY).length,
        'adding an address family requires an explicit route table and schema-version review'
    );
    const schemaRouteTables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bgp_routes_%' ORDER BY name")
        .all()
        .map(row => row.name);
    assert.deepEqual(
        schemaRouteTables,
        BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS.map(definition => definition.tableName).sort(),
        'every supported address family must have a dedicated route table'
    );
    assert.equal(
        store.db
            .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'bgp_routes'")
            .get().count,
        0,
        'the old shared route table must not exist'
    );
    const schemaObjectCount = store.db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .get().count;
    assert.throws(
        () => store.upsertRoutes('0|1|1; DROP TABLE bgp_route_attributes', [route('unsafe', '192.0.2.0')]),
        /numeric AFI\|SAFI/
    );
    assert.throws(() => store.upsertRoutes('0|999|999', [route('unsupported', '192.0.2.0')]), /does not support/);
    assert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().count,
        schemaObjectCount,
        'invalid instance keys must not create schema objects'
    );

    for (const definition of BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS) {
        const instanceKey = `99|${definition.afi}|${definition.safi}`;
        const routeKey = `family-route-${definition.addressFamily}`;
        const prefix = `198.51.${definition.addressFamily}.0`;
        store.upsertRoutes(instanceKey, [route(routeKey, prefix)]);
        const page = store.queryPage(instanceKey, {
            prefixExact: prefix,
            prefixLength: 24,
            pageSize: 2
        });
        assert.equal(page.total, 1, `${definition.name} query must use its own route table`);
        assert.equal(page.list[0].routeKey, routeKey);
        assert.equal(Array.from(store.iterateAttrGroups(instanceKey)).length, 1);
        assert.equal(
            store.db
                .prepare(
                    `SELECT COUNT(*) AS count
                       FROM ${definition.tableName} route
                       JOIN bgp_route_instances instance ON instance.instance_id = route.instance_id
                      WHERE instance.instance_key = @instanceKey AND route.route_key = @routeKey`
                )
                .get({ instanceKey, routeKey }).count,
            1,
            `${definition.name} route must be stored in ${definition.tableName}`
        );
    }
    for (const definition of BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS) {
        assert.equal(store.clearInstance(`99|${definition.afi}|${definition.safi}`).deleted, 1);
    }

    assert.deepEqual(
        store.applyBatch({
            instanceKey: '0|1|1',
            upserts: [
                route('0:0|0|10.0.0.0|24', '10.0.0.0'),
                route('0:0|1|10.0.0.0|24', '10.0.0.0', 1),
                route('0:0|0|10.0.1.0|24', '10.0.1.0', 0, '192.0.2.2')
            ]
        }),
        {
            instanceKey: '0|1|1',
            inserted: 3,
            updated: 0,
            unchanged: 0,
            deleted: 0,
            changed: 3,
            total: 3,
            revision: 1
        }
    );
    assert.equal(store.getRouteCount('0|1|1'), 3);
    assert.equal(store.getStatus().attributes, 2, 'identical path attributes must be deduplicated');

    const firstPage = store.queryPage('0|1|1', { page: 1, pageSize: 2 });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.list.length, 2);
    assert.ok(firstPage.nextCursor);
    const cursorPage = store.queryPage('0|1|1', {
        pageSize: 2,
        includeTotal: false,
        cursor: firstPage.nextCursor
    });
    assert.equal(cursorPage.total, null);
    assert.equal(cursorPage.list.length, 1);
    assert.equal(
        firstPage.list.some(first => cursorPage.list.some(second => first.routeKey === second.routeKey)),
        false
    );

    const prefixPage = store.queryPrefix('0|1|1', '10.0.0.0', { prefixLength: 24, pageSize: 10 });
    assert.equal(prefixPage.total, 2);
    assert.equal(
        prefixPage.list.every(item => item.ip === '10.0.0.0'),
        true
    );
    const detail = store.getRoute('0|1|1', '0:0|0|10.0.1.0|24');
    assert.equal(detail.nextHop, '192.0.2.2');
    assert.equal(detail.routeAttr.nextHop, '192.0.2.2');
    assert.equal(store.getAttributeRefCount('0|1|1', firstPage.list[0].attrId), 2);
    assert.equal(store.getAttributeCount('0|1|1', firstPage.list[0].attrId), 2);

    const update = store.upsertRoutes('0|1|1', [route('0:0|0|10.0.1.0|24', '10.0.1.0', 0, '192.0.2.9')]);
    assert.equal(update.inserted, 0);
    assert.equal(update.updated, 1);
    assert.equal(update.total, 3);
    assert.equal(store.getRoute('0|1|1', '0:0|0|10.0.1.0|24').nextHop, '192.0.2.9');

    store.upsertRoutes('1|1|1', [route('0:0|0|10.0.0.0|24', '10.0.0.0')]);
    assert.equal(store.getRouteCount('1|1|1'), 1);
    assert.equal(store.getRouteCount('0|1|1'), 3, 'route keys must be isolated by instance');

    store.upsertRoutes('mvpn|1|5', [
        {
            routeKey: '1|65000:1||||192.0.2.1',
            route: { routeType: 1, rd: '65000:1', originatingRouterIp: '192.0.2.1' }
        },
        {
            routeKey: '3|65000:1||10.0.0.1|239.0.0.1|',
            route: { routeType: 3, rd: '65000:1', sourceIp: '10.0.0.1', groupIp: '239.0.0.1' }
        }
    ]);
    assert.equal(store.queryPage('mvpn|1|5', { routeType: 3 }).total, 1);

    const ipv4Table = routeTable(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const mvpnTable = routeTable(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_MVPN);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${ipv4Table}`).get().count, 4);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${mvpnTable}`).get().count, 2);

    const attributesBeforeCrossFamilyShare = store.getStatus().attributes;
    const sharedNextHop = '192.0.2.250';
    store.upsertRoutes('2|1|1', [route('shared-ipv4-route', '198.18.0.0', 0, sharedNextHop)]);
    store.upsertRoutes('2|2|1', [route('shared-ipv6-route', '2001:db8::', 0, sharedNextHop)]);
    const sharedIpv4Route = store.getRoute('2|1|1', 'shared-ipv4-route');
    const sharedIpv6Route = store.getRoute('2|2|1', 'shared-ipv6-route');
    assert.equal(sharedIpv4Route.attrId, sharedIpv6Route.attrId, 'attributes must remain shared across route tables');
    assert.equal(store.getStatus().attributes, attributesBeforeCrossFamilyShare + 1);
    assert.equal(store.clearInstance('2|1|1').deleted, 1);
    assert.equal(store.getAttributeRefCount('2|2|1', sharedIpv6Route.attrId), 1);
    assert.equal(
        store.getStatus().attributes,
        attributesBeforeCrossFamilyShare + 1,
        'clearing one family must retain attributes referenced by another family'
    );
    assert.equal(store.clearInstance('2|2|1').deleted, 1);
    assert.equal(store.getStatus().attributes, attributesBeforeCrossFamilyShare);

    const beforeFailedBatch = store.getInstanceStats('0|1|1');
    assert.throws(
        () =>
            store.applyBatch({
                instanceKey: '0|1|1',
                upserts: [route('atomic-route', '10.0.2.0'), { route: {} }]
            }),
        /routeKey is required/
    );
    assert.equal(store.hasRoute('0|1|1', 'atomic-route'), false);
    assert.deepEqual(store.getInstanceStats('0|1|1'), beforeFailedBatch);

    const attrGroups = Array.from(store.iterateAttrGroups('0|1|1', { batchSize: 1 }));
    assert.equal(
        attrGroups.every(group => group.routes.length <= 1),
        true
    );
    assert.equal(
        attrGroups.reduce((total, group) => total + group.routes.length, 0),
        3
    );
    assert.equal(Array.from(store.iterateRouteBatches('0|1|1', { batchSize: 2 })).length, 2);

    const facade = store.createRouteMap('facade|1|1');
    facade.set('facade-route', { ip: '198.51.100.0', mask: 24, nextHop: '192.0.2.10' });
    assert.equal(facade.size, 1);
    assert.equal(facade.has('facade-route'), true);
    assert.equal(facade.get('facade-route').ip, '198.51.100.0');
    assert.deepEqual(Array.from(facade.keys()), ['facade-route']);
    assert.equal(Array.from(facade.values()).length, 1);
    let forEachCount = 0;
    facade.forEach((value, key, map) => {
        assert.equal(value.routeKey, key);
        assert.equal(map, facade);
        forEachCount += 1;
    });
    assert.equal(forEachCount, 1);
    assert.equal(facade.delete('facade-route'), true);
    assert.equal(facade.size, 0);

    assert.equal(store.deletePrefix('0|1|1', '10.0.0.0', { prefixLength: 24 }).deleted, 2);
    assert.equal(store.getRouteCount('0|1|1'), 1);
    assert.equal(store.clearInstance('1|1|1').deleted, 1);
    assert.equal(store.getRouteCount('1|1|1'), 0);
    assert.equal(store.sweepOrphanAttributes(), 0, 'mutations should clean orphan attributes incrementally');
} finally {
    store.close();
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-route-sqlite-'));
const dbPath = path.join(tempDir, 'routes.sqlite3');
let fileStore;
let reader;
try {
    fileStore = new BgpRouteSqliteStore({ dbPath }).open();
    assert.equal(fileStore.getStatus().journalMode, 'wal');
    fileStore.upsertRoutes('file|1|1', [route('file-route', '203.0.113.0')]);
    fileStore.close();
    fileStore = null;

    reader = new BgpRouteSqliteStore({ dbPath, readOnly: true }).open();
    assert.equal(reader.getRouteCount('file|1|1'), 1);
    assert.equal(reader.getRoute('file|1|1', 'file-route').ip, '203.0.113.0');
} finally {
    fileStore?.close();
    reader?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}

const incompatibleTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-route-schema-'));
try {
    for (const version of [1, 2, BgpRouteSqliteStore.SCHEMA_VERSION + 1]) {
        const incompatiblePath = path.join(incompatibleTempDir, `schema-${version}.sqlite3`);
        const incompatibleDb = new Database(incompatiblePath);
        incompatibleDb.pragma(`user_version = ${version}`);
        incompatibleDb.close();

        assert.throws(
            () => new BgpRouteSqliteStore({ dbPath: incompatiblePath }).open(),
            new RegExp(
                `BGP route SQLite schema ${version} is incompatible with schema ${BgpRouteSqliteStore.SCHEMA_VERSION}; data migration is not supported across major versions`
            )
        );
    }

    const legacyPath = path.join(incompatibleTempDir, 'legacy-version-zero.sqlite3');
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
        CREATE TABLE legacy_bgp_routes (
            route_key TEXT PRIMARY KEY,
            route_json TEXT NOT NULL
        );
        INSERT INTO legacy_bgp_routes(route_key, route_json)
        VALUES ('legacy-route', '{}');
    `);
    assert.equal(legacyDb.pragma('user_version', { simple: true }), 0);
    legacyDb.close();

    assert.throws(
        () => new BgpRouteSqliteStore({ dbPath: legacyPath }).open(),
        /BGP route SQLite schema 0 is not empty; data migration is not supported across major versions/
    );

    const preservedLegacyDb = new Database(legacyPath, { readonly: true });
    assert.equal(preservedLegacyDb.prepare('SELECT COUNT(*) AS count FROM legacy_bgp_routes').get().count, 1);
    assert.equal(
        preservedLegacyDb
            .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'bgp_routes'")
            .get().count,
        0,
        'a rejected version-0 database must not be partially initialized'
    );
    preservedLegacyDb.close();
} finally {
    fs.rmSync(incompatibleTempDir, { recursive: true, force: true });
}

console.log('BGP route SQLite store tests passed');
