'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const BmpConst = require('../../electron/const/bmpConst');
const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
const ClientStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');
const { builders } = require('../../scripts/mockBmpClient');
const { getComplexRouteIdentity } = require('../../electron/utils/bmpRouteLens');
const { makeStreamRunKey } = require('../../electron/utils/bmpRouteAssurance');
const {
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

let serial = 0;
function context(remoteIp = '192.0.2.10') {
    const bmp = {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp,
        remotePort: 55000,
        sysName: 'storage-regression',
        bmpVersion: 3,
        getBmpV4TlvDraft: () => 20
    };
    const owner = new BgpSession(bmp);
    Object.assign(owner, { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65001 });
    return { bmp, owner };
}
function route(owner, prefix = '203.0.113.0', nextHop = '192.0.2.1', options = {}) {
    const item = new Route(owner, null);
    Object.assign(item, {
        afi: 1,
        safi: 1,
        ribType: 2,
        pathId: 0,
        rd: '0:0',
        ip: prefix,
        mask: 24,
        nlriDetail: { prefix, length: 24, pathId: 0, rd: '0:0', valid: true },
        ...options
    });
    item.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop });
    item.markActive(owner.getRibEpoch(item.afi, item.safi, item.ribType));
    return item;
}
function announce(current, value, options = {}) {
    return buildRouteUpsertMutation(current.bmp, current.owner, value, value.afi, value.safi, value.ribType, {
        kind: 'peer',
        scopeState: 'ready',
        ...options
    });
}
function apply(store, mutations) {
    return store.applyBatch({ batchId: `storage-regression-${++serial}`, includeDeltas: true, mutations });
}
function count(store, table) {
    return store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}
function replace(store, current) {
    apply(store, [announce(current, route(current.owner))]);
    apply(store, [announce(current, route(current.owner, '203.0.113.0', '192.0.2.2'))]);
    assert.equal(count(store, 'bmp_route_attributes'), 2);
    assert.equal(count(store, 'main.bmp_gc_candidates'), 1);
}

if (process.argv[2] === '--crash-writer') {
    const store = new Store({ dbPath: process.argv[3] }).open();
    replace(store, context());
    // Do not call Store.close(): verify committed candidates survive abrupt
    // process teardown, rather than relying on a graceful shutdown GC hook.
    process.kill(process.pid, 'SIGKILL');
} else {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-storage-regressions-'));
    const stores = [];
    const open = name => {
        const store = new Store({ dbPath: path.join(directory, `${name}.sqlite3`) }).open();
        stores.push(store);
        assert.equal(store.db.pragma('synchronous', { simple: true }), 1, 'WAL writer defaults to NORMAL');
        const pageSize = store.db.pragma('page_size', { simple: true });
        const checkpointPages = store.db.pragma('wal_autocheckpoint', { simple: true });
        assert.equal(
            checkpointPages,
            Math.max(1, Math.floor((256 * 1024 * 1024) / pageSize)),
            'NORMAL uses the 256 MiB automatic checkpoint trigger, rather than tiny default checkpoints'
        );
        return store;
    };
    try {
        // An unknown withdraw creates neither identity, payload nor attribute.
        const unknown = open('unknown');
        const current = context();
        const withdraws = Array.from({ length: 100 }, (_, index) =>
            buildRouteWithdrawMutation(
                current.bmp,
                current.owner,
                {
                    prefix: `10.0.${index}.0`,
                    length: 24
                },
                null,
                1,
                1,
                2,
                { kind: 'peer', state: 'ready' }
            )
        );
        apply(unknown, withdraws);
        for (const table of [
            'bmp_current_routes_all',
            'bmp_route_identities',
            'bmp_route_payloads',
            'bmp_route_attributes'
        ]) {
            assert.equal(count(unknown, table), 0, `${table} remains empty after unknown withdrawals`);
        }
        assert.equal(unknown.sweep().hasMore, false);

        // Sequence replay can prefill new objects, but must retain their GC
        // candidates atomically without changing the existing route.
        const seed = announce(current, route(current.owner));
        apply(unknown, [seed]);
        const replay = announce(current, route(current.owner, '203.0.114.0', '192.0.2.2'));
        replay.sequence = seed.sequence;
        assert.equal(apply(unknown, [replay]).applied, 0);
        unknown.sweep();
        assert.equal(count(unknown, 'bmp_current_routes_all'), 1);
        assert.equal(count(unknown, 'bmp_route_identities'), 1);
        assert.equal(count(unknown, 'bmp_route_attributes'), 1);

        // Old-epoch upserts must not make a route live or leak newly created refs.
        const rejected = announce(current, route(current.owner, '203.0.115.0', '192.0.2.3'));
        rejected.scope = { ...rejected.scope, epoch: -1 };
        assert.equal(apply(unknown, [rejected]).deltas[0].projectionChanged, false);
        unknown.sweep();
        assert.equal(count(unknown, 'bmp_route_identities'), 1);
        assert.equal(count(unknown, 'bmp_route_attributes'), 1);

        const reopened = open('reopened');
        replace(reopened, context());
        reopened.close();
        reopened.open();
        assert.equal(count(reopened, 'main.bmp_gc_candidates'), 1);
        assert.equal(reopened.sweep().attributes, 1);
        assert.equal(count(reopened, 'bmp_route_attributes'), 1);

        const crashPath = path.join(directory, 'crashed.sqlite3');
        const child = spawnSync(process.execPath, [__filename, '--crash-writer', crashPath], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            timeout: 10000
        });
        assert.equal(child.error, undefined, child.error?.message);
        assert.notEqual(child.status, 0, child.stderr);
        const crashed = new Store({ dbPath: crashPath }).open();
        stores.push(crashed);
        assert.equal(count(crashed, 'main.bmp_gc_candidates'), 1);
        assert.equal(crashed.sweep().attributes, 1);
        assert.equal(count(crashed, 'bmp_route_attributes'), 1);

        const partitioned = new ClientStore({
            dbPath: path.join(directory, 'clients.sqlite3'),
            maxOpenDatabases: 1
        }).open();
        stores.push(partitioned);
        const a = context('192.0.2.20');
        const b = context('192.0.2.21');
        const aFirst = announce(a, route(a.owner));
        const bFirst = announce(b, route(b.owner));
        apply(partitioned, [aFirst]);
        apply(partitioned, [announce(a, route(a.owner, '203.0.113.0', '192.0.2.2'))]);
        apply(partitioned, [bFirst]);
        assert.equal(partitioned.stores.has(aFirst.source.id), false, 'A was evicted by the one-connection LRU');
        const aStore = partitioned.getStore(aFirst.source.id);
        assert.equal(count(aStore, 'main.bmp_gc_candidates'), 1);
        assert.equal(aStore.sweep().attributes, 1);
        assert.equal(count(aStore, 'bmp_route_attributes'), 1);
        assert.equal(partitioned.queryRoutes({ sourceId: bFirst.source.id }).total, 1);

        // Maintenance processes only its bounded persistent candidate budget.
        const bounded = open('bounded');
        const insert = bounded.db
            .prepare(`INSERT INTO bmp_route_attributes(attr_id, attr_json, first_seen_ms, last_seen_ms)
            VALUES (?, '{}', 0, 0)`);
        for (let index = 0; index < 7; index++) {
            const pk = Number(insert.run(`unused-${index}`).lastInsertRowid);
            bounded.addGcCandidates([{ attr_pk: pk }]);
        }
        const firstSweep = bounded.sweep({ auxiliaryLimit: 2 });
        assert.equal(firstSweep.attributes, 2);
        assert.equal(firstSweep.hasMore, true);
        assert.equal(count(bounded, 'main.bmp_gc_candidates'), 5);
        while (bounded.sweep({ auxiliaryLimit: 2 }).hasMore) {
            /* bounded follow-up batches */
        }
        assert.equal(count(bounded, 'bmp_route_attributes'), 0);

        // One actual BMP UPDATE exposes optional undefined parser diagnostics.
        // They must not turn every ordinary prefix into a distinct payload.
        const parsedMutations = [];
        const parsedFailures = [];
        const parser = new BmpSession(
            { sendEvent() {} },
            {
                bmpConfigData: { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 },
                persistence: {},
                enqueuePersistenceMutation(mutation) {
                    parsedMutations.push(mutation);
                    return true;
                },
                handlePersistenceFailure(error) {
                    parsedFailures.push(error);
                },
                enqueueRouteUpdateEvent() {},
                enqueueInstanceRouteUpdateEvent() {},
                invalidateRouteAssurance() {},
                requestPersistenceSweep() {}
            }
        );
        Object.assign(parser, {
            localIp: '127.0.0.1',
            localPort: 1790,
            remoteIp: '192.0.2.30',
            remotePort: 55000
        });
        parser.processMessage(builders.initiationMessage({ sysName: 'compact-payload-regression' }));
        parser.processMessage(
            builders.bmpMessage(BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, builders.peerUpPayload())
        );
        const prefixes = ['10.77.0.0', '10.77.1.0'];
        parser.processMessage(builders.routeMonitoringMessage({}, builders.ipv4Update(prefixes)));
        assert.deepEqual(parsedFailures, []);
        const parsedRoutes = parsedMutations.filter(mutation => mutation.eventType === 'upsert' && mutation.route);
        assert.equal(parsedRoutes.length, 2, 'one real BMP packet produces two route upsert mutations');
        for (const mutation of parsedRoutes) {
            assert.equal(mutation.route.nlriFlags, 3, 'ordinary valid NLRI and RD use compact flags');
            assert.equal(mutation.route.nlriJson, null);
            assert.equal(mutation.route.routeJson, '{}', 'undefined parser diagnostics do not become path payload');
        }
        const compact = open('compact-parser');
        apply(compact, parsedMutations);
        assert.equal(count(compact, 'bmp_current_routes_all'), 2);
        assert.equal(count(compact, 'bmp_route_payloads'), 1, 'different prefixes share the empty payload');
        assert.deepEqual(
            compact
                .queryRoutes({})
                .list.map(item => item.nlriDetail.prefix)
                .sort(),
            prefixes
        );
        for (const item of compact.queryRoutes({}).list) {
            assert.equal(item.nlriDetail.valid, true);
            assert.equal(item.nlriDetail.rd, '0:0');
        }
        const hostContext = context();
        apply(compact, [
            announce(
                hostContext,
                route(hostContext.owner, '10.88.0.7', '192.0.2.1', {
                    nlriDetail: {
                        prefix: '10.88.0.7',
                        length: 24,
                        pathId: 0,
                        rd: '0:0',
                        valid: true,
                        warnings: ['original host bits are retained as diagnostics']
                    }
                })
            )
        ]);
        const ipQuery = { afi: 1, safi: 1, prefixExact: '10.88.0.0', prefixLength: 24 };
        const prepare = compact.db.prepare.bind(compact.db);
        const indexedQueries = [];
        compact.db.prepare = sql => {
            if (sql.includes('candidate.prefix = @prefixExact')) indexedQueries.push(sql);
            return prepare(sql);
        };
        try {
            assert.equal(compact.queryRoutes(ipQuery).list[0].ip, '10.88.0.0');
            assert.equal(compact.queryRoutes({ ...ipQuery, prefixExact: '10.88.0.7' }).total, 0);
            const ipRows = [];
            compact.streamRouteAssuranceRows(ipQuery, chunk => ipRows.push(...chunk));
            assert.equal(ipRows.length, 1);
            assert.equal(ipRows[0].ip, '10.88.0.0', 'non-EVPN projections retain the canonical network prefix');
        } finally {
            compact.db.prepare = prepare;
        }
        assert.ok(indexedQueries.length >= 3);
        for (const sql of indexedQueries) {
            assert.doesNotMatch(sql, /json_extract|CASE WHEN \(r\.afi = 25/);
            const values = { afi: 1, safi: 1, prefixExact: '10.88.0.0', prefixLength: 24, limit: 101, offset: 0 };
            const bindings = Object.fromEntries(
                [...new Set(sql.match(/@\w+/g))].map(name => [name.slice(1), values[name.slice(1)]])
            );
            const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(bindings);
            assert.ok(
                plan.some(row => /SEARCH candidate USING.*idx_bmp_route_identities_prefix/.test(row.detail)),
                'single-AF IPv4 query and stream retain the identity prefix index'
            );
        }

        // Real nonempty diagnostics are not optional undefined values: retain
        // the complete complex NLRI in its own per-path payload.
        const diagnosed = open('diagnosed');
        const diagnosisContext = context();
        const diagnostic = announce(
            diagnosisContext,
            route(diagnosisContext.owner, '203.0.116.0', '192.0.2.1', {
                nlriDetail: {
                    prefix: '203.0.116.0',
                    length: 24,
                    pathId: 0,
                    rd: '0:0',
                    valid: true,
                    errors: ['retained NLRI diagnostic']
                }
            })
        );
        assert.equal(diagnostic.route.nlriFlags, 0);
        assert.deepEqual(JSON.parse(diagnostic.route.routeJson).nlriDetail.errors, ['retained NLRI diagnostic']);
        apply(diagnosed, [diagnostic]);
        assert.deepEqual(diagnosed.queryRoutes({}).list[0].nlriDetail.errors, ['retained NLRI diagnostic']);

        // Actual protocol-decoded EVPN labels remain local to peer/stage paths.
        const evpnRoute = (owner, label, ribType, secondLabel = null) => {
            const value = (label << 4) | 1;
            const body = Buffer.concat([
                Buffer.from('0000fde800000001', 'hex'),
                Buffer.alloc(10),
                builders.u32(100),
                Buffer.from([48, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 10, 32, 192, 0, 2, 10]),
                Buffer.from([(value >> 16) & 255, (value >> 8) & 255, value & 255]),
                ...(secondLabel === null
                    ? []
                    : [
                          Buffer.from([
                              (secondLabel >> 12) & 255,
                              (secondLabel >> 4) & 255,
                              ((secondLabel & 15) << 4) | 1
                          ])
                      ])
            ]);
            const nlri = Buffer.concat([Buffer.from([2, body.length]), body]);
            const decoded = parseBgpPacket(builders.multiprotocolUpdate(25, 70, nlri, { nextHop: '192.0.2.1' }));
            assert.equal(decoded.valid, true);
            const item = new Route(owner, null);
            BmpSession.prototype.setRouteNlri.call(
                {},
                item,
                decoded.pathAttributes.find(attr => attr.mpReach).mpReach.nlri[0],
                25,
                70
            );
            item.ribType = ribType;
            item.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' });
            item.markActive(owner.getRibEpoch(25, 70, ribType));
            return item;
        };
        const paths = open('paths');
        const p1 = context();
        const p2 = { bmp: p1.bmp, owner: new BgpSession(p1.bmp) };
        Object.assign(p2.owner, { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.2', sessionAs: 65002 });
        const one = announce(p1, evpnRoute(p1.owner, 100, 2));
        const two = announce(p2, evpnRoute(p2.owner, 200, 2, 201));
        const stage = announce(p1, evpnRoute(p1.owner, 400, 3, 401));
        apply(paths, [one, two, stage]);
        apply(paths, [announce(p1, evpnRoute(p1.owner, 300, 2))]);
        assert.equal(count(paths, 'bmp_route_identities'), 1, 'label changes share one canonical identity');
        const expected = new Map([
            [one.scope.id, 300],
            [two.scope.id, 200],
            [stage.scope.id, 400]
        ]);
        for (const item of paths.queryRoutes({}).list) {
            assert.equal(item.nlriDetail.labels[0].label, expected.get(item.persistentScopeId));
            assert.match(item.labels, new RegExp(`MPLS ${expected.get(item.persistentScopeId)}\\(`));
            assert.equal(item.mask, item.persistentScopeId === one.scope.id ? 37 : 40);
        }
        assert.equal(paths.queryRoutes({ afi: 25, safi: 70, prefixLength: 40 }).total, 2);
        assert.equal(paths.queryRoutes({ prefixLength: 40 }).total, 2);
        const pathSearch = { afi: 25, safi: 70, scopeId: one.scope.id };
        const macIpDetail = JSON.parse(one.route.routeJson).nlriDetail;
        assert.equal(paths.queryRoutes({ ...pathSearch, prefixFilter: macIpDetail.ipAddress }).total, 1);
        assert.equal(paths.queryRoutes({ ...pathSearch, prefixFilter: `${macIpDetail.ipAddress}/32` }).total, 1);
        assert.equal(paths.queryRoutes({ ...pathSearch, prefixCidrs: [`${macIpDetail.ipAddress}/32`] }).total, 1);

        // Keep identity display text unrelated to every searched NLRI field,
        // so these probes cannot accidentally pass by matching r.prefix.
        const searches = open('payload-searches');
        const searchContext = context();
        const semantic = announce(
            searchContext,
            route(searchContext.owner, 'evpn:payload-search-identity', '192.0.2.1', {
                afi: 25,
                safi: 70,
                mask: 0,
                rd: '65000:1',
                nlriDetail: {
                    ...macIpDetail,
                    prefix: '203.0.120.0',
                    ipPrefix: '203.0.121.0',
                    prefixLength: 24,
                    length: 24,
                    formatted: 'nlri-only-display-marker',
                    rawNlri: 'beefbabe11223344'
                }
            })
        );
        assert.equal(semantic.route.nlriJson, null);
        apply(searches, [semantic]);
        for (const prefixFilter of [
            '203.0.120.0',
            '203.0.120.0/24',
            '203.0.121.0',
            '203.0.121.0/24',
            macIpDetail.ipAddress,
            `${macIpDetail.ipAddress}/32`,
            '203.0.120',
            '203.0.121',
            'nlri-only-display-marker'
        ]) {
            assert.equal(
                searches.queryRoutes({ afi: 25, safi: 70, prefixFilter }).total,
                1,
                `payload NLRI matches ${prefixFilter}`
            );
        }
        for (const prefixCidrs of [['203.0.120.0/24'], ['203.0.121.0/24'], [`${macIpDetail.ipAddress}/32`]]) {
            assert.equal(searches.queryRoutes({ afi: 25, safi: 70, prefixCidrs }).total, 1);
        }
        for (const text of ['nlri-only-display-marker', 'beefbabe11223344', macIpDetail.macAddress]) {
            assert.equal(searches.queryRoutes({ searchText: text }).total, 1, `general search matches ${text}`);
            assert.equal(searches.queryRoutes({ routeIdentityText: text }).total, 1, `identity search matches ${text}`);
        }
        assert.equal(searches.queryRoutes({ prefixFilter: '203.0.122.0/24' }).total, 0);
        assert.equal(searches.queryRoutes({ prefixCidrs: ['203.0.122.0/24'] }).total, 0);
        assert.equal(searches.queryRoutes({ searchText: 'absent-nlri-marker' }).total, 0);
        const streamed = [];
        paths.streamRouteAssuranceRows({}, chunk => streamed.push(...chunk));
        assert.equal(streamed.length, 3);
        for (const item of streamed)
            assert.equal(item.nlriDetail.labels[0].label, expected.get(item.persistentScopeId));
        for (const lean of [true, false]) {
            const extended = [];
            paths.streamRouteAssuranceRows({ afi: 25, safi: 70, prefixLength: 40, lean }, chunk =>
                extended.push(...chunk)
            );
            assert.equal(extended.length, 2);
            assert.ok(extended.every(item => item.mask === 40 && item.nlriDetail.labels.length === 2));
        }
        apply(paths, [
            buildRouteWithdrawMutation(p1.bmp, p1.owner, JSON.parse(one.route.routeJson).nlriDetail, null, 25, 70, 2, {
                kind: 'peer',
                state: 'ready'
            })
        ]);
        assert.equal(paths.queryRoutes({ scopeId: one.scope.id }).total, 0);
        assert.equal(paths.queryRoutes({ scopeId: two.scope.id }).total, 1);
        assert.equal(paths.queryRoutes({ scopeId: stage.scope.id }).total, 1);

        // RT5 gateway changes preserve business identity, but its display prefix
        // is current path data and must never come from the first-seen identity.
        const gatewayRoute = (
            owner,
            gateway,
            ribType,
            label,
            displayOverride = false,
            rdBytes = builders.rd(65000, 1),
            pathId = 0
        ) => {
            const body = Buffer.concat([
                rdBytes,
                Buffer.alloc(10),
                builders.u32(100),
                Buffer.from([24]),
                builders.ip('198.51.100.0'),
                builders.ip(gateway),
                Buffer.from([(label >> 12) & 255, (label >> 4) & 255, ((label & 15) << 4) | 1])
            ]);
            const decoded = parseBgpPacket(
                builders.multiprotocolUpdate(25, 70, Buffer.concat([Buffer.from([5, body.length]), body]))
            );
            assert.equal(decoded.valid, true);
            const item = new Route(owner, null);
            BmpSession.prototype.setRouteNlri.call(
                {},
                item,
                decoded.pathAttributes.find(attr => attr.mpReach).mpReach.nlri[0],
                25,
                70
            );
            item.pathId = pathId;
            item.nlriDetail.pathId = pathId;
            if (displayOverride) {
                item.nlriDetail.displayPrefix = `${item.nlriDetail.prefix}:current-display`;
                item.ip = item.nlriDetail.displayPrefix;
            }
            item.ribType = ribType;
            item.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' });
            item.markActive(owner.getRibEpoch(25, 70, ribType));
            return item;
        };
        const gateways = open('gateway-paths');
        const oldGateway = announce(p1, gatewayRoute(p1.owner, '192.0.2.91', 2, 100));
        const currentGateway = announce(p1, gatewayRoute(p1.owner, '192.0.2.92', 2, 200));
        const peerGateway = announce(p2, gatewayRoute(p2.owner, '192.0.2.93', 2, 300));
        const stageGateway = announce(p1, gatewayRoute(p1.owner, '192.0.2.94', 3, 400, true));
        apply(gateways, [oldGateway]);
        apply(gateways, [currentGateway, peerGateway, stageGateway]);
        assert.equal(currentGateway.route.legacyRouteKey, oldGateway.route.legacyRouteKey);
        assert.ok(!currentGateway.route.legacyRouteKey.includes('192.0.2.91'));
        assert.equal(count(gateways, 'bmp_route_identities'), 1);
        assert.ok(gateways.db.prepare('SELECT prefix FROM bmp_route_identities').get().prefix.includes('192.0.2.91'));
        const gatewayMutations = [currentGateway, peerGateway, stageGateway];
        for (const mutation of gatewayMutations) {
            const detail = JSON.parse(mutation.route.routeJson).nlriDetail;
            const prefix = detail.displayPrefix || detail.prefix;
            const query = { afi: 25, safi: 70, scopeId: mutation.scope.id };
            const row = gateways.queryRoutes(query).list[0];
            assert.equal(row.ip, prefix);
            assert.equal(row.mask, detail.length);
            assert.equal(row.nlriDetail.gatewayIp, detail.gatewayIp);
            assert.equal(gateways.queryRoutes({ ...query, routeKey: mutation.route.legacyRouteKey }).total, 1);
            assert.equal(gateways.queryRoutes({ ...query, searchText: mutation.route.legacyRouteKey }).total, 1);
            assert.equal(gateways.queryRoutes({ ...query, routeIdentityText: mutation.route.legacyRouteKey }).total, 1);
            for (const filter of [
                { prefixExact: prefix, prefixLength: detail.length },
                { prefix: prefix },
                { prefixFilter: `gw=${detail.gatewayIp}` },
                { searchText: detail.gatewayIp },
                { routeIdentityText: detail.gatewayIp },
                { prefixFilter: '198.51.100.0/24' }
            ]) {
                assert.equal(gateways.queryRoutes({ ...query, ...filter }).total, 1);
                assert.equal(
                    gateways.queryRoutes({ ...filter }).total,
                    filter.prefixFilter === '198.51.100.0/24' ? 3 : 1
                );
            }
            for (const lean of [true, false]) {
                const rows = [];
                gateways.streamRouteAssuranceRows(
                    { afi: 25, safi: 70, prefixExact: prefix, prefixLength: detail.length, lean },
                    chunk => rows.push(...chunk)
                );
                assert.equal(rows.length, 1);
                assert.equal(rows[0].ip, prefix);
                assert.equal(rows[0].mask, detail.length);
                assert.equal(rows[0].nlriDetail.gatewayIp, detail.gatewayIp);
            }
        }
        for (const filter of [
            { prefixExact: oldGateway.route.prefix },
            { prefix: oldGateway.route.prefix },
            { prefixFilter: '192.0.2.91' },
            { prefixFilter: 'gw=192.0.2.91' },
            { searchText: '192.0.2.91' },
            { routeIdentityText: '192.0.2.91' }
        ]) {
            assert.equal(
                gateways.queryRoutes({ afi: 25, safi: 70, ...filter }).total,
                0,
                'obsolete identity gateway is not searchable'
            );
            assert.equal(gateways.queryRoutes(filter).total, 0);
        }
        for (const lean of [true, false]) {
            const rows = [];
            gateways.streamRouteAssuranceRows(
                { afi: 25, safi: 70, prefixExact: oldGateway.route.prefix, lean },
                chunk => rows.push(...chunk)
            );
            assert.equal(rows.length, 0);
        }

        // Two binary RD encodings have the same display text. Gateway order
        // used to interleave one stable NLRI across its ADD-PATH records.
        const runs = open('complex-runs');
        const rd0 = builders.rd(65000, 1);
        const rd2 = Buffer.from('00020000fde80001', 'hex');
        const runMutations = [
            announce(p1, gatewayRoute(p1.owner, '192.0.2.11', 2, 100, false, rd0, 0)),
            announce(p1, gatewayRoute(p1.owner, '192.0.2.12', 2, 200, false, rd2, 0)),
            announce(p1, gatewayRoute(p1.owner, '192.0.2.13', 2, 300, false, rd0, 1))
        ];
        apply(runs, runMutations);
        for (const lean of [true, false]) {
            const rows = [];
            runs.streamRouteAssuranceRows({ afi: 25, safi: 70, lean }, chunk => rows.push(...chunk));
            assert.equal(rows.length, 3);
            const keys = rows.map(row => makeStreamRunKey(row));
            assert.equal(new Set(keys).size, 2);
            assert.ok(keys[0] === keys[1] || keys[1] === keys[2], 'stable complex NLRI runs are contiguous');
            const lookup = getComplexRouteIdentity(rows.find(row => row.nlriDetail.rdRaw === 'raw:0000fde800000001'));
            const group = [];
            runs.streamRouteAssuranceRows(
                { afi: 25, safi: 70, rd: '65000:1', routeLookupIdentity: lookup, lean },
                chunk => group.push(...chunk)
            );
            assert.equal(
                group.length,
                2,
                'suffix lookup includes both ADD-PATH values and excludes the other binary RD'
            );
            assert.deepEqual(group.map(row => row.pathId).sort(), [0, 1]);
            assert.ok(group.every(row => getComplexRouteIdentity(row) === lookup));
        }

        const rds = open('rds');
        const rdContext = context();
        for (const [index, rd] of ['65000:1', '65000:2'].entries()) {
            const value = route(rdContext.owner, '10.0.0.0', '192.0.2.1', {
                safi: 128,
                rd,
                rdRaw: `raw:0000fde80000000${index + 1}`,
                nlriDetail: {
                    prefix: '10.0.0.0',
                    length: 24,
                    pathId: 0,
                    rd,
                    rdRaw: `raw:0000fde80000000${index + 1}`,
                    valid: true
                }
            });
            apply(rds, [announce(rdContext, value)]);
        }
        assert.equal(rds.queryRoutes({ afi: 1, safi: 128, prefixExact: '10.0.0.0' }).total, 2);
        assert.equal(rds.queryRoutes({ afi: 1, safi: 128, prefixExact: '10.0.0.0', rd: '065000:0001' }).total, 1);
        assert.equal(
            rds.queryRoutes({ afi: 1, safi: 128, prefixExact: '10.0.0.0', rd: 'RAW:0000FDE800000002' }).list[0].rd,
            '65000:2'
        );
        assert.equal(rds.queryRoutes({ afi: 1, safi: 128, prefixExact: '10.0.0.0', rd: '65000:3' }).total, 0);
        assert.equal(
            rds.queryRoutes({ afi: 1, safi: 128, prefixExact: '10.0.0.0', rd: '65000:1', includeTotal: false }).list
                .length,
            1
        );
        console.log('BMP persistence GC durability, NLRI path ownership and RD filter regressions passed');
    } finally {
        for (const store of stores.reverse()) store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
