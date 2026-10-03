const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { parse: parseVue } = require('@vue/compiler-sfc');
const { parse: parseJavaScript } = require('@babel/parser');
const { ref } = require('vue');
const BmpApp = require('../../electron/app/bmpApp');
const { createTrustedBmpEvent } = require('./fixtures/bmp_trusted_renderer');
const {
    getClientDatabaseDirectory,
    getClientDatabasePath
} = require('../../electron/worker/bmp/bmpClientPersistencePaths');

const sourceId = 'a'.repeat(64);
const otherSourceId = 'b'.repeat(64);

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
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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

async function assertSettingsDeletionConfirmation() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/view/settings/BmpDataSettings.vue'), 'utf8');
    const { descriptor, errors } = parseVue(source);
    assert.deepEqual(errors, []);
    assert.doesNotMatch(descriptor.template.content, /legacyDatabase|旧共享数据库|旧文件/);
    const script = descriptor.scriptSetup.content;
    const ast = parseJavaScript(script, { sourceType: 'module' });
    const names = new Set(['databaseInfo', 'confirmDeleteDatabase']);
    const declarations = ast.program.body.filter(
        node => node.type === 'VariableDeclaration' && node.declarations.some(item => names.has(item.id.name))
    );
    assert.equal(declarations.length, names.size, 'load both actual settings declarations');
    const confirmations = [];
    let deleteCalls = 0;
    const context = {
        ref,
        canDeleteDatabase: ref(false),
        dialog: { confirm: options => confirmations.push(options) },
        deleteDatabase: async () => {
            deleteCalls += 1;
        }
    };
    vm.runInNewContext(
        `${declarations.map(node => script.slice(node.start, node.end)).join('\n')}
        globalThis.settings = { databaseInfo, confirmDeleteDatabase };`,
        context,
        { filename: 'BmpDataSettings.vue' }
    );
    assert.equal(Object.hasOwn(context.settings.databaseInfo.value, 'legacyDatabaseExists'), false);
    assert.equal(Object.hasOwn(context.settings.databaseInfo.value, 'legacyDatabasePath'), false);
    context.settings.confirmDeleteDatabase();
    assert.equal(confirmations.length, 0, 'unavailable database deletion does not open a dialog');
    context.canDeleteDatabase.value = true;
    context.settings.confirmDeleteDatabase();
    assert.equal(confirmations.length, 1);
    assert.equal(
        confirmations[0].content,
        '将永久删除全部客户端数据库中的会话、路由和统计数据，且无法恢复。是否继续？'
    );
    assert.equal(confirmations[0].okType, 'danger');
    assert.equal(deleteCalls, 0, 'the confirmation does not delete before approval');
    await confirmations[0].onOk();
    assert.equal(deleteCalls, 1, 'approval invokes the actual bound deletion callback');
}

async function main() {
    await assertSettingsDeletionConfirmation();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-delete-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const clientDbPath = getClientDatabasePath(dbPath, sourceId);
    const clientDirectory = getClientDatabaseDirectory(dbPath);
    const unrelatedPath = path.join(tempDir, 'keep-me.txt');

    try {
        fs.writeFileSync(unrelatedPath, 'keep');
        const legacyArtifacts = writeArtifacts(dbPath);
        const artifacts = writeArtifacts(clientDbPath);
        const unknownFilePath = path.join(clientDirectory, 'unrecognized.sqlite3');
        fs.writeFileSync(unknownFilePath, 'unknown-file');
        const unknownDirectoryPath = path.join(clientDirectory, 'unrecognized-directory');
        fs.mkdirSync(unknownDirectoryPath);
        const app = makeApp(dbPath);
        const closeCalls = [];
        app.offlinePersistenceReader = {
            async close(options) {
                closeCalls.push(options);
                assert.equal(fs.existsSync(clientDbPath), true, 'the reader must close before database deletion');
            }
        };
        app.offlinePersistenceOpenPromise = Promise.resolve();

        const initialInfo = app.getPersistenceDatabaseInfo();
        assert.equal(initialInfo.exists, true);
        assert.equal(initialInfo.running, false);
        assert.equal(initialInfo.canDelete, true);
        assert.equal(initialInfo.fileCount, 4);
        assert.equal(initialInfo.storageMode, 'client-databases');
        assert.equal(initialInfo.storageDirectory, clientDirectory);
        assert.equal(initialInfo.clientDatabaseCount, 1);
        assert.equal(Object.hasOwn(initialInfo, 'legacyDatabaseExists'), false);
        assert.equal(Object.hasOwn(initialInfo, 'legacyDatabasePath'), false);
        assert.equal(
            initialInfo.artifacts.every(artifact => artifact.sourceId === sourceId),
            true
        );
        assert.equal(
            initialInfo.totalSize,
            artifacts.reduce((total, [, contents]) => total + Buffer.byteLength(contents), 0)
        );

        const result = await app.handleDeletePersistenceDatabase(createTrustedBmpEvent(app));
        assert.equal(result.status, 'success');
        assert.equal(result.msg, 'BMP数据库删除成功');
        assert.equal(result.data.deleted, true);
        assert.equal(result.data.deletedFileCount, 4);
        assert.deepEqual(result.data.deletedArtifacts, ['database', 'wal', 'shm', 'journal']);
        assert.equal(result.data.exists, false);
        assert.equal(result.data.clientDatabaseCount, 0);
        assert.equal(Object.hasOwn(result.data, 'legacyDatabaseExists'), false);
        assert.equal(Object.hasOwn(result.data, 'legacyDatabasePath'), false);
        assert.equal(result.data.busy, false);
        assert.equal(result.data.deleting, false);
        assert.deepEqual(closeCalls, [{ suppressErrors: true }]);
        assert.equal(app.offlinePersistenceReader, null);
        assert.equal(app.offlinePersistenceOpenPromise, null);
        for (const [filePath] of artifacts) {
            assert.equal(fs.existsSync(filePath), false);
        }
        assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'keep', 'unrelated BMP-directory files must remain');
        assert.equal(fs.readFileSync(unknownFilePath, 'utf8'), 'unknown-file');
        assert.equal(fs.statSync(unknownDirectoryPath).isDirectory(), true);
        for (const [filePath, contents] of legacyArtifacts) {
            assert.equal(
                fs.readFileSync(filePath, 'utf8'),
                contents,
                'manual deletion is limited to client artifacts, separate from startup schema cleanup'
            );
        }

        const repeatedResult = await app.handleDeletePersistenceDatabase(createTrustedBmpEvent(app));
        assert.equal(repeatedResult.status, 'success');
        assert.equal(repeatedResult.msg, 'BMP数据库不存在，无需删除');
        assert.equal(repeatedResult.data.deleted, false);

        fs.writeFileSync(clientDbPath, 'running-database');
        app.worker = {};
        const runningResult = await app.handleDeletePersistenceDatabase(createTrustedBmpEvent(app));
        assert.equal(runningResult.status, 'error');
        assert.equal(runningResult.msg, '请先停止 BMP 服务后再删除数据库');
        assert.equal(fs.readFileSync(clientDbPath, 'utf8'), 'running-database');
        app.worker = null;

        app.bmpStarting = true;
        const startingResult = await app.handleDeletePersistenceDatabase(createTrustedBmpEvent(app));
        assert.equal(startingResult.status, 'error');
        assert.equal(startingResult.msg, 'BMP 服务正在启动，请稍后重试');
        assert.equal(fs.existsSync(clientDbPath), true);
        app.bmpStarting = false;

        let releaseExistingOperation;
        app.offlinePersistenceLock = new Promise(resolve => {
            releaseExistingOperation = resolve;
        });
        const pendingDelete = app.handleDeletePersistenceDatabase(createTrustedBmpEvent(app));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(app.persistenceDatabaseDeleting, true);
        const repeatedPendingDelete = await app.handleDeletePersistenceDatabase(createTrustedBmpEvent(app));
        assert.equal(repeatedPendingDelete.status, 'error');
        assert.equal(repeatedPendingDelete.msg, 'BMP 数据库正在删除，请勿重复操作');
        const startDuringDelete = await app.handleStartBmp({ sender: {} }, {});
        assert.equal(startDuringDelete.status, 'error');
        assert.equal(startDuringDelete.msg, 'BMP数据库正在删除，请稍后重试');
        releaseExistingOperation();
        const pendingDeleteResult = await pendingDelete;
        assert.equal(pendingDeleteResult.status, 'success');
        assert.equal(fs.existsSync(clientDbPath), false);
        assert.equal(fs.existsSync(dbPath), true, 'manual deletion does not perform startup schema cleanup');
        assert.equal(app.persistenceDatabaseDeleting, false);

        const closeRacePath = path.join(tempDir, 'close-race.sqlite3');
        const closeRaceClientPath = getClientDatabasePath(closeRacePath, sourceId);
        fs.mkdirSync(path.dirname(closeRaceClientPath), { recursive: true });
        fs.writeFileSync(closeRaceClientPath, 'database');
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
        const closeRaceDelete = closeRaceApp.handleDeletePersistenceDatabase(createTrustedBmpEvent(closeRaceApp));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(
            fs.existsSync(closeRaceClientPath),
            true,
            'delete must wait for a failed reader to finish closing'
        );
        releaseFailedReaderClose();
        const closeRaceResult = await closeRaceDelete;
        assert.equal(closeRaceResult.status, 'success');
        assert.equal(fs.existsSync(closeRaceClientPath), false);

        const failingPath = path.join(tempDir, 'partial-failure.sqlite3');
        const failingClientPath = getClientDatabasePath(failingPath, sourceId);
        const removableClientPath = getClientDatabasePath(failingPath, otherSourceId);
        fs.mkdirSync(path.dirname(failingClientPath), { recursive: true });
        fs.writeFileSync(failingClientPath, 'database-must-remain');
        fs.mkdirSync(`${failingClientPath}-wal`);
        fs.writeFileSync(`${failingClientPath}-shm`, 'removable-sidecar');
        const removableArtifacts = writeArtifacts(removableClientPath);
        const failingApp = makeApp(failingPath);
        const failedResult = await failingApp.handleDeletePersistenceDatabase(createTrustedBmpEvent(failingApp));
        assert.equal(failedResult.status, 'error');
        assert.match(failedResult.msg, /wal/i);
        assert.equal(
            fs.readFileSync(failingClientPath, 'utf8'),
            'database-must-remain',
            'the primary database must remain when a sidecar cannot be removed'
        );
        assert.equal(fs.existsSync(`${failingClientPath}-shm`), false, 'other sidecars should still be cleaned up');
        for (const [filePath] of removableArtifacts) {
            assert.equal(
                fs.existsSync(filePath),
                false,
                'a failure for one client must not prevent other client deletion'
            );
        }
        assert.equal(failingApp.persistenceDatabaseDeleting, false);

        const orphanBasePath = path.join(tempDir, 'orphan.sqlite3');
        const orphanClientPath = getClientDatabasePath(orphanBasePath, sourceId);
        fs.mkdirSync(path.dirname(orphanClientPath), { recursive: true });
        fs.writeFileSync(`${orphanClientPath}-wal`, 'orphan-wal');
        const orphanApp = makeApp(orphanBasePath);
        assert.equal(orphanApp.getPersistenceDatabaseInfo().clientDatabaseCount, 0);
        const orphanResult = await orphanApp.handleDeletePersistenceDatabase(createTrustedBmpEvent(orphanApp));
        assert.equal(orphanResult.status, 'success');
        assert.equal(orphanResult.data.deletedFileCount, 1);
        assert.equal(fs.existsSync(`${orphanClientPath}-wal`), false, 'sidecar-only client artifacts must be deleted');

        const symlinkBasePath = path.join(tempDir, 'symlink.sqlite3');
        const symlinkClientPath = getClientDatabasePath(symlinkBasePath, sourceId);
        const symlinkTargetPath = path.join(tempDir, 'symlink-target.sqlite3');
        fs.mkdirSync(path.dirname(symlinkClientPath), { recursive: true });
        fs.writeFileSync(symlinkTargetPath, 'target-must-remain');
        fs.symlinkSync(symlinkTargetPath, symlinkClientPath);
        const symlinkApp = makeApp(symlinkBasePath);
        const symlinkResult = await symlinkApp.handleDeletePersistenceDatabase(createTrustedBmpEvent(symlinkApp));
        assert.equal(symlinkResult.status, 'error');
        assert.equal(fs.readFileSync(symlinkTargetPath, 'utf8'), 'target-must-remain');
        assert.equal(fs.lstatSync(symlinkClientPath).isSymbolicLink(), true, 'legal-looking symlinks must be refused');

        const legacyOnlyPath = path.join(tempDir, 'legacy-only.sqlite3');
        fs.writeFileSync(legacyOnlyPath, 'legacy-only');
        const legacyOnlyApp = makeApp(legacyOnlyPath);
        assert.equal(legacyOnlyApp.getPersistenceDatabaseInfo().exists, false);
        const legacyOnlyResult = await legacyOnlyApp.handleDeletePersistenceDatabase(
            createTrustedBmpEvent(legacyOnlyApp)
        );
        assert.equal(legacyOnlyResult.status, 'success');
        assert.equal(legacyOnlyResult.data.deleted, false);
        assert.equal(fs.readFileSync(legacyOnlyPath, 'utf8'), 'legacy-only');

        console.log('BMP database-delete app tests passed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
