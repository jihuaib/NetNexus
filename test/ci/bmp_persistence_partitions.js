const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const {
    BMP_ROUTE_FAMILIES,
    BMP_ROUTE_PARTITIONS,
    getBmpRoutePartitionById,
    resolveBmpRoutePartition,
    selectBmpRoutePartitions
} = require('../../electron/worker/bmp/bmpRoutePartitionManifest');

const expectedFamilyTokens = [
    'ipv4_unicast',
    'ipv6_unicast',
    'ipv4_multicast',
    'ipv6_multicast',
    'ipv4_labeled_unicast',
    'ipv6_labeled_unicast',
    'ipv4_mvpn',
    'ipv6_mvpn',
    'l2vpn_evpn',
    'vpnv4',
    'vpnv6',
    'ipv4_flowspec',
    'ipv6_flowspec',
    'ipv4_qp',
    'ipv6_qp',
    'bgp_ls',
    'bgp_ls_vpn',
    'other'
];
const expectedTableNames = [
    ...expectedFamilyTokens.map(token => `bmp_current_routes_peer_${token}`),
    ...expectedFamilyTokens.map(token => `bmp_current_routes_loc_rib_${token}`)
];
const requiredPartitionColumns = [
    'path_pk',
    'partition_id',
    'scope_id',
    'route_pk',
    'payload_id',
    'attr_id',
    'connection_id',
    'rib_epoch',
    'explicit_state',
    'first_seen_ms',
    'last_seen_ms',
    'source_timestamp_ms',
    'last_event_id'
];

assert.equal(BmpPersistenceStore.SCHEMA_VERSION, 9);
assert.deepEqual(
    BMP_ROUTE_FAMILIES.map(family => family.token),
    expectedFamilyTokens
);
assert.deepEqual(
    BMP_ROUTE_FAMILIES.map(family => family.familyId),
    Array.from({ length: 18 }, (_value, index) => index + 1)
);
assert.equal(BMP_ROUTE_PARTITIONS.length, 36);
assert.deepEqual(
    BMP_ROUTE_PARTITIONS.map(partition => partition.tableName),
    expectedTableNames
);
assert.deepEqual(
    BMP_ROUTE_PARTITIONS.map(partition => partition.partitionId),
    [
        ...Array.from({ length: 18 }, (_value, index) => 101 + index),
        ...Array.from({ length: 18 }, (_value, index) => 201 + index)
    ]
);
assert.equal(new Set(BMP_ROUTE_PARTITIONS.map(partition => partition.partitionId)).size, 36);
assert.equal(new Set(BMP_ROUTE_PARTITIONS.map(partition => partition.tableName)).size, 36);

assert.equal(
    resolveBmpRoutePartition({ scopeKind: 'peer', afi: 1, safi: 1 }).tableName,
    'bmp_current_routes_peer_ipv4_unicast'
);
assert.equal(
    resolveBmpRoutePartition({ scopeKind: 'loc-rib', afi: 25, safi: 70 }).tableName,
    'bmp_current_routes_loc_rib_l2vpn_evpn'
);
assert.equal(
    resolveBmpRoutePartition({ scopeKind: 'peer', afi: 65000, safi: 250 }).tableName,
    'bmp_current_routes_peer_other'
);
assert.equal(getBmpRoutePartitionById(201).tableName, 'bmp_current_routes_loc_rib_ipv4_unicast');
assert.deepEqual(
    selectBmpRoutePartitions({ afi: 1, safi: 1 }).map(partition => partition.tableName),
    ['bmp_current_routes_peer_ipv4_unicast', 'bmp_current_routes_loc_rib_ipv4_unicast']
);
assert.equal(selectBmpRoutePartitions({ scopeKind: 'peer' }).length, 18);
assert.throws(() => resolveBmpRoutePartition({ scopeKind: 'pre-policy', afi: 1, safi: 1 }), /scope kind/);
assert.throws(() => resolveBmpRoutePartition({ scopeKind: 'peer', afi: -1, safi: 1 }), /AFI/);
assert.throws(() => resolveBmpRoutePartition({ scopeKind: 'peer', afi: 1, safi: 256 }), /SAFI/);
assert.throws(() => getBmpRoutePartitionById(999), /Unknown BMP route partition ID/);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-partitions-'));
const dbPath = path.join(tempDir, 'bmp.sqlite3');
let store;
try {
    store = new BmpPersistenceStore({ dbPath }).open();
    const schemaRows = store.db
        .prepare(
            `SELECT type, name, tbl_name AS tableName, sql
               FROM sqlite_master
              WHERE name NOT LIKE 'sqlite_%'`
        )
        .all();
    const tableNames = new Set(schemaRows.filter(row => row.type === 'table').map(row => row.name));
    const view = schemaRows.find(row => row.type === 'view' && row.name === 'bmp_current_routes_all');

    assert.equal(tableNames.has('bmp_current_routes'), false, 'the legacy monolithic table must not be created');
    expectedTableNames.forEach(tableName => assert.equal(tableNames.has(tableName), true, tableName));
    assert.ok(view, 'the unified read view must exist');
    expectedTableNames.forEach(tableName => {
        assert.match(view.sql, new RegExp(`\\b${tableName}\\b`));

        const columns = store.db.pragma(`table_info(${tableName})`).map(column => column.name);
        assert.deepEqual(columns, requiredPartitionColumns, `${tableName} columns`);

        const indexNames = schemaRows
            .filter(
                row => row.type === 'index' && row.tableName === tableName && row.name.startsWith(`idx_${tableName}_`)
            )
            .map(row => row.name)
            .sort();
        assert.deepEqual(indexNames, [
            `idx_${tableName}_attr`,
            `idx_${tableName}_connection`,
            `idx_${tableName}_payload`,
            `idx_${tableName}_route`,
            `idx_${tableName}_scope_epoch`,
            `idx_${tableName}_scope_first_seen`
        ]);

        const triggerNames = schemaRows
            .filter(row => row.type === 'trigger' && row.tableName === tableName)
            .map(row => row.name)
            .sort();
        assert.deepEqual(triggerNames, [
            `trg_${tableName}_delete_refs`,
            `trg_${tableName}_insert_refs`,
            `trg_${tableName}_update_refs`,
            `trg_${tableName}_validate_insert`,
            `trg_${tableName}_validate_update`
        ]);
    });

    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bmp_current_routes_all').get().count, 0);

    const eventAtMs = 1767225600000;
    const otherMutation = {
        eventType: 'announce',
        sequence: 1,
        eventAtMs,
        sourceTimestampMs: null,
        source: {
            id: 'partition-test-source',
            keyJson: '{"key":"partition-test-source"}',
            identityJson: '{"source":"partition-test-source"}',
            remoteIp: '192.0.2.10',
            sysName: 'partition-test-router',
            sysDesc: 'partition trigger test'
        },
        connection: {
            id: 'partition-test-connection',
            generation: 1,
            localIp: '127.0.0.1',
            localPort: 11019,
            remoteIp: '192.0.2.10',
            remotePort: 50000,
            openedAtMs: eventAtMs
        },
        scope: {
            id: 'partition-test-scope-other',
            keyJson: '{"key":"partition-test-scope-other"}',
            identityJson: '{"scope":"partition-test-scope-other"}',
            kind: 'peer',
            ownerKey: 'partition-test-peer',
            peerType: 0,
            peerRd: '0:0',
            peerIp: '198.51.100.1',
            peerAs: 65001,
            vrfName: null,
            afi: 65000,
            safi: 250,
            ribType: '2',
            epoch: 0,
            state: 'syncing'
        },
        route: {
            id: 'partition-test-route-other',
            keyJson: '{"key":"partition-test-route-other"}',
            identityJson: '{"route":"partition-test-route-other"}',
            keyVersion: 1,
            legacyRouteKey: '0|0:0|opaque-other',
            afi: 65000,
            safi: 250,
            pathId: 0,
            rd: '0:0',
            prefix: null,
            prefixLength: null,
            nlriKind: 'opaque',
            nlriJson: '{"opaque":"other-family"}',
            attrId: 'partition-test-attr-original',
            attrJson: '{"nextHop":"192.0.2.1"}',
            routeJson: '{"afi":65000,"safi":250,"nlri":"other-family"}'
        }
    };
    assert.deepEqual(
        store.applyBatch({
            batchId: 'partition-test-other-family',
            createdAtMs: eventAtMs,
            mutations: [otherMutation]
        }),
        { duplicate: false, applied: 1 }
    );

    const otherTable = 'bmp_current_routes_peer_other';
    const otherRow = store.db.prepare(`SELECT * FROM ${otherTable}`).get();
    assert.ok(otherRow);
    assert.equal(otherRow.partition_id, 118);
    assert.equal(
        store.db.prepare('SELECT partition_id FROM bmp_rib_scopes WHERE scope_id = ?').pluck().get(otherRow.scope_id),
        118
    );
    assert.equal(
        store.db.prepare('SELECT COUNT(*) FROM bmp_current_routes_all').pluck().get(),
        1,
        'an unknown AFI/SAFI route must remain visible through the unified view'
    );

    const readReferenceState = () => ({
        identity: store.db
            .prepare(
                `SELECT current_ref_count, event_ref_count
                   FROM bmp_route_identities
                  WHERE route_pk = ?`
            )
            .get(otherRow.route_pk),
        payloads: store.db
            .prepare(
                `SELECT payload_id, current_ref_count, event_ref_count
                   FROM bmp_route_payloads
                  ORDER BY payload_id`
            )
            .all(),
        attributes: store.db
            .prepare(
                `SELECT attr_id, current_ref_count, event_ref_count
                   FROM bmp_route_attributes
                  ORDER BY attr_id`
            )
            .all(),
        scopeCounts: store.db
            .prepare(
                `SELECT connection_id, rib_epoch, explicit_state, route_count
                   FROM bmp_scope_route_counts
                  WHERE scope_id = ?
                  ORDER BY connection_id, rib_epoch, explicit_state`
            )
            .all(otherRow.scope_id)
    });
    assert.deepEqual(readReferenceState(), {
        identity: { current_ref_count: 1, event_ref_count: 1 },
        payloads: [{ payload_id: otherRow.payload_id, current_ref_count: 1, event_ref_count: 1 }],
        attributes: [{ attr_id: 'partition-test-attr-original', current_ref_count: 1, event_ref_count: 1 }],
        scopeCounts: [
            {
                connection_id: 'partition-test-connection',
                rib_epoch: 0,
                explicit_state: 'active',
                route_count: 1
            }
        ]
    });

    const referencesBeforeRejectedWrites = readReferenceState();
    assert.throws(
        () =>
            store.db.exec(`
                INSERT INTO bmp_current_routes_peer_ipv4_unicast(
                    scope_id, route_pk, payload_id, attr_id, connection_id, rib_epoch,
                    explicit_state, first_seen_ms, last_seen_ms, source_timestamp_ms, last_event_id
                )
                SELECT scope_id, route_pk, payload_id, attr_id, connection_id, rib_epoch,
                       explicit_state, first_seen_ms, last_seen_ms, source_timestamp_ms, last_event_id
                  FROM ${otherTable}
            `),
        /BMP route identity does not match target partition/,
        'an other-family route must not be inserted into a known-family partition'
    );
    assert.throws(
        () =>
            store.db
                .prepare(`UPDATE ${otherTable} SET route_pk = route_pk + 1000 WHERE path_pk = ?`)
                .run(otherRow.path_pk),
        /scope, partition, and identity are immutable/
    );
    assert.throws(
        () =>
            store.db.exec(`
                INSERT INTO bmp_rib_scopes(
                    scope_id, source_id, partition_id, scope_key_json, scope_identity_json,
                    scope_kind, afi, safi, rib_type, current_epoch, scope_state,
                    last_connection_id, created_at_ms, updated_at_ms
                )
                SELECT 'partition-test-invalid-scope', source_id, 101, '{}', '{}',
                       'peer', 65000, 250, '2', 0, 'syncing', last_connection_id,
                       created_at_ms, updated_at_ms
                  FROM bmp_rib_scopes
                 WHERE scope_id = 'partition-test-scope-other'
            `),
        /BMP scope does not match its route partition/
    );
    assert.deepEqual(readReferenceState(), referencesBeforeRejectedWrites);

    store.db
        .prepare(
            `INSERT INTO bmp_route_attributes(attr_id, attr_json, first_seen_ms, last_seen_ms)
             VALUES ('partition-test-attr-next', '{"nextHop":"192.0.2.2"}', ?, ?)`
        )
        .run(eventAtMs + 1, eventAtMs + 1);
    const nextPayloadId = Number(
        store.db
            .prepare(
                `INSERT INTO bmp_route_payloads(payload_hash, route_json, first_seen_ms, last_seen_ms)
                 VALUES (?, '{"afi":65000,"safi":250,"nlri":"other-family-next"}', ?, ?)
                 RETURNING payload_id`
            )
            .get(Buffer.from('partition-test-payload-next'), eventAtMs + 1, eventAtMs + 1).payload_id
    );
    store.db
        .prepare(`UPDATE ${otherTable} SET payload_id = ?, attr_id = ? WHERE path_pk = ?`)
        .run(nextPayloadId, 'partition-test-attr-next', otherRow.path_pk);

    assert.deepEqual(readReferenceState(), {
        identity: { current_ref_count: 1, event_ref_count: 1 },
        payloads: [
            { payload_id: otherRow.payload_id, current_ref_count: 0, event_ref_count: 1 },
            { payload_id: nextPayloadId, current_ref_count: 1, event_ref_count: 0 }
        ],
        attributes: [
            { attr_id: 'partition-test-attr-next', current_ref_count: 1, event_ref_count: 0 },
            { attr_id: 'partition-test-attr-original', current_ref_count: 0, event_ref_count: 1 }
        ],
        scopeCounts: [
            {
                connection_id: 'partition-test-connection',
                rib_epoch: 0,
                explicit_state: 'active',
                route_count: 1
            }
        ]
    });

    const referencesBeforeNoopUpdate = readReferenceState();
    store.db
        .prepare(
            `UPDATE ${otherTable}
                SET payload_id = payload_id,
                    attr_id = attr_id,
                    connection_id = connection_id,
                    rib_epoch = rib_epoch,
                    explicit_state = explicit_state
              WHERE path_pk = ?`
        )
        .run(otherRow.path_pk);
    assert.deepEqual(
        readReferenceState(),
        referencesBeforeNoopUpdate,
        'reference counts must not drift when watched columns retain the same values'
    );

    const eventId = store.db.prepare('SELECT event_id FROM bmp_route_events').pluck().get();
    assert.throws(
        () =>
            store.db
                .prepare('UPDATE bmp_route_events SET payload_id = ?, attr_id = ? WHERE event_id = ?')
                .run(nextPayloadId, 'partition-test-attr-next', eventId),
        /event identity, payload, and attributes are immutable/
    );
    assert.deepEqual(readReferenceState(), referencesBeforeNoopUpdate);

    console.log('BMP persistence partition manifest/schema tests passed');
} finally {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
