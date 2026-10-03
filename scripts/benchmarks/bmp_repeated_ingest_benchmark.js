// Run with Electron's Node ABI:
// ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/bmp_repeated_ingest_benchmark.js \
//   --routes=1000000 --rounds=3 --label=baseline --output=/tmp/bmp-baseline.json
// Uses fresh, retained temporary databases; never opens application databases.
// Times real TCP -> parser Worker -> persistence Worker -> committed marker.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

if (!process.versions.electron) {
    throw new Error('Run this benchmark with ELECTRON_RUN_AS_NODE=1 and node_modules/.bin/electron');
}

const BmpConst = require('../../electron/const/bmpConst');
const ProtocolProcessHost = require('../../electron/worker/core/protocolProcessHost');
const { builders } = require(process.env.NETNEXUS_BMP_BENCH_FIXTURE_MODULE || '../mockBmpClient');
const project = path.resolve(__dirname, '../..');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const argument = (name, fallback) =>
    process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const routeCount = Number(argument('routes', '1000000'));
const rounds = Number(argument('rounds', '3'));
const packetRoutes = Number(argument('packetRoutes', '50'));
const attributeGroups = Number(argument('attributeGroups', '100'));
const label = argument('label', 'measurement');
const outputPath = argument('output', null);
const kinds = argument('kind', 'both') === 'both' ? ['peer', 'loc-rib'] : [argument('kind', 'both')];
assert.ok(Number.isInteger(routeCount) && routeCount > 0 && routeCount <= 10000000);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 20);
assert.ok(Number.isInteger(packetRoutes) && packetRoutes > 0 && packetRoutes <= 500);
assert.ok(Number.isInteger(attributeGroups) && attributeGroups > 0 && attributeGroups <= 200);
assert.ok(kinds.every(kind => ['peer', 'loc-rib'].includes(kind)));
assert.match(label, /^[a-zA-Z0-9_-]+$/);
if (outputPath) assert.equal(fs.existsSync(outputPath), false, 'refuse to overwrite existing measurement');

const settings = {
    threadCount: 1,
    persistenceBatchSize: 5000,
    persistenceFlushMs: 20,
    persistenceReadFenceTimeoutMs: 30000,
    persistenceSweepIntervalMs: 3600000,
    logLevel: 'off'
};
const directory = fs.mkdtempSync(path.join(os.tmpdir(), `netnexus-bmp-repeat-${label}-`));
const peer = { peerAddress: '192.0.2.2', peerAs: 65000, routerId: '192.0.2.1', timestamp: 1700000000 };
const locRib = {
    flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED,
    peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
    timestamp: 1700000000
};

function prefixAt(index) {
    return `${10 + Math.floor(index / 65536)}.${(index >>> 8) & 255}.${index & 255}.0`;
}

function attributesAt(index) {
    const group = Math.floor(index / packetRoutes) % attributeGroups;
    return {
        nextHop: `192.0.2.${group + 1}`,
        asns: [65000, 65100, 65200 + group],
        localPref: 100 + group,
        communities: [`65000:${group}`]
    };
}

function routeMessage(kind, update) {
    return builders.routeMonitoringMessage(
        kind === 'peer' ? peer : locRib,
        update,
        kind === 'peer' ? {} : { vrfName: 'global' }
    );
}

function fixture(kind) {
    const packets = [];
    for (let start = 0; start < routeCount; start += packetRoutes) {
        const prefixes = [];
        for (let index = start; index < Math.min(start + packetRoutes, routeCount); index += 1) {
            prefixes.push(prefixAt(index));
        }
        packets.push(routeMessage(kind, builders.ipv4Update(prefixes, attributesAt(start))));
    }
    return Buffer.concat(packets);
}

function requester(host) {
    const pending = new Map();
    let sequence = 0;
    host.on('message', message => {
        const request = pending.get(message.messageId);
        if (!request) return;
        pending.delete(message.messageId);
        clearTimeout(request.timer);
        if (message.status === 'success') request.resolve(message.data);
        else request.reject(new Error(message.msg || 'BMP request failed'));
    });
    host.on('exit', (code, signal) => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(`BMP process exited ${code}/${signal}`));
        }
        pending.clear();
    });
    return (op, data) =>
        new Promise((resolve, reject) => {
            const messageId = `repeat-${++sequence}`;
            const timer = setTimeout(() => {
                pending.delete(messageId);
                reject(new Error(`request timed out: ${op}`));
            }, 120000);
            pending.set(messageId, { resolve, reject, timer });
            host.postMessage({ messageId, op, data });
        });
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitFor(read, predicate, description) {
    const deadline = performance.now() + 20 * 60 * 1000;
    for (;;) {
        const result = await read();
        if (predicate(result)) return result;
        if (performance.now() > deadline) throw new Error(`${description} timed out`);
        await sleep(25);
    }
}

const write = (socket, bytes) =>
    new Promise((resolve, reject) => socket.write(bytes, error => (error ? reject(error) : resolve())));

async function runKind(kind, round, bytes) {
    const database = path.join(directory, `${kind}-${round}`, 'bmp.sqlite3');
    fs.mkdirSync(path.dirname(database));
    assert.equal(fs.existsSync(database), false);
    const port = await freePort();
    const host = new ProtocolProcessHost(path.join(project, 'electron/worker/bmp/bmpWorker.js'), {
        serviceName: 'netnexus.protocol.bmp',
        utilityProcess: null
    });
    const request = requester(host);
    let socket;
    let started = false;
    try {
        await request(BmpConst.BMP_REQ_TYPES.START_BMP, { ...settings, port, persistenceDbPath: database });
        started = true;
        socket = net.createConnection({ host: '127.0.0.1', port });
        socket.on('error', () => {});
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        socket.setNoDelay(true);
        const name = `repeated-benchmark-${kind}`;
        await write(
            socket,
            Buffer.concat([
                builders.initiationMessage({ sysName: name }),
                builders.bmpMessage(
                    BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
                    kind === 'peer' ? builders.peerUpPayload(peer) : builders.locRibPeerUpPayload()
                )
            ])
        );
        const clients = await waitFor(
            () => request(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST),
            rows => rows.some(row => row.sysName === name && row.isOnline),
            'client initiation'
        );
        const sourceId = clients.find(row => row.sysName === name).persistentSourceId;
        const query = { sourceId, scopeKind: kind, routeState: 'all', pageSize: 1 };
        const rows = [];
        let previousSample;
        for (const [phaseIndex, phase] of ['first', 'repeat'].entries()) {
            const markerPrefix = `203.0.${phaseIndex + 1}.0`;
            const markerKey = `0|0:0|${markerPrefix}|24`;
            // Different, never-before-sent markers prevent an old row passing the barrier.
            const frame = Buffer.concat([
                bytes,
                routeMessage(kind, builders.endOfRibUpdate()),
                routeMessage(kind, builders.ipv4Update([markerPrefix]))
            ]);
            const before = performance.now();
            await write(socket, frame);
            await waitFor(
                () => request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, { ...query, legacyRouteKey: markerKey }),
                result => result.total === 1,
                'committed final marker'
            );
            const milliseconds = performance.now() - before;
            // Validation is deliberately outside the timed interval.
            const actual = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, query);
            assert.equal(actual.total, routeCount + phaseIndex + 1, 'exact persisted scope row count');
            for (const index of [0, Math.floor(routeCount / 2), routeCount - 1]) {
                const sample = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, {
                    ...query,
                    legacyRouteKey: `0|0:0|${prefixAt(index)}|24`
                });
                assert.equal(sample.total, 1);
                assert.equal(sample.list[0].nextHop, attributesAt(index).nextHop);
                assert.equal(sample.list[0].localPref, attributesAt(index).localPref);
                assert.equal(sample.list[0].routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);
                if (index === 0) {
                    if (previousSample) {
                        assert.equal(sample.list[0].firstSeenAt, previousSample.firstSeenAt);
                        assert.ok(Date.parse(sample.list[0].lastSeenAt) > Date.parse(previousSample.lastSeenAt));
                    }
                    previousSample = sample.list[0];
                }
            }
            const status = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTENCE_STATUS);
            assert.equal(status.watermark.bufferedBytes, 0, 'no pending database bytes');
            const result = {
                label,
                round,
                kind,
                phase,
                routes: routeCount,
                milliseconds: +milliseconds.toFixed(3),
                routesPerSecond: Math.round((routeCount * 1000) / milliseconds),
                persistedTotal: actual.total,
                fixtureBytes: bytes.length,
                sampleLastSeenAt: previousSample.lastSeenAt
            };
            rows.push(result);
            console.log(JSON.stringify(result));
        }
        await request(BmpConst.BMP_REQ_TYPES.STOP_BMP);
        started = false;
        return rows;
    } finally {
        socket?.destroy();
        if (started) await request(BmpConst.BMP_REQ_TYPES.STOP_BMP).catch(() => {});
        await host.terminate();
    }
}

async function main() {
    const fingerprints = {};
    for (const relative of [
        'electron/worker/bmp/bmpSession.js',
        'electron/worker/bmp/bmpBgpRoute.js',
        'electron/worker/bmp/bmpPersistenceMutation.js',
        'electron/worker/bmp/bmpPersistenceStore.js',
        'scripts/benchmarks/bmp_repeated_ingest_benchmark.js'
    ])
        fingerprints[relative] = crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(project, relative)))
            .digest('hex');
    const fixtures = new Map(kinds.map(kind => [kind, fixture(kind)]));
    const report = {
        label,
        routeCount,
        rounds,
        packetRoutes,
        attributeGroups,
        settings,
        analysisEnabled: false,
        startedAt: new Date().toISOString(),
        directory,
        method: 'loopback TCP until distinct final marker committed; one independent fresh database/process per kind/round',
        system: {
            platform: process.platform,
            arch: process.arch,
            cpu: os.cpus()[0]?.model,
            versions: process.versions
        },
        fingerprints,
        fixtures: Object.fromEntries(
            [...fixtures].map(([kind, bytes]) => [
                kind,
                { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
            ])
        ),
        results: []
    };
    for (let round = 0; round < rounds; round += 1) {
        // Alternate the order across rounds, identically for baseline/optimized.
        for (const kind of round % 2 ? [...kinds].reverse() : kinds) {
            report.results.push(...(await runKind(kind, round, fixtures.get(kind))));
        }
    }
    report.summary = [];
    for (const kind of kinds) {
        for (const phase of ['first', 'repeat']) {
            const values = report.results
                .filter(row => row.kind === kind && row.phase === phase)
                .map(row => row.milliseconds)
                .sort((a, b) => a - b);
            const middle = Math.floor(values.length / 2);
            const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
            report.summary.push({
                kind,
                phase,
                medianMs: median,
                routesPerSecond: Math.round((routeCount * 1000) / median),
                minMs: values[0],
                maxMs: values[values.length - 1]
            });
        }
    }
    report.finishedAt = new Date().toISOString();
    const destination = outputPath || path.join(directory, 'results.json');
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(
        JSON.stringify({ label, summary: report.summary, resultPath: destination, databaseDirectory: directory })
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
