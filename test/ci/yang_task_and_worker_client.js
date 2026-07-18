const assert = require('assert');
const path = require('path');
const TaskManager = require('../../electron/utils/taskManager');
const RequestWorkerClient = require('../../electron/worker/core/requestWorkerClient');

async function waitFor(predicate, timeoutMs = 1000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function testTaskManager() {
    const events = [];
    const manager = new TaskManager({ onProgress: event => events.push(event) });
    const task = manager.start('compile', async ({ report }) => {
        report({ phase: 'working', percent: 40 });
        return { ok: true };
    });
    await waitFor(() => manager.get(task.taskId)?.status === 'completed');
    assert.strictEqual(manager.get(task.taskId).percent, 100);
    assert(events.some(event => event.phase === 'working'));
    assert(events.some(event => event.phase === 'completed'));

    const failed = manager.start('failure', async () => {
        const error = new Error('expected');
        error.code = 'EXPECTED';
        throw error;
    });
    await waitFor(() => manager.get(failed.taskId)?.status === 'failed');
    assert.strictEqual(manager.get(failed.taskId).error.code, 'EXPECTED');
}

async function testWorkerClient() {
    const workerPath = path.join(__dirname, 'fixtures', 'yang_request_worker_fixture.js');
    const client = new RequestWorkerClient(workerPath, { defaultTimeoutMs: 100 });
    const echoed = await client.sendRequest('echo', { value: 7 });
    assert.deepStrictEqual(echoed.data, { value: 7 });

    let eventData = null;
    client.on('fixture:event', data => {
        eventData = data;
    });
    await client.sendRequest('emit', { value: 8 });
    assert.deepStrictEqual(eventData, { value: 8 });

    await assert.rejects(
        client.sendRequest('delay', { delayMs: 100 }, { timeoutMs: 10 }),
        error => error.code === 'WORKER_TIMEOUT'
    );
    await assert.rejects(client.sendRequest('fail'), /fixture failure/);
    await client.terminate();
}

Promise.resolve()
    .then(testTaskManager)
    .then(testWorkerClient)
    .then(() => console.log('YANG task manager and worker client tests passed'))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
