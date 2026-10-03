'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpClientPersistenceStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const { getClientDatabasePath } = require('../../electron/worker/bmp/bmpClientPersistencePaths');
const { builders } = require('../../scripts/mockBmpClient');

const TIME = 1767225600000;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-non-ip-bulk-'));
let serial = 0;

function evpnNlri(sequence, label) {
    const value = (label << 4) | 1;
    const body = Buffer.concat([
        Buffer.from('0000fde800000001', 'hex'),
        Buffer.alloc(10),
        builders.u32(100),
        Buffer.from([48, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, sequence, 32, 192, 0, 2, sequence]),
        Buffer.from([(value >> 16) & 255, (value >> 8) & 255, value & 255])
    ]);
    return Buffer.concat([Buffer.from([2, body.length]), body]);
}

const families = [
    {
        name: 'evpn',
        afi: 25,
        safi: 70,
        nextHop: '192.0.2.1',
        nlri: (index, changed = false) => evpnNlri(index + 10, changed && index === 0 ? 300 : 100 + index)
    },
    {
        name: 'ipv4-flowspec',
        afi: 1,
        safi: 133,
        nextHop: Buffer.alloc(0),
        nlri: index => Buffer.from([5, 1, 24, 192, 0, 2 + index])
    },
    {
        name: 'ipv6-flowspec',
        afi: 2,
        safi: 133,
        nextHop: Buffer.alloc(0),
        nlri: index => Buffer.concat([Buffer.from([11, 1, 64, 0]), Buffer.from(`20010db8000${index + 1}0000`, 'hex')])
    },
    // SAFI 134 VPN FlowSpec is not parsed by the current runtime. Exercise its
    // generic raw-NLRI partition separately, without claiming VPN support.
    {
        name: 'unknown-family-fallback',
        afi: 65000,
        safi: 200,
        nextHop: '192.0.2.1',
        nlri: index => Buffer.from([1, 3, 0xaa, 0xbb, index + 1])
    }
];

function indexedTlv(type, index, value) {
    return Buffer.concat([builders.u16(type), builders.u16(value.length), builders.u16(index), value]);
}

function bgpWithdraw(family, indexes) {
    const nlri = Buffer.concat(indexes.map(index => family.nlri(index)));
    const value = Buffer.concat([builders.u16(family.afi), Buffer.from([family.safi]), nlri]);
    const attr = Buffer.concat([Buffer.from([0x80, 15, value.length]), value]);
    const body = Buffer.concat([builders.u16(0), builders.u16(attr.length), attr]);
    return Buffer.concat([Buffer.alloc(16, 255), builders.u16(19 + body.length), Buffer.from([2]), body]);
}

function makeParser(name, advertised = families) {
    const pending = [];
    const failures = [];
    let timestamp = 0;
    const facade = {
        bmpConfigData: { bmpV4TlvDraft: 20 },
        persistence: {},
        enqueuePersistenceMutation(mutation) {
            mutation.eventAtMs = TIME + timestamp;
            mutation.sourceTimestampMs = TIME + timestamp - 200;
            pending.push(mutation);
            return true;
        },
        handlePersistenceFailure(error) {
            failures.push(error);
        },
        enqueueRouteUpdateEvent() {},
        enqueueInstanceRouteUpdateEvent() {},
        invalidateRouteAssurance() {},
        requestPersistenceSweep() {}
    };
    const session = new BmpSession({ sendEvent() {} }, facade);
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: `192.0.2.${name === 'client-b' ? 20 : 10}`,
        remotePort: 55000,
        persistenceConnectionId: `${name}-connection`,
        persistenceConnectionGeneration: 100,
        persistenceOpenedAtMs: TIME - 1000
    });
    const addressFamilies = advertised.map(({ afi, safi }) => ({ afi, safi }));
    session.processMessage(builders.initiationMessage({ sysName: name }));
    session.processMessage(
        builders.bmpMessage(
            BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
            builders.peerUpPayload({ recvAddressFamilies: addressFamilies, sendAddressFamilies: addressFamilies })
        )
    );
    assert.deepEqual(failures, []);
    const controls = pending.splice(0);
    const send = (packet, at = timestamp + 1000) => {
        timestamp = at;
        pending.length = 0;
        session.processMessage(packet);
        assert.deepEqual(failures, []);
        return pending.splice(0);
    };
    return {
        session,
        controls,
        announce(family, options = {}) {
            const nlri = Buffer.concat([family.nlri(0, options.labelsChanged), family.nlri(1)]);
            const update = builders.multiprotocolUpdate(family.afi, family.safi, nlri, {
                nextHop: family.nextHop,
                localPref: options.localPref ?? 100,
                communities: options.communities || []
            });
            const routeTlvs = options.tlv
                ? [indexedTlv(BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.SEQUENCE_NUMBER, 1, builders.u32(options.tlv))]
                : [];
            const mutations = send(builders.routeMonitoringMessage({}, update, { routeTlvs }));
            assert.equal(mutations.length, 2, `${family.name} packet must generate two unique actual route mutations`);
            assert.ok(mutations.every(mutation => mutation.eventType === 'upsert' && mutation.route));
            assert.notEqual(mutations[0].route.id, mutations[1].route.id);
            assert.equal(mutations[0].source, mutations[1].source);
            assert.equal(mutations[0].connection, mutations[1].connection);
            assert.equal(mutations[0].scope, mutations[1].scope);
            return mutations;
        },
        withdraw(family, indexes = [0]) {
            return send(builders.routeMonitoringMessage({}, bgpWithdraw(family, indexes)));
        },
        eor(family) {
            return send(builders.routeMonitoringMessage({}, builders.endOfRibUpdate(family.afi, family.safi)));
        }
    };
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
    ]) {
        result[table] = store.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
    }
    result.routes = store.db
        .prepare('SELECT * FROM bmp_current_routes_all ORDER BY partition_id, scope_pk, route_pk')
        .all();
    result.gc = store.db.prepare('SELECT * FROM main.bmp_gc_candidates ORDER BY kind, pk').all();
    return result;
}

function observe(store) {
    const counters = { point: 0, upsert: 0, bulk: 0, bulkRows: 0 };
    for (const statements of store.partitionStatements.values()) {
        for (const name of ['refreshRouteMetadata', 'upsertRoute']) {
            const original = statements[name];
            statements[name] = new Proxy(original, {
                get(target, key) {
                    if (key === 'run')
                        return (...args) => {
                            counters[name === 'upsertRoute' ? 'upsert' : 'point'] += 1;
                            return Reflect.apply(target.run, target, args);
                        };
                    return Reflect.get(target, key, target);
                }
            });
        }
    }
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = sql => {
        const statement = prepare(sql);
        if (!sql.includes('WITH seen(route_pk, payload_id, attr_pk,')) return statement;
        return new Proxy(statement, {
            get(target, key) {
                if (key === 'run')
                    return (...args) => {
                        counters.bulk += 1;
                        counters.bulkRows += (args.length - 4) / 6;
                        return Reflect.apply(target.run, target, args);
                    };
                return Reflect.get(target, key, target);
            }
        });
    };
    return counters;
}

function comparableResult(result) {
    return { ...result, deltas: result.deltas || [] };
}

function compareFamily(family, includeDeltas) {
    serial += 1;
    const parser = makeParser(`non-ip-${serial}`, [family]);
    const actual = new BmpPersistenceStore({ dbPath: path.join(directory, `${serial}-bulk.sqlite3`) }).open();
    const reference = new BmpPersistenceStore({ dbPath: path.join(directory, `${serial}-reference.sqlite3`) }).open();
    reference.prepareDeferredMetadataRefresh = () => {};
    const calls = observe(actual);
    let step = 0;
    const apply = (label, mutations) => {
        Object.keys(calls).forEach(key => {
            calls[key] = 0;
        });
        const request = { batchId: `non-ip-${serial}-${++step}-${label}`, createdAtMs: TIME, includeDeltas, mutations };
        const result = actual.applyBatch(request);
        const expected = reference.applyBatch(request);
        assert.deepEqual(
            comparableResult(result),
            comparableResult(expected),
            `${family.name}/${label}/RA=${includeDeltas} committed result`
        );
        assert.deepEqual(
            snapshot(actual),
            snapshot(reference),
            `${family.name}/${label} physical rows, attributes, payloads, counts and GC`
        );
        return result;
    };
    try {
        apply('controls', parser.controls);
        const seed = parser.announce(family);
        apply('initial', seed);
        const firstRows = snapshot(actual).routes;
        const repeat = apply('repeat', parser.announce(family));
        assert.equal(calls.bulk, 1);
        assert.equal(calls.bulkRows, 2);
        assert.equal(calls.point, 0);
        assert.equal(calls.upsert, 0);
        if (includeDeltas) assert.deepEqual(repeat.deltas, []);
        assert.equal(repeat.requiresProjectionRebuild, undefined);
        const repeatedRows = snapshot(actual).routes;
        assert.deepEqual(
            repeatedRows.map(row => row.first_seen_ms),
            firstRows.map(row => row.first_seen_ms)
        );
        assert.ok(repeatedRows.every((row, index) => row.last_seen_ms > firstRows[index].last_seen_ms));
        assert.deepEqual(snapshot(actual).gc, []);

        // Route payload is not part of the shared path-attribute object. One
        // indexed TLV changes one route; the other must still use bulk refresh.
        const decorated = apply('route-tlv-change', parser.announce(family, { tlv: 101 }));
        assert.equal(calls.upsert, 1);
        assert.equal(calls.bulkRows, 1);
        if (includeDeltas) assert.equal(decorated.deltas.length, 1);
        apply('same-route-tlv', parser.announce(family, { tlv: 101 }));
        assert.equal(calls.bulkRows, 2);

        if (family.name === 'evpn') {
            const labels = parser.announce(family, { tlv: 101, labelsChanged: true });
            assert.deepEqual(
                labels.map(mutation => mutation.route.id),
                seed.map(mutation => mutation.route.id),
                'EVPN label changes retain route identity'
            );
            apply('evpn-label-change', labels);
            assert.equal(calls.upsert, 1);
            assert.equal(calls.bulkRows, 1);
        }
        const changed = apply(
            'attribute-change',
            parser.announce(family, { localPref: 200, communities: ['65000:2'] })
        );
        assert.equal(calls.upsert, 2);
        assert.equal(calls.bulkRows, 0);
        if (includeDeltas) assert.ok(changed.deltas.every(delta => delta.classification === 'replace'));
        apply('same-attribute', parser.announce(family, { localPref: 200, communities: ['65000:2'] }));
        assert.equal(calls.bulkRows, 2);

        // A duplicated key must remain FIFO, even when a later announcement
        // changes its attributes. The reference keeps scalar metadata writes.
        const first = parser.announce(family, { localPref: 200, communities: ['65000:2'] });
        const second = parser.announce(family, { localPref: 300 });
        apply('duplicate-path-fallback', [...first, ...second]);
        assert.equal(calls.bulk, 0);
        assert.equal(actual.queryRoutes({ routeState: 'all' }).total, 2);
        assert.ok(actual.queryRoutes({ routeState: 'all' }).list.every(route => route.localPref === 300));
        const withdrawn = parser.withdraw(family);
        assert.equal(withdrawn.length, 1);
        assert.equal(withdrawn[0].eventType, 'withdraw');
        apply('withdraw', withdrawn);
        assert.equal(calls.bulk, 0);
        assert.equal(actual.queryRoutes({ routeState: 'all' }).total, 1);
        apply('restore-after-withdraw', parser.announce(family, { localPref: 300 }));
        assert.equal(calls.upsert, 1);
        assert.equal(calls.bulkRows, 1);
        apply('eor', parser.eor(family));
        assert.equal(calls.bulk, 0);
        apply('ready-repeat', parser.announce(family, { localPref: 300 }));
        assert.equal(calls.bulkRows, 2);
    } finally {
        actual.close();
        reference.close();
    }
}

function physicalClient(databasePath) {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        return {
            sources: db.prepare('SELECT source_id FROM bmp_sources ORDER BY source_id').all(),
            identities: db.prepare('SELECT route_id FROM bmp_route_identities ORDER BY route_id').all(),
            attributes: db.prepare('SELECT attr_id, attr_json FROM bmp_route_attributes ORDER BY attr_id').all(),
            payloads: db.prepare('SELECT payload_hash, route_json FROM bmp_route_payloads ORDER BY payload_hash').all(),
            routes: db.prepare('SELECT * FROM bmp_current_routes_all ORDER BY partition_id, scope_pk, route_pk').all()
        };
    } finally {
        db.close();
    }
}

function clientIsolation() {
    const basePath = path.join(directory, 'isolated.sqlite3');
    const store = new BmpClientPersistenceStore({ dbPath: basePath }).open();
    const a = makeParser('client-a');
    const b = makeParser('client-b');
    let step = 0;
    const apply = mutations =>
        store.applyBatch({ batchId: `non-ip-isolation-${++step}`, createdAtMs: TIME, mutations });
    try {
        apply([...a.controls, ...b.controls]);
        families.forEach(family =>
            apply([...a.announce(family, { localPref: 100 }), ...b.announce(family, { localPref: 200 })])
        );
        const sourceA = a.session.getPersistentSourceId();
        const sourceB = b.session.getPersistentSourceId();
        assert.notEqual(sourceA, sourceB);
        const pathA = getClientDatabasePath(basePath, sourceA);
        const pathB = getClientDatabasePath(basePath, sourceB);
        assert.notEqual(pathA, pathB);
        assert.ok(fs.existsSync(pathA) && fs.existsSync(pathB));
        const dataA = physicalClient(pathA);
        const dataB = physicalClient(pathB);
        assert.deepEqual(dataA.sources, [{ source_id: sourceA }]);
        assert.deepEqual(dataB.sources, [{ source_id: sourceB }]);
        assert.deepEqual(
            dataA.identities,
            dataB.identities,
            'same non-IP NLRI identities exist independently in both files'
        );
        assert.equal(dataA.routes.length, families.length * 2);
        assert.equal(dataB.routes.length, families.length * 2);
        assert.ok(dataA.attributes.every(row => JSON.parse(row.attr_json).localPref === 100));
        assert.ok(dataB.attributes.every(row => JSON.parse(row.attr_json).localPref === 200));
        assert.ok(dataA.attributes.every(row => !dataB.attributes.some(other => row.attr_id === other.attr_id)));
        families.forEach(family => apply(a.announce(family, { localPref: 100 })));
        assert.deepEqual(physicalClient(pathB), dataB, 'client A repeated routes cannot touch client B');
        apply(a.announce(families[0], { localPref: 300, labelsChanged: true, tlv: 777 }));
        apply(a.withdraw(families[1]));
        assert.deepEqual(
            physicalClient(pathB),
            dataB,
            'client A payload/attribute changes and withdraw cannot touch client B'
        );
        assert.equal(store.queryRoutes({ sourceId: sourceA, routeState: 'all' }).total, families.length * 2 - 1);
        assert.equal(store.queryRoutes({ sourceId: sourceB, routeState: 'all' }).total, families.length * 2);
        store.purgeSource({ sourceId: sourceA });
        assert.equal(store.queryRoutes({ sourceId: sourceA, routeState: 'all' }).total, 0);
        assert.deepEqual(
            physicalClient(pathB),
            dataB,
            'purging A keeps every B route, attribute and payload unchanged'
        );
    } finally {
        store.close();
    }
}

try {
    for (const family of families) for (const includeDeltas of [false, true]) compareFamily(family, includeDeltas);
    clientIsolation();
    console.log(
        'BMP non-IP bulk refresh passed: real EVPN/IPv4+IPv6 FlowSpec/fallback parsing, scalar parity and Client file isolation'
    );
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
