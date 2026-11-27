const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Example: node scripts/benchmarks/bgp_route_group_regeneration_benchmark.js --routes=1000000 --scenarios=first,delete
if (!process.versions.electron) {
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    if (result.error) throw result.error;
    process.exit(result.status === null ? 1 : result.status);
}

process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForBenchmark() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');

function argument(name, fallback) {
    const key = `--${name}`;
    const index = process.argv.indexOf(key);
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
    const inline = process.argv.find(value => value.startsWith(`${key}=`));
    return inline ? inline.slice(key.length + 1) : fallback;
}

function positiveArgument(name, fallback) {
    const value = Number(argument(name, fallback));
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid --${name}`);
    return value;
}

const now = () => process.hrtime.bigint();
const elapsed = started => Number(now() - started) / 1e6;
const progressInterval = Number(argument('progress', 0));
let current = null;

function record(name, milliseconds, count = 1) {
    if (!current) return;
    const metric = current.timings[name] || { ms: 0, calls: 0 };
    metric.ms += milliseconds;
    metric.calls += count;
    current.timings[name] = metric;
}

function timedIterator(iterable, name) {
    return {
        [Symbol.iterator]() {
            const iterator = iterable[Symbol.iterator]();
            let yielded = 0;
            return {
                next(...args) {
                    const started = now();
                    try {
                        const result = iterator.next(...args);
                        if (!result.done && progressInterval > 0 && ++yielded % progressInterval === 0) {
                            console.log(`${current?.scenario || 'setup'} ${name}: ${yielded} routes`);
                        }
                        return result;
                    } finally {
                        record(name, elapsed(started));
                    }
                },
                return(value) {
                    return iterator.return ? iterator.return(value) : { value, done: true };
                }
            };
        }
    };
}

function instrumentSync(object, method) {
    const original = object[method];
    object[method] = function measured(...args) {
        const started = now();
        try {
            return original.apply(this, args);
        } finally {
            record(method, elapsed(started));
        }
    };
}

function instrumentAsync(object, method) {
    const original = object[method];
    object[method] = async function measured(...args) {
        const started = now();
        try {
            return await original.apply(this, args);
        } finally {
            record(method, elapsed(started));
        }
    };
}

function fixture(dbPath) {
    const worker = new BgpWorker();
    const store = new BgpRouteSqliteStore(dbPath);
    const instance = new BgpInstance(0, 2, 241, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    worker.messageHandler.sendSuccessResponse = (_id, stats) => {
        if (current) current.result = stats;
    };
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
        isAddPathSendEnabled: () => false,
        buildBgpMessageHeader(length, packetType) {
            const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
            header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
            header[BgpConst.BGP_MARKER_LEN + 2] = packetType;
            return header;
        },
        processCustomPkt: hex => Buffer.from(hex, 'hex'),
        sendRoute(buffer) {
            if (current) {
                current.packets += 1;
                current.bytes += buffer.length;
            }
        }
    };
    const peer = new BgpPeer(session, instance);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    instance.peerMap.set(session.peerIp, peer);

    const replace = store.replaceRouteGroup;
    store.replaceRouteGroup = function measuredReplace(groupId, options) {
        return replace.call(this, groupId, {
            ...options,
            routes: timedIterator(options.routes, 'candidateGeneration')
        });
    };
    for (const method of [
        'replaceRouteGroup',
        'withdrawRouteGroup',
        'resolveAttribute',
        'cleanupOrphanCandidates',
        'syncRouteGroupMembership'
    ])
        instrumentSync(store, method);
    const iterate = store.iterateRouteGroupRoutes;
    store.iterateRouteGroupRoutes = function measuredIteration(...args) {
        return timedIterator(iterate.apply(this, args), 'iterateRouteGroupRoutes');
    };
    for (const method of ['withdrawStoredGroupRoutes', 'announceStoredGroup']) instrumentAsync(worker, method);
    return { worker, store, instance };
}

function configuration(count, med = 42, startBit = count > 65536 ? 96 : 112) {
    return {
        groupId: 'range-benchmark',
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV6_QP,
        prefix: '2001:db8::1234:0',
        mask: 128,
        count,
        ipGenerationMode: 'rangeIncrement',
        ipRangeStartBit: String(startBit),
        ipStep: 1,
        attributeRules: [
            { type: 'origin', value: 0 },
            { type: 'asPath', value: '64512 64513' },
            { type: 'med', value: med },
            { type: 'localPref', value: 100 },
            { type: 'communities', value: '65000:1' },
            { type: 'med', value: 7 }
        ],
        nlriRules: [
            { type: 'dqpn', mode: 'fixed', value: 1 },
            { type: 'bsid', mode: 'fixed', value: '2001:db8::1' }
        ]
    };
}

async function main() {
    const count = positiveArgument('routes', 24117);
    const rounds = positiveArgument('rounds', 1);
    const startBit = positiveArgument('start-bit', count > 65536 ? 96 : 112);
    if (![64, 80, 92, 96, 112].includes(startBit)) throw new Error('Invalid --start-bit');
    if (BigInt(count) > 1n << BigInt(128 - startBit)) throw new Error('Route count exceeds the selected range');
    const scenarios = String(argument('scenarios', 'first,same,attributesChanged')).split(',');
    if (
        scenarios[0] !== 'first' ||
        scenarios.some(name => !['first', 'same', 'attributesChanged', 'delete'].includes(name)) ||
        (scenarios.includes('delete') && scenarios[scenarios.length - 1] !== 'delete')
    )
        throw new Error('--scenarios must begin with first and contain first, same, attributesChanged or final delete');
    const label = argument('label', 'current');
    const tempRoot = path.resolve(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(tempRoot, 'netnexus-bgp-regen-'));
    const output = path.resolve(argument('output', `test-results/bench-bgp-regen-${label}-${Date.now()}.json`));
    const report = {
        timestamp: new Date().toISOString(),
        label,
        runtime: { node: process.versions.node, electron: process.versions.electron, platform: process.platform },
        routes: count,
        rounds,
        configuration: configuration(count, 42, startBit),
        notes: 'Nested timings overlap. Iterator timings measure next() execution only. Peer counts packets and bytes without retaining payloads.',
        measurements: []
    };
    let f;
    try {
        for (let round = 1; round <= rounds; round += 1) {
            f = fixture(path.join(directory, `routes-${round}.sqlite`));
            console.log(`${label} round=${round}: benchmark source loaded`);
            for (const [scenario, med] of [
                ['first', 42],
                ['same', 42],
                ['attributesChanged', 43],
                ['delete', 42]
            ]) {
                if (!scenarios.includes(scenario)) continue;
                current = {
                    round,
                    scenario,
                    totalMs: 0,
                    packets: 0,
                    bytes: 0,
                    timings: {},
                    memoryBefore: process.memoryUsage()
                };
                const started = now();
                if (scenario === 'delete') {
                    await f.worker.withdrawRouteGroup('benchmark', { groupId: report.configuration.groupId });
                } else {
                    await f.worker.generateQpRoutes('benchmark', configuration(count, med, startBit));
                }
                current.totalMs = elapsed(started);
                current.memoryAfter = process.memoryUsage();
                if (f.instance.routeMap.size !== (scenario === 'delete' ? 0 : count))
                    throw new Error('Route count mismatch');
                if (scenario === 'delete') {
                    if (f.store.listRouteGroups().some(group => group.groupId === report.configuration.groupId))
                        throw new Error('Deleted route group still exists');
                    if (current.result?.deleted !== count) throw new Error('Deleted route count mismatch');
                    if (current.packets === 0) throw new Error('No withdrawal packets sent');
                }
                for (const metric of Object.values(current.timings)) metric.ms = Number(metric.ms.toFixed(3));
                current.totalMs = Number(current.totalMs.toFixed(3));
                report.measurements.push(current);
                console.log(
                    `${label} round=${round} scenario=${scenario} routes=${count} total=${current.totalMs} ms ` +
                        `candidates=${current.timings.candidateGeneration?.ms} ms ` +
                        `replace=${current.timings.replaceRouteGroup?.ms} ms ` +
                        `delete=${current.timings.withdrawRouteGroup?.ms} ms ` +
                        `withdraw=${current.timings.withdrawStoredGroupRoutes?.ms} ms ` +
                        `announce=${current.timings.announceStoredGroup?.ms} ms packets=${current.packets}`
                );
                current = null;
                fs.mkdirSync(path.dirname(output), { recursive: true });
                fs.writeFileSync(output, `${JSON.stringify(report, null, 4)}\n`);
            }
            f.store.close();
            f = null;
        }
        console.log(`Report: ${output}`);
    } finally {
        current = null;
        if (f) f.store.close();
        if (path.dirname(directory) !== tempRoot || !path.basename(directory).startsWith('netnexus-bgp-regen-'))
            throw new Error('Unexpected benchmark cleanup directory');
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
