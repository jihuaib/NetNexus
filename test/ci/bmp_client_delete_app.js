const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');
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
        assert.equal(legacyOnlyStatus.data.legacyDatabaseExists, true);
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
        assert.equal(offlineStatus.data.legacyDatabaseExists, true);
        assert.equal(createdOptions.length, 1, 'offline queries should reuse the existing partition reader');
        await app.closeOfflinePersistenceReader();
        assert.deepEqual(closedOptions, [{ suppressErrors: true }]);

        const migrationOptions = [];
        app.createPersistenceClient = options => {
            migrationOptions.push(options);
            const needsMigration = migrationOptions.length === 1;
            return {
                async open() {
                    if (needsMigration) {
                        const error = new Error('client schema needs migration');
                        error.code = 'BMP_PERSISTENCE_SCHEMA_MIGRATION_REQUIRED';
                        throw error;
                    }
                },
                async close() {}
            };
        };
        await app.openOfflinePersistenceReader();
        assert.equal(migrationOptions.length, 3);
        assert.equal(
            migrationOptions.every(options => options.partitionByClient === true),
            true
        );
        assert.equal(migrationOptions[0].readOnly, true);
        assert.notEqual(migrationOptions[1].readOnly, true, 'only the partition schema initializer is writable');
        assert.equal(migrationOptions[2].readOnly, true);
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'legacy-database-must-not-be-read');
    } finally {
        await app.closeOfflinePersistenceReader();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function main() {
    const sourceId = 'a'.repeat(64);
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

    const result = await app.handleDeleteClientData(null, {
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
    const stoppedResult = await app.handleDeleteClientData(null, { sourceId, remoteIp: '192.0.2.10' });
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
