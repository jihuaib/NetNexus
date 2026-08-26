// better-sqlite3 is built for Electron's ABI. Run this benchmark with:
// ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --expose-gc scripts/benchmarks/bmp_route_scale_benchmark.js --routes=100000

const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN_COMMAND =
    'ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --expose-gc scripts/benchmarks/bmp_route_scale_benchmark.js';

if (!process.versions.electron) {
    console.error(`This benchmark must use Electron's Node ABI. Run:\n${RUN_COMMAND} --routes=100000`);
    process.exit(1);
}

const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const DEFAULT_ROUTE_COUNT = 1_000_000;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MUTATION_BATCH_SIZE = 2000;
const AFI = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
const SAFI = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;

function getArgValue(name, defaultValue) {
    const prefix = `--${name}=`;
    const arg = process.argv.find(item => item.startsWith(prefix));
    if (!arg) {
        return defaultValue;
    }
    const value = Number(arg.slice(prefix.length));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

function hasArg(name) {
    return process.argv.includes(`--${name}`);
}

function formatMs(ms) {
    return `${ms.toFixed(2)} ms`;
}

function formatRate(total, ms) {
    return `${Math.round(total / Math.max(ms / 1000, 0.001)).toLocaleString()} routes/s`;
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(2)} ${units[index]}`;
}

function getMemoryUsage(collect = true) {
    if (collect && typeof global.gc === 'function') {
        global.gc();
    }
    const usage = process.memoryUsage();
    return {
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external
    };
}

function printMemory(label, usage = getMemoryUsage()) {
    console.log(
        `${label}: rss=${formatBytes(usage.rss)}, heapUsed=${formatBytes(usage.heapUsed)}, heapTotal=${formatBytes(
            usage.heapTotal
        )}, external=${formatBytes(usage.external)}`
    );
    return usage;
}

function timeStep(label, fn) {
    const start = process.hrtime.bigint();
    const result = fn();
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    console.log(`${label}: ${formatMs(ms)}`);
    return { result, ms };
}

function ipFromIndex(index) {
    const second = (index >>> 16) & 0xff;
    const third = (index >>> 8) & 0xff;
    const fourth = index & 0xff;
    return `10.${second}.${third}.${fourth}`;
}

function makeContext() {
    const bmpSession = {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '192.0.2.254',
        remotePort: 50000,
        sysName: 'bmp-scale-benchmark',
        sysDesc: 'SQLite-only BMP RIB benchmark',
        bmpVersion: 4,
        getBmpV4TlvDraft: () => 20
    };
    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, {
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: '192.0.2.1',
        sessionAs: 65000,
        vrfTableNames: ['benchmark']
    });
    owner.ribTypes.push(RIB_TYPE);
    owner.enabledAddressFamilies.push({ afi: AFI, safi: SAFI });
    owner.ensureRouteScope(AFI, SAFI, RIB_TYPE);
    return { bmpSession, owner };
}

function makeRoute(index, options = {}) {
    const samePrefix = options.samePrefix === true;
    const sameAttr = options.sameAttr === true;

    // This object is deliberately transient. It is serialized into the current
    // bounded mutation batch and is never inserted into an in-memory route Map.
    const route = new BmpBgpRoute(null, null);
    route.pathId = samePrefix ? index : 0;
    route.rd = '0:0';
    route.ip = samePrefix ? '10.0.0.0' : ipFromIndex(index);
    route.mask = samePrefix ? 24 : 32;
    route.afi = AFI;
    route.safi = SAFI;
    route.ribType = RIB_TYPE;
    route.nlriDetail = {
        prefix: route.ip,
        length: route.mask,
        pathId: route.pathId,
        rd: route.rd
    };
    route.assignRouteAttr({
        origin: 'IGP',
        asPath: '65000 65001',
        nextHop: '192.0.2.1',
        med: sameAttr ? 0 : index % 100,
        localPref: 100,
        communities: sameAttr ? '65000:1 65000:2' : null,
        otc: sameAttr ? 65000 : null
    });
    route.markActive(0);
    return route;
}

function makeBatch(batchId, mutations) {
    return {
        batchId,
        createdAtMs: Date.now(),
        mutations
    };
}

function getExpectedPageLength(total, page, pageSize) {
    return Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize));
}

function writeRouteBatches(store, bmpSession, owner, routeCount, options = {}) {
    let applied = 0;
    let batchNumber = 0;
    let mutations = [];
    let peakRss = 0;
    let peakHeapUsed = 0;

    const commit = () => {
        if (mutations.length === 0) {
            return;
        }
        batchNumber += 1;
        const result = store.applyBatch(makeBatch(`routes-${batchNumber}`, mutations));
        if (result.duplicate || result.applied !== mutations.length || result.deltas.length !== mutations.length) {
            throw new Error(
                `unexpected batch result: batch=${batchNumber}, applied=${result.applied}, deltas=${result.deltas.length}`
            );
        }
        applied += result.applied;

        // Drop every reference to the committed mutations and their transient
        // route payloads before the next batch is generated.
        mutations = [];
        const usage = getMemoryUsage(false);
        peakRss = Math.max(peakRss, usage.rss);
        peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
    };

    for (let index = 0; index < routeCount; index += 1) {
        const route = makeRoute(index, options);
        mutations.push(
            buildRouteUpsertMutation(bmpSession, owner, route, AFI, SAFI, RIB_TYPE, {
                kind: 'peer',
                state: 'ready',
                scopeState: 'ready'
            })
        );
        if (mutations.length >= MUTATION_BATCH_SIZE) {
            commit();
        }
    }
    commit();

    return { applied, batchNumber, peakRss, peakHeapUsed };
}

function runBenchmark() {
    const routeCount = getArgValue('routes', DEFAULT_ROUTE_COUNT);
    const page = getArgValue('page', DEFAULT_PAGE);
    const pageSize = getArgValue('pageSize', DEFAULT_PAGE_SIZE);
    const samePrefix = hasArg('samePrefix');
    const sameAttr = hasArg('sameAttr');
    const keepDb = hasArg('keepDb');
    const exactPrefix = samePrefix ? '10.0.0.0/24' : ipFromIndex(Math.floor(routeCount / 2));
    const missingPrefix = '203.0.113.255';
    const exactExpectedTotal = samePrefix ? routeCount : 1;
    const detailPathId = samePrefix ? Math.floor(routeCount / 2) : 0;
    const detailIp = samePrefix ? '10.0.0.0' : exactPrefix;
    const detailMask = samePrefix ? 24 : 32;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-scale-'));
    const dbPath = path.join(tempDir, 'bmp-rib.sqlite3');
    const { bmpSession, owner } = makeContext();
    let store = null;

    console.log('BMP SQLite-only RIB scale benchmark');
    console.log(`Run command: ${RUN_COMMAND} --routes=${routeCount}`);
    console.log(
        `routes=${routeCount}, page=${page}, pageSize=${pageSize}, samePrefix=${samePrefix}, sameAttr=${sameAttr}, keepDb=${keepDb}`
    );
    console.log(`bounded JS mutation batch=${MUTATION_BATCH_SIZE}; resident per-route Map/index=none`);
    const before = printMemory('before');

    try {
        store = new BmpPersistenceStore({ dbPath }).open();
        const connectionOpen = buildConnectionMutation(bmpSession, 'connection_open');
        const scopeOpen = buildScopeMutation(bmpSession, owner, AFI, SAFI, RIB_TYPE, 'scope_open', {
            kind: 'peer',
            state: 'ready'
        });
        const scopeId = scopeOpen.scope.id;
        const setup = store.applyBatch(makeBatch('setup', [connectionOpen, scopeOpen]));
        if (setup.duplicate || setup.applied !== 2) {
            throw new Error(`unexpected setup result: ${JSON.stringify(setup)}`);
        }

        const write = timeStep('build + commit route mutations', () =>
            writeRouteBatches(store, bmpSession, owner, routeCount, { samePrefix, sameAttr })
        );
        if (write.result.applied !== routeCount) {
            throw new Error(`expected ${routeCount} committed routes, got ${write.result.applied}`);
        }
        console.log(
            `write throughput: ${formatRate(routeCount, write.ms)}, batches=${write.result.batchNumber}, sampledPeakRss=${formatBytes(
                write.result.peakRss
            )}, sampledPeakHeap=${formatBytes(write.result.peakHeapUsed)}`
        );

        const afterWrite = printMemory('after commit + GC');
        console.log(
            `retained memory delta: rss=${formatBytes(afterWrite.rss - before.rss)}, heapUsed=${formatBytes(
                afterWrite.heapUsed - before.heapUsed
            )}; in-memory route scopes=${owner.routeScopes.size}`
        );

        const summary = timeStep('SQLite scope summary', () => store.queryScopeSummary({ scopeId })).result;
        if (summary.total !== routeCount || summary.active !== routeCount || summary.stale !== 0) {
            throw new Error(`unexpected scope summary: ${JSON.stringify(summary)}`);
        }

        const pageResult = timeStep('SQLite ordinary route page', () =>
            store.queryRoutes({
                scopeId,
                page,
                pageSize,
                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
            })
        ).result;
        const expectedPageLength = getExpectedPageLength(routeCount, page, pageSize);
        if (pageResult.total !== routeCount || pageResult.list.length !== expectedPageLength) {
            throw new Error(`unexpected page result: total=${pageResult.total}, list=${pageResult.list.length}`);
        }

        const prefixResult = timeStep('SQLite exact prefix page', () =>
            store.queryRoutes({
                scopeId,
                page,
                pageSize,
                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                prefixFilter: exactPrefix
            })
        ).result;
        const expectedPrefixPageLength = getExpectedPageLength(exactExpectedTotal, page, pageSize);
        if (prefixResult.total !== exactExpectedTotal || prefixResult.list.length !== expectedPrefixPageLength) {
            throw new Error(
                `unexpected exact prefix result: total=${prefixResult.total}, list=${prefixResult.list.length}`
            );
        }

        const missingResult = timeStep('SQLite missing prefix page', () =>
            store.queryRoutes({
                scopeId,
                page: 1,
                pageSize,
                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                prefixFilter: missingPrefix
            })
        ).result;
        if (missingResult.total !== 0 || missingResult.list.length !== 0) {
            throw new Error(`unexpected missing prefix result: ${JSON.stringify(missingResult)}`);
        }

        const detailRouteKey = BmpBgpRoute.makeKey(detailPathId, '0:0', detailIp, detailMask);
        const detailResult = timeStep('SQLite route detail by legacy key', () =>
            store.queryRoutes({
                scopeId,
                legacyRouteKey: detailRouteKey,
                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                pageSize: 1
            })
        ).result;
        if (detailResult.total !== 1 || detailResult.list[0]?.routeKey !== detailRouteKey) {
            throw new Error(`unexpected detail result for ${detailRouteKey}`);
        }

        const status = store.getStatus({ includeCounts: true });
        if (status.currentRoutes !== routeCount) {
            throw new Error(`expected ${routeCount} SQLite routes, got ${status.currentRoutes}`);
        }
        console.log(`SQLite: currentRoutes=${status.currentRoutes}, size=${formatBytes(status.totalSize)}`);
        printMemory('after queries');
    } finally {
        store?.close();
        if (keepDb) {
            console.log(`kept benchmark database: ${dbPath}`);
        } else {
            fs.rmSync(tempDir, { recursive: true, force: true });
            console.log('temporary benchmark database removed');
        }
    }
}

try {
    runBenchmark();
} catch (error) {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}
