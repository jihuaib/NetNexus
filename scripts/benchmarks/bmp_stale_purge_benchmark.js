// ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --expose-gc
//   scripts/benchmarks/bmp_stale_purge_benchmark.js --routes=1000000 --rounds=3
// Synthetic SQLite cleanup benchmark, not a TCP ingest or renderer benchmark.
// The legacy detailed path and the manual bulk path receive identical copies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { buildRouteUpsertMutation } = require('../../electron/worker/bmp/bmpPersistenceMutation');

// These closed synthetic datasets model a stable running collector. Opening a
// benchmark copy must not turn its intentionally active rows stale via restart
// recovery; production recovery remains enabled everywhere else.
class BenchmarkStore extends BmpPersistenceStore {
    recoverInterruptedConnections() {
        return 0;
    }
}

function argument(name, fallback) {
    const value = process.argv.find(item => item.startsWith(`--${name}=`));
    return value ? value.slice(name.length + 3) : fallback;
}

function integerArgument(name, fallback) {
    const value = Number(argument(name, fallback));
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid --${name}`);
    return value;
}

function seed(dbPath, kind, count, sparse) {
    const store = new BenchmarkStore({ dbPath }).open();
    try {
        const session = {
            localIp: '127.0.0.1',
            localPort: 11019,
            remoteIp: '192.0.2.10',
            remotePort: 50000,
            sysName: 'stale-purge-benchmark',
            persistenceConnectionId: 'benchmark-connection',
            getBmpV4TlvDraft: () => 20
        };
        const owner = kind === 'peer' ? new BmpBgpSession(session) : new BmpBgpInstance(session);
        Object.assign(
            owner,
            kind === 'peer'
                ? { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65001 }
                : { instanceType: 3, instanceRd: '0:0', instanceIp: '0.0.0.0', instanceAs: 65001, afi: 1, safi: 1 }
        );
        const ribType = kind === 'peer' ? 2 : 'loc-rib';
        const route = new BmpBgpRoute(owner, null);
        Object.assign(route, {
            afi: 1,
            safi: 1,
            ribType,
            pathId: 1,
            rd: '0:0',
            ip: '10.0.0.1',
            mask: 32,
            nlriDetail: { prefix: '10.0.0.1', length: 32, pathId: 1, rd: '0:0' }
        });
        route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' });
        route.markActive(0);
        const mutation = buildRouteUpsertMutation(session, owner, route, 1, 1, ribType, {
            kind,
            state: 'ready',
            scopeState: 'ready'
        });
        store.applyBatch({ batchId: 'seed', mutations: [mutation], includeDeltas: false });
        const table = `bmp_current_routes_${kind === 'peer' ? 'peer' : 'loc_rib'}_ipv4_unicast`;
        // Seeding is deliberately outside the timed region. Integer identities
        // and shared small payload/attributes keep dataset construction bounded.
        store.db.transaction(() => {
            if (count > 1) {
                store.db
                    .prepare(
                        `
                    WITH RECURSIVE seq(n) AS (VALUES(2) UNION ALL SELECT n + 1 FROM seq WHERE n < @count)
                    INSERT INTO bmp_route_identities(
                        route_pk, route_id, route_key_version, legacy_route_key, afi, safi, path_id, rd,
                        prefix, prefix_length, nlri_kind, nlri_json, nlri_flags, first_seen_ms, last_seen_ms
                    ) SELECT n, printf('%064x', n), i.route_key_version, 'benchmark|' || n, 1, 1, n, i.rd,
                        printf('10.%d.%d.%d', (n >> 16) & 255, (n >> 8) & 255, n & 255), 32,
                        i.nlri_kind, NULL, i.nlri_flags, i.first_seen_ms, i.last_seen_ms
                      FROM seq CROSS JOIN bmp_route_identities i WHERE i.route_pk = 1
                `
                    )
                    .run({ count });
                store.db
                    .prepare(
                        `
                    INSERT INTO ${table}(
                        scope_pk, route_pk, payload_id, attr_pk, connection_pk, rib_epoch, explicit_state,
                        first_seen_ms, last_seen_ms, source_timestamp_ms, last_sequence
                    ) SELECT r.scope_pk, i.route_pk, r.payload_id, r.attr_pk, r.connection_pk, r.rib_epoch,
                        r.explicit_state, r.first_seen_ms, r.last_seen_ms, r.source_timestamp_ms, r.last_sequence
                      FROM bmp_route_identities i CROSS JOIN ${table} r WHERE i.route_pk > 1 AND r.route_pk = 1
                `
                    )
                    .run();
            }
            if (sparse) {
                store.db.prepare(`UPDATE ${table} SET rib_epoch = 1 WHERE route_pk <= ?`).run(Math.floor(count * 0.9));
                store.db.prepare('UPDATE bmp_rib_scopes SET current_epoch = 1').run();
            } else {
                store.db.prepare("UPDATE bmp_rib_scopes SET scope_state = 'stale'").run();
            }
        })();
        const summary = store.queryScopeSummary({ scopeId: mutation.scope.id });
        assert.equal(summary.total, count);
        assert.equal(summary.stale, sparse ? count - Math.floor(count * 0.9) : count);
        store.checkpoint('TRUNCATE');
        return { scopeId: mutation.scope.id, sourceId: mutation.source.id, stale: summary.stale };
    } finally {
        store.close();
    }
}

function measure(dbPath, query, includeDetails) {
    const store = new BenchmarkStore({ dbPath }).open();
    try {
        global.gc?.();
        let deleted = 0;
        let batches = 0;
        const batchTimes = [];
        const start = performance.now();
        for (;;) {
            const batchStart = performance.now();
            const result = store.purgeStaleRoutes({ ...query, includeDetails, routeLimit: 20000 });
            batchTimes.push(performance.now() - batchStart);
            deleted += result.purged;
            batches += 1;
            if (includeDetails) assert.equal(result.routes.length, result.purged);
            else assert.equal(Object.hasOwn(result, 'routes'), false);
            if (!result.hasMore) break;
            assert.ok(result.purged > 0, 'cleanup must make progress');
        }
        const milliseconds = performance.now() - start;
        assert.equal(deleted, query.stale);
        assert.equal(store.queryScopeSummary(query).stale, 0);
        assert.deepEqual(store.db.pragma('foreign_key_check'), []);
        return { milliseconds, deleted, batches, batchTimes };
    } finally {
        store.close();
    }
}

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function main() {
    if (!process.versions.electron) throw new Error('Run with ELECTRON_RUN_AS_NODE=1 electron --expose-gc');
    const routes = integerArgument('routes', 1000000);
    const rounds = integerArgument('rounds', 3);
    const requestedKind = argument('kind', 'both');
    const kinds = requestedKind === 'both' ? ['peer', 'loc-rib'] : [requestedKind];
    if (kinds.some(kind => !['peer', 'loc-rib'].includes(kind))) throw new Error('Invalid --kind');
    const sparse = process.argv.includes('--sparse');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-stale-purge-benchmark-'));
    const results = [];
    for (const kind of kinds) {
        const base = path.join(directory, `${kind}-seed.sqlite3`);
        const query = seed(base, kind, routes, sparse);
        const before = [];
        const after = [];
        for (let round = 0; round < rounds; round += 1) {
            // Alternate order to avoid systematically favoring a warm cache.
            for (const optimized of round % 2 ? [true, false] : [false, true]) {
                const dbPath = path.join(directory, `${kind}-${round}-${optimized ? 'bulk' : 'legacy'}.sqlite3`);
                fs.copyFileSync(base, dbPath);
                const result = measure(dbPath, query, !optimized);
                (optimized ? after : before).push(result);
                console.log(JSON.stringify({ kind, round, optimized, ...result }));
            }
        }
        const beforeMs = median(before.map(result => result.milliseconds));
        const afterMs = median(after.map(result => result.milliseconds));
        results.push({
            kind,
            routes,
            sparse,
            rounds,
            beforeMs,
            afterMs,
            reductionPercent: (1 - afterMs / beforeMs) * 100
        });
    }
    console.log(JSON.stringify({ directory, runtime: process.versions, results }, null, 2));
}

main();
