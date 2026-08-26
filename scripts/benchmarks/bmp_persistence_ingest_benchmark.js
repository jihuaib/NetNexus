// Reproduces "many BMP neighbours x many routes each" ingest through the real
// BmpPersistenceClient worker while a UI-like poller issues route queries.
//
// better-sqlite3 is built for Electron's ABI. Run with:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/bmp_persistence_ingest_benchmark.js \
//       --neighbors=20 --routes=20000 --pollMs=500
//
// Options:
//   --neighbors=N      BGP peers under one BMP client (default 20)
//   --routes=N         routes per peer (default 20000)
//   --pollMs=N         UI poll interval while ingesting (default 500)
//   --fenceTimeoutMs=N bound on the read fence, mirrors bmpWorker.readPersistence (default 250; 0 = unbounded)
//   --batchSize=N      client batch size (default: client default 2000)
//   --flushMs=N        client flush delay (default: client default 20)
//   --deltas           request committed deltas (Route Assurance enabled path)
//   --storeOnly        skip the worker; apply batches directly on the store
//   --keepDb           keep the SQLite file

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.versions.electron) {
    console.error(
        "This benchmark must use Electron's Node ABI. Run:\n" +
            'ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/bmp_persistence_ingest_benchmark.js'
    );
    process.exit(1);
}

const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const AFI = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
const SAFI = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;

function getArgValue(name, defaultValue) {
    const prefix = `--${name}=`;
    const arg = process.argv.find(item => item.startsWith(prefix));
    if (!arg) return defaultValue;
    const value = Number(arg.slice(prefix.length));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

function hasArg(name) {
    return process.argv.includes(`--${name}`);
}

function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
    return sorted[index];
}

function stats(values) {
    if (values.length === 0) return 'n=0';
    const sum = values.reduce((a, b) => a + b, 0);
    return (
        `n=${values.length} avg=${(sum / values.length).toFixed(1)}ms ` +
        `p50=${percentile(values, 0.5).toFixed(1)}ms p95=${percentile(values, 0.95).toFixed(1)}ms ` +
        `max=${Math.max(...values).toFixed(1)}ms`
    );
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(1)} ${units[index]}`;
}

function ipFromIndex(neighbor, index) {
    return `10.${neighbor & 0xff}.${(index >>> 8) & 0xff}.${index & 0xff}`;
}

function makeBmpSession() {
    return {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '192.0.2.254',
        remotePort: 50000,
        sysName: 'bmp-ingest-benchmark',
        sysDesc: 'multi-neighbour ingest benchmark',
        bmpVersion: 4,
        getBmpV4TlvDraft: () => 20
    };
}

function makeNeighbor(bmpSession, neighborIndex) {
    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, {
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: `192.0.2.${neighborIndex + 1}`,
        sessionAs: 65000 + neighborIndex,
        vrfTableNames: ['benchmark']
    });
    owner.ribTypes.push(RIB_TYPE);
    owner.enabledAddressFamilies.push({ afi: AFI, safi: SAFI });
    owner.ensureRouteScope(AFI, SAFI, RIB_TYPE);
    return owner;
}

function makeRoute(neighborIndex, index) {
    const route = new BmpBgpRoute(null, null);
    route.pathId = 0;
    route.rd = '0:0';
    route.ip = ipFromIndex(neighborIndex, index);
    route.mask = 32;
    route.afi = AFI;
    route.safi = SAFI;
    route.ribType = RIB_TYPE;
    route.nlriDetail = { prefix: route.ip, length: route.mask, pathId: 0, rd: '0:0' };
    route.assignRouteAttr({
        origin: 'IGP',
        asPath: `${65000 + neighborIndex} 65100 ${65200 + (index % 50)}`,
        nextHop: `192.0.2.${neighborIndex + 1}`,
        med: index % 100,
        localPref: 100,
        communities: `65000:${index % 20}`
    });
    route.markActive(0);
    return route;
}

// Same semantics as bmpWorker.fencePersistenceRead: wait for queued writes,
// but never longer than the timeout.
function boundedFence(client, timeoutMs) {
    const fence = client.fence();
    if (!(timeoutMs > 0)) {
        return fence;
    }
    let timer = null;
    return Promise.race([
        fence,
        new Promise(resolve => {
            timer = setTimeout(resolve, timeoutMs);
        })
    ]).finally(() => {
        clearTimeout(timer);
        fence.catch(() => {});
    });
}

function makeBatch(batchId, mutations) {
    return { batchId, createdAtMs: Date.now(), mutations };
}

async function main() {
    const neighbors = getArgValue('neighbors', 20);
    const routesPerNeighbor = getArgValue('routes', 20000);
    const pollMs = getArgValue('pollMs', 500);
    const fenceTimeoutMs = hasArg('fenceTimeoutMs=0') ? 0 : getArgValue('fenceTimeoutMs', 250);
    const includeDeltas = hasArg('deltas');
    const storeOnly = hasArg('storeOnly');
    const keepDb = hasArg('keepDb');
    const totalRoutes = neighbors * routesPerNeighbor;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-ingest-'));
    const dbPath = path.join(tempDir, 'bmp-ingest.sqlite3');
    const bmpSession = makeBmpSession();
    const owners = Array.from({ length: neighbors }, (_, index) => makeNeighbor(bmpSession, index));

    console.log('BMP persistence ingest benchmark');
    console.log(
        `neighbors=${neighbors} routes/neighbor=${routesPerNeighbor} total=${totalRoutes} pollMs=${pollMs} ` +
            `fenceTimeoutMs=${fenceTimeoutMs} ` +
            `deltas=${includeDeltas} storeOnly=${storeOnly}`
    );

    // ---- Phase 0: measure mutation building cost (runs on the bmpWorker thread in production).
    let buildMs = 0;
    const setupMutations = [buildConnectionMutation(bmpSession, 'connection_open')];
    const scopeIds = [];
    owners.forEach(owner => {
        const scopeOpen = buildScopeMutation(bmpSession, owner, AFI, SAFI, RIB_TYPE, 'scope_open', {
            kind: 'peer',
            state: 'ready'
        });
        scopeIds.push(scopeOpen.scope.id);
        setupMutations.push(scopeOpen);
    });

    const buildRouteMutation = (neighborIndex, index) => {
        const started = nowMs();
        const mutation = buildRouteUpsertMutation(
            bmpSession,
            owners[neighborIndex],
            makeRoute(neighborIndex, index),
            AFI,
            SAFI,
            RIB_TYPE,
            { kind: 'peer', state: 'ready', scopeState: 'ready' }
        );
        buildMs += nowMs() - started;
        return mutation;
    };

    // Interleave neighbours the way a real full-table dump arrives: every peer
    // is sending at once, so consecutive mutations alternate between scopes.
    function* mutationGenerator() {
        for (let index = 0; index < routesPerNeighbor; index += 1) {
            for (let neighbor = 0; neighbor < neighbors; neighbor += 1) {
                yield buildRouteMutation(neighbor, index);
            }
        }
    }

    const result = {
        totalRoutes,
        wallMs: 0,
        buildMs: 0,
        fencedQuery: [],
        unfencedQuery: [],
        pauses: 0,
        pausedMs: 0,
        maxQueueLength: 0
    };

    try {
        if (storeOnly) {
            const store = new BmpPersistenceStore({ dbPath }).open();
            store.applyBatch(makeBatch('setup', setupMutations));
            const batchSize = getArgValue('batchSize', 2000);
            const batchMs = [];
            let batchNumber = 0;
            let mutations = [];
            const started = nowMs();
            for (const mutation of mutationGenerator()) {
                mutations.push(mutation);
                if (mutations.length >= batchSize) {
                    batchNumber += 1;
                    const t = nowMs();
                    store.applyBatch({ ...makeBatch(`b-${batchNumber}`, mutations), includeDeltas });
                    batchMs.push(nowMs() - t);
                    mutations = [];
                }
            }
            if (mutations.length > 0) {
                batchNumber += 1;
                const t = nowMs();
                store.applyBatch({ ...makeBatch(`b-${batchNumber}`, mutations), includeDeltas });
                batchMs.push(nowMs() - t);
            }
            result.wallMs = nowMs() - started;
            result.buildMs = buildMs;
            const status = store.getStatus({ includeCounts: true });
            console.log(`applyBatch latency: ${stats(batchMs)} (batchSize=${batchSize})`);
            console.log(`SQLite: currentRoutes=${status.currentRoutes} size=${formatBytes(status.totalSize)}`);
            store.close();
        } else {
            let pausedAt = null;
            const client = new BmpPersistenceClient({
                dbPath,
                batchSize: getArgValue('batchSize', undefined),
                flushMs: getArgValue('flushMs', undefined),
                includeCommittedDeltas: includeDeltas,
                onPause: () => {
                    result.pauses += 1;
                    pausedAt = nowMs();
                },
                onResume: () => {
                    if (pausedAt !== null) {
                        result.pausedMs += nowMs() - pausedAt;
                        pausedAt = null;
                    }
                },
                onError: error => {
                    console.error(`persistence error: ${error.message}`);
                }
            });
            await client.open();
            setupMutations.forEach(mutation => client.enqueue(mutation));
            await client.drain();

            // UI-like poller: mimics bmpWorker.readPersistence (fence first, then query)
            // and the same query without the fence, alternating.
            let polling = true;
            const query = { scopeId: scopeIds[0], page: 1, pageSize: 20, routeState: 'all' };
            const poller = (async () => {
                let fenced = true;
                while (polling) {
                    const t = nowMs();
                    try {
                        if (fenced) {
                            await boundedFence(client, fenceTimeoutMs);
                        }
                        await client.queryRoutes(query);
                        (fenced ? result.fencedQuery : result.unfencedQuery).push(nowMs() - t);
                    } catch (error) {
                        console.error(`query failed: ${error.message}`);
                    }
                    fenced = !fenced;
                    await new Promise(resolve => setTimeout(resolve, pollMs));
                }
            })();

            // Producer: emulates the socket handler enqueuing as fast as data arrives,
            // yielding to the event loop between chunks and honouring backpressure
            // the same way bmpWorker pauses sockets at the high watermark.
            const started = nowMs();
            const generator = mutationGenerator();
            let done = false;
            while (!done) {
                if (client.paused) {
                    await new Promise(resolve => setTimeout(resolve, 5));
                    continue;
                }
                for (let i = 0; i < 500; i += 1) {
                    const next = generator.next();
                    if (next.done) {
                        done = true;
                        break;
                    }
                    client.enqueue(next.value);
                }
                result.maxQueueLength = Math.max(result.maxQueueLength, client.getQueueLength());
                await new Promise(resolve => setImmediate(resolve));
            }
            const enqueueDoneMs = nowMs() - started;
            await client.drain();
            result.wallMs = nowMs() - started;
            result.buildMs = buildMs;
            polling = false;
            await poller;

            const status = await client.getStatus({ includeCounts: true });
            console.log(`enqueue finished at ${enqueueDoneMs.toFixed(0)}ms; drained at ${result.wallMs.toFixed(0)}ms`);
            console.log(`SQLite: currentRoutes=${status.currentRoutes} size=${formatBytes(status.totalSize)}`);
            await client.close();
        }
    } finally {
        if (keepDb) {
            console.log(`kept benchmark database: ${dbPath}`);
        } else {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    console.log('---- results ----');
    console.log(
        `ingest: ${totalRoutes} routes in ${(result.wallMs / 1000).toFixed(1)}s => ` +
            `${Math.round(totalRoutes / (result.wallMs / 1000)).toLocaleString()} routes/s`
    );
    console.log(
        `mutation build cost (producer thread): ${(result.buildMs / 1000).toFixed(1)}s ` +
            `(${((result.buildMs / totalRoutes) * 1000).toFixed(1)} us/route)`
    );
    if (!storeOnly) {
        console.log(
            `backpressure: pauses=${result.pauses} pausedTotal=${(result.pausedMs / 1000).toFixed(1)}s maxQueue=${result.maxQueueLength}`
        );
        console.log(`UI query (fenced, timeout=${fenceTimeoutMs}ms): ${stats(result.fencedQuery)}`);
        console.log(`UI query (unfenced):             ${stats(result.unfencedQuery)}`);
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
