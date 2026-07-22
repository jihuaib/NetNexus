const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BmpApp = require('../../electron/app/bmpApp');

function makeApp(dbPath) {
    const app = Object.create(BmpApp.prototype);
    app.persistenceDbPath = dbPath;
    app.worker = null;
    app.bmpStarting = false;
    app.persistenceDatabaseDeleting = false;
    app.offlinePersistenceReader = null;
    app.offlinePersistenceOpenPromise = null;
    app.offlinePersistenceLock = Promise.resolve();
    app.offlinePersistenceClosePromises = new Set();
    return app;
}

function writeArtifacts(dbPath) {
    const artifacts = [
        [dbPath, 'database'],
        [`${dbPath}-wal`, 'wal-data'],
        [`${dbPath}-shm`, 'shm'],
        [`${dbPath}-journal`, 'journal-data']
    ];
    for (const [filePath, contents] of artifacts) {
        fs.writeFileSync(filePath, contents);
    }
    return artifacts;
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-delete-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const unrelatedPath = path.join(tempDir, 'keep-me.txt');

    try {
        fs.writeFileSync(unrelatedPath, 'keep');
        const artifacts = writeArtifacts(dbPath);
        const app = makeApp(dbPath);
        const closeCalls = [];
        app.offlinePersistenceReader = {
            async close(options) {
                closeCalls.push(options);
                assert.equal(fs.existsSync(dbPath), true, 'the reader must close before database deletion');
            }
        };
        app.offlinePersistenceOpenPromise = Promise.resolve();

        const initialInfo = app.getPersistenceDatabaseInfo();
        assert.equal(initialInfo.exists, true);
        assert.equal(initialInfo.running, false);
        assert.equal(initialInfo.canDelete, true);
        assert.equal(initialInfo.fileCount, 4);
        assert.equal(
            initialInfo.totalSize,
            artifacts.reduce((total, [, contents]) => total + Buffer.byteLength(contents), 0)
        );

        const result = await app.handleDeletePersistenceDatabase();
        assert.equal(result.status, 'success');
        assert.equal(result.msg, 'BMP数据库删除成功');
        assert.equal(result.data.deleted, true);
        assert.equal(result.data.deletedFileCount, 4);
        assert.deepEqual(result.data.deletedArtifacts, ['database', 'wal', 'shm', 'journal']);
        assert.equal(result.data.exists, false);
        assert.equal(result.data.busy, false);
        assert.equal(result.data.deleting, false);
        assert.deepEqual(closeCalls, [{ suppressErrors: true }]);
        assert.equal(app.offlinePersistenceReader, null);
        assert.equal(app.offlinePersistenceOpenPromise, null);
        for (const [filePath] of artifacts) {
            assert.equal(fs.existsSync(filePath), false);
        }
        assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'keep', 'unrelated BMP-directory files must remain');

        const repeatedResult = await app.handleDeletePersistenceDatabase();
        assert.equal(repeatedResult.status, 'success');
        assert.equal(repeatedResult.msg, 'BMP数据库不存在，无需删除');
        assert.equal(repeatedResult.data.deleted, false);

        fs.writeFileSync(dbPath, 'running-database');
        app.worker = {};
        const runningResult = await app.handleDeletePersistenceDatabase();
        assert.equal(runningResult.status, 'error');
        assert.equal(runningResult.msg, '请先停止 BMP 服务后再删除数据库');
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'running-database');
        app.worker = null;

        app.bmpStarting = true;
        const startingResult = await app.handleDeletePersistenceDatabase();
        assert.equal(startingResult.status, 'error');
        assert.equal(startingResult.msg, 'BMP 服务正在启动，请稍后重试');
        assert.equal(fs.existsSync(dbPath), true);
        app.bmpStarting = false;

        let releaseExistingOperation;
        app.offlinePersistenceLock = new Promise(resolve => {
            releaseExistingOperation = resolve;
        });
        const pendingDelete = app.handleDeletePersistenceDatabase();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(app.persistenceDatabaseDeleting, true);
        const repeatedPendingDelete = await app.handleDeletePersistenceDatabase();
        assert.equal(repeatedPendingDelete.status, 'error');
        assert.equal(repeatedPendingDelete.msg, 'BMP 数据库正在删除，请勿重复操作');
        const startDuringDelete = await app.handleStartBmp({ sender: {} }, {});
        assert.equal(startDuringDelete.status, 'error');
        assert.equal(startDuringDelete.msg, 'BMP数据库正在删除，请稍后重试');
        releaseExistingOperation();
        const pendingDeleteResult = await pendingDelete;
        assert.equal(pendingDeleteResult.status, 'success');
        assert.equal(fs.existsSync(dbPath), false);
        assert.equal(app.persistenceDatabaseDeleting, false);

        const closeRacePath = path.join(tempDir, 'close-race.sqlite3');
        fs.writeFileSync(closeRacePath, 'database');
        const closeRaceApp = makeApp(closeRacePath);
        let releaseFailedReaderClose;
        const failedReaderClose = new Promise(resolve => {
            releaseFailedReaderClose = resolve;
        });
        const failedReader = {
            close() {
                return failedReaderClose;
            }
        };
        closeRaceApp.offlinePersistenceReader = failedReader;
        closeRaceApp.handleOfflinePersistenceFailure(failedReader, new Error('synthetic reader failure'));
        const closeRaceDelete = closeRaceApp.handleDeletePersistenceDatabase();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fs.existsSync(closeRacePath), true, 'delete must wait for a failed reader to finish closing');
        releaseFailedReaderClose();
        const closeRaceResult = await closeRaceDelete;
        assert.equal(closeRaceResult.status, 'success');
        assert.equal(fs.existsSync(closeRacePath), false);

        const failingPath = path.join(tempDir, 'partial-failure.sqlite3');
        fs.writeFileSync(failingPath, 'database-must-remain');
        fs.mkdirSync(`${failingPath}-wal`);
        fs.writeFileSync(`${failingPath}-shm`, 'removable-sidecar');
        const failingApp = makeApp(failingPath);
        const failedResult = await failingApp.handleDeletePersistenceDatabase();
        assert.equal(failedResult.status, 'error');
        assert.match(failedResult.msg, /wal/i);
        assert.equal(
            fs.readFileSync(failingPath, 'utf8'),
            'database-must-remain',
            'the primary database must remain when a sidecar cannot be removed'
        );
        assert.equal(fs.existsSync(`${failingPath}-shm`), false, 'other sidecars should still be cleaned up');
        assert.equal(failingApp.persistenceDatabaseDeleting, false);

        console.log('BMP database-delete app tests passed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
