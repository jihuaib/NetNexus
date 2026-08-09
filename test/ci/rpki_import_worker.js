const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

process.env.NODE_ENV = 'test';

const projectRoot = path.join(__dirname, '..', '..');
const appPath = path.join(projectRoot, 'electron', 'app', 'rpkiApp.js');
const importWorkerPath = path.join(projectRoot, 'electron', 'worker', 'rpki', 'rpkiImportWorker.js');
const { RPKI_IMPORT_OP } = require(path.join(projectRoot, 'electron', 'worker', 'rpki', 'rpkiImportTask.js'));
const RpkiSqliteStore = require(path.join(projectRoot, 'electron', 'worker', 'rpki', 'rpkiSqliteStore.js'));
const RpkiApp = require(path.join(projectRoot, 'electron', 'app', 'rpkiApp.js'));

const HEARTBEAT_INTERVAL_MS = 10;
const HEARTBEAT_MAX_GAP_MS = 250;
const HEARTBEAT_IMPORT_SIZE = 100000;

class MemoryStore {
    constructor() {
        this.values = new Map();
    }

    get(key) {
        return this.values.get(key);
    }

    set(key, value) {
        this.values.set(key, value);
    }
}

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(name, handler) {
        this.handlers.set(name, handler);
    }
}

function makeRoa(index) {
    return {
        prefix: `10.${(index >>> 16) & 0xff}.${(index >>> 8) & 0xff}.${index & 0xff}/32`,
        asn: `AS${64512 + (index % 500000)}`,
        maxLength: 32
    };
}

function makeAspa(index) {
    return {
        customerAsn: 100000 + index,
        providerAsns: [700000 + index, 800000 + index],
        afiFlags: (index % 3) + 1
    };
}

function assertPrimitiveStats(stats, label) {
    assert.equal(stats && typeof stats === 'object' && !Array.isArray(stats), true, `${label} must be an object`);
    for (const [key, value] of Object.entries(stats)) {
        assert.equal(
            value === null || ['string', 'number', 'boolean'].includes(typeof value),
            true,
            `${label}.${key} must remain a small scalar instead of transporting imported rows over IPC`
        );
    }
    assert.ok(
        Buffer.byteLength(JSON.stringify(stats), 'utf8') < 4096,
        `${label} response must remain bounded and must not contain the imported dataset`
    );
}

function assertMainProcessImportBoundary() {
    const source = fs.readFileSync(appPath, 'utf8');
    assert.match(
        source,
        /resolveWorkerPath\(['"]rpki\/rpkiImportWorker\.js['"]\)/,
        'RpkiApp must delegate JSON imports to the dedicated RPKI import worker'
    );
    assert.doesNotMatch(
        source,
        /\bparse(?:Roa|Aspa)JsonFile\b/,
        'Electron main must not parse large RPKI JSON files directly'
    );
    assert.doesNotMatch(
        source,
        /\.(?:begin|stage|commit|abort)(?:Roa|Aspa)Import(?:Batch)?\s*\(/,
        'Electron main must not execute staged RPKI import transactions directly'
    );
}

class ImportWorkerClient {
    constructor(workerPath) {
        this.worker = new Worker(workerPath);
        this.callbacks = new Map();
        this.sequence = 0;
        this.terminating = false;

        this.worker.on('message', message => {
            const callback = this.callbacks.get(message?.messageId);
            if (!callback) {
                return;
            }
            this.callbacks.delete(message.messageId);
            if (message.status === 'success') {
                callback.resolve(message);
                return;
            }
            const error = new Error(message.msg || 'RPKI import worker request failed');
            error.data = message.data;
            callback.reject(error);
        });
        this.worker.on('error', error => this.rejectPending(error));
        this.worker.on('exit', code => {
            if (!this.terminating || this.callbacks.size > 0) {
                this.rejectPending(new Error(`RPKI import worker exited with code ${code}`));
            }
        });
    }

    rejectPending(error) {
        for (const callback of this.callbacks.values()) {
            callback.reject(error);
        }
        this.callbacks.clear();
    }

    request(operation, data) {
        this.sequence += 1;
        const messageId = `rpki-import-test-${process.pid}-${this.sequence}`;
        return new Promise((resolve, reject) => {
            this.callbacks.set(messageId, { resolve, reject });
            this.worker.postMessage({ messageId, op: operation, data });
        });
    }

    async close() {
        this.terminating = true;
        await this.worker.terminate();
    }
}

function readStoreState(dbPath) {
    const store = new RpkiSqliteStore({ dbPath }).open();
    try {
        return {
            roas: store.getRoaCount(),
            aspas: store.getAspaCount(),
            serial: store.getCacheSerial()
        };
    } finally {
        store.close();
    }
}

async function verifyWorkerImportsAndRollback(client, tempDir) {
    const dbPath = path.join(tempDir, 'functional', 'rpki.sqlite3');
    const roaPath = path.join(tempDir, 'valid-roas.json');
    const aspaPath = path.join(tempDir, 'valid-aspas.json');
    await fs.promises.writeFile(
        roaPath,
        JSON.stringify({ roas: Array.from({ length: 6001 }, (_, index) => makeRoa(index)) }),
        'utf8'
    );
    await fs.promises.writeFile(
        aspaPath,
        JSON.stringify({ aspas: Array.from({ length: 3001 }, (_, index) => makeAspa(index)) }),
        'utf8'
    );

    const roaResponse = await client.request(RPKI_IMPORT_OP.IMPORT_ROA_JSON, {
        filePath: roaPath,
        dbPath
    });
    assert.equal(roaResponse.data.imported, 6001);
    assert.equal(roaResponse.data.total, 6001);
    assert.equal(roaResponse.data.changed, 6001);
    assertPrimitiveStats(roaResponse.data, 'ROA import stats');

    const aspaResponse = await client.request(RPKI_IMPORT_OP.IMPORT_ASPA_JSON, {
        filePath: aspaPath,
        dbPath
    });
    assert.equal(aspaResponse.data.imported, 3001);
    assert.equal(aspaResponse.data.total, 3001);
    assert.equal(aspaResponse.data.changed, 3001);
    assertPrimitiveStats(aspaResponse.data, 'ASPA import stats');

    const committedState = readStoreState(dbPath);
    assert.deepEqual(committedState.roas, 6001);
    assert.deepEqual(committedState.aspas, 3001);

    const malformedRoaPath = path.join(tempDir, 'malformed-roas.json');
    const malformedAspaPath = path.join(tempDir, 'malformed-aspas.json');
    await fs.promises.writeFile(
        malformedRoaPath,
        `{"roas":[${Array.from({ length: 5001 }, (_, index) => JSON.stringify(makeRoa(200000 + index))).join(',')}`,
        'utf8'
    );
    await fs.promises.writeFile(
        malformedAspaPath,
        `{"aspas":[${Array.from({ length: 5001 }, (_, index) => JSON.stringify(makeAspa(20000 + index))).join(',')}`,
        'utf8'
    );

    await assert.rejects(
        client.request(RPKI_IMPORT_OP.IMPORT_ROA_JSON, { filePath: malformedRoaPath, dbPath }),
        /ROA JSON文件不完整或格式错误/
    );
    await assert.rejects(
        client.request(RPKI_IMPORT_OP.IMPORT_ASPA_JSON, { filePath: malformedAspaPath, dbPath }),
        /ASPA JSON文件不完整或格式错误/
    );
    assert.deepEqual(
        readStoreState(dbPath),
        committedState,
        'malformed worker imports must roll back staged rows and preserve the committed cache serial'
    );
}

async function verifyMainThreadHeartbeat(tempDir) {
    const dbPath = path.join(tempDir, 'heartbeat', 'rpki.sqlite3');
    const importPath = path.join(tempDir, 'heartbeat-roas.json');
    const app = new RpkiApp(new FakeIpcMain(), new MemoryStore());
    app.getRpkiDatabasePath = () => dbPath;
    await fs.promises.writeFile(
        importPath,
        JSON.stringify({ roas: Array.from({ length: HEARTBEAT_IMPORT_SIZE }, (_, index) => makeRoa(500000 + index)) }),
        'utf8'
    );

    let heartbeatCount = 0;
    let maxGapMs = 0;
    let previousHeartbeat = performance.now();
    let importPending = true;
    const heartbeat = setInterval(() => {
        const now = performance.now();
        if (importPending) {
            heartbeatCount += 1;
            maxGapMs = Math.max(maxGapMs, now - previousHeartbeat);
        }
        previousHeartbeat = now;
    }, HEARTBEAT_INTERVAL_MS);

    const startedAt = performance.now();
    try {
        const response = await app.handleImportRoaJson(null, { filePath: importPath });
        const elapsedMs = performance.now() - startedAt;
        assert.equal(response.status, 'success');
        assert.equal(response.data.imported, HEARTBEAT_IMPORT_SIZE);
        assert.ok(
            elapsedMs >= HEARTBEAT_INTERVAL_MS * 2,
            'heartbeat fixture must be large enough to exercise scheduling'
        );
        assert.ok(heartbeatCount >= 2, 'the Electron main thread heartbeat must run while the import worker is busy');
        assert.ok(
            maxGapMs < HEARTBEAT_MAX_GAP_MS,
            `RPKI import starved the main event loop for ${maxGapMs.toFixed(1)}ms`
        );
        assertPrimitiveStats(response.data, 'large ROA import stats');
        assert.ok(
            Buffer.byteLength(JSON.stringify(response), 'utf8') < 8192,
            'the renderer IPC response must not contain imported ROA rows'
        );
    } finally {
        importPending = false;
        clearInterval(heartbeat);
        await app.closeStorage();
    }
}

async function main() {
    assertMainProcessImportBoundary();
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'netnexus-rpki-import-worker-'));
    const client = new ImportWorkerClient(importWorkerPath);

    try {
        await verifyWorkerImportsAndRollback(client, tempDir);
        await verifyMainThreadHeartbeat(tempDir);
        console.log('RPKI import worker isolation tests passed');
    } finally {
        await client.close();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
