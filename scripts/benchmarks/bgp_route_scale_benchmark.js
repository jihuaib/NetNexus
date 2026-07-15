const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.versions.electron) {
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    if (result.error) throw result.error;
    process.exit(result.status || 0);
}

const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpRoute = require('../../electron/worker/bgp/bgpRoute');

const DEFAULT_ROUTE_COUNT = 1_000_000;
const DEFAULT_PAGE_SIZE = 25;
const BATCH_SIZE = 5000;
const INSTANCE_KEY = '0|1|1';

function getArgValue(name, defaultValue) {
    const prefix = `--${name}=`;
    const arg = process.argv.find(item => item.startsWith(prefix));
    if (!arg) return defaultValue;
    const value = Number(arg.slice(prefix.length));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(2)} ${units[unit]}`;
}

function memory(label) {
    const usage = process.memoryUsage();
    console.log(`${label}: rss=${formatBytes(usage.rss)}, heapUsed=${formatBytes(usage.heapUsed)}`);
    return usage;
}

function timed(label, fn) {
    const started = process.hrtime.bigint();
    const result = fn();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${label}: ${elapsedMs.toFixed(2)} ms`);
    return result;
}

function ipFromIndex(index) {
    const value = (10 * 2 ** 24 + index) >>> 0;
    return `${value >>> 24}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function makeEntry(index) {
    const ip = ipFromIndex(index);
    return {
        routeKey: BgpRoute.makeUnicastKey(0, '0:0', ip, 32),
        route: { ip, mask: 32, rd: '0:0', pathId: 0 },
        attr: {
            nextHop: '192.0.2.1',
            origin: 'IGP',
            asPath: '65000 65001',
            med: 0,
            localPref: 100
        }
    };
}

function assertPage(store, page, pageSize, routeCount) {
    const result = store.queryPage(INSTANCE_KEY, { page, pageSize });
    const expected = Math.max(0, Math.min(pageSize, routeCount - (page - 1) * pageSize));
    if (result.total !== routeCount || result.list.length !== expected) {
        throw new Error(`unexpected page ${page}: total=${result.total}, rows=${result.list.length}`);
    }
}

function main() {
    const routeCount = getArgValue('routes', DEFAULT_ROUTE_COUNT);
    const pageSize = getArgValue('pageSize', DEFAULT_PAGE_SIZE);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-sqlite-benchmark-'));
    const dbPath = path.join(tempDir, 'bgp-routes.sqlite3');
    const store = new BgpRouteSqliteStore({ dbPath }).open();

    console.log(`BGP SQLite scale benchmark: routes=${routeCount}, batch=${BATCH_SIZE}, db=${dbPath}`);
    const before = memory('before');
    timed('batched SQLite upsert', () => {
        for (let start = 0; start < routeCount; start += BATCH_SIZE) {
            const end = Math.min(routeCount, start + BATCH_SIZE);
            const entries = [];
            for (let index = start; index < end; index++) entries.push(makeEntry(index));
            store.upsertRoutes(INSTANCE_KEY, entries);
        }
    });
    const after = memory('after insert');

    if (store.getRouteCount(INSTANCE_KEY) !== routeCount) {
        throw new Error(`route count mismatch: ${store.getRouteCount(INSTANCE_KEY)}`);
    }
    const lastPage = Math.ceil(routeCount / pageSize);
    timed('first page', () => assertPage(store, 1, pageSize, routeCount));
    timed('middle page', () => assertPage(store, Math.max(1, Math.floor(lastPage / 2)), pageSize, routeCount));
    timed('last page', () => assertPage(store, lastPage, pageSize, routeCount));
    timed('route detail', () => {
        const route = makeEntry(Math.floor(routeCount / 2));
        if (!store.queryDetail(INSTANCE_KEY, route.routeKey)) throw new Error('detail route missing');
    });

    const status = store.getStatus();
    store.close();
    timed('read-only reopen and count', () => {
        const reader = new BgpRouteSqliteStore({ dbPath, readOnly: true }).open();
        if (reader.getRouteCount(INSTANCE_KEY) !== routeCount) throw new Error('restart count mismatch');
        reader.close();
    });

    console.log(
        `database=${formatBytes(status.totalSize)}, rssDelta=${formatBytes(Math.max(0, after.rss - before.rss))}, ` +
            `heapDelta=${formatBytes(Math.max(0, after.heapUsed - before.heapUsed))}`
    );
    if (!process.argv.includes('--keep')) fs.rmSync(tempDir, { recursive: true, force: true });
}

main();
