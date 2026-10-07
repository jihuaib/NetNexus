// Writer OPEN resets only its own different-version databases. Global status
// is safe only after the facade's OPEN barrier has reset every lane.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const BmpClientPersistenceStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const {
    getClientDatabasePath,
    getClientWorkerIndex,
    assertClientDatabaseArtifacts,
    listClientDatabases,
    listClientDatabaseArtifacts
} = require('../../electron/worker/bmp/bmpClientPersistencePaths');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-owned-status-'));
const dbPath = path.join(tempDir, 'bmp.sqlite3');
const workerCount = 4;
const sourceIds = [];
for (let probe = 0; sourceIds.filter(Boolean).length < workerCount; probe += 1) {
    const id = crypto.createHash('sha256').update(`owned-status-${probe}`).digest('hex');
    sourceIds[getClientWorkerIndex(id, workerCount)] ||= id;
}

function withDatabase(id, action) {
    const db = new Database(getClientDatabasePath(dbPath, id));
    try {
        return action(db);
    } finally {
        db.close();
    }
}

function downgrade() {
    for (const id of sourceIds) withDatabase(id, db => db.pragma('user_version = 13'));
}

function seedClients() {
    const seed = new BmpClientPersistenceStore({ dbPath }).open();
    try {
        for (const id of sourceIds) seed.getStore(id, true);
    } finally {
        seed.close();
    }
}

function verifyDiscoveryIsolation() {
    const originalLstat = fs.lstatSync;
    const foreignPaths = new Set(sourceIds.slice(1).map(id => getClientDatabasePath(dbPath, id)));
    const ownPath = getClientDatabasePath(dbPath, sourceIds[0]);
    const orphanSidecar = `${getClientDatabasePath(dbPath, 'f'.repeat(64))}-wal`;
    fs.writeFileSync(orphanSidecar, 'another writer may be deleting this sidecar');
    const denyLstat = predicate => {
        fs.lstatSync = function (filePath, ...args) {
            if (predicate(String(filePath))) {
                const error = new Error(`EPERM: simulated inaccessible artifact: ${filePath}`);
                error.code = 'EPERM';
                throw error;
            }
            return originalLstat.call(this, filePath, ...args);
        };
    };
    let lane;
    try {
        denyLstat(
            filename =>
                filename === orphanSidecar ||
                [...foreignPaths].some(
                    databasePath => filename === databasePath || filename.startsWith(`${databasePath}-`)
                )
        );
        lane = new BmpClientPersistenceStore({ dbPath, workerIndex: 0, workerCount }).open();
        assert.equal(
            lane.getStatus({ ownedOnly: true }).clientDatabaseCount,
            0,
            'owned startup and status must not inspect foreign main files or unrelated sidecars'
        );
        assert.throws(
            () => listClientDatabases(dbPath),
            { code: 'EPERM' },
            'global discovery still reports an inaccessible main file'
        );
        lane.getStore(sourceIds[0], true);
        denyLstat(filename => filename === orphanSidecar);
        assert.equal(listClientDatabases(dbPath).length, workerCount, 'main discovery must not inspect any sidecar');
        assert.throws(
            () => listClientDatabaseArtifacts(dbPath, { sourceIdFilter: id => id === 'f'.repeat(64) }),
            { code: 'EPERM' },
            'explicit artifact enumeration still validates sidecars'
        );
        denyLstat(filename => filename === ownPath);
        assert.throws(
            () => listClientDatabases(dbPath, { sourceIdFilter: id => id === sourceIds[0] }),
            { code: 'EPERM' },
            'owned main file errors must not be swallowed'
        );
        denyLstat(filename => filename === `${ownPath}-wal`);
        assert.throws(
            () => assertClientDatabaseArtifacts(dbPath, sourceIds[0]),
            { code: 'EPERM' },
            'owned sidecar errors must not be swallowed'
        );
    } finally {
        fs.lstatSync = originalLstat;
        lane?.close();
        fs.rmSync(orphanSidecar, { force: true });
    }
}

async function main() {
    assert.equal(BmpPersistenceStore.SCHEMA_VERSION, 14, 'this regression exercises schema 13 -> 14 startup reset');
    seedClients();

    downgrade();
    verifyDiscoveryIsolation();
    seedClients();
    downgrade();
    const firstLane = new BmpClientPersistenceStore({ dbPath, workerIndex: 0, workerCount }).open();
    try {
        const owned = firstLane.getStatus({ ownedOnly: true, includeCounts: true });
        assert.equal(owned.clientDatabaseCount, 0, 'different-version owned files are removed, not eagerly recreated');
        assert.equal(fs.existsSync(getClientDatabasePath(dbPath, sourceIds[0])), false);
        assert.equal(firstLane.stores.size, 0, 'owned status must not create foreign reader handles');
        for (const id of sourceIds.slice(1)) {
            assert.equal(
                withDatabase(id, db => db.pragma('user_version', { simple: true })),
                13
            );
        }
    } finally {
        firstLane.close();
    }

    for (let round = 0; round < 3; round += 1) {
        seedClients();
        downgrade();
        const writers = new BmpPersistenceClient({ dbPath, partitionByClient: true, writerWorkerCount: workerCount });
        const reader = new BmpPersistenceClient({ dbPath, partitionByClient: true, readOnly: true });
        try {
            const opened = await writers.open();
            assert.equal(opened.writerWorkerCount, workerCount);
            assert.equal(
                opened.clientDatabaseCount,
                0,
                'post-barrier status must see all different-version files removed'
            );
            for (const id of sourceIds) assert.equal(fs.existsSync(getClientDatabasePath(dbPath, id)), false);
            const global = await writers.getStatus({ includeCounts: true });
            assert.equal(global.clientDatabaseCount, 0);
            assert.equal(global.currentRoutes, 0);
            const readonly = await reader.open();
            assert.equal(readonly.clientDatabaseCount, 0, 'read-only OPEN must not recreate removed clients');
            assert.equal((await reader.queryRoutes({ pageSize: 2 })).list.length, 0);
        } finally {
            await reader.close({ suppressErrors: true });
            await writers.close({ suppressErrors: true });
            assert.equal(reader.workerAlive, false, 'reader shutdown is awaited before deleting test files');
            assert.equal(
                writers.clients.every(client => !client.workerAlive),
                true,
                'all writer shutdowns are awaited before the next fixture or cleanup'
            );
        }
    }
    console.log('BMP writer-owned startup status tests passed');
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
