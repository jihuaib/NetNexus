const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SnmpConst = require('../../electron/const/snmpConst');
const WorkerWithPromise = require('../../electron/worker/core/workerWithPromise');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-mib-worker-progress-'));
const mibDirectory = path.join(tempDir, 'mibs');

function writeMib(index) {
    const suffix = String(index).padStart(2, '0');
    const filePath = path.join(mibDirectory, `NETNEXUS-PROGRESS-${suffix}-MIB.mib`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
        filePath,
        `NETNEXUS-PROGRESS-${suffix}-MIB DEFINITIONS ::= BEGIN

IMPORTS
    enterprises
        FROM SNMPv2-SMI;

netNexusProgress${suffix} OBJECT IDENTIFIER ::= { enterprises ${92000 + index} }

END
`,
        'utf8'
    );
}

async function run() {
    for (let index = 0; index < 6; index += 1) {
        writeMib(index);
    }

    const workerPath = path.resolve(__dirname, '../../electron/worker/snmp/mibWorker.js');
    const worker = new WorkerWithPromise(workerPath).createLongRunningWorker();
    const progressId = `ci-progress-${Date.now()}`;
    const events = [];
    const listener = progress => events.push(progress);
    worker.addEventListener(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, listener);

    try {
        const response = await worker.sendRequest(SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS, {
            filePaths: [mibDirectory],
            force: true,
            progressId
        });
        assert.equal(response.status, 'success');
        assert.equal(response.data.loadedFiles.length, 6);
        assert(events.length > 0, 'worker必须主动推送MIB编译进度');
        assert(events.every(event => event.progressId === progressId));
        assert(events.some(event => event.phase === 'preparing'));
        assert(events.some(event => event.phase === 'scanning'));
        assert(events.some(event => event.phase === 'serializing'));
        assert(events.some(event => event.phase === 'indexing'));
        const finalEvent = events.at(-1);
        assert.equal(finalEvent.phase, 'completed');
        assert.equal(finalEvent.completed, 6);
        assert.equal(finalEvent.total, 6);
        assert.deepEqual(finalEvent.counts, { compiled: 6, skipped: 0, failed: 0 });

        const oldListenerEventCount = events.length;
        worker.removeEventListener(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, listener);
        await worker.sendRequest(SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS, {
            filePaths: [mibDirectory],
            force: true,
            progressId: `${progressId}-second`
        });
        assert.equal(events.length, oldListenerEventCount, '移除监听器后不应继续收到后续任务进度');

        console.log('MIB worker progress event tests passed');
    } finally {
        await worker.terminate();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
