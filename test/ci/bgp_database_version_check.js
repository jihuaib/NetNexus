const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpConst = require('../../electron/const/bgpConst');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const { resetDatabaseIfVersionChanged } = require('../../electron/worker/bgp/bgpDatabaseVersionCheck');

const version = BgpRouteSqliteStore.SCHEMA_VERSION;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-version-check-'));
const suffixes = ['-wal', '-shm', '-journal', ''];

function createDatabase(dbPath, schemaVersion) {
    const db = new Database(dbPath);
    try {
        db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('old-data')");
        db.pragma(`user_version = ${schemaVersion}`);
    } finally {
        db.close();
    }
}

function seedRoutes(dbPath) {
    const store = new BgpRouteSqliteStore(dbPath).open();
    try {
        store.replaceRouteGroup('old-group', {
            groupName: 'Old group',
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            instanceKey: '0|1|1',
            routes: [
                {
                    routeKey: '65000:1|0|10.0.0.0|24',
                    route: { ip: '10.0.0.0', mask: 24, pathId: 0, rd: '65000:1' },
                    attr: { asPath: '64512', nextHop: '192.0.2.1' }
                }
            ]
        });
        store.upsertRoutes('0|2|1', [
            {
                routeKey: 'ipv6-route',
                route: { ip: '2001:db8::', mask: 64, pathId: 0, rd: '0:0' },
                attr: { asPath: '64513', nextHop: '2001:db8::1' }
            }
        ]);
        return {
            status: store.getStatus(),
            group: store.getRouteGroupRoutes('old-group'),
            ipv6: Array.from(store.iterateRoutes('0|2|1'))
        };
    } finally {
        store.close();
    }
}

function verifyExactTargets() {
    const absent = path.join(directory, 'absent', 'bgp.sqlite3');
    assert.equal(resetDatabaseIfVersionChanged(absent, version).exists, false);
    assert.equal(fs.existsSync(path.dirname(absent)), false);
    const orphan = path.join(directory, 'orphan.sqlite3');
    fs.writeFileSync(`${orphan}-wal`, 'orphan-wal');
    assert.equal(resetDatabaseIfVersionChanged(orphan, version).reset, false);
    assert.equal(fs.readFileSync(`${orphan}-wal`, 'utf8'), 'orphan-wal');

    for (const previousVersion of [0, version - 1, version + 1, -1]) {
        const dbPath = path.join(directory, `helper-${previousVersion}.sqlite3`);
        createDatabase(dbPath, previousVersion);
        for (const suffix of suffixes.filter(Boolean)) fs.writeFileSync(`${dbPath}${suffix}`, '');
        fs.writeFileSync(`${dbPath}.backup`, 'keep-backup');
        fs.writeFileSync(`${dbPath}-wal.backup`, 'keep-similar-name');
        const result = resetDatabaseIfVersionChanged(dbPath, version);
        assert.equal(result.previousVersion, previousVersion);
        assert.equal(result.reset, true);
        assert.equal(result.deletedFiles.at(-1), dbPath, 'the main file must be deleted after its sidecars');
        for (const suffix of suffixes) assert.equal(fs.existsSync(`${dbPath}${suffix}`), false);
        assert.equal(fs.readFileSync(`${dbPath}.backup`, 'utf8'), 'keep-backup');
        assert.equal(fs.readFileSync(`${dbPath}-wal.backup`, 'utf8'), 'keep-similar-name');
        assert.equal(resetDatabaseIfVersionChanged(dbPath, version).reset, false);
    }
}

function verifyStoreResetAndPreservation() {
    const current = path.join(directory, 'current.sqlite3');
    const snapshot = seedRoutes(current);
    const bytes = fs.readFileSync(current);
    assert.equal(resetDatabaseIfVersionChanged(current, version).reset, false);
    assert.deepEqual(fs.readFileSync(current), bytes, 'current-version checks must preserve the database');
    const currentStore = new BgpRouteSqliteStore(current).open();
    try {
        assert.equal(currentStore.getStatus().routes, snapshot.status.routes);
        assert.deepEqual(currentStore.getRouteGroupRoutes('old-group'), snapshot.group);
        assert.deepEqual(Array.from(currentStore.iterateRoutes('0|2|1')), snapshot.ipv6);
    } finally {
        currentStore.close();
    }
    for (const previousVersion of [0, version - 1, version + 1, -1]) {
        const dbPath = path.join(directory, `store-${previousVersion}.sqlite3`);
        seedRoutes(dbPath);
        const db = new Database(dbPath);
        db.pragma(`user_version = ${previousVersion}`);
        db.close();
        const before = fs.readFileSync(dbPath);
        assert.throws(
            () => new BgpRouteSqliteStore({ dbPath, readOnly: true }).open(),
            /does not match expected schema/
        );
        assert.deepEqual(fs.readFileSync(dbPath), before, 'a readonly reader must not reset mismatched data');
        const store = new BgpRouteSqliteStore(dbPath).open();
        try {
            const status = store.getStatus();
            assert.equal(status.schemaVersion, version);
            assert.equal(status.routes, 0);
            assert.equal(status.attributes, 0);
            assert.equal(status.instances, 0);
            assert.deepEqual(store.listRouteGroups(), []);
        } finally {
            store.close();
        }
    }
}

function verifyFailuresPreserveData() {
    const corrupt = path.join(directory, 'corrupt.sqlite3');
    fs.writeFileSync(corrupt, 'not a SQLite database');
    const corruptStore = new BgpRouteSqliteStore(corrupt);
    assert.throws(
        () => corruptStore.open(),
        error => error.code === 'BGP_ROUTE_DATABASE_VERSION_CHECK_FAILED'
    );
    assert.equal(corruptStore.db, null);
    assert.equal(fs.readFileSync(corrupt, 'utf8'), 'not a SQLite database');

    const malformed = path.join(directory, 'malformed-current.sqlite3');
    createDatabase(malformed, version);
    assert.throws(() => new BgpRouteSqliteStore(malformed).open(), /missing|schema/i);
    const kept = new Database(malformed, { readonly: true });
    assert.equal(kept.prepare('SELECT value FROM marker').get().value, 'old-data');
    assert.equal(kept.pragma('user_version', { simple: true }), version);
    kept.close();

    const unsafe = path.join(directory, 'unsafe-sidecar.sqlite3');
    createDatabase(unsafe, version - 1);
    fs.mkdirSync(`${unsafe}-journal`);
    const before = fs.readFileSync(unsafe);
    assert.throws(() => new BgpRouteSqliteStore(unsafe).open(), /not a regular file/);
    assert.deepEqual(fs.readFileSync(unsafe), before);
    assert.equal(fs.statSync(`${unsafe}-journal`).isDirectory(), true);

    const locked = path.join(directory, 'unlink-failure.sqlite3');
    createDatabase(locked, version - 1);
    fs.writeFileSync(`${locked}-journal`, '');
    const lockedBefore = fs.readFileSync(locked);
    const originalUnlink = fs.unlinkSync;
    try {
        fs.unlinkSync = function (filePath, ...args) {
            if (filePath === `${locked}-journal`) {
                const error = new Error('permission denied');
                error.code = 'EACCES';
                throw error;
            }
            return originalUnlink.call(this, filePath, ...args);
        };
        assert.throws(() => new BgpRouteSqliteStore(locked).open(), /cannot remove/);
    } finally {
        fs.unlinkSync = originalUnlink;
    }
    assert.deepEqual(fs.readFileSync(locked), lockedBefore, 'a sidecar deletion failure must preserve the main file');
}

function verifyWorkerStart() {
    const dbPath = path.join(directory, 'worker.sqlite3');
    createDatabase(dbPath, version - 1);
    const worker = new BgpWorker();
    const errors = [];
    let listenCalls = 0;
    worker.messageHandler.sendErrorResponse = (_id, message) => errors.push(message);
    worker.startTcpServer = () => {
        listenCalls++;
        assert.equal(worker.routeStore.getStatus().schemaVersion, version);
        assert.equal(worker.bgpInstanceMap.get('0|1|1').routeMap.size, 0);
    };
    const config = { routeDatabasePath: dbPath, addressFamily: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC] };
    try {
        worker.startBgp('reset', config);
        assert.equal(listenCalls, 1, 'BGP startup must reset and hydrate before listening');
        assert.deepEqual(errors, []);
        worker.routeStore.close();
        fs.writeFileSync(dbPath, 'unreadable SQLite data');
        worker.startBgp('corrupt', config);
        assert.equal(listenCalls, 1, 'an unreadable database must prevent BGP listening');
        assert.equal(errors.length, 1);
        assert.match(errors[0], /cannot read SQLite user_version/);
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'unreadable SQLite data');
    } finally {
        worker.routeStore?.close();
    }
}

try {
    verifyExactTargets();
    verifyStoreResetAndPreservation();
    verifyFailuresPreserveData();
    verifyWorkerStart();
    console.log('BGP schema version reset, current/readonly preservation, startup and safe failure tests passed');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
