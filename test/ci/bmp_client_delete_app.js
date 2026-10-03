const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');
const Database = require('better-sqlite3');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');
const { createTrustedBmpEvent } = require('./fixtures/bmp_trusted_renderer');
const { getClientDatabasePath } = require('../../electron/worker/bmp/bmpClientPersistencePaths');

async function assertOfflineReaderIsolation(sourceId) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-offline-app-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const app = Object.create(BmpApp.prototype);
    Object.assign(app, {
        persistenceDbPath: dbPath,
        worker: null,
        bmpStarting: false,
        persistenceDatabaseDeleting: false,
        offlinePersistenceReader: null,
        offlinePersistenceOpenPromise: null,
        offlinePersistenceLock: Promise.resolve(),
        offlinePersistenceClosePromises: new Set(),
        logLevel: 'off'
    });
    const createdOptions = [];
    const closedOptions = [];
    app.createPersistenceClient = options => {
        createdOptions.push(options);
        return {
            async open() {},
            async close(closeOptions) {
                closedOptions.push(closeOptions);
            },
            async queryRoutes(query) {
                return { total: 1, list: [{ sourceId, routeState: 'stale' }], query };
            },
            async getStatus() {
                return {
                    enabled: true,
                    ready: true,
                    dbPath,
                    storageMode: 'client-databases',
                    clientDatabaseCount: 1,
                    clientDatabases: [{ sourceId, dbPath: getClientDatabasePath(dbPath, sourceId) }]
                };
            }
        };
    };

    try {
        fs.writeFileSync(dbPath, 'legacy-database-must-not-be-read');
        const legacyOnlyStatus = await app.queryPersistenceStatus();
        assert.equal(legacyOnlyStatus.status, 'success');
        assert.equal(legacyOnlyStatus.data.ready, false);
        assert.equal(legacyOnlyStatus.data.storageMode, 'client-databases');
        assert.equal(legacyOnlyStatus.data.clientDatabaseCount, 0);
        assert.equal(Object.hasOwn(legacyOnlyStatus.data, 'legacyDatabaseExists'), false);
        assert.equal(Object.hasOwn(legacyOnlyStatus.data, 'legacyDatabasePath'), false);
        await assert.rejects(app.queryPersistedRoutes({ sourceId }), /持久化数据库不存在/);
        assert.equal(createdOptions.length, 0, 'legacy-only storage must never open a persistence client');

        const clientDbPath = getClientDatabasePath(dbPath, sourceId);
        fs.mkdirSync(path.dirname(clientDbPath), { recursive: true });
        fs.writeFileSync(clientDbPath, 'client-database-fixture');
        const query = { sourceId, routeState: 'all', page: 1, pageSize: 10 };
        const offlineRoutes = await app.queryPersistedRoutes(query);
        assert.equal(offlineRoutes.status, 'success');
        assert.equal(offlineRoutes.data.total, 1);
        assert.deepEqual(offlineRoutes.data.query, query);
        assert.equal(createdOptions.length, 1);
        assert.equal(createdOptions[0].dbPath, dbPath, 'the base path remains the partition locator');
        assert.equal(createdOptions[0].partitionByClient, true);
        assert.equal(createdOptions[0].readOnly, true);
        const offlineStatus = await app.queryPersistenceStatus();
        assert.equal(offlineStatus.data.clientDatabaseCount, 1);
        assert.equal(Object.hasOwn(offlineStatus.data, 'legacyDatabaseExists'), false);
        assert.equal(Object.hasOwn(offlineStatus.data, 'legacyDatabasePath'), false);
        assert.equal(createdOptions.length, 1, 'offline queries should reuse the existing partition reader');
        await app.closeOfflinePersistenceReader();
        assert.deepEqual(closedOptions, [{ suppressErrors: true }]);

        const failedOptions = [];
        const failedCloseOptions = [];
        const schemaError = new Error('client schema is incompatible');
        schemaError.code = 'BMP_PERSISTENCE_SCHEMA_MIGRATION_REQUIRED';
        app.createPersistenceClient = options => {
            failedOptions.push(options);
            return {
                async open() {
                    throw schemaError;
                },
                async close(options) {
                    failedCloseOptions.push(options);
                }
            };
        };
        await assert.rejects(app.queryPersistedRoutes(query), error => error === schemaError);
        assert.equal(failedOptions.length, 1, 'a schema-open failure does not create a writer or retry internally');
        assert.equal(failedOptions[0].partitionByClient, true);
        assert.equal(failedOptions[0].readOnly, true);
        assert.deepEqual(failedCloseOptions, [{ suppressErrors: true }]);
        assert.equal(app.offlinePersistenceReader, null);
        assert.equal(app.offlinePersistenceOpenPromise, null);
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'legacy-database-must-not-be-read');
        assert.equal(fs.readFileSync(clientDbPath, 'utf8'), 'client-database-fixture');
    } finally {
        await app.closeOfflinePersistenceReader();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function assertOldSchemaQueriesDoNotCreateWriter(sourceId) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-old-schema-app-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const clientDbPath = getClientDatabasePath(dbPath, sourceId);
    fs.mkdirSync(path.dirname(clientDbPath), { recursive: true });
    const database = new Database(clientDbPath);
    database.exec(
        "CREATE TABLE retained_data (value TEXT); INSERT INTO retained_data VALUES ('keep'); PRAGMA user_version = 13;"
    );
    database.close();
    fs.writeFileSync(dbPath, 'shared-file-not-part-of-offline-queries');
    const originalContents = fs.readFileSync(clientDbPath);
    const app = Object.create(BmpApp.prototype);
    Object.assign(app, {
        persistenceDbPath: dbPath,
        worker: null,
        bmpStarting: false,
        persistenceDatabaseDeleting: false,
        offlinePersistenceReader: null,
        offlinePersistenceOpenPromise: null,
        offlinePersistenceLock: Promise.resolve(),
        offlinePersistenceClosePromises: new Set(),
        logLevel: 'off'
    });
    const createdOptions = [];
    app.createPersistenceClient = options => {
        createdOptions.push(options);
        return BmpApp.prototype.createPersistenceClient.call(app, options);
    };
    try {
        await assert.rejects(
            app.queryPersistedRoutes({ sourceId, page: 1, pageSize: 10 }),
            error => error.code === 'BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE'
        );
        assert.equal(createdOptions.length, 1);
        assert.equal(createdOptions[0].readOnly, true, 'an actual v13 database is opened only by a reader');
        assert.equal(app.offlinePersistenceReader, null);
        assert.equal(app.offlinePersistenceOpenPromise, null);
        assert.deepEqual(fs.readFileSync(clientDbPath), originalContents, 'offline schema errors do not change data');
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'shared-file-not-part-of-offline-queries');

        const deletion = await app.handleDeletePersistenceDatabase(createTrustedBmpEvent(app));
        assert.equal(deletion.status, 'success');
        assert.equal(deletion.data.deleted, true);
        assert.equal(fs.existsSync(clientDbPath), false, 'manual deletion still removes incompatible client databases');
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'shared-file-not-part-of-offline-queries');
        assert.equal(createdOptions.length, 1, 'manual deletion does not create a writer');
    } finally {
        await app.closeOfflinePersistenceReader();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function main() {
    const sourceId = 'a'.repeat(64);
    await assertOldSchemaQueriesDoNotCreateWriter(sourceId);
    let workerPayload = null;
    const app = Object.create(BmpApp.prototype);
    app.worker = {
        async sendRequest(requestType, payload) {
            assert.equal(requestType, BmpConst.BMP_REQ_TYPES.DELETE_CLIENT_DATA);
            workerPayload = payload;
            return {
                data: { sourceId: payload.sourceId, deleted: true },
                msg: 'deleted'
            };
        }
    };

    const event = createTrustedBmpEvent(app);
    const result = await app.handleDeleteClientData(event, {
        sourceId: ` ${sourceId} `,
        remoteIp: ' 192.0.2.10 ',
        nestedReactiveData: { rawTlvs: [] },
        callback: () => {}
    });

    assert.deepEqual(workerPayload, {
        sourceId,
        remoteIp: '192.0.2.10'
    });
    const { port1, port2 } = new MessageChannel();
    assert.doesNotThrow(() => port1.postMessage(workerPayload));
    port1.close();
    port2.close();
    assert.equal(result.status, 'success');
    assert.equal(result.data.deleted, true);

    app.worker = null;
    const stoppedResult = await app.handleDeleteClientData(event, { sourceId, remoteIp: '192.0.2.10' });
    assert.equal(stoppedResult.status, 'error');
    assert.equal(stoppedResult.msg, '请先启动 BMP 服务后删除离线客户端');

    const clientSelectors = [];
    app.worker = {
        async sendRequest(requestType, payload) {
            assert.equal(requestType, BmpConst.BMP_REQ_TYPES.GET_CLIENT);
            clientSelectors.push(payload);
            return { data: { ...payload, sysName: 'router-a' }, msg: 'found' };
        }
    };

    const sourceClient = await app.handleGetClient(null, `source:${sourceId}`);
    assert.deepEqual(clientSelectors[0], { persistentSourceId: sourceId });
    assert.equal(sourceClient.status, 'success');
    assert.equal(sourceClient.data.sysName, 'router-a');

    const connectionClient = await app.handleGetClient(null, 'connection:127.0.0.1|11019|192.0.2.10|49152');
    assert.deepEqual(clientSelectors[1], {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 49152
    });
    assert.equal(connectionClient.status, 'success');

    const invalidClient = await app.handleGetClient(null, 'source:not-a-valid-source-id');
    assert.equal(invalidClient.status, 'error');
    assert.equal(clientSelectors.length, 2);

    await assertOfflineReaderIsolation(sourceId);

    console.log('BMP client query/delete app tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
