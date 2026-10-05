// Preload only for the existing synthetic stale-purge benchmark:
// ELECTRON_RUN_AS_NODE=1 electron --expose-gc --require ./scripts/benchmarks/bmp_stale_purge_full_gc.js \
//   scripts/benchmarks/bmp_stale_purge_benchmark.js --routes=1000000 --rounds=3
// The measured fixture produces at most ~20,002 distinct GC candidates per
// 20,000-route batch. A 50,000-candidate budget includes full reclamation, so
// deferring GC cannot make a route-deletion-only result look like a speedup.
const assert = require('node:assert/strict');
const path = require('node:path');
assert.equal(path.basename(process.argv[1] || ''), 'bmp_stale_purge_benchmark.js');
const Store = require('../../electron/worker/bmp/bmpPersistenceStore');
const originalPurge = Store.prototype.purgeStaleRoutes;

Store.prototype.purgeStaleRoutes = function purgeWithFullReclamation(query) {
    const result = originalPurge.call(this, { ...query, gcLimit: 50000 });
    if (!result.hasMore) {
        assert.equal(this.db.prepare('SELECT COUNT(*) AS count FROM bmp_gc_candidates').get().count, 0);
        for (const [table, key, reference] of [
            ['bmp_route_identities', 'route_pk', 'route_pk'],
            ['bmp_route_payloads', 'payload_id', 'payload_id'],
            ['bmp_route_attributes', 'attr_pk', 'attr_pk']
        ]) {
            const orphanCount = this.db
                .prepare(
                    `SELECT COUNT(*) AS count FROM ${table} AS objects
                WHERE NOT EXISTS (SELECT 1 FROM bmp_current_route_refs AS refs
                                  WHERE refs.${reference} = objects.${key})`
                )
                .get().count;
            assert.equal(orphanCount, 0, `${table}: timed purge must reclaim every unreferenced object`);
        }
    }
    return result;
};
