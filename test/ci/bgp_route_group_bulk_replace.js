const assert = require('node:assert/strict');
const BgpConst = require('../../electron/const/bgpConst');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');

const QP = BgpConst.BGP_ADDR_FAMILY.IPV6_QP;
const LABEL = BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
const instanceKey = 'bulk-replace|2|241';
const labelInstanceKey = 'bulk-replace|1|4';
const groupId = 'bulk';
const qpTable = BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS.find(family => family.addressFamily === QP).tableName;
const labelTable = BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS.find(family => family.addressFamily === LABEL).tableName;

function entry(suffix, options = {}) {
    const { med = 10, mpNextHop = '2001:db8::1' } = options;
    return {
        route: { ip: `2001:db8::${suffix.toString(16)}`, mask: 128, dqpn: 1, mpNextHop },
        attr: { origin: 'IGP', asPath: '65000', med }
    };
}

function replace(store, routes, options = {}) {
    return store.replaceRouteGroup(groupId, {
        groupName: 'Bulk replacement',
        addressFamily: QP,
        instanceKey,
        includeOldRoutes: false,
        routes,
        ...options
    });
}

function installWriteAudit(store) {
    store.db.exec('CREATE TEMP TABLE bulk_write_audit(table_name TEXT, operation TEXT, route_key TEXT)');
    for (const [table, name] of [
        [qpTable, 'routes'],
        ['bgp_route_group_members', 'members']
    ]) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
            const record = operation === 'DELETE' ? 'OLD' : 'NEW';
            store.db.exec(`
                CREATE TEMP TRIGGER bulk_audit_${name}_${operation} AFTER ${operation} ON main.${table}
                BEGIN
                    INSERT INTO bulk_write_audit VALUES ('${name}', '${operation}', ${record}.route_key);
                END
            `);
        }
    }
}

function auditCounts(store) {
    return store.db
        .prepare('SELECT table_name, operation, COUNT(*) AS count FROM bulk_write_audit GROUP BY table_name, operation')
        .all()
        .reduce((counts, row) => ({ ...counts, [`${row.table_name}:${row.operation}`]: row.count }), {});
}

function snapshot(store) {
    return {
        routes: store.db.prepare(`SELECT * FROM ${qpTable} ORDER BY route_id`).all(),
        labelRoutes: store.db.prepare(`SELECT * FROM ${labelTable} ORDER BY route_id`).all(),
        members: store.db.prepare('SELECT * FROM bgp_route_group_members ORDER BY instance_id, route_key').all(),
        groups: store.db.prepare('SELECT * FROM bgp_route_groups ORDER BY group_id').all(),
        instances: store.db.prepare('SELECT * FROM bgp_route_instances ORDER BY instance_id').all(),
        attributes: store.db.prepare('SELECT * FROM bgp_route_attributes ORDER BY attr_id').all(),
        orphanCandidates: store.db.prepare('SELECT * FROM bgp_route_orphan_candidates ORDER BY attr_id').all()
    };
}

function assertCounters(result, expected) {
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, `${key} counter`);
}

const store = new BgpRouteSqliteStore().open();
try {
    const initial = [0x10, 2, 0x20, 3, 0x30, 4].map(suffix => entry(suffix));
    replace(store, initial);
    installWriteAudit(store);
    const initialRows = store.getRouteGroupRoutes(groupId);
    const originalRowsByKey = new Map(initialRows.map(route => [route.routeKey, route]));
    const initialRevision = store.getInstanceStats(instanceKey).revision;
    const unchanged = replace(store, initial);
    assertCounters(unchanged, { inserted: 0, updated: 0, unchanged: 6, deleted: 0, changed: 0 });
    assert.deepEqual(auditCounts(store), {}, 'unchanged generation must not rewrite routes or group membership');
    assert.deepEqual(store.getRouteGroupRoutes(groupId), initialRows);
    assert.equal(store.getInstanceStats(instanceKey).revision, initialRevision);

    const mixed = replace(store, [
        entry(0x30),
        entry(2, { med: 44 }),
        entry(4),
        entry(3, { mpNextHop: '2001:db8::77' }),
        entry(0x51),
        entry(0x40)
    ]);
    assertCounters(mixed, { inserted: 2, updated: 2, unchanged: 2, deleted: 2, changed: 6 });
    assert.deepEqual(auditCounts(store), {
        'members:DELETE': 2,
        'members:INSERT': 2,
        'routes:DELETE': 2,
        'routes:INSERT': 2,
        'routes:UPDATE': 2
    });
    const mixedRows = store.getRouteGroupRoutes(groupId);
    assert.deepEqual(
        mixedRows.map(route => route.ip),
        ['2001:db8::2', '2001:db8::3', '2001:db8::30', '2001:db8::4', '2001:db8::51', '2001:db8::40'],
        'retained route IDs preserve their order and new routes follow candidate order'
    );
    for (const route of mixedRows.slice(0, 4)) {
        const original = originalRowsByKey.get(route.routeKey);
        assert.equal(route.persistentRouteId, original.persistentRouteId, 'updates retain persistent route IDs');
        assert.equal(route.createdAtMs, original.createdAtMs, 'updates retain route creation timestamps');
    }
    assert.deepEqual(
        mixed.withdrawnRoutes.map(route => route.ip),
        ['2001:db8::10', '2001:db8::20']
    );
    assert.equal(store.getRouteCount(instanceKey), 6);
    assert.equal(store.listRouteGroups()[0].routeCount, 6);
    assert.equal(store.getStatus().attributes, 2);

    store.db.exec('DELETE FROM bulk_write_audit');
    const oldAttrIds = new Set(mixedRows.map(route => route.attrId));
    const allNewAttributes = mixedRows.map(route => ({
        route: { ip: route.ip, mask: route.mask, dqpn: route.dqpn, mpNextHop: route.mpNextHop },
        attr: { origin: 'IGP', asPath: '65000', med: 55 }
    }));
    assertCounters(replace(store, allNewAttributes), { inserted: 0, updated: 6, unchanged: 0, deleted: 0 });
    assert.deepEqual(auditCounts(store), { 'routes:UPDATE': 6 }, 'attribute changes retain membership rows');
    assert.equal(store.getStatus().attributes, 1, 'obsolete shared attributes are reclaimed after the merge');
    assert.ok(store.getRouteGroupRoutes(groupId).every(route => !oldAttrIds.has(route.attrId)));
    assert.equal(store.sweepOrphanAttributes(), 0, 'replacement leaves no unreferenced attribute records');

    store.db.exec('DELETE FROM bulk_write_audit');
    const beforeUpdateFailure = snapshot(store);
    store.db.exec(`
        CREATE TEMP TRIGGER bulk_fail_update BEFORE UPDATE ON main.${qpTable}
        WHEN NEW.prefix = '2001:db8::30'
        BEGIN SELECT RAISE(ABORT, 'injected bulk update failure'); END
    `);
    const failedCandidates = [2, 3, 0x30, 4, 0x51, 0x99].map(suffix => entry(suffix, { med: 777 }));
    assert.throws(() => replace(store, failedCandidates), /injected bulk update failure/);
    assert.deepEqual(
        snapshot(store),
        beforeUpdateFailure,
        'late SQL failure rolls back rows, statistics and attributes'
    );
    assert.deepEqual(auditCounts(store), {}, 'audit writes from the failed transaction also roll back');
    store.db.exec('DROP TRIGGER bulk_fail_update');
    store.db.exec(`
        CREATE TEMP TRIGGER bulk_ignore_update BEFORE UPDATE ON main.${qpTable}
        WHEN NEW.prefix = '2001:db8::30'
        BEGIN SELECT RAISE(IGNORE); END
    `);
    assert.throws(() => replace(store, failedCandidates), /failed|incomplete|merge/i);
    assert.deepEqual(snapshot(store), beforeUpdateFailure, 'an ignored row update cannot commit an incomplete group');
    store.db.exec('DROP TRIGGER bulk_ignore_update');
    assertCounters(replace(store, failedCandidates), { inserted: 1, updated: 5, unchanged: 0, deleted: 1 });
    assert.ok(store.getRouteGroupRoutes(groupId).every(route => route.routeAttr.med === 777));
    assert.equal(store.getStatus().attributes, 1, 'a failed staged attribute does not poison the subsequent merge');

    const beforeFamilyFailure = snapshot(store);
    store.db.exec(`
        CREATE TEMP TRIGGER bulk_fail_family_insert BEFORE INSERT ON main.${labelTable}
        WHEN NEW.prefix = '192.0.2.1'
        BEGIN SELECT RAISE(ABORT, 'injected family insertion failure'); END
    `);
    const labelRoutes = [{ route: { ip: '192.0.2.1', mask: 32, label: 16 }, attr: { nextHop: '192.0.2.2' } }];
    const labelOptions = { addressFamily: LABEL, instanceKey: labelInstanceKey };
    assert.throws(() => replace(store, labelRoutes, labelOptions), /injected family insertion failure/);
    assert.deepEqual(
        snapshot(store),
        beforeFamilyFailure,
        'family replacement failure restores the old family and owner'
    );
    store.db.exec('DROP TRIGGER bulk_fail_family_insert');
    const familyChanged = replace(store, labelRoutes, labelOptions);
    assertCounters(familyChanged, { inserted: 1, updated: 0, unchanged: 0, deleted: 6 });
    assert.equal(familyChanged.withdrawnRoutes.length, 6);
    assert.equal(store.getRouteCount(instanceKey), 0);
    assert.equal(store.getRouteCount(labelInstanceKey), 1);
    assert.equal(store.getRouteGroupRoutes(groupId)[0].label, 16);

    store.upsertRoutes(labelInstanceKey, [
        { routeKey: 'legacy-label-key', route: { ip: '192.0.2.99', mask: 32, label: 20 }, attr: { med: 1 } }
    ]);
    const beforeLegacyConflict = snapshot(store);
    assert.throws(
        () =>
            replace(
                store,
                [
                    { route: { ip: '192.0.2.100', mask: 32, label: 30 }, attr: { med: 888 } },
                    { route: { ip: '192.0.2.99', mask: 32, label: 20 }, attr: { med: 888 } }
                ],
                labelOptions
            ),
        /existing legacy route/
    );
    assert.deepEqual(snapshot(store), beforeLegacyConflict, 'canonical legacy conflicts retain the committed snapshot');

    const migratedInstanceKey = 'bulk-replace-target|1|4';
    const migratedOptions = { ...labelOptions, instanceKey: migratedInstanceKey };
    const migrated = replace(store, labelRoutes, migratedOptions);
    assertCounters(migrated, { inserted: 1, updated: 0, unchanged: 0, deleted: 1 });
    assert.equal(migrated.withdrawnRoutes[0].instanceKey, labelInstanceKey);
    assert.equal(store.getRouteCount(labelInstanceKey), 1, 'migration retains unrelated legacy routes');
    assert.equal(store.getRouteCount(migratedInstanceKey), 1);
    assert.equal(store.getRouteGroupRoutes(groupId)[0].instanceKey, migratedInstanceKey);
    const migratedId = store.getRouteGroupRoutes(groupId)[0].persistentRouteId;
    const labelAttr = { attributePolicy: 'configured', configuredAttributes: [], pathAttributes: [] };
    const toggleLabel = label =>
        replace(store, [{ route: { ip: '192.0.2.1', mask: 32, label }, attr: labelAttr }], migratedOptions);
    for (const [nextLabel, withdrawnLabel] of [
        [null, 16],
        [99, null]
    ]) {
        const toggled = toggleLabel(nextLabel);
        assertCounters(toggled, { inserted: 0, updated: 1, unchanged: 0, deleted: 0 });
        assert.equal(toggled.withdrawnRoutes.length, 1);
        assert.equal(
            toggled.withdrawnRoutes[0].forceWithdraw,
            true,
            'label presence changes withdraw the old encoding'
        );
        assert.equal(toggled.withdrawnRoutes[0].label, withdrawnLabel);
        const retained = store.getRouteGroupRoutes(groupId)[0];
        assert.equal(retained.persistentRouteId, migratedId);
        assert.equal(retained.label, nextLabel);
        assert.equal(retained.forceWithdraw, undefined, 'the force marker is absent from the stored replacement');
    }
    const empty = replace(store, [], migratedOptions);
    assertCounters(empty, { inserted: 0, updated: 0, unchanged: 0, deleted: 1 });
    assert.equal(empty.withdrawnRoutes.length, 1);
    assert.equal(store.getRouteCount(migratedInstanceKey), 0);
    assert.deepEqual(store.listRouteGroups(), [], 'an empty replacement removes the group and all its members');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bgp_route_group_members').get().count, 0);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
} finally {
    store.close();
}

const sharedStore = new BgpRouteSqliteStore().open();
try {
    const attributes = med => ({
        attributePolicy: 'configured',
        configuredAttributes: ['med', 'communities'],
        med,
        communities: [`65000:${med}`],
        pathAttributes:
            med % 2 === 0
                ? [
                      { type: 'communities', value: [`65000:${med}`] },
                      { type: 'med', value: med }
                  ]
                : [
                      { type: 'med', value: med },
                      { type: 'communities', value: [`65000:${med}`] }
                  ]
    });
    const sharedOptions = { sharedAttributes: true, batchSize: 2 };
    replace(
        sharedStore,
        Array.from({ length: 6 }, (_, index) => ({ ...entry(index + 1), attr: attributes(31) }))
    );
    const sharedRows = Array.from(sharedStore.iterateRouteGroupRoutes(groupId, sharedOptions));
    const sharedAttr = sharedRows[0].routeAttr;
    assert.ok(
        sharedRows.every(route => route.routeAttr === sharedAttr),
        'fixed attributes are reused across page boundaries'
    );
    assert.ok(Object.isFrozen(sharedAttr));
    assert.ok(Object.isFrozen(sharedAttr.communities));
    assert.ok(Object.isFrozen(sharedAttr.pathAttributes));
    assert.ok(Object.isFrozen(sharedAttr.pathAttributes[0]));
    assert.ok(Object.isFrozen(sharedAttr.pathAttributes[1].value));
    assert.equal(Reflect.set(sharedAttr, 'med', 999), false);
    assert.equal(Reflect.set(sharedAttr.pathAttributes[0], 'value', 999), false);
    assert.throws(() => sharedAttr.communities.push('65000:999'), TypeError);
    assert.equal(sharedRows[5].routeAttr.med, 31);

    const independent = sharedStore.getRouteGroupRoutes(groupId);
    assert.notEqual(independent[0].routeAttr, independent[1].routeAttr);
    assert.equal(Object.isFrozen(independent[0].routeAttr), false);
    independent[0].routeAttr.med = 999;
    independent[0].routeAttr.pathAttributes[0].value = 999;
    independent[0].routeAttr.communities.push('65000:999');
    assert.equal(independent[1].routeAttr.med, 31);
    assert.equal(independent[1].routeAttr.pathAttributes[0].value, 31);
    assert.deepEqual(independent[1].routeAttr.communities, ['65000:31']);
    assert.equal(sharedStore.getRouteGroupRoutes(groupId)[0].routeAttr.med, 31);
    assert.deepEqual(
        sharedStore.getRouteGroupRoutes(groupId)[0].routeAttr.pathAttributes,
        attributes(31).pathAttributes
    );

    const distinctAttributes = 617;
    const variedRoutes = Array.from({ length: distinctAttributes * 2 }, (_, index) => ({
        ...entry(0x1000 + index),
        attr: attributes(index % distinctAttributes)
    }));
    replace(sharedStore, variedRoutes);
    const compactRows = Array.from(
        sharedStore.iterateRouteGroupRoutes(groupId, {
            sharedAttributes: true,
            includeInlineAttributes: false,
            batchSize: distinctAttributes
        })
    );
    assert.equal(compactRows.length, variedRoutes.length);
    assert.equal(new Set(compactRows.map(route => route.attrId)).size, distinctAttributes);
    compactRows.forEach((route, index) => {
        const med = index % distinctAttributes;
        assert.equal(route.ip, variedRoutes[index].route.ip);
        assert.equal(route.med, undefined, 'compact rows expose path attributes through routeAttr');
        assert.equal(route.pathAttributes, undefined);
        assert.equal(route.routeAttr.med, med);
        assert.deepEqual(
            route.routeAttr.pathAttributes,
            attributes(med).pathAttributes,
            'descriptor order is retained'
        );
        assert.deepEqual(route.routeAttr.communities, [`65000:${med}`]);
        assert.ok(Object.isFrozen(route.routeAttr));
        if (index >= distinctAttributes) {
            assert.equal(route.routeAttr, compactRows[index - distinctAttributes].routeAttr);
        }
    });
} finally {
    sharedStore.close();
}

console.log('BGP route group bulk replacement tests passed');
