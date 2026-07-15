const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const RpkiApp = require('../../electron/app/rpkiApp');
const RpkiConst = require('../../electron/const/rpkiConst');

class MemoryStore {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial));
    }

    get(key) {
        return this.values.get(key);
    }

    set(key, value) {
        this.values.set(key, value);
    }

    delete(key) {
        this.values.delete(key);
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
        asn: `AS${64512 + (index % 1000)}`,
        maxLength: 32
    };
}

function makeAspa(index) {
    return {
        customerAsn: 100000 + index,
        providerAsns: [200000 + index, 300000 + index, 300000 + index],
        afiFlags: (index % 3) + 1
    };
}

function configurePaths(rpkiApp, rootDir) {
    rpkiApp.getRpkiDatabasePath = () => path.join(rootDir, 'rpki', 'rpki.sqlite3');
}

async function testCloseWaitsForImport(rootDir) {
    const app = new RpkiApp(new FakeIpcMain(), new MemoryStore());
    configurePaths(app, rootDir);
    const importPath = path.join(rootDir, 'close-during-import.json');
    await fs.promises.mkdir(rootDir, { recursive: true });
    await fs.promises.writeFile(
        importPath,
        JSON.stringify({ roas: Array.from({ length: 5001 }, (_, index) => makeRoa(40000 + index)) }),
        'utf8'
    );

    const sqliteStore = await app.ensureRpkiStorage();
    const originalStageRoaBatch = sqliteStore.stageRoaBatch.bind(sqliteStore);
    let firstBatchResolve;
    const firstBatch = new Promise(resolve => {
        firstBatchResolve = resolve;
    });
    sqliteStore.stageRoaBatch = (...args) => {
        const result = originalStageRoaBatch(...args);
        firstBatchResolve();
        return result;
    };

    const importPromise = app.importRoaJsonFile(importPath);
    await firstBatch;
    const closePromise = app.closeStorage();
    const stats = await importPromise;
    await closePromise;
    assert.equal(stats.imported, 5001, 'closeStorage must drain an in-flight import');
    assert.equal(sqliteStore.db, null, 'closeStorage must close SQLite after the mutation queue drains');
    const reopened = await app.ensureRpkiStorage();
    const reopenedInsert = await app.handleAddRoa(null, makeRoa(49999));
    assert.equal(reopenedInsert.status, 'success', 'the same RpkiApp instance must accept CRUD after a macOS close');
    assert.equal(reopened.hasRoa(makeRoa(49999)), true);
    await app.closeStorage();
}

async function testWorkerSyncFailure(rootDir) {
    const app = new RpkiApp(new FakeIpcMain(), new MemoryStore());
    configurePaths(app, rootDir);
    const sqliteStore = await app.ensureRpkiStorage();
    let terminated = false;
    app.worker = {
        async sendRequest() {
            throw new Error('synthetic worker failure');
        },
        removeEventListener() {},
        async terminate() {
            terminated = true;
        }
    };

    try {
        const result = await app.handleAddRoa(null, makeRoa(50000));
        assert.equal(result.status, 'error');
        assert.match(result.msg, /数据已写入SQLite/);
        assert.equal(sqliteStore.hasRoa(makeRoa(50000)), true, 'committed data must survive worker sync failure');
        assert.equal(app.worker, null, 'a stale worker must be removed after sync failure');
        assert.equal(terminated, true, 'a stale worker must be terminated');
    } finally {
        app.worker = null;
        await app.closeStorage();
    }
}

async function main() {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'netnexus-rpki-sqlite-app-'));
    const rpkiApp = new RpkiApp(new FakeIpcMain(), new MemoryStore());
    configurePaths(rpkiApp, tempDir);
    let restartedRpkiApp = null;

    try {
        const sqliteStore = await rpkiApp.ensureRpkiStorage();
        assert.equal(sqliteStore.getRoaCount(), 0, 'a new major-version SQLite store must start empty');
        assert.equal(sqliteStore.getAspaCount(), 0, 'a new major-version SQLite store must start empty');
        assert.equal(rpkiApp.roaQueryIndex, undefined, 'RpkiApp must not retain the old full-memory ROA index');

        sqliteStore.addRoa({ prefix: '192.0.2.99/24', asn: 'AS65000', maxLength: 24 });
        sqliteStore.upsertAspa({ customerAsn: 65000, providerAsns: [65002, 65002], afiFlags: 3 });

        const workerCalls = [];
        rpkiApp.worker = {
            async sendRequest(type, payload) {
                workerCalls.push({ type, payload });
                return { status: 'success', data: null, msg: '' };
            }
        };

        const addResult = await rpkiApp.handleAddRoa(null, {
            prefix: '198.51.100.7/24',
            asn: 'AS65010',
            maxLength: 24
        });
        assert.equal(addResult.status, 'success');
        assert.equal(sqliteStore.getRoaCount(), 2);
        assert.equal(workerCalls.at(-1).type, RpkiConst.RPKI_REQ_TYPES.DATASET_CHANGED);
        assert.equal(workerCalls.at(-1).payload.operations[0].action, 'announce');

        const duplicateResult = await rpkiApp.handleAddRoa(null, {
            prefix: '198.51.100.0/24',
            asn: 65010,
            maxLength: 24
        });
        assert.equal(duplicateResult.status, 'error', 'canonical duplicate ROA should be rejected by SQLite');

        const replaceAspaResult = await rpkiApp.handleAddAspa(null, {
            customerAsn: 65000,
            providerAsns: [65003, 65003, 65004],
            afiFlags: 2
        });
        assert.equal(replaceAspaResult.status, 'success');
        assert.equal(workerCalls.at(-1).payload.operations[0].action, 'replace');
        assert.deepEqual(workerCalls.at(-1).payload.operations[0].oldData.providerAsns, [65002, 65002]);
        const callsBeforeIdenticalAspa = workerCalls.length;
        const serialBeforeIdenticalAspa = sqliteStore.getCacheSerial();
        const identicalAspaResult = await rpkiApp.handleAddAspa(null, {
            customerAsn: 65000,
            providerAsns: [65003, 65003, 65004],
            afiFlags: 2
        });
        assert.equal(identicalAspaResult.status, 'success');
        assert.equal(workerCalls.length, callsBeforeIdenticalAspa, 'identical ASPA must not notify the worker');
        assert.equal(sqliteStore.getCacheSerial(), serialBeforeIdenticalAspa);

        const roaImportPath = path.join(tempDir, 'import-roas.json');
        const aspaImportPath = path.join(tempDir, 'import-aspas.json');
        await fs.promises.writeFile(
            roaImportPath,
            JSON.stringify({ roas: Array.from({ length: 5001 }, (_, index) => makeRoa(index)) }),
            'utf8'
        );
        await fs.promises.writeFile(
            aspaImportPath,
            JSON.stringify({ aspas: Array.from({ length: 5001 }, (_, index) => makeAspa(index)) }),
            'utf8'
        );

        workerCalls.length = 0;
        const roaStats = await rpkiApp.importRoaJsonFile(roaImportPath);
        assert.equal(roaStats.imported, 5001);
        assert.equal(roaStats.total, 5003);
        assert.equal(workerCalls.length, 1, 'large ROA import should emit one cache boundary, not per-row IPC');
        assert.equal(workerCalls[0].type, RpkiConst.RPKI_REQ_TYPES.DATASET_CHANGED);
        assert.equal(workerCalls[0].payload.invalidate, true);

        const malformedRoaPath = path.join(tempDir, 'malformed-roas.json');
        const malformedAspaPath = path.join(tempDir, 'malformed-aspas.json');
        await fs.promises.writeFile(
            malformedRoaPath,
            `{"roas":[${Array.from({ length: 5001 }, (_, index) => JSON.stringify(makeRoa(20000 + index))).join(',')}`,
            'utf8'
        );
        await fs.promises.writeFile(
            malformedAspaPath,
            `{"aspas":[${Array.from({ length: 5001 }, (_, index) => JSON.stringify(makeAspa(20000 + index))).join(',')}`,
            'utf8'
        );
        const beforeMalformed = {
            roas: sqliteStore.getRoaCount(),
            aspas: sqliteStore.getAspaCount(),
            serial: sqliteStore.getCacheSerial(),
            workerCalls: workerCalls.length
        };
        await assert.rejects(rpkiApp.importRoaJsonFile(malformedRoaPath), /ROA JSON文件不完整或格式错误/);
        await assert.rejects(rpkiApp.importAspaJsonFile(malformedAspaPath), /ASPA JSON文件不完整或格式错误/);
        assert.equal(sqliteStore.getRoaCount(), beforeMalformed.roas, 'malformed ROA import must be atomic');
        assert.equal(sqliteStore.getAspaCount(), beforeMalformed.aspas, 'malformed ASPA import must be atomic');
        assert.equal(sqliteStore.getCacheSerial(), beforeMalformed.serial, 'failed imports must not bump serial');
        assert.equal(workerCalls.length, beforeMalformed.workerCalls, 'failed imports must not notify the worker');
        assert.equal(workerCalls[0].payload.operations.length, 0);

        const duplicateImportPath = path.join(tempDir, 'duplicate-roas.json');
        await fs.promises.writeFile(
            duplicateImportPath,
            JSON.stringify({ roas: Array.from({ length: 10001 }, () => makeRoa(0)) }),
            'utf8'
        );
        const originalStageRoaBatch = sqliteStore.stageRoaBatch.bind(sqliteStore);
        let duplicateBatchCalls = 0;
        sqliteStore.stageRoaBatch = (...args) => {
            duplicateBatchCalls += 1;
            return originalStageRoaBatch(...args);
        };
        const duplicateStats = await rpkiApp.importRoaJsonFile(duplicateImportPath, { limit: 1 });
        sqliteStore.stageRoaBatch = originalStageRoaBatch;
        assert.equal(duplicateStats.imported, 0);
        assert.equal(duplicateStats.duplicate, 10001);
        assert.equal(
            duplicateBatchCalls,
            3,
            'small import limits with many duplicates must retain 5000-row transaction batching'
        );

        workerCalls.length = 0;
        const aspaStats = await rpkiApp.importAspaJsonFile(aspaImportPath);
        assert.equal(aspaStats.imported, 5001);
        assert.equal(aspaStats.total, 5002);
        assert.equal(workerCalls.length, 1, 'large ASPA import should emit one cache boundary, not per-row IPC');
        assert.equal(workerCalls[0].payload.invalidate, true);

        const lastRoaPage = await rpkiApp.handleGetRoaList(null, { page: 501, pageSize: 10 });
        assert.equal(lastRoaPage.status, 'success');
        assert.equal(lastRoaPage.data.items.length, 3);
        assert.equal(lastRoaPage.data.storageTotal, 5003);

        const boundedDefaultList = await rpkiApp.handleGetRoaList(null);
        assert.equal(boundedDefaultList.status, 'success');
        assert.equal(boundedDefaultList.data.length, 1000, 'the default list response must remain bounded');

        const deleteRoas = await rpkiApp.handleDeleteAllRoa();
        const deleteAspas = await rpkiApp.handleDeleteAllAspa();
        assert.equal(deleteRoas.data.deleted, 5003);
        assert.equal(deleteAspas.data.deleted, 5002);
        assert.equal(sqliteStore.getRoaCount(), 0);
        assert.equal(sqliteStore.getAspaCount(), 0);

        rpkiApp.worker = null;
        const retainedRoa = makeRoa(60000);
        const retainedAspa = makeAspa(60000);
        assert.equal((await rpkiApp.handleAddRoa(null, retainedRoa)).status, 'success');
        assert.equal((await rpkiApp.handleAddAspa(null, retainedAspa)).status, 'success');
        await rpkiApp.closeStorage();
        restartedRpkiApp = new RpkiApp(new FakeIpcMain(), new MemoryStore());
        configurePaths(restartedRpkiApp, tempDir);
        const reopened = await restartedRpkiApp.ensureRpkiStorage();
        assert.equal(reopened.getRoaCount(), 1, 'same-version restart must retain newly stored ROAs');
        assert.equal(reopened.getAspaCount(), 1, 'same-version restart must retain newly stored ASPAs');
        assert.equal(reopened.hasRoa(retainedRoa), true);
        assert.deepEqual(reopened.getAspa(retainedAspa.customerAsn).providerAsns, retainedAspa.providerAsns);

        await restartedRpkiApp.closeStorage();
        restartedRpkiApp = null;

        await testCloseWaitsForImport(path.join(tempDir, 'close-drain'));
        await testWorkerSyncFailure(path.join(tempDir, 'worker-failure'));

        console.log('RPKI SQLite app integration tests passed');
    } finally {
        rpkiApp.worker = null;
        await restartedRpkiApp?.closeStorage();
        await rpkiApp.closeStorage();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
