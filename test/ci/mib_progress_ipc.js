const assert = require('assert');
const SnmpApp = require('../../electron/app/snmpApp');
const SnmpConst = require('../../electron/const/snmpConst');

class FakeSnmpProcessClient {
    constructor(summary, progressEvents = []) {
        this.summary = summary;
        this.progressEvents = progressEvents;
        this.listeners = new Map();
        this.lastRequest = null;
    }

    addEventListener(eventName, listener) {
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, new Set());
        }
        this.listeners.get(eventName).add(listener);
    }

    removeEventListener(eventName, listener) {
        this.listeners.get(eventName)?.delete(listener);
    }

    async sendRequest(op, data) {
        this.lastRequest = { op, data };
        for (const progress of this.progressEvents) {
            for (const listener of this.listeners.get(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS) || []) {
                listener({ progressId: data.progressId, ...progress });
            }
        }
        return {
            status: 'success',
            msg: 'ok',
            data: this.summary
        };
    }
}

async function run() {
    const summary = {
        expandedFileCount: 2,
        loadedFiles: [{ filePath: '/tmp/a.mib' }],
        skippedFiles: [{ filePath: '/tmp/b.mib' }],
        failedFiles: [],
        cacheHit: false
    };
    const worker = new FakeSnmpProcessClient(summary, [
        {
            phase: 'compiling',
            completed: 1,
            total: 2,
            percent: 50,
            counts: { compiled: 1, skipped: 0, failed: 0 },
            fileName: 'a.mib'
        },
        {
            phase: 'completed',
            completed: 2,
            total: 2,
            percent: 100,
            counts: { compiled: 1, skipped: 1, failed: 0 }
        }
    ]);
    const app = Object.create(SnmpApp.prototype);
    app.worker = worker;
    app.snmpReady = true;
    app.snmpStopping = false;
    app.mibProgressTargets = new Map();
    worker.addEventListener(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, payload =>
        app.handleMibCompileProgress(payload)
    );

    const sent = [];
    const sender = {
        id: 17,
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload })
    };
    const result = await app.requestMibWithProgress(
        { sender },
        SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS,
        { filePaths: ['/tmp'] }
    );

    assert.equal(result.data, summary);
    assert.equal(worker.lastRequest.op, SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS);
    assert.match(worker.lastRequest.data.progressId, /^17-/u);
    assert(sent.every(event => event.channel === 'unified-event'));
    assert(sent.every(event => event.payload.type === 'snmp:mibCompileProgress'));
    const progressPayloads = sent.map(event => event.payload.data.data);
    assert(progressPayloads.some(progress => progress.phase === 'preparing'));
    assert(progressPayloads.some(progress => progress.phase === 'compiling'));
    assert.equal(progressPayloads.filter(progress => progress.phase === 'completed').length, 1);
    assert.deepEqual(progressPayloads.at(-1).counts, { compiled: 1, skipped: 1, failed: 0 });
    assert.equal(app.mibProgressTargets.size, 0);

    const cachedWorker = new FakeSnmpProcessClient({ ...summary, cacheHit: true }, [
        {
            phase: 'completed',
            completed: 2,
            total: 2,
            percent: 100,
            cacheHit: true,
            counts: { compiled: 1, skipped: 1, failed: 0 }
        }
    ]);
    app.worker = cachedWorker;
    cachedWorker.addEventListener(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, payload =>
        app.handleMibCompileProgress(payload)
    );
    const cachedEvents = [];
    await app.requestMibWithProgress(
        {
            sender: {
                id: 18,
                isDestroyed: () => false,
                send: (channel, payload) => cachedEvents.push({ channel, payload })
            }
        },
        SnmpConst.MIB_REQ_TYPES.GET_MIB_STATUS,
        {},
        { announceImmediately: false }
    );
    assert.equal(cachedEvents.length, 0, '缓存命中时不应闪烁进度浮层');

    console.log('MIB progress IPC bridge tests passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
