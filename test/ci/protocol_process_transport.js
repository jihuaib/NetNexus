const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const ProtocolProcessHost = require('../../electron/worker/core/protocolProcessHost');
const ProtocolProcessWithPromise = require('../../electron/worker/core/protocolProcessWithPromise');
const RequestProcessClient = require('../../electron/worker/core/requestProcessClient');

const fixturePath = path.join(__dirname, 'fixtures', 'protocol_process_fixture.js');
const fixtureServiceName = 'netnexus.protocol.test';

async function testLongRunningProcess() {
    let exitCode = null;
    let exitDetails = null;
    const client = new ProtocolProcessWithPromise(fixturePath, {
        serviceName: fixtureServiceName,
        onExit: (code, _client, details) => {
            exitCode = code;
            exitDetails = details;
        }
    }).createLongRunningProcess();

    assert.notEqual(client.pid, process.pid);
    assert.equal(
        client.transport,
        process.env.NETNEXUS_EXPECT_UTILITY_PROCESS === '1' ? 'utility-process' : 'child-process'
    );
    assert.equal(client.serviceName, fixtureServiceName);

    const runtime = await client.sendRequest('runtime');
    assert.equal(runtime.data.pid, client.pid);
    assert.equal(runtime.data.isMainThread, true);
    assert.equal(runtime.data.threadId, 0);
    assert.equal(runtime.data.serviceName, fixtureServiceName);

    const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
    const echoed = await client.sendRequest('echo', { nested: { value: 7 }, binary });
    assert.deepEqual(echoed.data.nested, { value: 7 });
    assert(ArrayBuffer.isView(echoed.data.binary));
    assert.deepEqual(Buffer.from(echoed.data.binary), binary);

    let eventData = null;
    client.addEventListener('fixture:event', data => {
        eventData = data;
    });
    await client.sendRequest('emit', { value: 8 });
    assert.deepEqual(eventData, { value: 8 });

    await assert.rejects(
        client.sendRequest('delay', { delayMs: 100 }, { timeoutMs: 10 }),
        error => error.code === 'WORKER_TIMEOUT'
    );
    await assert.rejects(
        client.sendRequest('fail'),
        error => error.message === 'fixture failure' && error.data?.reason === 'expected'
    );
    await Promise.all([client.terminate(), client.terminate()]);
    await client.terminate();
    await assert.rejects(client.sendRequest('echo'), error => error.code === 'WORKER_TERMINATED');
    assert.notEqual(exitCode, null);
    assert.equal(exitDetails.expected, true);
}

function createRouteGraph(binarySize) {
    const allocation = Buffer.alloc(binarySize + 32, 0xa5);
    const binary = allocation.subarray(16, 16 + binarySize);
    for (let index = 0; index < binary.length; index += 1) binary[index] = (index * 31 + 255) & 0xff;
    const backing = new ArrayBuffer(128);
    new Uint8Array(backing).set(Array.from({ length: 128 }, (_, index) => (index * 17) & 0xff));
    const attributes = Object.freeze({
        origin: 'IGP',
        asPath: '64512 64513',
        med: 0,
        localPref: 100,
        communities: Object.freeze(['64512:100', '64512:200']),
        nextHop: '192.0.2.1'
    });
    const source = Object.freeze({ sysName: 'large-route-graph', remoteIp: '192.0.2.10', localPort: 11019 });
    const scope = Object.freeze({
        sourceId: 'a'.repeat(64),
        scopeId: 'b'.repeat(64),
        afi: 1,
        safi: 1,
        ribType: 2,
        state: 'ready'
    });
    const routes = Object.freeze(
        Array.from({ length: 1000 }, (_, index) => {
            const prefix = `10.${index >> 8}.${index & 255}.0`;
            return Object.freeze({
                persistentRouteId: String(index).padStart(64, '0'),
                persistentSourceId: scope.sourceId,
                persistentScopeId: scope.scopeId,
                routeKey: `0|0:0|${prefix}|24`,
                afi: 1,
                safi: 1,
                ip: prefix,
                mask: 24,
                pathId: 0,
                rd: '0:0',
                routeState: 'active',
                nlriDetail: Object.freeze({ prefix, length: 24, pathId: 0, rd: '0:0' }),
                attributes,
                source,
                scope,
                labels: null,
                parseStatus: 0,
                pathStatusNames: Object.freeze([]),
                lastSeenAt: '2026-10-02T00:00:00.000Z'
            });
        })
    );
    const graph = {
        binary,
        repeatedBinary: binary,
        backing,
        bytes: new Uint8Array(backing, 16, 64),
        words: new Uint16Array(backing, 16, 24),
        dataView: new DataView(backing, 24, 16),
        routes,
        repeatedRoute: routes[0],
        attributes,
        source,
        scope,
        byRoute: new Map([
            [routes[0], attributes],
            ['scope', scope]
        ]),
        members: new Set([scope, attributes]),
        receivedAt: new Date('2026-10-02T00:00:00.000Z'),
        optional: undefined,
        nan: NaN,
        negativeZero: -0
    };
    graph.self = graph;
    Object.freeze(graph);
    return { graph, allocation };
}

async function testForcedNodeForkLargeRouteGraphs() {
    let exitCode = null;
    let exitDetails = null;
    const client = new ProtocolProcessWithPromise(fixturePath, {
        serviceName: `${fixtureServiceName}.node-fork`,
        utilityProcess: null,
        defaultTimeoutMs: 10000,
        onExit: (code, _client, details) => {
            exitCode = code;
            exitDetails = details;
        }
    }).createLongRunningProcess();
    try {
        assert.equal(
            client.transport,
            'child-process',
            'large graph regression must explicitly bypass utility process'
        );
        if (process.versions.electron)
            assert.equal(client.process.jsonIpc, true, 'Electron fallback must use the pure-JS graph codec over JSON');
        for (const binarySize of [32 * 1024, 1024 * 1024]) {
            const { graph, allocation } = createRouteGraph(binarySize);
            // Snapshot bytes directly; no V8 serialization is used by this test.
            const originalBinary = Buffer.from(graph.binary);
            const originalBacking = Buffer.from(new Uint8Array(graph.backing));
            const originalKeys = Object.keys(graph);
            const echoed = (await client.sendRequest('echo', graph)).data;
            assert.deepEqual(echoed, graph, 'a 1,000-route object graph must survive both directions of real fork IPC');
            assert.ok(Buffer.isBuffer(echoed.binary));
            assert.equal(echoed.binary.length, binarySize);
            assert.deepEqual(echoed.binary, originalBinary);
            assert.strictEqual(echoed.binary, echoed.repeatedBinary);
            assert.strictEqual(echoed.self, echoed);
            assert.strictEqual(echoed.repeatedRoute, echoed.routes[0]);
            assert.equal(echoed.routes.length, 1000);
            assert.ok(
                echoed.routes.every(
                    route =>
                        route.attributes === echoed.attributes &&
                        route.source === echoed.source &&
                        route.scope === echoed.scope
                )
            );
            assert.strictEqual(echoed.byRoute.get(echoed.routes[0]), echoed.attributes);
            assert.ok(echoed.members.has(echoed.scope));
            assert.ok(echoed.bytes instanceof Uint8Array);
            assert.ok(echoed.words instanceof Uint16Array);
            assert.ok(echoed.dataView instanceof DataView);
            if (client.process.jsonIpc) {
                // The new graph codec preserves backing-store identity and view
                // offsets. Plain Node's unchanged advanced IPC only preserves
                // view contents, and can use an IPC allocation as its backing.
                assert.strictEqual(echoed.bytes.buffer, echoed.backing);
                assert.strictEqual(echoed.words.buffer, echoed.backing);
                assert.strictEqual(echoed.dataView.buffer, echoed.backing);
                assert.equal(echoed.bytes.byteOffset, 16);
                assert.equal(echoed.words.byteOffset, 16);
                assert.equal(echoed.dataView.byteOffset, 24);
            }
            assert.equal(echoed.dataView.byteLength, 16);
            assert.deepEqual(Buffer.from(new Uint8Array(echoed.backing)), originalBacking);
            assert.deepEqual(graph.binary, originalBinary, 'encoding must not modify user Buffer bytes');
            assert.deepEqual(
                Buffer.from(new Uint8Array(graph.backing)),
                originalBacking,
                'encoding must not modify user view bytes'
            );
            assert.deepEqual(Object.keys(graph), originalKeys, 'encoding must not attach metadata to user objects');
            assert.strictEqual(graph.self, graph);
            assert.ok(allocation.subarray(0, 16).every(byte => byte === 0xa5));
            assert.ok(allocation.subarray(16 + binarySize).every(byte => byte === 0xa5));
        }
        await client.terminate();
        assert.equal(exitCode, 0);
        assert.equal(
            exitDetails.signal,
            null,
            'large JSON graph traffic must not trigger a delayed SIGTRAP on process cleanup'
        );
        assert.equal(client.process.exitSignal, null);
        assert.equal(client.process.exitCode, 0);
        assert.equal(exitDetails.expected, true);
    } finally {
        await client.terminate();
    }
}

async function testRequestProcessClient() {
    const client = new RequestProcessClient(fixturePath, {
        serviceName: fixtureServiceName,
        // Process startup alone can exceed 100ms on hosted Windows runners.
        // Timeout behavior is covered below with an explicit 10ms request.
        defaultTimeoutMs: 5000
    });

    const echoed = await client.sendRequest('echo', { value: 9 });
    assert.deepEqual(echoed.data, { value: 9 });
    assert.notEqual(client.process.pid, process.pid);

    await assert.rejects(
        client.sendRequest('delay', { delayMs: 100 }, { timeoutMs: 10 }),
        error => error.code === 'WORKER_TIMEOUT'
    );

    const abortController = new AbortController();
    const cancelled = client.sendRequest('delay', { delayMs: 100 }, { signal: abortController.signal });
    abortController.abort();
    await assert.rejects(cancelled, error => error.code === 'WORKER_CANCELLED');

    await assert.rejects(
        client.sendRequest('fail'),
        error => error.message === 'fixture failure' && error.data?.reason === 'expected'
    );
    await client.terminate();
    await assert.rejects(
        client.sendRequest('echo', { mustNotRestart: true }),
        error => error.code === 'WORKER_TERMINATED' && error.message === 'Protocol process client is closed'
    );
    assert.equal(client.process, null);
}

async function testUnexpectedExitRejectsPendingRequest() {
    let exitCode = null;
    let exitDetails = null;
    const client = new ProtocolProcessWithPromise(fixturePath, {
        serviceName: fixtureServiceName,
        onExit: (code, _client, details) => {
            exitCode = code;
            exitDetails = details;
        }
    }).createLongRunningProcess();

    await assert.rejects(client.sendRequest('exit', { code: 23 }), /stopped with exit code 23/);
    assert.equal(exitCode, 23);
    assert.equal(exitDetails.expected, false);
    await assert.rejects(client.sendRequest('echo'), error => error.code === 'WORKER_EXIT');
    await client.terminate();
}

async function testRequestClientDoesNotRestartAfterUnexpectedExit() {
    const client = new RequestProcessClient(fixturePath, {
        serviceName: fixtureServiceName,
        defaultTimeoutMs: 1000
    });

    await assert.rejects(client.sendRequest('exit', { code: 24 }), error => error.code === 'WORKER_EXIT');
    assert.equal(client.process, null);
    await assert.rejects(client.sendRequest('echo'), error => error.code === 'WORKER_EXIT');
    await client.terminate();
}

async function testSpawnFailureSettlesHost() {
    const host = new ProtocolProcessHost(fixturePath, {
        serviceName: fixtureServiceName,
        utilityProcess: null,
        cwd: path.join(__dirname, 'fixtures', 'missing-process-cwd'),
        forceKillTimeoutMs: 250
    });
    let spawnError = null;
    host.on('error', error => {
        spawnError = error;
    });

    const [exitCode] = await new Promise(resolve => host.once('exit', (...args) => resolve(args)));
    assert(spawnError);
    assert.equal(exitCode, 1);
    assert.equal(host.runtime, null);
    assert.equal(await host.terminate(), 1);
}

async function testRejectedUtilityKillDoesNotHang() {
    const runtime = new EventEmitter();
    runtime.pid = undefined;
    runtime.postMessage = () => {};
    runtime.kill = () => false;
    const host = new ProtocolProcessHost(fixturePath, {
        serviceName: fixtureServiceName,
        utilityProcess: { fork: () => runtime },
        forceKillTimeoutMs: 250
    });

    await assert.rejects(host.terminate(), error => error.code === 'PROCESS_TERMINATE_FAILED');
    runtime.emit('exit', 0, null);
    assert.equal(host.runtime, null);
}

async function testRequestClientPreCancelledDoesNotSpawn() {
    let forkCount = 0;
    const client = new RequestProcessClient(fixturePath, {
        utilityProcess: {
            fork: () => {
                forkCount += 1;
                throw new Error('must not fork');
            }
        }
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        client.sendRequest('echo', null, { signal: controller.signal }),
        error => error.code === 'WORKER_CANCELLED'
    );
    assert.equal(forkCount, 0);
    await client.terminate();
}

async function testConcurrentRequestClientTerminateWaitsForExit() {
    const runtime = new EventEmitter();
    runtime.pid = 987654;
    runtime.postMessage = () => {};
    runtime.kill = () => {
        setTimeout(() => runtime.emit('exit', 0, null), 75);
        return true;
    };
    const client = new RequestProcessClient(fixturePath, {
        utilityProcess: { fork: () => runtime },
        forceKillTimeoutMs: 250
    }).start();

    const first = client.terminate();
    let secondFinished = false;
    const second = client.terminate().then(() => {
        secondFinished = true;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(secondFinished, false);
    await Promise.all([first, second]);
    assert.equal(client.process, null);
}

async function main() {
    await testLongRunningProcess();
    await testForcedNodeForkLargeRouteGraphs();
    await testRequestProcessClient();
    await testUnexpectedExitRejectsPendingRequest();
    await testRequestClientDoesNotRestartAfterUnexpectedExit();
    await testSpawnFailureSettlesHost();
    await testRejectedUtilityKillDoesNotHang();
    await testRequestClientPreCancelledDoesNotSpawn();
    await testConcurrentRequestClientTerminateWaitsForExit();
    console.log('Protocol process transport tests passed');
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = main;
