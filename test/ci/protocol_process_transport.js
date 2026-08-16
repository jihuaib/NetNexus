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
