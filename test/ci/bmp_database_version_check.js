const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpClientPersistenceStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const {
    resetDatabaseIfVersionChanged,
    prepareBmpDatabaseVersions
} = require('../../electron/worker/bmp/bmpDatabaseVersionCheck');
const {
    getClientDatabaseDirectory,
    getClientDatabasePath
} = require('../../electron/worker/bmp/bmpClientPersistencePaths');

const version = BmpPersistenceStore.SCHEMA_VERSION;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-db-version-'));
const suffixes = ['', '-wal', '-shm', '-journal'];

function createDatabase(dbPath, schemaVersion) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('keep-data')");
        db.pragma(`user_version = ${schemaVersion}`);
    } finally {
        db.close();
    }
}

function assertRemoved(dbPath) {
    for (const suffix of suffixes) assert.equal(fs.existsSync(`${dbPath}${suffix}`), false, `${dbPath}${suffix}`);
}

function verifyExactTargets() {
    const absent = path.join(directory, 'absent', 'bmp.sqlite3');
    assert.equal(resetDatabaseIfVersionChanged(absent, version).exists, false);
    assert.equal(fs.existsSync(path.dirname(absent)), false, 'missing databases must not create directories or files');
    const orphan = path.join(directory, 'orphan.sqlite3');
    for (const suffix of suffixes.slice(1)) fs.writeFileSync(`${orphan}${suffix}`, `orphan${suffix}`);
    const orphanResult = resetDatabaseIfVersionChanged(orphan, version);
    assert.equal(orphanResult.reset, false);
    assert.equal(orphanResult.exists, false);
    for (const suffix of suffixes.slice(1))
        assert.equal(fs.readFileSync(`${orphan}${suffix}`, 'utf8'), `orphan${suffix}`);

    const current = path.join(directory, 'current.sqlite3');
    createDatabase(current, version);
    const contents = fs.readFileSync(current);
    const inode = fs.statSync(current).ino;
    assert.equal(resetDatabaseIfVersionChanged(current, version).reset, false);
    assert.equal(fs.statSync(current).ino, inode);
    assert.deepEqual(
        fs.readFileSync(current),
        contents,
        'same-version helper must not recover or change database data'
    );
    assert.equal(prepareBmpDatabaseVersions(current, { expectedVersion: version }).resetCount, 0);

    for (const previousVersion of [0, version - 1, version + 1, -1]) {
        const dbPath = path.join(directory, `changed-${previousVersion}.sqlite3`);
        createDatabase(dbPath, previousVersion);
        for (const suffix of suffixes.slice(1)) fs.writeFileSync(`${dbPath}${suffix}`, '');
        fs.writeFileSync(`${dbPath}.backup`, 'not a deletion target');
        fs.writeFileSync(`${dbPath}-wal.backup`, 'not a sidecar');
        const result = resetDatabaseIfVersionChanged(dbPath, version);
        assert.equal(result.previousVersion, previousVersion);
        assert.equal(result.reset, true);
        assert.equal(result.deletedFiles.at(-1), dbPath, 'the main file is removed after all sidecars');
        assertRemoved(dbPath);
        assert.equal(fs.readFileSync(`${dbPath}.backup`, 'utf8'), 'not a deletion target');
        assert.equal(fs.readFileSync(`${dbPath}-wal.backup`, 'utf8'), 'not a sidecar');
        assert.equal(resetDatabaseIfVersionChanged(dbPath, version).reset, false, 'restarts are idempotent');
    }
}

function verifyUnsafeFiles() {
    const unreadable = path.join(directory, 'unreadable.sqlite3');
    fs.writeFileSync(unreadable, 'not a SQLite database');
    assert.throws(() => resetDatabaseIfVersionChanged(unreadable, version), /cannot read SQLite user_version/);
    assert.equal(fs.readFileSync(unreadable, 'utf8'), 'not a SQLite database');
    for (const invalidSuffix of suffixes) {
        const dbPath = path.join(directory, `invalid-${invalidSuffix || 'main'}.sqlite3`);
        if (invalidSuffix) createDatabase(dbPath, version - 1);
        else fs.mkdirSync(dbPath);
        if (invalidSuffix) fs.mkdirSync(`${dbPath}${invalidSuffix}`);
        const before = invalidSuffix ? fs.readFileSync(dbPath) : null;
        assert.throws(() => resetDatabaseIfVersionChanged(dbPath, version), /not a regular file/);
        assert.equal(fs.lstatSync(`${dbPath}${invalidSuffix}`).isDirectory(), true);
        if (before)
            assert.deepEqual(fs.readFileSync(dbPath), before, 'unsafe sibling must fail before deleting main data');
    }
    const symlinkTarget = path.join(directory, 'symlink-target');
    fs.mkdirSync(symlinkTarget);
    const sentinel = path.join(symlinkTarget, 'sentinel');
    fs.writeFileSync(sentinel, 'external data');
    for (const invalidSuffix of suffixes) {
        const dbPath = path.join(directory, `linked-${invalidSuffix || 'main'}.sqlite3`);
        if (invalidSuffix) createDatabase(dbPath, version - 1);
        const target = process.platform === 'win32' ? symlinkTarget : sentinel;
        fs.symlinkSync(target, `${dbPath}${invalidSuffix}`, process.platform === 'win32' ? 'junction' : 'file');
        const before = invalidSuffix ? fs.readFileSync(dbPath) : null;
        assert.throws(() => resetDatabaseIfVersionChanged(dbPath, version), /not a regular file/);
        assert.equal(fs.lstatSync(`${dbPath}${invalidSuffix}`).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external data');
        if (before) assert.deepEqual(fs.readFileSync(dbPath), before);
    }
    const changed = path.join(directory, 'changed-during-check.sqlite3');
    createDatabase(changed, version - 1);
    const originalLstat = fs.lstatSync;
    let mainInspections = 0;
    try {
        fs.lstatSync = function (filePath, ...args) {
            if (filePath === changed && ++mainInspections === 3) {
                const db = new Database(changed);
                try {
                    db.pragma(`user_version = ${version}`);
                } finally {
                    db.close();
                }
            }
            return originalLstat.call(this, filePath, ...args);
        };
        assert.throws(() => resetDatabaseIfVersionChanged(changed, version), /user_version changed before reset/);
    } finally {
        fs.lstatSync = originalLstat;
    }
    assert.equal(fs.existsSync(changed), true, 'a version changed in-place before deletion must be preserved');
}

function createCrashWal(dbPath, walVersion) {
    createDatabase(dbPath, version);
    const before = fs.readFileSync(dbPath);
    const child = spawnSync(
        process.execPath,
        [
            '-e',
            `
        const Database = require('better-sqlite3');
        const db = new Database(${JSON.stringify(dbPath)});
        db.pragma('journal_mode = WAL');
        db.pragma('wal_autocheckpoint = 0');
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.exec("BEGIN; PRAGMA user_version = ${walVersion}; INSERT INTO marker VALUES ('wal-data'); COMMIT");
        process.exit(0);
    `
        ],
        {
            cwd: path.join(__dirname, '../..'),
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            timeout: 10000
        }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.ok(fs.statSync(`${dbPath}-wal`).size > 32, 'version update must remain in an uncheckpointed WAL');
    assert.equal(
        fs.readFileSync(dbPath).readInt32BE(60),
        before.readInt32BE(60),
        'main header still has original version'
    );
    fs.unlinkSync(`${dbPath}-shm`);
}

function verifyWalVersions() {
    const same = path.join(directory, 'wal-same.sqlite3');
    createCrashWal(same, version);
    const before = fs.readFileSync(same);
    const walBefore = fs.readFileSync(`${same}-wal`);
    const result = resetDatabaseIfVersionChanged(same, version);
    assert.equal(result.reset, false, 'missing SHM may be recreated by SQLite, not mistaken for a changed artifact');
    assert.deepEqual(fs.readFileSync(same), before);
    assert.deepEqual(fs.readFileSync(`${same}-wal`), walBefore);
    assert.equal(fs.existsSync(`${same}-shm`), true);
    const old = path.join(directory, 'wal-changed.sqlite3');
    createCrashWal(old, version - 1);
    const changed = resetDatabaseIfVersionChanged(old, version);
    assert.equal(
        changed.previousVersion,
        version - 1,
        'PRAGMA version must include the committed WAL, not just the header'
    );
    assert.equal(changed.reset, true);
    assertRemoved(old);
}

function verifyMixedAndLaneOwnership() {
    const dbPath = path.join(directory, 'mixed', 'bmp.sqlite3');
    const ids = [0, 1, 2, 3].map(index => `${index.toString(16).padStart(8, '0')}${'a'.repeat(56)}`);
    const seed = new BmpClientPersistenceStore({ dbPath }).open();
    try {
        for (const id of ids)
            seed.getStore(id, true).db.exec("CREATE TABLE marker(value); INSERT INTO marker VALUES ('keep-client')");
    } finally {
        seed.close();
    }
    for (const index of [0, 1, 2]) {
        const db = new Database(getClientDatabasePath(dbPath, ids[index]));
        db.pragma(`user_version = ${[version - 1, version + 1, 0][index]}`);
        db.close();
    }
    createDatabase(dbPath, version);
    const sharedContents = fs.readFileSync(dbPath);
    const currentPath = getClientDatabasePath(dbPath, ids[3]);
    const currentContents = fs.readFileSync(currentPath);
    const unknownPath = path.join(getClientDatabaseDirectory(dbPath), 'unknown.sqlite3');
    fs.writeFileSync(unknownPath, 'unknown data');
    const orphan = getClientDatabasePath(dbPath, 'f'.repeat(64));
    fs.writeFileSync(`${orphan}-wal`, 'orphan data');
    const reader = new BmpClientPersistenceStore({ dbPath, readOnly: true }).open();
    reader.close();
    assert.equal(
        fs.existsSync(getClientDatabasePath(dbPath, ids[0])),
        true,
        'readonly open does not reset old clients'
    );
    const lane = new BmpClientPersistenceStore({ dbPath, workerIndex: 1, workerCount: 4 }).open();
    lane.close();
    assertRemoved(getClientDatabasePath(dbPath, ids[1]));
    assert.equal(fs.existsSync(getClientDatabasePath(dbPath, ids[0])), true, 'a lane does not reset another lane');
    assert.deepEqual(fs.readFileSync(dbPath), sharedContents, 'nonzero lane must not inspect or reset the shared file');
    const result = prepareBmpDatabaseVersions(dbPath, { expectedVersion: version });
    assert.equal(result.resetCount, 2);
    assertRemoved(getClientDatabasePath(dbPath, ids[0]));
    assertRemoved(getClientDatabasePath(dbPath, ids[2]));
    assert.deepEqual(fs.readFileSync(currentPath), currentContents, 'same-version client data is kept exactly');
    assert.deepEqual(fs.readFileSync(dbPath), sharedContents, 'same-version shared data is preserved');
    assert.equal(fs.readFileSync(unknownPath, 'utf8'), 'unknown data');
    assert.equal(fs.readFileSync(`${orphan}-wal`, 'utf8'), 'orphan data');
    assert.equal(prepareBmpDatabaseVersions(dbPath, { expectedVersion: version }).resetCount, 0);

    const failedPath = path.join(directory, 'preflight', 'bmp.sqlite3');
    createDatabase(failedPath, version - 1);
    const invalidClient = getClientDatabasePath(failedPath, ids[0]);
    fs.mkdirSync(path.dirname(invalidClient));
    fs.writeFileSync(invalidClient, 'not a SQLite client');
    const failedContents = fs.readFileSync(failedPath);
    assert.throws(
        () => prepareBmpDatabaseVersions(failedPath, { expectedVersion: version }),
        /cannot read SQLite user_version/
    );
    assert.deepEqual(
        fs.readFileSync(failedPath),
        failedContents,
        'all selected versions are inspected before any unlink'
    );
}

async function verifyWorkerPoolFailure() {
    const dbPath = path.join(directory, 'worker-failure.sqlite3');
    fs.writeFileSync(dbPath, 'corrupt database must be preserved');
    const client = new BmpPersistenceClient({ dbPath, partitionByClient: true, writerWorkerCount: 4 });
    try {
        await assert.rejects(client.open(), /cannot read SQLite user_version/);
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'corrupt database must be preserved');
        assert.equal(
            client.clients.every(lane => !lane.workerAlive),
            true,
            'failed startup closes every writer lane'
        );
    } finally {
        await client.close({ suppressErrors: true });
    }
}

async function main() {
    verifyExactTargets();
    verifyUnsafeFiles();
    verifyWalVersions();
    verifyMixedAndLaneOwnership();
    await verifyWorkerPoolFailure();
    console.log(
        'BMP database schema version startup checks passed: same/mixed versions, WAL, owned lanes and safe failures'
    );
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
